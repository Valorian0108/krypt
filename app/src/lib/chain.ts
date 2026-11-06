// The signing path for owner changes: build the transaction here, let the
// person approve it in one Auth0 popup, have the server relay that approval
// to the key network, then hand the finished signed transaction back to the
// server, which validates it before broadcasting. This is the exact sequence
// proven live on testnet, with the two chain reads moved to the server.

import { FastAuthSignature } from "@fast-auth-near/browser-sdk";
import { transactions, utils } from "near-api-js";
import { Signature, SignedTransaction } from "near-api-js/lib/transaction.js";
import { KeyType } from "near-api-js/lib/utils/key_pair.js";
import { api } from "./api";
import { getSigner } from "./auth";
import type { BroadcastResult } from "./types";

export type OwnerCall = {
  method: string;
  args: Record<string, unknown>;
  gas?: bigint;
};

// Owner methods write state; the numbers match the proven scripts. The
// server refuses anything above 150 Tgas per action or more than 6 actions.
export const GAS_WRITE = 100_000_000_000_000n;
export const GAS_OWNER = 50_000_000_000_000n;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function describeCancel(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/popup|closed|cancel|timeout/i.test(message)) {
    return "The approval window closed before you approved. Nothing was sent.";
  }
  return message;
}

export async function signOwnerTransaction(options: {
  vaultId: string;
  publicKey: string;
  calls: OwnerCall[];
  onStep?: (step: string) => void;
}): Promise<BroadcastResult> {
  const { vaultId, publicKey, calls, onStep } = options;
  if (calls.length === 0) throw new Error("There is nothing to sign.");
  if (calls.length > 6) throw new Error("Too many changes for one approval.");
  const step = onStep || (() => undefined);

  step("Reading your account from the network");
  const [block, accessKey] = await Promise.all([
    api.block(),
    api.accessKey(vaultId, publicKey),
  ]);

  const actions = calls.map((call) =>
    transactions.functionCall(
      call.method,
      call.args,
      call.gas ?? GAS_OWNER,
      1n, // every owner method requires exactly one yoctoNEAR
    ),
  );
  const transaction = transactions.createTransaction(
    vaultId,
    utils.PublicKey.fromString(publicKey),
    vaultId,
    BigInt(accessKey.nonce) + 1n,
    actions,
    utils.serialize.base_decode(block.hash),
  );

  const signer = await getSigner();

  step("Waiting for your approval in the sign-in window");
  try {
    // The approval popup is allowed three minutes: lib/auth.ts patches the
    // Auth0 client so timeoutInSeconds actually reaches loginWithPopup,
    // which is where this approval form appears.
    await signer.requestTransactionSignature({ transaction });
  } catch (error) {
    throw new Error(describeCancel(error));
  }

  const { signatureRequest } = await signer.getSignatureRequest();
  const signPayload = signatureRequest.signPayload as unknown;
  if (!Array.isArray(signPayload) || signPayload.length === 0) {
    throw new Error(
      "The approval did not include the transaction. Close the sign-in window and try again.",
    );
  }

  step("Asking the key network for your one signature");
  const relayed = await api.relaySign({
    guard_id: signatureRequest.guardId,
    verify_payload: signatureRequest.verifyPayload,
    sign_payload: signPayload,
    algorithm: "eddsa",
  });
  const successValue = relayed.result?.status?.SuccessValue;
  if (typeof successValue !== "string" || !successValue) {
    throw new Error(
      "The key network returned no signature. Nothing was sent; you can try again.",
    );
  }

  const signature = FastAuthSignature.fromBase64(successValue);
  const signedTransaction = new SignedTransaction({
    transaction,
    signature: new Signature({
      keyType: KeyType.ED25519,
      data: signature.recover("ed25519"),
    }),
  });
  const encoded = transactions.encodeTransaction(signedTransaction);

  step("Sending your signed change to the network");
  return api.broadcast(toBase64(new Uint8Array(encoded)));
}

// The one-time setup approval: register the agent and turn on the rules. A
// new account starts with nobody on its pay list, so the payee argument is
// optional and is only used when an operator deliberately seeds one.
export function onboardingCalls(
  agentId: string,
  rulesArgs: Record<string, unknown>,
  payee?: string,
): OwnerCall[] {
  const calls: OwnerCall[] = [
    { method: "register_agent", args: { agent: agentId }, gas: GAS_OWNER },
    { method: "set_rules", args: rulesArgs, gas: GAS_WRITE },
  ];
  if (payee) calls.push({ method: "add_payee", args: { payee }, gas: GAS_OWNER });
  return calls;
}
