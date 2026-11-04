// The contractor loop (Step 5): given a task and a budget, the agent
// decomposes the task, decides do-or-buy per subtask, picks payees,
// counters once on a too-high quote, checks the work, and pays through
// the vault, never exceeding its budget.
//
// Deterministic on purpose: same inputs, same decisions, no model calls.
// Every rule below is a published constant or a pure function, and the
// pure functions are unit-tested in loop.test.mjs.
//
// Usage, from the repository root:
//   node --env-file=.env agent/loop.mjs "<task>" <budget-in-NEAR> [--plan-only]
//
// --plan-only makes every decision and prints the plan with LIVE quotes
// from the job board, but sends no transactions. Read-only and free.
//
// The pipeline this demo agent runs is fixed and documented:
//   subtask "digest": the deliverable. A verifiable on-chain SHA-256 of
//     the task text, bought from the job board (published formula:
//     0.01 NEAR base + 0.0002 NEAR per byte, same constants as the
//     worker contract).
//   subtask "inputs": a dataset from the data seller (flat 0.02 NEAR;
//     the seller has no contract, so the rate is published in both
//     sides' configs). Bought only with what the deliverable leaves over.
//
// Do-or-buy is a real decision, not theatre:
//   - The deliverable is budgeted FIRST, against the whole budget. If the
//     full task's quote fits, buy it. If not, the loop COUNTERS ONCE by
//     re-scoping: it solves the published formula for the largest task
//     that fits (maxAffordableBytes), truncates the task to that many
//     bytes without splitting UTF-8 characters, and re-quotes. If even
//     the base fee does not fit, it does the work locally (computes the
//     digest itself) and records that no on-chain proof was bought.
//   - Inputs are bought only if the remainder covers the flat rate.
//
// Payment discipline (paid mode): every spend goes through the vault's
// request_spend with the scoped agent key, every spend is preflighted
// against the live rules (payee on the allowlist, amount at or below the
// auto-settle limit so the loop never queues a spend behind the owner's
// back, vault headroom covers it), the bought work is verified locally
// before payment (check-work-then-pay, same as hire.mjs), and a running
// ledger aborts the loop the moment the next spend would exceed budget.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Account, JsonRpcProvider, actions, parseNearAmount } from "near-api-js";

// ----------------------------------------------------------------------
// Published constants (mirror worker-contract/src/lib.rs exactly)
// ----------------------------------------------------------------------
export const NEAR = 10n ** 24n;
export const BASE_FEE = NEAR / 100n; // 0.01 NEAR
export const PER_BYTE_FEE = NEAR / 5000n; // 0.0002 NEAR per byte
export const DATA_PRICE = NEAR / 50n; // 0.02 NEAR flat, the seller's published rate

// ----------------------------------------------------------------------
// Pure decision core (unit-tested, no I/O)
// ----------------------------------------------------------------------

export function byteLength(s) {
  return BigInt(Buffer.byteLength(s, "utf8"));
}

/// The job board's published price for a task of `bytes` bytes.
export function priceOf(bytes) {
  const n = BigInt(bytes);
  if (n <= 0n) throw new Error("a task must have at least 1 byte");
  return BASE_FEE + n * PER_BYTE_FEE;
}

/// The largest task size (in bytes) whose quote fits in `slice` yocto.
/// Zero when even the base fee does not fit.
export function maxAffordableBytes(slice) {
  if (slice <= BASE_FEE) return 0n;
  return (slice - BASE_FEE) / PER_BYTE_FEE;
}

/// Truncate `s` to at most `maxBytes` UTF-8 bytes, never splitting a
/// multi-byte character: if the cut lands inside one, back off to its
/// start. A continuation byte has the bit pattern 10xxxxxx.
export function truncateToBytes(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  const max = Number(maxBytes);
  if (buf.length <= max) return s;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/// The do-or-buy plan for the whole budget. Deterministic:
/// 1. the deliverable (digest) is budgeted first, against everything;
/// 2. inputs (data) are bought only from the remainder.
/// Returns a plain object the caller can print, test, and execute.
export function planContract(task, budgetYocto) {
  const fullBytes = byteLength(task);
  const fullQuote = priceOf(fullBytes);
  const plan = {
    budget_yocto: budgetYocto.toString(),
    digest: null,
    data: null,
    total_yocto: "0",
    remainder_yocto: "0",
  };
  let remainder;
  if (fullQuote <= budgetYocto) {
    remainder = budgetYocto - fullQuote;
    plan.digest = {
      decision: "buy",
      task_to_buy: task,
      task_bytes: fullBytes.toString(),
      quote_yocto: fullQuote.toString(),
      countered: false,
    };
  } else {
    const maxB = maxAffordableBytes(budgetYocto);
    if (maxB >= 1n) {
      // Counter once: re-scope the task to the largest affordable size.
      const countered = truncateToBytes(task, maxB);
      const counteredBytes = byteLength(countered);
      const counteredQuote = priceOf(counteredBytes);
      remainder = budgetYocto - counteredQuote;
      plan.digest = {
        decision: "buy",
        task_to_buy: countered,
        task_bytes: counteredBytes.toString(),
        quote_yocto: counteredQuote.toString(),
        countered: true,
        full_quote_yocto: fullQuote.toString(),
      };
    } else {
      // Even the base fee does not fit: do the work locally, no on-chain
      // proof. The digest is still computed and reported, so the loop's
      // output stays useful.
      remainder = budgetYocto;
      plan.digest = {
        decision: "do-locally",
        local_digest: createHash("sha256").update(task, "utf8").digest("hex"),
        reason: "the base fee alone exceeds the budget",
      };
    }
  }
  if (remainder >= DATA_PRICE) {
    plan.data = { decision: "buy", price_yocto: DATA_PRICE.toString() };
    remainder -= DATA_PRICE;
  } else {
    plan.data = {
      decision: "skip",
      reason: "the deliverable left less than the seller's flat rate",
    };
  }
  plan.remainder_yocto = remainder.toString();
  const spent =
    (plan.digest.decision === "buy" ? BigInt(plan.digest.quote_yocto) : 0n) +
    (plan.data.decision === "buy" ? DATA_PRICE : 0n);
  plan.total_yocto = spent.toString();
  return plan;
}

/// Check-work-then-pay: verify the delivered job against the task we are
/// about to pay for. Returns the list of problems (empty means pay).
export function checkWork(taskToBuy, job) {
  const problems = [];
  const local = createHash("sha256").update(taskToBuy, "utf8").digest("hex");
  if (!job) problems.push("no delivered job on the board for this task");
  else {
    if (job.result !== local) problems.push("result digest does not match the task");
    if (job.task !== taskToBuy) problems.push("stored task text does not match");
    if (job.id !== local.slice(0, 8)) problems.push("job id does not match the digest prefix");
  }
  return problems;
}

// ----------------------------------------------------------------------
// Chain-facing runner (thin; all decisions come from the pure core above)
// ----------------------------------------------------------------------

function nearStr(yocto) {
  const y = BigInt(yocto);
  const whole = y / NEAR;
  const frac = (y % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const args = process.argv.slice(2);
  const planOnly = args.includes("--plan-only");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [task, budgetNear] = positional;
  if (!task || !budgetNear) {
    console.error(
      'usage: node --env-file=.env agent/loop.mjs "<task>" <budget-in-NEAR> [--plan-only]'
    );
    process.exit(2);
  }
  const budgetYocto = BigInt(parseNearAmount(budgetNear) ?? "-1");
  if (budgetYocto <= 0n) {
    console.error("budget must be a positive NEAR value, for example 0.05");
    process.exit(2);
  }
  for (const name of ["VAULT_ACCOUNT_ID", "WORKER_ACCOUNT_ID", "SELLER_ACCOUNT_ID"]) {
    if (!process.env[name]) {
      console.error(`missing ${name} in the environment (run with --env-file=.env from the repo root)`);
      process.exit(2);
    }
  }
  if (!planOnly) {
    for (const name of ["AGENT_ACCOUNT_ID", "AGENT_PRIVATE_KEY"]) {
      if (!process.env[name]) {
        console.error(`missing ${name} in the environment (paid mode needs the agent key)`);
        process.exit(2);
      }
    }
  }
  const vault = process.env.VAULT_ACCOUNT_ID;
  const worker = process.env.WORKER_ACCOUNT_ID;
  const seller = process.env.SELLER_ACCOUNT_ID;
  const provider = new JsonRpcProvider({
    url: process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org",
  });
  const view = (contractId, method, viewArgs) =>
    provider.callFunction({ contractId, method, args: viewArgs, blockQuery: { finality: "final" } });

  console.log(`task:     "${task}"`);
  console.log(`budget:   ${budgetNear} NEAR (${budgetYocto} yocto)`);
  console.log(`mode:     ${planOnly ? "plan-only (read-only, sends nothing)" : "paid (spends through the vault)"}`);

  // 1. Decide locally with the pure core.
  const plan = planContract(task, budgetYocto);

  // 2. Cross-check the digest decision against the LIVE board quote, so a
  //    drift between our constants and the deployed contract aborts the
  //    loop before any payment instead of after.
  if (plan.digest.decision === "buy") {
    const liveQuote = await view(worker, "quote", { task: plan.digest.task_to_buy });
    if (liveQuote.price_yocto !== plan.digest.quote_yocto) {
      console.error(
        `the live quote (${liveQuote.price_yocto}) disagrees with the local plan (${plan.digest.quote_yocto}); aborting`
      );
      process.exit(1);
    }
    console.log(`quote:    live board confirms ${nearStr(liveQuote.price_yocto)} NEAR for job ${liveQuote.task_id}${plan.digest.countered ? " (countered, re-scoped task)" : ""}`);
  }

  console.log("\n--- the plan ---");
  if (plan.digest.decision === "buy") {
    console.log(
      `digest:   BUY "${plan.digest.task_to_buy}" (${plan.digest.task_bytes} bytes) for ${nearStr(plan.digest.quote_yocto)} NEAR` +
        (plan.digest.countered
          ? ` (countered once from ${nearStr(plan.digest.full_quote_yocto)}; the full task did not fit the budget)`
          : "")
    );
  } else {
    console.log(`digest:   DO LOCALLY (${plan.digest.reason}); local digest ${plan.digest.local_digest}`);
  }
  if (plan.data.decision === "buy") {
    console.log(`inputs:   BUY the dataset from ${seller} for ${nearStr(DATA_PRICE)} NEAR`);
  } else {
    console.log(`inputs:   SKIP (${plan.data.reason})`);
  }
  console.log(`total:    ${nearStr(plan.total_yocto)} NEAR of ${budgetNear}, remainder ${nearStr(plan.remainder_yocto)}`);

  if (planOnly) {
    if (plan.digest.decision === "buy") {
      console.log("\nBefore the paid run, the vendor must deliver (vendor side, worker key):");
      console.log(`  node --env-file=.env counterparty/vendor.mjs fulfil "${plan.digest.task_to_buy}"`);
    }
    console.log("plan-only mode: nothing was sent.");
    process.exit(0);
  }

  // 3. Paid mode. Preflight against the LIVE policy: payees allowlisted,
  //    each spend at or below the auto-settle limit (the loop must never
  //    queue a spend behind the owner's back), and the vault's headroom
  //    (balance minus storage reserve) covers everything.
  const [rules, vaultAcct] = await Promise.all([
    view(vault, "get_rules", {}),
    provider.viewAccount({ accountId: vault, blockQuery: { finality: "final" } }),
  ]);
  const autoLimit = BigInt(rules.auto_limit);
  const headroom = BigInt(vaultAcct.amount) - BigInt(vaultAcct.storage_usage) * 10n ** 19n;
  const spends = [];
  if (plan.digest.decision === "buy") spends.push({ payee: worker, amount: BigInt(plan.digest.quote_yocto), purpose: `loop job: ${plan.digest.task_to_buy.slice(0, 240)}` });
  if (plan.data.decision === "buy") spends.push({ payee: seller, amount: DATA_PRICE, purpose: `loop inputs: ${task.slice(0, 240)}` });
  for (const s of spends) {
    if (!rules.payees.includes(s.payee)) {
      console.error(`preflight: ${s.payee} is not on the vault's allowlist; aborting, nothing spent`);
      process.exit(1);
    }
    if (s.amount > autoLimit) {
      console.error(`preflight: ${nearStr(s.amount)} is above the auto-settle limit ${nearStr(autoLimit)}; the loop refuses to queue spends behind the owner; aborting`);
      process.exit(1);
    }
  }
  if (spends.reduce((a, s) => a + s.amount, 0n) > headroom) {
    console.error(`preflight: the vault's spendable headroom is ${nearStr(headroom)} NEAR, below the plan's total; top up the vault first; aborting, nothing spent`);
    process.exit(1);
  }

  // 4. Check-work-then-pay for the bought digest: the job must already be
  //    delivered and match, exactly like hire.mjs.
  if (plan.digest.decision === "buy") {
    const liveQuote = await view(worker, "quote", { task: plan.digest.task_to_buy });
    const job = await view(worker, "get_job", { id: liveQuote.task_id });
    const problems = checkWork(plan.digest.task_to_buy, job);
    if (job && BigInt(job.price_yocto) !== BigInt(plan.digest.quote_yocto)) {
      problems.push("stored price does not match the plan's quote");
    }
    if (problems.length) {
      console.error("work check FAILED, refusing to pay:");
      for (const p of problems) console.error(`  - ${p}`);
      if (!job) {
        console.log("the vendor must deliver first:");
        console.log(`  node --env-file=.env counterparty/vendor.mjs fulfil "${plan.digest.task_to_buy}"`);
      }
      process.exit(1);
    }
    console.log(`\nwork:     verified for job ${liveQuote.task_id} (digest recomputed locally, task and price match)`);
  }

  // 5. Execute the spends in order, ledger-guarded.
  const account = new Account(process.env.AGENT_ACCOUNT_ID, provider, process.env.AGENT_PRIVATE_KEY);
  let ledger = 0n;
  for (const s of spends) {
    if (ledger + s.amount > budgetYocto) {
      console.error(`ledger: the next spend would exceed the budget; aborting before paying ${s.payee}`);
      process.exit(1);
    }
    const out = await account.signAndSendTransaction({
      receiverId: vault,
      actions: [
        actions.functionCall(
          "request_spend",
          { payee: s.payee, amount: s.amount.toString(), purpose: s.purpose },
          100n * 10n ** 12n,
          0n
        ),
      ],
      waitUntil: "EXECUTED",
      throwOnFailure: true,
    });
    const txHash = out?.transaction?.hash || out?.transaction_outcome?.id;
    const receipt = JSON.parse(Buffer.from(out.status.SuccessValue, "base64").toString("utf8"));
    ledger += s.amount;
    console.log(`payment:  receipt ${receipt.id} to ${s.payee}, ${nearStr(s.amount)} NEAR, status ${receipt.status}`);
    console.log(`          tx ${txHash}`);
    if (receipt.status !== "Settled") {
      console.error(`the loop only proceeds on Settled spends; receipt ${receipt.id} is ${receipt.status} (${receipt.reason}); stopping`);
      process.exit(1);
    }
  }
  console.log(`\nledger:   spent ${nearStr(ledger)} of ${budgetNear} NEAR; remainder ${nearStr(budgetYocto - ledger)}`);
  console.log("loop complete.");
  process.exit(0);
}
