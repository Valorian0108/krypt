import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { transactions, utils } from "near-api-js";
import { decodeSignedTransaction } from "@near-js/transactions";
import { config, GAS, ONE_YOCTO } from "./config.mjs";
import {
  broadcastSignedTransaction,
  callView,
  signAndSendWithKey,
  storagePerByte,
  viewAccessKey,
  viewAccessKeyList,
  viewAccount,
} from "./rpc.mjs";

const MAX_USER_TX_BYTES = 512 * 1024;

// The owner methods this app is willing to broadcast on a user's behalf.
// Anything else, including key changes and plain transfers, is refused here
// even though the login's key could technically sign it.
const ALLOWED_METHODS = new Set([
  "set_rules",
  "register_agent",
  "revoke_agent",
  "add_payee",
  "remove_payee",
  "approve_spend",
  "refuse_spend",
  "withdraw",
  "simulate_spend",
]);
const MAX_ACTIONS = 6;
const MAX_GAS_PER_ACTION = 150_000_000_000_000n;

let sponsor = null;
let wasm = null;
let wasmInfo = null;

export function nearToYocto(near) {
  const [whole, fraction = ""] = String(near).split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw new Error(`${near} is not a NEAR amount`);
  }
  return BigInt(whole + fraction.padEnd(24, "0").slice(0, 24));
}

export function yoctoToNear(yocto) {
  const value = BigInt(yocto);
  const padded = value.toString().padStart(25, "0");
  const whole = padded.slice(0, -24).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-24).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function formatPublicKey(key) {
  // The decoded transaction carries the key as whatever the borsh decoder
  // produced: a PublicKey instance in some package copies, or a plain enum
  // object like { ed25519Key: { data: [..32 bytes..] } } in others. Accept
  // both, verified live against @near-js/transactions 2.5.1.
  if (key && key.data instanceof Uint8Array) {
    const curve = key.keyType === 0 ? "ed25519" : "secp256k1";
    return `${curve}:${utils.serialize.base_encode(key.data)}`;
  }
  for (const [prop, curve] of [
    ["ed25519Key", "ed25519"],
    ["secp256k1Key", "secp256k1"],
  ]) {
    const variant = key && key[prop];
    if (!variant) continue;
    const raw = variant instanceof Uint8Array ? variant : variant.data;
    if (!raw) continue;
    const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw);
    return `${curve}:${utils.serialize.base_encode(bytes)}`;
  }
  throw new Error("That transaction carries an unreadable key.");
}

export async function initChain() {
  const bytes = await readFile(config.wasmPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== config.wasmSha256) {
    throw new Error(
      `the bundled contract does not match the expected build: ${sha256}`,
    );
  }
  wasm = bytes;
  wasmInfo = {
    bytes: bytes.length,
    sha256,
    codeHash: utils.serialize.base_encode(
      createHash("sha256").update(bytes).digest(),
    ),
  };

  const keyJson = JSON.parse(await readFile(config.sponsorKeyPath, "utf8"));
  if (!keyJson.private_key) {
    throw new Error("the sponsor key file has no private_key field");
  }
  const keyPair = utils.KeyPair.fromString(keyJson.private_key);
  const publicKey = keyPair.getPublicKey().toString();
  if (keyJson.public_key && keyJson.public_key !== publicKey) {
    throw new Error("the sponsor key file's public_key does not match its private_key");
  }
  await viewAccessKey(config.sponsorAccountId, publicKey);
  sponsor = { keyPair, publicKey };
  return { sponsorPublicKey: publicKey, wasm: wasmInfo };
}

export function chainInfo() {
  if (!sponsor) throw new Error("the chain layer is not ready yet");
  return { sponsorPublicKey: sponsor.publicKey, wasm: wasmInfo };
}

export async function accountExists(accountId) {
  try {
    await viewAccount(accountId);
    return true;
  } catch (error) {
    const text = String(error.message || error);
    if (text.includes("UNKNOWN_ACCOUNT") || text.includes("does not exist")) {
      return false;
    }
    throw error;
  }
}

export async function keyOnAccount(accountId, publicKey) {
  try {
    const result = await viewAccessKey(accountId, publicKey);
    return result;
  } catch (error) {
    const text = String(error.message || error);
    // near RPC says UNKNOWN_ACCESS_KEY or "doesn't exist"; fastnear says
    // "access key ... does not exist while viewing". All mean: not on this
    // account.
    if (
      text.includes("UNKNOWN_ACCESS_KEY") ||
      text.includes("doesn't exist") ||
      text.includes("does not exist")
    ) {
      return null;
    }
    throw error;
  }
}

export async function sponsorAvailableYocto() {
  const account = await viewAccount(config.sponsorAccountId);
  const perByte = await storagePerByte();
  const locked = BigInt(account.storage_usage) * perByte;
  // account.locked is staked elsewhere and cannot be spent from here, so
  // only the liquid balance minus the storage reserve is really available.
  return BigInt(account.amount) - locked;
}

async function requireSponsorFunds(requiredYocto, what) {
  const available = await sponsorAvailableYocto();
  if (available < requiredYocto) {
    const error = new Error(
      `The treasury holds ${yoctoToNear(available)} NEAR, which is not enough to ${what} ` +
        `(${yoctoToNear(requiredYocto)} NEAR needed). Top up ${config.sponsorAccountId} and try again.`,
    );
    error.status = 507;
    throw error;
  }
}

function sponsorSend(receiverId, actions) {
  if (!sponsor) throw new Error("the chain layer is not ready yet");
  return signAndSendWithKey({
    signerId: config.sponsorAccountId,
    keyPair: sponsor.keyPair,
    receiverId,
    actions,
  });
}

export function explainFailure(outcome, what) {
  const failure = outcome.status?.Failure;
  if (!failure) return null;
  const text = JSON.stringify(failure);
  const panic = text.match(/Smart contract panicked: ([^"\\]+)/);
  if (panic) return panic[1].trim();
  // Raw LackBalanceForState JSON is meaningless to owners. It means the
  // account cannot keep the NEAR the network locks for its stored state, so
  // the fix is always the same: put a little more NEAR in the vault.
  if (text.includes("LackBalanceForState")) {
    const needed = text.match(/"amount":\s*"?(\d+)"?/);
    const amount = needed ? `${yoctoToNear(BigInt(needed[1]))} NEAR` : "more NEAR";
    return (
      `The vault is short on storage money: the network wants about ${amount} locked to keep ` +
      "its receipts and rules stored. Top up the vault a little, then try this again."
    );
  }
  const execution = text.match(/"ExecutionError":"([^"]+)"/);
  if (execution) return execution[1].replace(/\\"/g, '"').slice(0, 300);
  return `${what} was refused by the network: ${text.slice(0, 300)}`;
}

function assertSucceeded(outcome, what) {
  const sentence = explainFailure(outcome, what);
  if (sentence) throw new Error(sentence);
}

export function outcomeLogs(outcome) {
  const logs = [];
  for (const entry of outcome?.receipts_outcome || []) {
    for (const line of entry?.outcome?.logs || []) {
      logs.push(line);
    }
  }
  return logs;
}

export function vaultIdForSubject(subject) {
  const digest = createHash("sha256").update(subject).digest("hex").slice(0, 10);
  return `v1-${digest}.${config.sponsorSubaccountSuffix}`;
}

export function agentIdForSubject(subject) {
  const digest = createHash("sha256").update(`agent:${subject}`).digest("hex").slice(0, 10);
  return `agent-${digest}.${config.sponsorSubaccountSuffix}`;
}

export async function provisionVault({ vaultId, publicKey }) {
  const funding = nearToYocto(config.vaultFundingNear);
  await requireSponsorFunds(
    funding + nearToYocto("0.05"),
    "create a new account",
  );

  if (await accountExists(vaultId)) {
    // A previous attempt may have created it. Adopt only if it is ours.
    const key = await keyOnAccount(vaultId, publicKey);
    const status = key ? await callView(vaultId, "get_status").catch(() => null) : null;
    if (key && status && status.owner === vaultId) {
      return { txHash: null, reused: true };
    }
    throw new Error(
      `The account ${vaultId} already exists and this login does not control it.`,
    );
  }

  const actions = [
    transactions.createAccount(),
    transactions.transfer(funding),
    transactions.addKey(
      utils.PublicKey.fromString(publicKey),
      transactions.fullAccessKey(),
    ),
    transactions.deployContract(wasm),
    transactions.functionCall("new", { owner: vaultId }, GAS.deployInit, 0n),
  ];

  const { hash, outcome } = await sponsorSend(vaultId, actions);
  assertSucceeded(outcome, "Creating the account");

  const key = await keyOnAccount(vaultId, publicKey);
  if (!key) throw new Error("The account was created but the login key is missing.");
  const status = await callView(vaultId, "get_status");
  if (!status || status.owner !== vaultId) {
    throw new Error("The account was created but its rules did not initialize.");
  }
  return { txHash: hash, reused: false };
}

export async function provisionAgent({ agentId, agentPublicKey, vaultId }) {
  const funding = nearToYocto(config.agentFundingNear);
  const allowance = nearToYocto(config.agentGasAllowanceNear);
  await requireSponsorFunds(
    funding + nearToYocto("0.02"),
    "create the agent account",
  );

  if (await accountExists(agentId)) {
    const key = await keyOnAccount(agentId, agentPublicKey);
    if (key) return { txHash: null, reused: true };
    throw new Error(
      `The agent account ${agentId} already exists with a different key.`,
    );
  }

  const actions = [
    transactions.createAccount(),
    transactions.transfer(funding),
    transactions.addKey(
      utils.PublicKey.fromString(agentPublicKey),
      transactions.functionCallAccessKey(vaultId, ["request_spend"], allowance),
    ),
  ];

  const { hash, outcome } = await sponsorSend(agentId, actions);
  assertSucceeded(outcome, "Creating the agent account");

  const key = await keyOnAccount(agentId, agentPublicKey);
  const permission = key?.access_key?.permission;
  const receiver = permission?.FunctionCall?.receiver_id;
  const methods = permission?.FunctionCall?.method_names || [];
  if (receiver !== vaultId || !methods.includes("request_spend")) {
    throw new Error(
      "The agent account was created but its key is not limited to requesting spends.",
    );
  }
  return { txHash: hash, reused: false };
}

export async function readVault(vaultId) {
  const [account, keys, status, rules, receipts, pending] = await Promise.all([
    viewAccount(vaultId),
    viewAccessKeyList(vaultId),
    callView(vaultId, "get_status"),
    callView(vaultId, "get_rules"),
    callView(vaultId, "get_receipts", { limit: 50 }),
    callView(vaultId, "get_pending"),
  ]);

  const perByte = await storagePerByte();
  const balance = BigInt(account.amount);
  const reserve = BigInt(account.storage_usage) * perByte;
  const spendable = balance > reserve ? balance - reserve : 0n;

  return {
    vaultId,
    balanceYocto: balance.toString(),
    storageReserveYocto: reserve.toString(),
    spendableYocto: spendable.toString(),
    storageBytes: account.storage_usage,
    codeHash: account.code_hash,
    accessKeys: keys.keys.map((entry) => ({
      publicKey: entry.public_key,
      permission:
        entry.access_key.permission === "FullAccess"
          ? "full"
          : entry.access_key.permission?.FunctionCall
            ? {
                type: "scoped",
                receiver: entry.access_key.permission.FunctionCall.receiver_id,
                methods: entry.access_key.permission.FunctionCall.method_names,
              }
            : "unknown",
    })),
    status,
    rules,
    receipts: Array.isArray(receipts) ? receipts : [],
    pending: Array.isArray(pending) ? pending : [],
  };
}

export async function relaySign({ guardId, verifyPayload, signPayload, algorithm }) {
  await requireSponsorFunds(nearToYocto("0.01"), "ask for a signature");
  const actions = [
    transactions.functionCall(
      "sign",
      {
        guard_id: guardId,
        verify_payload: verifyPayload,
        sign_payload: signPayload,
        algorithm,
      },
      GAS.sign,
      ONE_YOCTO,
    ),
  ];
  const { hash, outcome } = await sponsorSend(config.fastAuthContractId, actions);
  assertSucceeded(outcome, "The approval relay");
  return { hash, outcome };
}

export function summarizeUserTransaction(decoded) {
  return decoded.transaction.actions
    .map((action) => {
      const call = action.functionCall;
      if (!call) return "unknown action";
      return `${call.methodName}(${String(call.deposit)} yocto)`;
    })
    .join(", ");
}

// The browser signs with its own login key and hands the signed bytes here.
// Before broadcasting, the server checks that the transaction really is an
// owner call from this login's own account. A user can only affect their own
// vault, and only through the methods this product exposes.
export function inspectUserTransaction(signedTxBase64, { vaultId, publicKey }) {
  let bytes;
  try {
    bytes = Buffer.from(signedTxBase64, "base64");
  } catch {
    throw new Error("That transaction could not be read.");
  }
  if (bytes.length === 0 || bytes.length > MAX_USER_TX_BYTES) {
    throw new Error("That transaction is the wrong size.");
  }

  let decoded;
  try {
    decoded = decodeSignedTransaction(bytes);
  } catch {
    throw new Error("That transaction could not be read.");
  }

  const tx = decoded.transaction;
  if (tx.signerId !== vaultId) {
    throw new Error("That transaction is not from your own account.");
  }
  if (tx.receiverId !== vaultId) {
    throw new Error("That transaction does not target your own account.");
  }
  if (formatPublicKey(tx.publicKey) !== publicKey) {
    throw new Error("That transaction was not signed with this login's key.");
  }
  if (tx.actions.length === 0 || tx.actions.length > MAX_ACTIONS) {
    throw new Error("That transaction has too many steps.");
  }

  for (const action of tx.actions) {
    const call = action.functionCall;
    if (!call) {
      throw new Error("This app only sends rule and approval changes.");
    }
    if (!ALLOWED_METHODS.has(call.methodName)) {
      throw new Error(`This app does not send ${call.methodName}.`);
    }
    if (BigInt(call.deposit) > ONE_YOCTO) {
      throw new Error("This app never attaches more than a token deposit.");
    }
    if (BigInt(call.gas) > MAX_GAS_PER_ACTION) {
      throw new Error("This app does not send transactions with that much gas.");
    }
  }

  return { bytes, decoded, summary: summarizeUserTransaction(decoded) };
}

export async function broadcastUserTransaction(signedTxBase64, { vaultId, publicKey }) {
  const { bytes, summary } = inspectUserTransaction(signedTxBase64, {
    vaultId,
    publicKey,
  });
  const { hash, outcome } = await broadcastSignedTransaction(bytes, vaultId);
  assertSucceeded(outcome, "The change");
  return { hash, outcome, summary };
}
