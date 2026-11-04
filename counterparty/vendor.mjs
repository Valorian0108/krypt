// The vendor's runner for the job board contract on worker.<owner>.testnet.
// Two modes:
//   node --env-file=.env counterparty/vendor.mjs quote   "<task>"   (read-only, no key needed)
//   node --env-file=.env counterparty/vendor.mjs fulfil  "<task>"   (signs with WORKER_PRIVATE_KEY)
//
// fulfil is the vendor doing the work: the contract itself computes the
// SHA-256 digest of the task and stores the job record on-chain, before
// any payment. That ordering is deliberate; the vault's policy is what
// makes delivering first safe for the vendor.
import { Account, JsonRpcProvider, actions } from "near-api-js";

const [mode, task] = process.argv.slice(2);
if (!mode || !task || !["quote", "fulfil"].includes(mode)) {
  console.error('usage: node --env-file=.env counterparty/vendor.mjs <quote|fulfil> "<task>"');
  process.exit(2);
}

const worker = process.env.WORKER_ACCOUNT_ID;
if (!worker) {
  console.error("missing WORKER_ACCOUNT_ID in the environment (run with --env-file=.env from the repo root)");
  process.exit(2);
}
const url = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
const provider = new JsonRpcProvider({ url });

async function view(method, args) {
  return provider.callFunction({
    contractId: worker,
    method,
    args,
    blockQuery: { finality: "final" },
  });
}

const NEAR = 10n ** 24n;
function nearStr(yocto) {
  const y = BigInt(yocto);
  const whole = y / NEAR;
  const frac = (y % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

if (mode === "quote") {
  const q = await view("quote", { task });
  console.log(`job id:  ${q.task_id}`);
  console.log(`price:   ${nearStr(q.price_yocto)} NEAR (${q.price_yocto} yocto)`);
  process.exit(0);
}

// fulfil: a real transaction, signed with the worker account's own key.
if (!process.env.WORKER_PRIVATE_KEY) {
  console.error("missing WORKER_PRIVATE_KEY in the environment (run with --env-file=.env from the repo root)");
  process.exit(2);
}
const account = new Account(worker, provider, process.env.WORKER_PRIVATE_KEY);
const out = await account.signAndSendTransaction({
  receiverId: worker,
  actions: [
    actions.functionCall("fulfil", { task }, 100n * 10n ** 12n, 0n),
  ],
  waitUntil: "EXECUTED",
  throwOnFailure: true,
});
const txHash = out?.transaction?.hash || out?.transaction_outcome?.id;
console.log(`tx:       ${txHash}`);
console.log(`explorer: https://explorer.testnet.near.org/transactions/${txHash}`);
const job = JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString("utf8"));
console.log("job delivered on-chain:");
console.log(JSON.stringify(job, null, 2));
console.log(`price:    ${nearStr(job.price_yocto)} NEAR`);
process.exit(0);
