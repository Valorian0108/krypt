// Unit tests for the contractor loop's decision core. Pure functions only:
// no chain access, no keys. The price vectors are pinned to live evidence:
// priceOf(3) is the "abc" job (0.0106 NEAR) and priceOf(29) is the batch 2
// demo job (0.0158 NEAR, vault receipt 7), both read from the deployed job
// board, so these tests fail loudly if the constants ever drift from the
// contract's.
//
// Run from the repository root: node --test agent/loop.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NEAR,
  BASE_FEE,
  PER_BYTE_FEE,
  DATA_PRICE,
  priceOf,
  maxAffordableBytes,
  truncateToBytes,
  planContract,
  checkWork,
} from "./loop.mjs";

const y = (nearDecimal) => BigInt(Math.round(nearDecimal * 1e6)) * 10n ** 18n; // helper for small NEAR amounts

test("constants mirror the worker contract", () => {
  assert.equal(BASE_FEE, NEAR / 100n);
  assert.equal(PER_BYTE_FEE, NEAR / 5000n);
  assert.equal(DATA_PRICE, NEAR / 50n);
});

test("priceOf matches the two live board quotes", () => {
  assert.equal(priceOf(3n), 10600000000000000000000n); // "abc", live
  assert.equal(priceOf(29n), 15800000000000000000000n); // batch 2 demo task, receipt 7
});

test("priceOf rejects an empty task", () => {
  assert.throws(() => priceOf(0n), /at least 1 byte/);
});

test("maxAffordableBytes solves the published formula", () => {
  // A 0.015 slice affords base 0.01 + 25 bytes at 0.0002 = 0.015 exactly.
  assert.equal(maxAffordableBytes(y(0.015)), 25n);
  // The base fee alone affords zero bytes; below it, zero as well.
  assert.equal(maxAffordableBytes(BASE_FEE), 0n);
  assert.equal(maxAffordableBytes(y(0.005)), 0n);
  // Floors instead of rounding up: 0.0151 slice still affords 25 bytes.
  assert.equal(maxAffordableBytes(y(0.0151)), 25n);
});

test("truncateToBytes cuts to the byte budget", () => {
  assert.equal(truncateToBytes("audit digest: infra report q3", 19n), "audit digest: infra");
  assert.equal(truncateToBytes("audit digest: infra report q3", 25n), "audit digest: infra repor");
});

test("truncateToBytes never splits a UTF-8 character", () => {
  // e-acute is 2 bytes; a 3-byte budget would cut the second one in half.
  assert.equal(truncateToBytes("\u00e9\u00e9\u00e9", 3n), "\u00e9");
  // A 4-byte budget fits two of them exactly.
  assert.equal(truncateToBytes("\u00e9\u00e9\u00e9", 4n), "\u00e9\u00e9");
});

test("truncateToBytes leaves short strings alone", () => {
  assert.equal(truncateToBytes("short", 100n), "short");
});

test("plan: a comfortable budget buys both subtasks, deliverable first", () => {
  const plan = planContract("audit digest: infra report q3", y(0.05));
  assert.equal(plan.digest.decision, "buy");
  assert.equal(plan.digest.countered, false);
  assert.equal(plan.digest.quote_yocto, "15800000000000000000000");
  assert.equal(plan.data.decision, "buy");
  assert.equal(plan.total_yocto, (y(0.0158) + DATA_PRICE).toString());
  assert.equal(plan.remainder_yocto, (y(0.05) - y(0.0158) - DATA_PRICE).toString());
});

test("plan: a tight budget counters once by re-scoping the task", () => {
  const plan = planContract("audit digest: infra report q3", y(0.015));
  assert.equal(plan.digest.decision, "buy");
  assert.equal(plan.digest.countered, true);
  assert.equal(plan.digest.task_to_buy, "audit digest: infra repor"); // 25 bytes
  assert.equal(plan.digest.quote_yocto, y(0.015).toString());
  assert.equal(plan.digest.full_quote_yocto, "15800000000000000000000");
  assert.equal(plan.data.decision, "skip"); // nothing left over
  assert.equal(plan.remainder_yocto, "0");
});

test("plan: a middling budget buys the deliverable and skips inputs", () => {
  const plan = planContract("audit digest: infra report q3", y(0.025));
  assert.equal(plan.digest.decision, "buy");
  assert.equal(plan.digest.countered, false);
  assert.equal(plan.data.decision, "skip");
  assert.equal(plan.total_yocto, "15800000000000000000000");
});

test("plan: below the base fee, the work is done locally", () => {
  const plan = planContract("audit digest: infra report q3", y(0.005));
  assert.equal(plan.digest.decision, "do-locally");
  assert.match(plan.digest.local_digest, /^[0-9a-f]{64}$/);
  assert.equal(plan.data.decision, "skip");
  assert.equal(plan.total_yocto, "0");
});

test("plan: the total never exceeds the budget", () => {
  for (const b of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.05, 0.1]) {
    const plan = planContract("audit digest: infra report q3", y(b));
    assert.ok(BigInt(plan.total_yocto) <= y(b), `budget ${b} overspent`);
  }
});

test("checkWork passes a matching job and rejects a wrong one", () => {
  const task = "abc";
  const good = {
    id: "ba7816bf",
    task,
    result: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  };
  assert.deepEqual(checkWork(task, good), []);
  assert.deepEqual(checkWork(task, null), ["no delivered job on the board for this task"]);
  const tampered = { ...good, result: "0".repeat(64) };
  // The stored id still matches the local digest prefix; only the result
  // was tampered with, so exactly one problem is reported.
  assert.deepEqual(checkWork(task, tampered), ["result digest does not match the task"]);
});
