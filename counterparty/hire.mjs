// The agent-side hiring cycle, end to end:
//   1. ask the job board for a quote (free read)
//   2. recompute the work's expected digest locally
//   3. fetch the delivered job and CHECK THE WORK before paying:
//      digest match, task match, price match
//   4. only then request the spend through the policy vault, with the
//      scoped agent key, and print the receipt
//
// Usage, from the repository root:
//   node --env-file=.env counterparty/hire.mjs "<task>"
//
// Required .env entries: AGENT_ACCOUNT_ID, AGENT_PRIVATE_KEY,
// VAULT_ACCOUNT_ID, WORKER_ACCOUNT_ID. Optional: NEAR_RPC_URL.
//
// The vendor must have run vendor.mjs fulfil first; if the job is not on
// the board yet, this exits without spending anything.
import { createHash } from "node:crypto";
import { Account, JsonRpcProvider, actions } from "near-api-js";

const [task] = process.argv.slice(2);
if (!task) {
  console.error('usage: node --env-file=.env counterparty/hire.mjs "<task>"');
  process.exit(2);
}
for (const name of ["AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY", "VAULT_ACCOUNT_ID", "WORKER_ACCOUNT_ID"]) {
  if (!process.env[name]) {
    console.error(`missing ${name} in the environment (run with --env-file=.env from the repo root)`);
    process.exit(2);
  }
}

const agent = process.env.AGENT_ACCOUNT_ID;
const vault = process.env.VAULT_ACCOUNT_ID;
const worker = process.env.WORKER_ACCOUNT_ID;
const url = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const provider = new JsonRpcProvider({ url });

async function view(contractId, method, args) {
  return provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });
}

const NEAR = 10n ** 24n;
function nearStr(yocto) {
  const y = BigInt(yocto);
  const whole = y / NEAR;
  const frac = (y % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// 1. The published quote.
const quote = await view(worker, "quote", { task });
console.log(`quote:    job ${quote.task_id} for ${nearStr(quote.price_yocto)} NEAR`);

// 2. What the work SHOULD be, computed here with node's own SHA-256.
const localDigest = createHash("sha256").update(task, "utf8").digest("hex");
if (localDigest.slice(0, 8) !== quote.task_id) {
  console.error("the job board's id does not match the local digest of the task; aborting");
  process.exit(1);
}

// 3. Fetch the delivered job and check the work before any payment.
const job = await view(worker, "get_job", { id: quote.task_id });
if (!job) {
  console.log("no delivered job on the board yet; the vendor must run:");
  console.log(`  node --env-file=.env counterparty/vendor.mjs fulfil "<task>"`);
  process.exit(2);
}
const problems = [];
if (job.result !== localDigest) problems.push("result digest does not match the task");
if (job.task !== task) problems.push("stored task text does not match");
if (job.price_yocto !== quote.price_yocto) problems.push("stored price does not match the quote");
if (problems.length) {
  console.error("work check FAILED, refusing to pay:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`work:     verified (sha256 matches locally, price matches quote)`);

// 4. Pay through the policy vault with the scoped agent key. The purpose
//    carries the job id so the receipt and the job board cross-reference.
//    Kept under the vault's 280-byte purpose cap.
const purpose = `job ${quote.task_id}: ${task.slice(0, 240)}`;
const account = new Account(agent, provider, process.env.AGENT_PRIVATE_KEY);
console.log(`payment:  requesting ${nearStr(quote.price_yocto)} NEAR to ${worker} through the vault`);
const out = await account.signAndSendTransaction({
  receiverId: vault,
  actions: [
    actions.functionCall(
      "request_spend",
      { payee: worker, amount: quote.price_yocto, purpose },
      100n * 10n ** 12n,
      0n
    ),
  ],
  waitUntil: "EXECUTED",
  throwOnFailure: true,
});
const txHash = out?.transaction?.hash || out?.transaction_outcome?.id;
console.log(`tx:       ${txHash}`);
console.log(`explorer: https://explorer.testnet.near.org/transactions/${txHash}`);
const receipt = JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString("utf8"));
console.log("vault receipt:");
console.log(JSON.stringify(receipt, null, 2));

if (receipt.status === "Queued") {
  console.log("\nThe price is above the auto-settle limit, so the owner decides with:");
  console.log(`  near contract call-function as-transaction ${vault} approve_spend file-args <file-with-{\"receipt_id\":${receipt.id}}> prepaid-gas "100 Tgas" attached-deposit "1 yoctoNEAR" sign-as <owner> network-config testnet sign-with-keychain send`);
} else if (receipt.status === "Rejected") {
  console.log("\nThe policy refused this payment; nothing moved. Reason above.");
  process.exit(1);
}
process.exit(0);
