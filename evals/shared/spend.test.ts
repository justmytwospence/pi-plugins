import assert from "node:assert/strict";
import { test } from "node:test";
import { costPerCall, DEFAULT_COST_PER_CALL, estimate, Spend } from "./spend.ts";

test("Spend adds costs and counts every call, even without a cost", () => {
  const spend = new Spend();
  spend.add(0.001).add(undefined).add(Number.NaN).add(0.0025);
  assert.equal(spend.calls, 4);
  assert.ok(Math.abs(spend.total - 0.0035) < 1e-12);
  assert.equal(spend.line(), "spend: $0.0035 over 4 calls");
  assert.deepEqual(JSON.parse(JSON.stringify(spend)), { spend: 0.0035, calls: 4 });
});

test("addOutcome reads usage.cost.total from an askJev outcome and counts failures", () => {
  const spend = new Spend();
  spend.addOutcome({ ok: true, usage: { cost: { total: 0.002 } } }).addOutcome({ ok: true }).addOutcome({ ok: false, reason: "timeout" }).addOutcome(undefined);
  assert.equal(spend.calls, 4);
  assert.equal(spend.total, 0.002);
});

test("an empty Spend", () => {
  assert.equal(new Spend().line(), "spend: $0.0000 over 0 calls");
});

test("merge folds two accumulators", () => {
  const a = new Spend().add(0.5);
  const b = new Spend().add(0.25).add(0.25);
  assert.equal(a.merge(b).calls, 3);
  assert.equal(a.total, 1);
});

test("costPerCall reads EVAL_COST_PER_CALL and falls back for anything unusable", () => {
  assert.equal(costPerCall({}), DEFAULT_COST_PER_CALL);
  assert.equal(costPerCall({ EVAL_COST_PER_CALL: "0.001" }), 0.001);
  for (const bad of ["", "abc", "0", "-1"]) assert.equal(costPerCall({ EVAL_COST_PER_CALL: bad }), DEFAULT_COST_PER_CALL);
});

test("estimate is calls x price with a 0.5x to 2x range", () => {
  const e = estimate(1000, { EVAL_COST_PER_CALL: "0.001" });
  assert.deepEqual(e.usd, { low: 0.5, expected: 1, high: 2 });
  assert.equal(e.calls, 1000);
  assert.match(e.note, /estimate/u);
  assert.deepEqual(estimate(0, {}).usd, { low: 0, expected: 0, high: 0 });
});
