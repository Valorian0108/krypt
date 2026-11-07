// One-off operator page, not part of the product UI. It upgrades the
// contract code on the signed-in owner's vault.
//
// A contract deploy cannot go through the FastAuth popup: the SDK puts the
// whole transaction in the Auth0 URL, and a 229 KB WASM becomes a 1.1 MB
// URL that the login server refuses before it answers. This page therefore
// adds a temporary full-access key with one small popup-approved AddKey
// transaction, signs the deploy locally with that key, and removes the key
// immediately afterwards. The temporary private key lives only in this tab.
//
// State is safe: the fix batch changed behaviour only, never the stored
// struct layout, so the new code reads the old vault state as-is.

import { FastAuthSignature } from "@fast-auth-near/browser-sdk";
import { transactions, utils } from "near-api-js";
import { Signature, SignedTransaction } from "near-api-js/lib/transaction.js";
import { KeyPair, KeyType } from "near-api-js/lib/utils/key_pair.js";
import { api, setTokenGetter } from "./lib/api";
import { getIdToken, getSigner, initAuth, isLoggedIn, login, logout } from "./lib/auth";

const EXPECTED_SHA256 =
  "3ba68aef1f1754bea075f2e074c29f1f2b76a5cb804881486cf01271e132c842";

// Same ordered fallbacks the app server uses. Archival nodes are kept for
// reads only; they reject transaction broadcasts.
const BROADCAST_RPCS = [
  "https://test.rpc.fastnear.com",
  "https://near-testnet.drpc.org",
];
const READ_RPCS = [
  ...BROADCAST_RPCS,
  "https://archival-rpc.testnet.near.org",
];

const h1 = document.querySelector("h1") as HTMLHeadingElement;
const logEl = document.querySelector("#log") as HTMLPreElement;
const factsEl = document.querySelector("#facts") as HTMLDivElement;
const goBtn = document.querySelector("#go") as HTMLButtonElement;
const signInBtn = document.querySelector("#signin") as HTMLButtonElement;
const signOutBtn = document.querySelector("#signout") as HTMLButtonElement;

let wasmBytes: Uint8Array | null = null;
let vaultId = "";
let publicKey = "";

function say(line: string): void {
  h1.textContent = line;
  logEl.textContent += `${new Date().toISOString().slice(11, 19)} ${line}\n`;
}

// Cleanup messages belong in the log without replacing the headline that
// already says UPGRADED or FAILED.
function note(line: string): void {
  logEl.textContent += `${new Date().toISOString().slice(11, 19)} ${line}\n`;
}

function fact(label: string, value: string): void {
  const row = document.createElement("div");
  row.className = "fact";
  const key = document.createElement("span");
  key.textContent = label;
  const code = document.createElement("code");
  code.textContent = value;
  row.append(key, code);
  factsEl.append(row);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer: subtle.digest rejects views that might
  // alias a SharedArrayBuffer.
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function rpc<T>(
  method: string,
  params: unknown,
  endpoints: string[] = READ_RPCS,
): Promise<T> {
  let lastError = "";
  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) {
        lastError = `${url} returned HTTP ${response.status}`;
        continue;
      }
      const json = (await response.json()) as {
        result?: T;
        error?: { message?: string };
      };
      if (json.error || json.result === undefined) {
        lastError = json.error?.message || `${url} returned no result`;
        continue;
      }
      return json.result;
    } catch (error) {
      lastError = `${url}: ${describe(error)}`;
    }
  }
  throw new Error(
    `Every RPC endpoint refused ${method}${lastError ? ` (last: ${lastError.slice(0, 180)})` : ""}.`,
  );
}

async function boot(): Promise<void> {
  try {
    say("Reading the app config");
    const config = await api.config();
    initAuth(config);
    setTokenGetter(getIdToken);
    const loggedIn = await isLoggedIn();
    signInBtn.hidden = loggedIn;
    signOutBtn.hidden = !loggedIn;
    if (!loggedIn) {
      say("Not signed in yet");
      return;
    }
    await loadSession();
  } catch (error) {
    say(`FAILED boot: ${describe(error)}`);
  }
}

async function loadSession(): Promise<void> {
  signInBtn.hidden = true;
  signOutBtn.hidden = false;
  say("Reading your account");
  const me = await api.me();
  if (me.needsSetup) {
    const who = me.identity.email || me.identity.name || "this login";
    fact("signed in as", who);
    if (!me.existingVault) {
      say(
        me.setupInProgress
          ? "Setup is still running for this login"
          : "This login has no vault to upgrade",
      );
      return;
    }
    // The server matched this login to a demo vault and confirmed the
    // derived key is on that account. Upgrade it without running the
    // product setup flow.
    vaultId = me.existingVault;
    publicKey = me.identity.publicKey;
  } else {
    vaultId = me.user.vaultId;
    publicKey = me.user.publicKey;
    fact("signed in as", me.user.email || me.user.name || vaultId);
  }
  fact("vault", vaultId);
  fact("vault key", publicKey);

  say("Fetching the bundled contract");
  const response = await fetch("/assets/policy_contract.wasm");
  wasmBytes = new Uint8Array(await response.arrayBuffer());
  const sha = await sha256Hex(wasmBytes);
  fact("bundle bytes", String(wasmBytes.length));
  fact("bundle sha256", sha);
  if (sha !== EXPECTED_SHA256) {
    goBtn.hidden = true;
    say("The bundled contract does not match the expected build");
    return;
  }
  fact("code hash after upgrade", utils.serialize.base_encode(hexToBytes(sha)));

  const account = await rpc<{ code_hash: string }>("query", {
    request_type: "view_account",
    account_id: vaultId,
    finality: "final",
  });
  fact("code on chain now", account.code_hash);
  if (account.code_hash === utils.serialize.base_encode(hexToBytes(sha))) {
    say("This vault already runs the new contract");
    return;
  }
  goBtn.hidden = false;
  say("Ready: approve the upgrade when you want it");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Tx = ReturnType<typeof transactions.createTransaction>;
type BroadcastOutcome = {
  final_execution_status?: string;
  status?: Record<string, unknown>;
  transaction?: { hash?: string };
  transaction_outcome?: { id?: string };
};

async function signWithFastAuth(transaction: Tx): Promise<SignedTransaction> {
  const signer = await getSigner();
  await signer.requestTransactionSignature({ transaction });
  const { signatureRequest } = await signer.getSignatureRequest();
  const rawPayload = signatureRequest.signPayload as unknown;
  const signPayload = Array.isArray(rawPayload)
    ? (rawPayload as number[])
    : Array.from(rawPayload as Uint8Array);
  if (signPayload.length === 0) {
    throw new Error("The approval carried no transaction.");
  }

  const relayed = await api.relaySign({
    guard_id: signatureRequest.guardId,
    verify_payload: signatureRequest.verifyPayload,
    sign_payload: signPayload,
    algorithm: "eddsa",
  });
  const successValue = relayed.result?.status?.SuccessValue;
  if (typeof successValue !== "string" || !successValue) {
    throw new Error("The key network returned no signature.");
  }
  const signature = FastAuthSignature.fromBase64(successValue);
  return new SignedTransaction({
    transaction,
    signature: new Signature({
      keyType: KeyType.ED25519,
      data: signature.recover("ed25519"),
    }),
  });
}

async function signWithKey(
  transaction: Tx,
  key: KeyPair,
): Promise<SignedTransaction> {
  const encoded = new Uint8Array(transactions.encodeTransaction(transaction));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoded));
  const signed = key.sign(digest);
  return new SignedTransaction({
    transaction,
    signature: new Signature({
      keyType: KeyType.ED25519,
      data: signed.signature,
    }),
  });
}

async function broadcastSigned(
  signed: SignedTransaction,
  failure: string,
): Promise<BroadcastOutcome> {
  const encoded = new Uint8Array(transactions.encodeTransaction(signed));
  const outcome = await rpc<BroadcastOutcome>(
    "send_tx",
    { signed_tx_base64: toBase64(encoded), wait_until: "FINAL" },
    BROADCAST_RPCS,
  );
  const status = outcome.status || {};
  if (!("SuccessValue" in status)) {
    throw new Error(`${failure}: ${JSON.stringify(status).slice(0, 240)}`);
  }
  return outcome;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAccessKey(
  accountId: string,
  key: string,
): Promise<{ nonce: string; permission: unknown }> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await api.accessKey(accountId, key);
    } catch {
      await sleep(1000);
    }
  }
  throw new Error("The temporary key did not appear on chain in time.");
}

async function waitForCodeHash(
  accountId: string,
  expected: string,
): Promise<string> {
  let codeHash = "";
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const account = await rpc<{ code_hash: string }>("query", {
      request_type: "view_account",
      account_id: accountId,
      finality: "final",
    });
    codeHash = account.code_hash;
    if (codeHash === expected) return codeHash;
    await sleep(1000);
  }
  return codeHash;
}

async function upgrade(): Promise<void> {
  if (!wasmBytes) return;
  goBtn.disabled = true;

  // The temporary key exists only in this tab. It is never logged, sent to
  // the server, or stored anywhere.
  const tempKey = KeyPair.fromRandom("ed25519");
  const tempPublicKey = tempKey.getPublicKey();
  const tempKeyString = tempPublicKey.toString();
  let keyAdded = false;
  let upgraded = false;
  let deployNonce: bigint | null = null;

  try {
    say("Reading your key and a fresh block");
    const [block, accessKey] = await Promise.all([
      api.block(),
      api.accessKey(vaultId, publicKey),
    ]);
    const addTx = transactions.createTransaction(
      vaultId,
      utils.PublicKey.fromString(publicKey),
      vaultId,
      BigInt(accessKey.nonce) + 1n,
      [transactions.addKey(tempPublicKey, transactions.fullAccessKey())],
      utils.serialize.base_decode(block.hash),
    );

    say("Waiting for your approval to add a temporary key");
    const signedAdd = await signWithFastAuth(addTx);

    say("Adding the temporary key");
    await broadcastSigned(signedAdd, "The network rejected the temporary key");
    keyAdded = true;
    fact("temporary key", tempKeyString);

    say("Waiting for the temporary key to land");
    const tempAccess = await waitForAccessKey(vaultId, tempKeyString);
    if (tempAccess.permission !== "FullAccess") {
      throw new Error("The temporary key is not a full-access key.");
    }

    say("Signing the contract deploy locally");
    const deployBlock = await api.block();
    deployNonce = BigInt(tempAccess.nonce) + 1n;
    const deployTx = transactions.createTransaction(
      vaultId,
      tempPublicKey,
      vaultId,
      deployNonce,
      [transactions.deployContract(wasmBytes)],
      utils.serialize.base_decode(deployBlock.hash),
    );
    const signedDeploy = await signWithKey(deployTx, tempKey);

    say("Broadcasting the upgrade straight to the network");
    const outcome = await broadcastSigned(
      signedDeploy,
      "The network rejected the upgrade",
    );
    fact(
      "upgrade transaction",
      outcome.transaction?.hash || outcome.transaction_outcome?.id || "unknown",
    );

    const expectedHash = utils.serialize.base_encode(
      hexToBytes(EXPECTED_SHA256),
    );
    const afterHash = await waitForCodeHash(vaultId, expectedHash);
    fact("code on chain after", afterHash);
    if (afterHash !== expectedHash) {
      throw new Error("The new code hash does not match the bundle.");
    }
    upgraded = true;
    goBtn.hidden = true;
    say(`UPGRADED ${vaultId}`);
  } catch (error) {
    say(`FAILED ${describe(error).slice(0, 220)}`);
  } finally {
    if (keyAdded) {
      try {
        note("Removing the temporary key");
        let removeNonce: bigint;
        if (deployNonce !== null) {
          removeNonce = deployNonce + 1n;
        } else {
          const access = await waitForAccessKey(vaultId, tempKeyString);
          removeNonce = BigInt(access.nonce) + 1n;
        }
        const block = await api.block();
        const removeTx = transactions.createTransaction(
          vaultId,
          tempPublicKey,
          vaultId,
          removeNonce,
          [transactions.deleteKey(tempPublicKey)],
          utils.serialize.base_decode(block.hash),
        );
        const signedRemove = await signWithKey(removeTx, tempKey);
        await broadcastSigned(
          signedRemove,
          "The network rejected removing the temporary key",
        );
        fact("temporary key removed", "yes");
        note("Temporary key removed");
      } catch (error) {
        fact("temporary key removed", "no, the private key is only in this tab");
        note(
          `WARNING: the temporary key was not removed: ${describe(error).slice(0, 160)}`,
        );
      }
    }
    if (!upgraded && !goBtn.hidden) {
      goBtn.disabled = false;
    }
  }
}

signInBtn.addEventListener("click", () => {
  signInBtn.disabled = true;
  void (async () => {
    try {
      say("Opening the sign-in window");
      await login();
      await loadSession();
    } catch (error) {
      signInBtn.disabled = false;
      say(`FAILED sign-in: ${describe(error)}`);
    }
  })();
});

signOutBtn.addEventListener("click", () => {
  signOutBtn.disabled = true;
  say("Signing out");
  void logout().catch((error) => {
    signOutBtn.disabled = false;
    say(`FAILED sign-out: ${describe(error)}`);
  });
});

goBtn.addEventListener("click", () => {
  void upgrade();
});

void boot();
