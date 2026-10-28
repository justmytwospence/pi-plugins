import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { diff, diffRecords, evalParams, gitState, last, record, type ResultRecord } from "./results.ts";

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

test("evalParams keeps EVAL_* only and gitState answers", () => {
  assert.deepEqual(evalParams({ EVAL_B: "1", EVAL_A: "2", PATH: "x" }), { EVAL_A: "2", EVAL_B: "1" });
  assert.equal(typeof gitState().commit, "string");
});
