// Unit tests for the attack suite's prediction engine and scenario table.
// Pure functions and plain data only: no chain access, no keys.
//
// The refusal reasons are pinned twice: literally in the branch tests, and
// against the contract source (this file reads contract/src/lib.rs and
// asserts every REASONS string appears verbatim), so the suite fails loudly
// if the contract's wording ever drifts from the runner's copy of it.
//
// The branch-order vectors mirror live evidence from Step 3: cap beats
// budget (receipt 3) and headroom beats queue (receipt 6), both real
// refusals read back from the deployed vault.
//
// Run from the repository root: node --test agent/attack.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseNearAmount } from "near-api-js";
import { REASONS, predictOutcome, ATTACKER, SCENARIOS } from "./attack.mjs";

const yocto = (nearDecimal) => BigInt(parseNearAmount(nearDecimal));
const req = (payee, amountNear) => ({ payee, amountYocto: yocto(amountNear) });

// The canonical live policy, measured after Step 5 batch 2: cap 0.5,
// auto_limit 0.2, budget remaining 0.2584, headroom 0.9795563... (exact
// live yocto), allowlist of three owner sub-accounts.
const CANON_ALLOWLIST = ["eqxdemi.testnet", "worker.eqxdemi.testnet", "data.eqxdemi.testnet"];
const CANON = {
  expired: false,
  allowlist: CANON_ALLOWLIST,
  cap: yocto("0.5"),
  budgetRemaining: yocto("0.2584"),
  headroom: 979556300398099900000011n,
  autoLimit: yocto("0.2"),
};

test("every REASONS string appears verbatim in the contract source", () => {
  const src = readFileSync(new URL("../contract/src/lib.rs", import.meta.url), "utf8");
  for (const [key, reason] of Object.entries(REASONS)) {
    assert.ok(src.includes(reason), `REASONS.${key} is not verbatim in contract/src/lib.rs: "${reason}"`);
  }
});

test("ladder: expiry dominates every rule", () => {
  const expired = { ...CANON, expired: true };
  assert.deepEqual(predictOutcome(req(ATTACKER, "0.6"), expired), {
    status: "Rejected",
    reason: REASONS.expired,
  });
});

test("ladder: zero dominates allowlist", () => {
  // The contract tests amount == 0, and an amount is unsigned on-chain, so
  // the predictor's <= 0 is exactly equivalent on the reachable domain.
  assert.deepEqual(predictOutcome({ payee: ATTACKER, amountYocto: 0n }, CANON), {
    status: "Rejected",
    reason: REASONS.zero,
  });
});

test("ladder: allowlist dominates cap", () => {
  // 0.6 is over the cap, but the payee is not allowed, so allowlist fires.
  assert.deepEqual(predictOutcome(req(ATTACKER, "0.6"), CANON), {
    status: "Rejected",
    reason: REASONS.allowlist,
  });
});

test("ladder: cap dominates budget (live receipt 3)", () => {
  // 0.6 is over both the cap (0.5) and the remaining budget (0.2584); the
  // contract checks the cap first, proven live by receipt 3.
  assert.deepEqual(predictOutcome(req("eqxdemi.testnet", "0.6"), CANON), {
    status: "Rejected",
    reason: REASONS.cap,
  });
});

test("ladder: budget dominates headroom", () => {
  const thin = { ...CANON, headroom: yocto("0.1") };
  // 0.3 passes the cap, exceeds the remaining budget, and also exceeds the
  // thin headroom; budget is checked first.
  assert.deepEqual(predictOutcome(req("eqxdemi.testnet", "0.3"), thin), {
    status: "Rejected",
    reason: REASONS.budget,
  });
});

test("ladder: headroom dominates queue (live receipt 6)", () => {
  const frozen = { ...CANON, headroom: yocto("0.0195") };
  // 0.25 would queue on its own (above the auto-limit) but the vault cannot
  // hold it above its storage reserve, so it is a headroom refusal, matching
  // the live receipt 6 evidence.
  assert.deepEqual(predictOutcome(req("eqxdemi.testnet", "0.25"), frozen), {
    status: "Rejected",
    reason: REASONS.headroom,
  });
});

test("ladder: above the auto-limit queues, at or below it settles", () => {
  assert.deepEqual(predictOutcome(req("worker.eqxdemi.testnet", "0.25"), CANON), {
    status: "Queued",
    reason: REASONS.queued,
  });
  assert.deepEqual(predictOutcome(req("worker.eqxdemi.testnet", "0.2"), CANON), {
    status: "Settled",
    reason: REASONS.settled,
  });
  assert.deepEqual(
    predictOutcome({ payee: "worker.eqxdemi.testnet", amountYocto: 200000000000000000000001n }, CANON),
    { status: "Queued", reason: REASONS.queued }
  );
});

test("boundaries are inclusive for cap, budget and headroom", () => {
  const big = { ...CANON, budgetRemaining: yocto("1"), headroom: yocto("1") };
  // Amount exactly at the cap passes the cap check (the contract uses >);
  // it queues for being over the auto-limit, not rejected.
  assert.deepEqual(predictOutcome(req("eqxdemi.testnet", "0.5"), big), {
    status: "Queued",
    reason: REASONS.queued,
  });
  // Amount exactly at the remaining budget passes the budget check.
  assert.deepEqual(predictOutcome(req("eqxdemi.testnet", "0.2584"), CANON), {
    status: "Queued",
    reason: REASONS.queued,
  });
  // Amount exactly at the headroom passes the headroom check.
  const tight = { ...CANON, headroom: yocto("0.15") };
  assert.deepEqual(predictOutcome(req("worker.eqxdemi.testnet", "0.15"), tight), {
    status: "Settled",
    reason: REASONS.settled,
  });
});

test("scenario table is coherent with the contract's constraints", () => {
  assert.equal(SCENARIOS.length, 5);
  const ids = new Set();
  for (const s of SCENARIOS) {
    assert.ok(!ids.has(s.id), `duplicate scenario id ${s.id}`);
    ids.add(s.id);
    assert.ok(typeof s.injection === "string" && s.injection.length > 0, `${s.id} needs an injection`);
    if (s.kind === "request_spend") {
      const bytes = Buffer.byteLength(s.purpose, "utf8");
      assert.ok(bytes >= 1 && bytes <= 280, `${s.id} purpose is ${bytes} bytes (contract allows 1..280)`);
      assert.ok(yocto(s.amountNear) > 0n, `${s.id} amount must be positive`);
      assert.ok(["Rejected", "Queued", "Settled"].includes(s.expected.status), `${s.id} unexpected expected status`);
      assert.ok(s.purpose.startsWith("INJECTED"), `${s.id} purpose needs the INJECTED prefix for verify mode`);
    } else {
      assert.equal(s.expected.status, "NetworkRefused", `${s.id} is a network-layer scenario`);
    }
  }
});

test("S1 aims off-allowlist, at an amount that would otherwise auto-settle", () => {
  const s = SCENARIOS.find((x) => x.id === "S1-exfil");
  assert.equal(s.payee, ATTACKER);
  assert.ok(!CANON.allowlist.includes(ATTACKER));
  // 0.01 is below the auto-limit, so without the allowlist it would have
  // settled silently: the allowlist check is the effective wall here.
  assert.ok(yocto(s.amountNear) <= CANON.autoLimit);
});

test("S2 clears the allowlist so the cap is the effective wall", () => {
  const s = SCENARIOS.find((x) => x.id === "S2-cap-smash");
  assert.ok(CANON.allowlist.includes(s.payee));
  assert.ok(yocto(s.amountNear) > CANON.cap);
});

test("S3 sits in the queue window: over the auto-limit, within every other rule", () => {
  const s = SCENARIOS.find((x) => x.id === "S3-human-wall");
  assert.ok(CANON.allowlist.includes(s.payee));
  const amount = yocto(s.amountNear);
  assert.ok(amount > CANON.autoLimit && amount <= CANON.cap);
  assert.ok(amount <= CANON.budgetRemaining, "S3 must fit the remaining budget or it would be a budget refusal");
  assert.ok(amount <= CANON.headroom);
  assert.deepEqual(s.finalExpected, { status: "OwnerRefused", reason: REASONS.refused });
});

test("every contract-layer scenario predicts exactly its expected outcome under the canonical state", () => {
  for (const s of SCENARIOS.filter((x) => x.kind === "request_spend")) {
    assert.deepEqual(predictOutcome(req(s.payee, s.amountNear), CANON), s.expected, `${s.id} prediction drift`);
  }
});

test("S3 drifts to a budget refusal if the remaining budget drops below 0.25", () => {
  const drained = { ...CANON, budgetRemaining: yocto("0.1") };
  assert.deepEqual(predictOutcome(req("eqxdemi.testnet", "0.25"), drained), {
    status: "Rejected",
    reason: REASONS.budget,
  });
  // The runner compares this against S3's expectation (Queued) and aborts
  // before sending anything: this is why the live suite needs a remaining
  // budget of at least 0.25, or a fresh period.
});

test("S2 stays a cap refusal after a period reset restores the budget", () => {
  const reset = { ...CANON, budgetRemaining: yocto("1") };
  assert.deepEqual(predictOutcome(req("eqxdemi.testnet", "0.6"), reset), {
    status: "Rejected",
    reason: REASONS.cap,
  });
  assert.deepEqual(predictOutcome(req("eqxdemi.testnet", "0.25"), reset), {
    status: "Queued",
    reason: REASONS.queued,
  });
});

test("network-layer scenarios aim at things the scoped key cannot do", () => {
  const s4 = SCENARIOS.find((x) => x.id === "S4-bypass");
  assert.equal(s4.kind, "transfer");
  assert.equal(s4.receiver, ATTACKER);
  assert.ok(yocto(s4.amountNear) > 0n);
  const s5 = SCENARIOS.find((x) => x.id === "S5-self-approve");
  assert.equal(s5.kind, "approve_spend");
  assert.ok(Number.isInteger(s5.receiptId) && s5.receiptId > 0);
  // A non-existent receipt id: the network must refuse before the contract
  // could ever complain about the missing pending spend.
});
