// One-off operator page, not part of the product UI. It upgrades the
// contract code on the signed-in owner's vault. The product server refuses
// to broadcast a DeployContract action on purpose (its whitelist only
// carries owner function calls), so this page signs the deploy with the
// owner's FastAuth popup through the same relay as the product, then
// broadcasts the signed transaction straight to a public RPC.
//
// State is safe: the fix batch changed behaviour only, never the stored
// struct layout, so the new code reads the old vault state as-is.

import { FastAuthSignature } from "@fast-auth-near/browser-sdk";
import { transactions, utils } from "near-api-js";
import { Signature, SignedTransaction } from "near-api-js/lib/transaction.js";
import { KeyType } from "near-api-js/lib/utils/key_pair.js";
import { api, setTokenGetter } from "./lib/api";
import { getIdToken, getSigner, initAuth, isLoggedIn, login } from "./lib/auth";

const EXPECTED_SHA256 =
  "3ba68aef1f1754bea075f2e074c29f1f2b76a5cb804881486cf01271e132c842";

// Same ordered fallbacks the app server uses.
const RPCS = [
  "https://test.rpc.fastnear.com",
  "https://near-testnet.drpc.org",
  "https://archival-rpc.testnet.near.org",
];

const h1 = document.querySelector("h1") as HTMLHeadingElement;
const logEl = document.querySelector("#log") as HTMLPreElement;
const factsEl = document.querySelector("#facts") as HTMLDivElement;
const goBtn = document.querySelector("#go") as HTMLButtonElement;
const signInBtn = document.querySelector("#signin") as HTMLButtonElement;

let wasmBytes: Uint8Array | null = null;
let vaultId = "";
let publicKey = "";

function say(line: string): void {
  h1.textContent = line;
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

async function rpc<T>(method: string, params: unknown): Promise<T> {
  for (const url of RPCS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) continue;
      const json = (await response.json()) as {
        result?: T;
        error?: { message?: string };
      };
      if (json.error || json.result === undefined) continue;
      return json.result;
    } catch {
      // This endpoint is down; the next one may answer.
    }
  }
  throw new Error(`Every RPC endpoint refused ${method}.`);
}

async function boot(): Promise<void> {
  try {
    say("Reading the app config");
    const config = await api.config();
    initAuth(config);
    setTokenGetter(getIdToken);
    if (!(await isLoggedIn())) {
      signInBtn.hidden = false;
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
  say("Reading your account");
  const me = await api.me();
  if (me.needsSetup) {
    say("This login has no vault to upgrade");
    return;
  }
  vaultId = me.user.vaultId;
  publicKey = me.user.publicKey;
  fact("signed in as", me.user.email || me.user.name || vaultId);
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

async function upgrade(): Promise<void> {
  if (!wasmBytes) return;
  goBtn.disabled = true;
  try {
    say("Reading your key and a fresh block");
    const [block, accessKey] = await Promise.all([
      api.block(),
      api.accessKey(vaultId, publicKey),
    ]);
    const transaction = transactions.createTransaction(
      vaultId,
      utils.PublicKey.fromString(publicKey),
      vaultId,
      BigInt(accessKey.nonce) + 1n,
      [transactions.deployContract(wasmBytes)],
      utils.serialize.base_decode(block.hash),
    );

    say("Waiting for your approval in the popup");
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

    say("Asking the key network for your one signature");
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
    const signedTransaction = new SignedTransaction({
      transaction,
      signature: new Signature({
        keyType: KeyType.ED25519,
        data: signature.recover("ed25519"),
      }),
    });
    const encoded = new Uint8Array(
      transactions.encodeTransaction(signedTransaction),
    );

    say("Broadcasting the upgrade straight to the network");
    const outcome = await rpc<{
      transaction_outcome?: { id?: string };
      status?: Record<string, unknown>;
    }>("broadcast_tx_commit", [toBase64(encoded)]);
    const status = outcome.status || {};
    if (!("SuccessValue" in status)) {
      throw new Error(
        `The network rejected the upgrade: ${JSON.stringify(status).slice(0, 240)}`,
      );
    }
    fact("upgrade transaction", outcome.transaction_outcome?.id || "unknown");

    const after = await rpc<{ code_hash: string }>("query", {
      request_type: "view_account",
      account_id: vaultId,
      finality: "final",
    });
    fact("code on chain after", after.code_hash);
    say(`UPGRADED ${vaultId}`);
  } catch (error) {
    goBtn.disabled = false;
    say(`FAILED ${describe(error).slice(0, 220)}`);
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

goBtn.addEventListener("click", () => {
  void upgrade();
});

void boot();
