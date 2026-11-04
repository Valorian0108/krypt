// Step 7: the dry mode. One command that rehearses the contractor loop and
// the contract-layer attacks against the DEPLOYED contract's own decision
// function, with no keys, no funds, and no state change.
//
// It works because the vault exposes simulate_spend, a read-only view that
// runs the exact same rules ladder as request_spend (literally the same
// decide() function) and reports the status and sentence a live request
// would receive, without recording, queueing, reserving budget, or paying
// anything.
//
// What it covers:
//   - the loop's two spends (the digest job at the live board quote, the
//     dataset at the seller's published rate), each simulated against the
//     live rules and compared to "would settle";
//   - the three contract-layer attacks (off-allowlist, over-cap, queued),
//     each simulated and compared to its documented outcome.
//
// What it cannot cover, stated plainly: the two network-layer attacks are
// access-key checks, not contract logic, so a contract view cannot simulate
// them. The live Step 6 run is their evidence.
//
// Usage, from the repository root:
//   node --env-file=.env agent/dry.mjs
// No private key is read. Only three public account ids are needed; if one
// is missing, the runner exits with a usage message.
import { pathToFileURL } from "node:url";
import { JsonRpcProvider, parseNearAmount } from "near-api-js";
import { planContract, DATA_PRICE } from "./loop.mjs";
import { REASONS, SCENARIOS } from "./attack.mjs";

export const DRY_TASK = "audit digest: infra report q3";
export const DRY_BUDGET_NEAR = "0.05";

function nearStr(yocto) {
  const y = BigInt(yocto);
  const whole = y / 10n ** 24n;
  const frac = (y % 10n ** 24n).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/// What the contract should report in dry mode: the decision a live
/// request gets BEFORE any owner action. S3 therefore expects Queued, not
/// OwnerRefused: only a human can refuse, and dry mode cannot act for one.
export function expectedSimulation(s) {
  return { status: s.expected.status, reason: s.expected.reason };
}

/// Compare a SimulationView result to an expectation. Returns the list of
/// problems; empty means the contract agreed.
export function checkSimulation(sim, expected) {
  const problems = [];
  if (!sim || sim.simulated !== true) problems.push("the contract did not mark the result as simulated");
  if (!sim) return problems;
  if (sim.would_be_status !== expected.status) {
    problems.push(`expected ${expected.status}, got ${sim.would_be_status}`);
  }
  if (sim.would_be_reason !== expected.reason) {
    problems.push(`expected reason "${expected.reason}", got "${sim.would_be_reason}"`);
  }
  return problems;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const vault = process.env.VAULT_ACCOUNT_ID;
  const worker = process.env.WORKER_ACCOUNT_ID;
  const seller = process.env.SELLER_ACCOUNT_ID;
  for (const [name, value] of [
    ["VAULT_ACCOUNT_ID", vault],
    ["WORKER_ACCOUNT_ID", worker],
    ["SELLER_ACCOUNT_ID", seller],
  ]) {
    if (!value) {
      console.error(
        `missing ${name} (copy .env.example to .env and fill the three public account ids; dry mode needs no keys)`
      );
      process.exit(2);
    }
  }
  const provider = new JsonRpcProvider({
    url: process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org",
  });
  const view = (contractId, method, args) =>
    provider.callFunction({ contractId, method, args, blockQuery: { finality: "final" } });

  const [rules, status, vaultAcct] = await Promise.all([
    view(vault, "get_rules", {}),
    view(vault, "get_status", {}),
    provider.viewAccount({ accountId: vault, blockQuery: { finality: "final" } }),
  ]);
  const headroom = BigInt(vaultAcct.amount) - BigInt(vaultAcct.storage_usage) * 10n ** 19n;
  console.log(`vault:    ${vault}`);
  console.log(
    `rules:    cap ${nearStr(rules.cap_per_spend)}, auto-limit ${nearStr(
      rules.auto_limit
    )}, budget ${nearStr(rules.budget_per_period)} per period`
  );
  console.log(
    `state:    spent ${nearStr(status.spent_this_period)}, remaining ${nearStr(
      status.budget_remaining
    )}, headroom ${nearStr(headroom)}, receipts ${status.receipts_count}`
  );
  console.log("mode:     dry (read-only contract simulations; no keys, no funds, nothing sent)");

  const budgetYocto = BigInt(parseNearAmount(DRY_BUDGET_NEAR));
  const plan = planContract(DRY_TASK, budgetYocto);
  const simulated = [];

  // The loop's deliverable, quoted by the live board.
  if (plan.digest.decision === "buy") {
    const liveQuote = await view(worker, "quote", { task: plan.digest.task_to_buy });
    if (BigInt(liveQuote.price_yocto) !== BigInt(plan.digest.quote_yocto)) {
      console.error(
        `the live quote (${liveQuote.price_yocto}) disagrees with the local plan (${plan.digest.quote_yocto}); aborting, nothing sent`
      );
      process.exit(1);
    }
    simulated.push({
      label: `loop digest to ${worker}`,
      request: {
        payee: worker,
        amount: liveQuote.price_yocto,
        purpose: `loop job: ${plan.digest.task_to_buy.slice(0, 240)}`,
      },
      expected: { status: "Settled", reason: REASONS.settled },
    });
  }
  // The loop's inputs, only when the remainder covers the seller's rate.
  if (plan.data.decision === "buy") {
    simulated.push({
      label: `loop inputs to ${seller}`,
      request: {
        payee: seller,
        amount: DATA_PRICE.toString(),
        purpose: `loop inputs: ${DRY_TASK.slice(0, 240)}`,
      },
      expected: { status: "Settled", reason: REASONS.settled },
    });
  }
  for (const s of SCENARIOS.filter((x) => x.kind === "request_spend")) {
    simulated.push({
      label: `${s.id} (${s.layer})`,
      request: { payee: s.payee, amount: parseNearAmount(s.amountNear), purpose: s.purpose },
      expected: expectedSimulation(s),
    });
  }

  console.log(`\n--- ${simulated.length} requests simulated by the contract ---`);
  let failures = 0;
  for (const item of simulated) {
    const sim = await view(vault, "simulate_spend", item.request);
    const problems = checkSimulation(sim, item.expected);
    const ok = problems.length === 0;
    if (!ok) failures += 1;
    console.log(`\n${item.label}`);
    console.log(`  request:  ${nearStr(item.request.amount)} NEAR to ${item.request.payee}`);
    console.log(`  contract: ${sim.would_be_status}, "${sim.would_be_reason}"`);
    console.log(`  ${ok ? "MATCHES the documented outcome" : `DOES NOT MATCH: ${problems.join("; ")}`}`);
  }

  console.log(
    "\nnetwork-layer scenarios (S4 direct transfer, S5 self-approval) are access-key checks, not contract logic; a view cannot simulate them. They stay proven by the live Step 6 run."
  );
  if (failures === 0) {
    console.log(
      `\nscoreboard: ${simulated.length}/${simulated.length} simulations matched. Nothing was recorded, queued, or paid.`
    );
    process.exit(0);
  }
  console.log(
    `\nscoreboard: ${simulated.length - failures}/${simulated.length} matched, ${failures} failed. Nothing was sent.`
  );
  process.exit(1);
}
