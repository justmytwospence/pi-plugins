import assert from "node:assert/strict";
import { test } from "node:test";
import { costPerCall, DEFAULT_COST_PER_CALL, estimate, Spend } from "./spend.ts";

test("Spend adds costs and counts every call, even without a cost", () => {
  const spend = new Spend();
  spend.add(0.001).add(undefined).add(Number.NaN).add(0.0025);
  assert.equal(spend.calls, 4);
  assert.ok(Math.abs(spend.total - 0.0035) < 1e-12);
  assert.equal(spend.line(), "spend: $0.0035 over 4 calls (catalog estimate; not a cash charge or verified credit debit)");
  assert.deepEqual(JSON.parse(JSON.stringify(spend)), { spend: 0.0035, calls: 4, backendAttempts: {}, registryCalls: 0, actualProviders: {}, attempts: [] });
});

test("addOutcome reads usage.cost.total from an askJev outcome and counts failures", () => {
  const spend = new Spend();
  spend.addOutcome({ ok: true, usage: { cost: { total: 0.002 } } }).addOutcome({ ok: true }).addOutcome({ ok: false, reason: "timeout", usage: { cost: { total: 0.003 } } }).addOutcome({ ok: false, reason: "unavailable" }).addOutcome(undefined);
  assert.equal(spend.calls, 5);
  assert.equal(spend.total, 0.005);
});

test("waterfall usage is charged once while logical, backend and registry calls stay distinct", () => {
  const first = { backend: "jev", provider: "typesafe", model: "jev-latest", status: "failed", sdkCalls: 2, usage: { cost: { total: 0.03 } } };
  const winner = { backend: "openai-decisions", provider: "system1-openai", model: "reported-version", status: "succeeded", sdkCalls: 1, usage: { cost: { total: 0.02 } } };
  const spend = new Spend().addOutcome({ ok: true, ...winner, usage: { cost: { total: 0.05 } }, attempts: [first, winner] });
  spend.addOutcome({ ok: false, attempts: [{ ...first, status: "cooldown", sdkCalls: 0 }], usage: { cost: { total: 0.01 } } });
  assert.equal(spend.calls, 2);
  assert.ok(Math.abs(spend.total - 0.06) < 1e-10);
  assert.deepEqual(spend.backendAttempts, { jev: 1, "openai-decisions": 1 });
  assert.equal(spend.registryCalls, 3);
  assert.deepEqual(spend.actualProviders, { '["openai-decisions","system1-openai","reported-version"]': 1 });
  assert.equal(spend.attempts.length, 3);
  assert.deepEqual(spend.attempts[0].usage, first.usage);
  const merged = new Spend().merge(spend);
  assert.deepEqual(merged.audit(), spend.audit());
  assert.match(merged.line(), /2 backend attempts, 3 registry calls/u);
});

test("audit whitelists fields and never keeps questions or raw bodies", () => {
  const spend = new Spend().addOutcome({ ok: false, attempts: [{ backend: "jev", status: "failed", sdkCalls: 0, state: "secret", answers: {}, raw: "private" }] });
  assert.doesNotMatch(JSON.stringify(spend.audit()), /secret|private|answers|state/u);
  assert.equal(spend.calls, 1);
  assert.equal(spend.total, 0);
});

test("an empty Spend", () => {
  assert.equal(new Spend().line(), "spend: $0.0000 over 0 calls (catalog estimate; not a cash charge or verified credit debit)");
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
