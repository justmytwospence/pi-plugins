import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import lean, { CASES } from "../eval/lean.target.ts";
import { last } from "../../../evals/shared/results.ts";
import { runEval } from "../../../evals/shared/runner.ts";

// A Jev that bills a tenth of a cent per call. `answer` gets the questions and the state of each request.
const usage = { input: 300, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
function fakeJev(answer: (questions: Record<string, any>, state: Record<string, any>) => Record<string, unknown> | { stopReason: "error"; errorMessage: string }) {
  const calls: number[] = [];
  const registry = {
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id }),
    classify: async (_model: unknown, context: { questions: Record<string, any>; state: Record<string, any> }) => {
      calls.push(Object.keys(context.questions).length);
      const result = answer(context.questions, context.state);
      if ("stopReason" in result) return { model: "jev-latest", ...result };
      return { model: "jev-latest", stopReason: "stop", answers: result, usage };
    },
  };
  return { calls, registry };
}

// Keeps the blocks that carry a failure, drops the rest, and answers the compaction as the check expects.
const FAILURE = /error|fail|assert|panic|ERR!|TS\d|E0\d|Found \d|could not|ERESOLVE|peer |relation|exit code|index out|export const|1 problem|main\.rs|users_email|Can't resolve/iu;
const good = (questions: Record<string, any>, state: Record<string, any>) =>
  Object.fromEntries(
    Object.keys(questions).map((id) => {
      if (id === "needs_all") return [id, { type: "bool", probability: 0.05 }];
      if (id.startsWith("block::")) return [id, { type: "bool", probability: FAILURE.test(state.output[id.slice("block::".length)]) ? 0.9 : 0.05 }];
      const unit = id.slice("keep::".length);
      return [id, { type: "choice", choice: unit === "U001" || unit === "U004" ? "verbatim" : "drop", probabilities: {}, confidence: 0.9 }];
    }),
  );

function run(argv: string[], registry: unknown, env: Record<string, string> = {}, credentials = true) {
  const out: string[] = [];
  const err: string[] = [];
  const full = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "lean-target-")), ...env };
  const code = runEval(argv, { targets: [lean], env: full, hasCredentials: credentials, registry: async () => registry, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err, env: full };
}

describe("the lean eval target", () => {
  test("is registered as cases of pi-cache-guard", () => {
    expect([lean.id, lean.package, lean.kind]).toEqual(["lean", "pi-cache-guard", "cases"]);
  });

  test("plan counts the requests, one per trim and one for the compaction, without Jev", async () => {
    const plan = await lean.plan({ sample: () => { throw new Error("no sessions"); }, compare: false, env: {}, log: () => undefined });
    expect(plan.calls).toBe(CASES.length + 1);
    expect(plan.notes).toMatch(/^10 trims \(1376 questions in all/u);
    expect(plan.notes).toMatch(/1 compaction \(4 questions\)$/u);
  });

  test("a live run makes exactly the planned requests and passes when every check holds", async () => {
    const fake = fakeJev(good);
    const r = run(["lean"], fake.registry);
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(11);
    const text = r.out.join("\n");
    expect(text).toMatch(/vitest with one failure: kept \d+\/1\d+ lines/u);
    expect(text).toMatch(/^compaction: \{"U001":"verbatim"/mu);
    expect(text).not.toContain("misses:");
    expect(text).toMatch(/spend: \$0\.0110 over 11 calls/u);
    const [recorded] = last("lean", 1, r.env);
    expect(recorded).toMatchObject({ calls: 11, metrics: { cases: 10, misses: 0, mustKeepFound: 24, mustKeepTotal: 24, compactionHits: 3 } });
    expect(recorded!.metrics["keptShare.vitest-with-one-failure"]).toBeLessThanOrEqual(0.7);
  });

  test("a trim that loses a required line, or keeps too much, is a miss and fails the target", async () => {
    // Every block judged unneeded: the trims keep only the head and the tail, and the compaction stays right.
    const fake = fakeJev((questions, state) => Object.fromEntries(Object.entries(good(questions, state)).map(([id, a]) => [id, id.startsWith("block::") ? { type: "bool", probability: 0.05 } : a])));
    const r = run(["lean", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.targets.lean.pass).toBe(false);
    expect(result.targets.lean.metrics.misses).toBeGreaterThan(0);
    expect(r.err.join("\n")).toContain("vitest with one failure: trimmed output lost \"AssertionError: expected 1 to be 3\"");
    expect(r.err.join("\n")).not.toContain("compaction: U001");
  });

  test("Jev calls that give no answer are counted as failures, and fail the target", async () => {
    const fake = fakeJev(() => ({ stopReason: "error", errorMessage: "boom" }));
    const r = run(["lean", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result).toMatchObject({ pass: false, targets: { lean: { pass: false, failures: 11, calls: 11 } } });
  });

  test("without credentials it skips cleanly: exit 0, no request", async () => {
    const fake = fakeJev(good);
    const r = run(["lean"], fake.registry, {}, false);
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(0);
    expect(r.out.join("\n")).toContain("skipped: TYPESAFE_API_KEY is not set");
  });
});
