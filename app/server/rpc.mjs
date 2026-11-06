import { createHash } from "node:crypto";
import { utils, transactions } from "near-api-js";
import { config } from "./config.mjs";

export class RpcError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RpcError";
    this.endpoint = options.endpoint;
    this.rpcError = options.rpcError;
    this.deterministic = Boolean(options.deterministic);
  }
}

const endpoints = [...new Set([config.rpcUrl, ...config.rpcFallbacks])];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error) {
  return typeof error === "string" ? error : JSON.stringify(error);
}

function isTimeout(error) {
  const text = errorText(error);
  return text.includes("TIMEOUT_ERROR") || text.includes("Timeout");
}

function isDeterministicViewError(error) {
  const text = errorText(error);
  return (
    text.includes("UNKNOWN_ACCOUNT") ||
    text.includes("UNKNOWN_ACCESS_KEY") ||
    text.includes("UNKNOWN_BLOCK") ||
    text.includes("INVALID_ACCOUNT_ID") ||
    // fastnear answers some view failures with HTTP 200 and an inline
    // "access key ... does not exist while viewing" string. That condition
    // is the same on every endpoint, so failing over would only waste a
    // request. Verified live on 2026-11-05.
    text.includes("does not exist") ||
    text.includes("doesn't exist") ||
    text.includes("CONTRACT_EXECUTION_ERROR") ||
    text.includes("wasm execution failed")
  );
}

async function post(endpoint, method, params, timeoutMs) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "ring1", method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new RpcError(`${endpoint} did not answer: ${error.message}`, {
      endpoint,
    });
  }

  const text = await response.text();
  if (!response.ok) {
    throw new RpcError(
      `${endpoint} answered HTTP ${response.status}: ${text.slice(0, 240)}`,
      { endpoint },
    );
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RpcError(`${endpoint} returned unreadable JSON`, { endpoint });
  }

  if (body.error) {
    throw new RpcError(`${endpoint} rejected ${method}: ${errorText(body.error)}`, {
      endpoint,
      rpcError: body.error,
      deterministic: isDeterministicViewError(body.error),
    });
  }
  // Some endpoints (fastnear) report a failed view as HTTP 200 with the
  // message inline at result.error instead of a top-level error. Treat it
  // the same way so callers never see a half-empty "successful" result.
  if (body.result && typeof body.result.error === "string" && body.result.error) {
    throw new RpcError(`${endpoint} rejected ${method}: ${body.result.error}`, {
      endpoint,
      rpcError: body.result.error,
      deterministic: isDeterministicViewError(body.result.error),
    });
  }
  return body.result;
}

export async function rpcCall(method, params, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const candidates = options.failover === false ? [endpoints[0]] : endpoints;
  let lastError;
  for (const endpoint of candidates) {
    try {
      return await post(endpoint, method, params, timeoutMs);
    } catch (error) {
      lastError = error;
      if (error instanceof RpcError && error.deterministic) {
        throw error;
      }
      if (options.failover === false) {
        throw error;
      }
    }
  }
  throw lastError ?? new RpcError("every RPC endpoint failed");
}

export async function query(params) {
  return rpcCall("query", params);
}

export async function viewAccount(accountId) {
  return query({
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });
}

export async function viewAccessKey(accountId, publicKey) {
  const result = await query({
    request_type: "view_access_key",
    finality: "final",
    account_id: accountId,
    public_key: publicKey,
  });
  // view_access_key answers with nonce and permission at the top level,
  // while view_access_key_list wraps each entry in access_key. Normalize to
  // the wrapped shape so every caller reads result.access_key.permission.
  // Verified against fastnear and drpc on 2026-11-05.
  if (result && !result.access_key && result.permission !== undefined) {
    result.access_key = { permission: result.permission };
  }
  return result;
}

export async function viewAccessKeyList(accountId) {
  return query({
    request_type: "view_access_key_list",
    finality: "final",
    account_id: accountId,
  });
}

export async function callView(contractId, methodName, args = {}) {
  const result = await query({
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: methodName,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  const text = Buffer.from(result.result || []).toString("utf8");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function getBlock() {
  return rpcCall("block", { finality: "final" });
}

let protocolCache = null;
let protocolCachedAt = 0;

export async function protocolConfig() {
  if (protocolCache && Date.now() - protocolCachedAt < 5 * 60_000) {
    return protocolCache;
  }
  const result = await rpcCall("EXPERIMENTAL_protocol_config", {
    finality: "final",
  });
  protocolCache = result;
  protocolCachedAt = Date.now();
  return result;
}

export async function storagePerByte() {
  const protocol = await protocolConfig();
  return BigInt(protocol.runtime_config.storage_amount_per_byte);
}

export async function storageReserve(accountId) {
  const account = await viewAccount(accountId);
  const perByte = await storagePerByte();
  return BigInt(account.storage_usage) * perByte;
}

export function base58Encode(bytes) {
  return utils.serialize.base_encode(bytes);
}

export function transactionHash(encodedUnsigned) {
  return base58Encode(createHash("sha256").update(encodedUnsigned).digest());
}

function isRpcTimeoutError(error) {
  return error instanceof RpcError && error.rpcError && isTimeout(error.rpcError);
}

async function pollOutcome(hash, senderAccountId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";
  while (Date.now() < deadline) {
    for (const endpoint of endpoints) {
      try {
        const result = await post(
          endpoint,
          "tx",
          {
            tx_hash: hash,
            sender_account_id: senderAccountId,
            wait_until: "FINAL",
          },
          20_000,
        );
        const status = result.status;
        if (status && typeof status === "object" && "Started" in status) {
          lastStatus = "started";
          break;
        }
        if (status !== undefined && status !== null) {
          return result;
        }
        lastStatus = String(status);
        break;
      } catch (error) {
        if (error instanceof RpcError && isTimeout(error.rpcError)) {
          lastStatus = "waiting";
          break;
        }
        if (error instanceof RpcError && error.rpcError) {
          const text = errorText(error.rpcError);
          if (text.includes("UNKNOWN_TRANSACTION")) {
            lastStatus = "not seen yet";
            break;
          }
        }
        lastStatus = error instanceof Error ? error.message : String(error);
      }
    }
    await sleep(1_500);
  }
  throw new RpcError(
    `the network did not finish transaction ${hash} in time (last status: ${lastStatus})`,
  );
}

// Broadcast one already-signed transaction. Resending the same bytes is safe:
// the hash and nonce are fixed, so the network keeps at most one.
export async function broadcastSignedTransaction(signedBytes, senderAccountId) {
  const signedBase64 = Buffer.from(signedBytes).toString("base64");
  let hash = null;
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const result = await post(
        endpoint,
        "send_tx",
        { signed_tx_base64: signedBase64, wait_until: "INCLUDED" },
        25_000,
      );
      hash = result.transaction?.hash || result.transaction_outcome?.id || null;
      break;
    } catch (error) {
      lastError = error;
      if (error instanceof RpcError && isRpcTimeoutError(error)) {
        // The transaction was accepted but the wait window closed. Poll by
        // the hash the caller can compute, or by the hash in the error body.
        const text = errorText(error.rpcError);
        const match = text.match(/[1-9A-HJ-NP-Za-km-z]{43,44}/);
        hash = match ? match[0] : null;
        break;
      }
      // A transport error may mean accepted or not. The same bytes can be
      // sent again, so try the next endpoint.
    }
  }

  if (!hash) {
    // Compute the hash from the signed bytes; NEAR's transaction id is the
    // base58 sha256 of the signed transaction.
    hash = base58Encode(createHash("sha256").update(signedBytes).digest());
  }

  try {
    const outcome = await pollOutcome(hash, senderAccountId, 120_000);
    return { hash, outcome };
  } catch (error) {
    if (lastError && !(error instanceof RpcError)) throw lastError;
    throw error;
  }
}

const keyQueues = new Map();

export function withKeyQueue(keyId, task) {
  const previous = keyQueues.get(keyId) || Promise.resolve();
  const run = previous.then(task, task);
  keyQueues.set(
    keyId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

// Sign and send with a local key. Used by the sponsor for provisioning and
// by each agent for request_spend. Reads the nonce fresh every time: the
// near-api-js Account object caches it, which caused a real collision.
export async function signAndSendWithKey({
  signerId,
  keyPair,
  receiverId,
  actions,
  waitUntil = "FINAL",
}) {
  return withKeyQueue(`${signerId}:${keyPair.getPublicKey().toString()}`, async () => {
    const publicKey = keyPair.getPublicKey();
    const accessKey = await viewAccessKey(signerId, publicKey.toString());
    const block = await getBlock();
    const transaction = transactions.createTransaction(
      signerId,
      publicKey,
      receiverId,
      BigInt(accessKey.nonce) + 1n,
      actions,
      utils.serialize.base_decode(block.header.hash),
    );
    const encoded = transactions.encodeTransaction(transaction);
    const hashBytes = createHash("sha256").update(encoded).digest();
    const { signature } = keyPair.sign(hashBytes);
    const signed = new transactions.SignedTransaction({
      transaction,
      signature: new transactions.Signature({
        keyType: publicKey.keyType,
        data: signature,
      }),
    });
    const signedBytes = transactions.encodeTransaction(signed);
    const localHash = base58Encode(hashBytes);
    if (waitUntil === "NONE") {
      return { hash: localHash, signedBytes };
    }
    const sent = await broadcastSignedTransaction(signedBytes, signerId);
    return { hash: sent.hash || localHash, outcome: sent.outcome };
  });
}
