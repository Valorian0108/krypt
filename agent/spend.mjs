// The agent's request path: ask the policy vault for one spend, signed with
// the scoped FunctionCall key. This key can call exactly one method
// (request_spend) on exactly one contract (the vault), can never attach a
// deposit, and can never transfer NEAR directly: the network enforces all
// of it before our code runs.
//
// Usage, from the repository root:
//   node --env-file=.env agent/spend.mjs <amount-in-NEAR> "<purpose>" [payee]
//
// Required .env entries: AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY,
// VAULT_ACCOUNT_ID. Optional: NEAR_RPC_URL, PAYEE_ACCOUNT_ID.
//
// Every outcome (Settled, Queued, Rejected) is a normal return value: the
// contract answers with a readable Receipt. Only authorization failures
// (nobody registered, wrong caller) panic.
import { Account, JsonRpcProvider, actions, parseNearAmount } from "near-api-js";

const [amountNear, purpose, payeeArg] = process.argv.slice(2);

if (!amountNear || !purpose) {
  console.error('usage: node --env-file=.env agent/spend.mjs <amount-in-NEAR> "<purpose>" [payee]');
  process.exit(2);
}
for (const name of ["AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY", "VAULT_ACCOUNT_ID"]) {
  if (!process.env[name]) {
    console.error(`missing ${name} in the environment (run with --env-file=.env from the repo root)`);
    process.exit(2);
  }
}

const agent = process.env.AGENT_ACCOUNT_ID;
const vault = process.env.VAULT_ACCOUNT_ID;
const payee = payeeArg || process.env.PAYEE_ACCOUNT_ID || "eqxdemi.testnet";
const url = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const amountYocto = parseNearAmount(amountNear);
if (amountYocto === null || BigInt(amountYocto) <= 0n) {
  console.error("amount must be a positive NEAR value, for example 0.05");
  process.exit(2);
}

const provider = new JsonRpcProvider({ url });
const account = new Account(agent, provider, process.env.AGENT_PRIVATE_KEY);

console.log(`agent:    ${agent}`);
console.log(`vault:    ${vault}`);
console.log(`request:  ${amountNear} NEAR to ${payee}`);
console.log(`purpose:  ${purpose}`);

const out = await account.signAndSendTransaction({
  receiverId: vault,
  actions: [
    actions.functionCall(
      "request_spend",
      { payee, amount: amountYocto, purpose },
      100n * 10n ** 12n, // 100 Tgas
      0n // a FunctionCall key cannot attach a deposit, and needs none here
    ),
  ],
  waitUntil: "EXECUTED",
  throwOnFailure: true,
});

const txHash = out?.transaction?.hash || out?.transaction_outcome?.id;
console.log(`tx:       ${txHash}`);
console.log(`explorer: https://explorer.testnet.near.org/transactions/${txHash}`);

// request_spend returns the Receipt itself; decode the SuccessValue.
const b64 = out?.status?.SuccessValue;
if (typeof b64 !== "string") {
  console.log("unexpected outcome status:", JSON.stringify(out?.status));
  process.exit(1);
}
const receipt = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
console.log("receipt:");
console.log(JSON.stringify(receipt, null, 2));

if (receipt.status === "Queued") {
  console.log("\nThis spend is waiting for the owner. The owner decides with:");
  console.log(`  near contract call-function as-transaction ${vault} approve_spend file-args <file-with-{\"receipt_id\":${receipt.id}}> prepaid-gas "100 Tgas" attached-deposit "1 yoctoNEAR" sign-as <owner> network-config testnet sign-with-keychain send`);
  console.log("  (or refuse_spend with the same arguments to decline it)");
}
process.exit(0);
