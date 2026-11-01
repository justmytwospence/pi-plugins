import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { comparisonWarning, diff, diffRecords, evalParams, gitState, last, record, type ResultRecord } from "./results.ts";

const env = () => ({ EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "eval-results-")), EVAL_SEED: "7", EVAL_SAMPLE: "3", OTHER: "x" });

test("record appends one JSON line with the stamps filled in, last reads them back", () => {
  const e = env();
  const first = record("demo", { seed: 7, spend: 0.01, calls: 4, metrics: { prompts: 10 } }, e);
  record("demo", { seed: 7, spend: 0.02, calls: 5, metrics: { prompts: 12 }, compare: { prompts: 12 } }, e);
  assert.deepEqual(first.params, { EVAL_SAMPLE: "3", EVAL_SEED: "7" });
  assert.match(first.at, /^\d{4}-\d\d-\d\dT/u);
  assert.equal(typeof first.commit, "string");
  assert.equal(typeof first.dirty, "boolean");
  assert.equal(readFileSync(path.join(e.EVAL_RESULTS_DIR, "demo.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.deepEqual(last("demo", 1, e).map((r) => r.metrics), [{ prompts: 12 }]);
  assert.deepEqual(last("demo", 5, e).map((r) => r.calls), [4, 5]);
  assert.deepEqual(last("demo", 0, e), []);
});

test("last of a target with no history is empty and torn lines are skipped", () => {
  const e = env();
  assert.deepEqual(last("none", 3, e), []);
  record("torn", { spend: 0, calls: 0, metrics: {} }, e);
  appendFileSync(path.join(e.EVAL_RESULTS_DIR, "torn.jsonl"), "{not json\n");
  assert.equal(last("torn", 3, e).length, 1);
});

test("a target name cannot leave the results directory", () => {
  assert.throws(() => record("../x", { spend: 0, calls: 0, metrics: {} }, env()), /bad results target/u);
  assert.throws(() => last("a/b", 1, env()), /bad results target/u);
});

test("diff gives numeric deltas for matching keys only", () => {
  assert.deepEqual(diff({ a: 1, b: 2, s: "x", only: 1 }, { a: 4, b: 2, s: "y", other: 3 }), { a: 3, b: 0 });
  assert.deepEqual(diff({ m: { x: 1, y: 2 }, n: { z: 1 } }, { m: { x: 3 }, n: { w: 1 } }), { m: { x: 2 } });
  assert.deepEqual(diff({ a: 0.1 }, { a: 0.3 }), { a: 0.2 });
  assert.deepEqual(diff(undefined, { a: 1 }), {});
});

test("diffRecords compares spend, calls, metrics and compare, not the stamps", () => {
  const rec = (spend: number, calls: number, p: number, compare?: number): ResultRecord => ({
    at: "t",
    commit: "abc",
    dirty: false,
    seed: 1,
    params: {},
    spend,
    calls,
    metrics: { prompts: p },
    ...(compare === undefined ? {} : { compare: { prompts: compare } }),
  });
  assert.deepEqual(diffRecords(rec(1, 10, 5, 8), rec(3, 12, 4, 9)), { spend: 2, calls: 2, metrics: { prompts: -1 }, compare: { prompts: 1 } });
  assert.deepEqual(diffRecords(rec(1, 10, 5), rec(1, 10, 5, 9)), { spend: 0, calls: 0, metrics: { prompts: 0 } });
});

test("classifier provenance roundtrips alongside legacy records", () => {
  const e = env();
  const legacy = record("provenance", { spend: 1, calls: 1, metrics: { score: 1 } }, e);
  const classifier = { backend: "jev", provider: "typesafe", model: "jev-latest" };
  const current = record("provenance", { spend: 2, calls: 2, metrics: { score: 2 }, classifier }, e);
  assert.deepEqual(last("provenance", 2, e), [legacy, current]);
  assert.equal(last("provenance", 2, e)[0].classifier, undefined);
  assert.deepEqual(last("provenance", 2, e)[1].classifier, classifier);
});

test("record comparisons warn for unknown or mismatched classifier provenance", () => {
  const legacy: ResultRecord = { at: "t", commit: "c", dirty: false, seed: null, params: {}, spend: 1, calls: 1, metrics: { score: 1 } };
  const classifier = { backend: "jev", provider: "typesafe", model: "jev-latest" };
  const known = { ...legacy, classifier };
  const next = { ...known, spend: 2, calls: 2, metrics: { score: 3 } };
  const expected = { spend: 1, calls: 1, metrics: { score: 2 } };
  assert.equal(comparisonWarning(known, next), undefined);
  assert.deepEqual(diffRecords(known, next), expected);
  assert.match(comparisonWarning(legacy, { ...next, classifier: undefined })!, /legacy\/unknown/u);
  assert.deepEqual(diffRecords(legacy, { ...next, classifier: undefined }), expected);
  for (const [a, b] of [[legacy, next], [next, legacy]] as const) {
    assert.match(comparisonWarning(a, b)!, /legacy\/unknown/u);
    assert.deepEqual(diffRecords(a, b), {});
  }
  for (const field of ["backend", "provider", "model"] as const) {
    const different = { ...next, classifier: { ...classifier, [field]: "different" } };
    assert.match(comparisonWarning(known, different)!, new RegExp(field, "u"));
    assert.deepEqual(diffRecords(known, different), {});
  }
});

test("policy and actual mix roundtrip independently and suppress incompatible numeric comparisons", () => {
  const e = env();
  const jev = { backend: "jev", provider: "typesafe", model: "jev-latest" };
  const openai = { backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna" };
  const configuredPolicy = { waterfall: ["jev", "openai-decisions"], targets: [jev, openai], key: "full-chain" };
  const jevKey = JSON.stringify(Object.values(jev));
  const openaiKey = JSON.stringify(Object.values(openai));
  const a = record("mixed", { spend: 0.03, calls: 3, metrics: { score: 0.5 }, configuredPolicy,
    actualProviders: { [jevKey]: 2, [openaiKey]: 1 }, backendAttempts: { jev: 3, "openai-decisions": 1 }, registryCalls: 4 }, e);
  assert.deepEqual(last("mixed", 1, e)[0], a);
  assert.equal(a.classifier, undefined);
  const b = { ...a, spend: 0.06, calls: 6, actualProviders: { [openaiKey]: 2, [jevKey]: 4 } };
  assert.equal(comparisonWarning(a, b), undefined);
  assert.equal(diffRecords(a, b).calls, 3);
  for (const different of [
    { ...b, configuredPolicy: { waterfall: ["openai-decisions", "jev"], targets: [openai, jev] } },
    { ...b, configuredPolicy: { ...configuredPolicy, targets: [{ ...jev, model: "another" }, openai] } },
    { ...b, actualProviders: { [jevKey]: 1, [openaiKey]: 1 } },
    { ...b, actualProviders: undefined },
    { ...b, configuredPolicy: undefined },
  ]) {
    assert.match(comparisonWarning(a, different)!, /numeric comparison suppressed/u);
    assert.deepEqual(diffRecords(a, different), {});
  }
  // A reset key alone is not a different configured policy.
  assert.equal(comparisonWarning(a, { ...a, configuredPolicy: { ...configuredPolicy, key: "reset" } }), undefined);
  assert.deepEqual(diffRecords(a, { ...a, configuredPolicy: undefined, actualProviders: undefined, classifier: jev }), {});
});

test("evalParams keeps EVAL_* only and gitState answers", () => {
  assert.deepEqual(evalParams({ EVAL_B: "1", EVAL_A: "2", PATH: "x" }), { EVAL_A: "2", EVAL_B: "1" });
  assert.equal(typeof gitState().commit, "string");
});
