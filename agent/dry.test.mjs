// Unit tests for the dry mode's comparison core. No chain access: these
// pin the expectation rules and the fail-loud behavior. The live agreement
// between simulate_spend and the documented outcome is the dry mode's own
// integration test, run after the view is deployed.
//
// Run from the repository root: node --test agent/dry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNearAmount } from "near-api-js";
import { DRY_TASK, DRY_BUDGET_NEAR, expectedSimulation, checkSimulation } from "./dry.mjs";
import { planContract } from "./loop.mjs";
import { REASONS, SCENARIOS } from "./attack.mjs";

const simOf = (status, reason) => ({
  simulated: true,
  would_be_status: status,
  would_be_reason: reason,
  note: "nothing was recorded, queued, or paid",
});

test("dry expectations are the decision before any owner action", () => {
  const s3 = SCENARIOS.find((s) => s.id === "S3-human-wall");
  // S3 queues; only the human refusal in the live run turns it into
  // OwnerRefused. Dry mode must not claim the refusal for itself.
  assert.deepEqual(expectedSimulation(s3), { status: "Queued", reason: REASONS.queued });
});

test("every contract-layer scenario passes when the contract agrees", () => {
  for (const s of SCENARIOS.filter((x) => x.kind === "request_spend")) {
    const expected = expectedSimulation(s);
    assert.deepEqual(checkSimulation(simOf(expected.status, expected.reason), expected), []);
  }
});

test("both loop spends are expected to settle", () => {
  assert.deepEqual(checkSimulation(simOf("Settled", REASONS.settled), {
    status: "Settled",
    reason: REASONS.settled,
  }), []);
});

test("a tampered status or reason fails loudly", () => {
  const expected = { status: "Rejected", reason: REASONS.allowlist };
  // Wrong reason, right status: one problem.
  assert.equal(checkSimulation(simOf("Rejected", REASONS.cap), expected).length, 1);
  // Wrong status: at least one problem names it.
  const problems = checkSimulation(simOf("Settled", REASONS.allowlist), expected);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Settled/);
});

test("a result the contract did not mark as simulated fails", () => {
  const expected = { status: "Rejected", reason: REASONS.allowlist };
  const fake = { ...simOf("Rejected", REASONS.allowlist), simulated: false };
  assert.deepEqual(checkSimulation(fake, expected), ["the contract did not mark the result as simulated"]);
  assert.deepEqual(checkSimulation(null, expected), ["the contract did not mark the result as simulated"]);
});

test("the default dry rehearsal fits its 0.05 budget", () => {
  const plan = planContract(DRY_TASK, BigInt(parseNearAmount(DRY_BUDGET_NEAR)));
  assert.equal(plan.digest.decision, "buy");
  assert.equal(plan.data.decision, "buy");
});
