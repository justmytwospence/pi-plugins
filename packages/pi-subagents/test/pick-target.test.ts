import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import pick, { CASES } from "../eval/pick.target.ts";
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

const choiceAnswer = (best: string, keys: string[]) => ({
  type: "choice",
  choice: best,
  probabilities: Object.fromEntries(keys.map((k) => [k, k === best ? 0.9 : 0.05])),
  confidence: 0.9,
});

// The role the case was written for; the tier and the effort are the middle options.
const routed = (questions: Record<string, any>, state: Record<string, any>, roleOf: (task: string) => string) =>
  Object.fromEntries(
    Object.entries(questions).map(([id, q]) => {
      const keys = Object.keys(q.criteria);
      const best = id === "role" ? roleOf(state.task) : id === "tier" ? "balanced" : "medium";
      return [id, choiceAnswer(best, keys)];
    }),
  );

const expected = (task: string) => CASES.find((c) => c.task === task)?.role ?? "general";

function run(argv: string[], registry: unknown, withKey = true) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "pick-target-")) };
  const code = runEval(argv, { targets: [pick], env, hasCredentials: withKey, registry: async () => registry, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err, env };
}

describe("the pick eval target", () => {
  test("is registered as cases of pi-subagents", () => {
    expect([pick.id, pick.package, pick.kind]).toEqual(["pick", "pi-subagents", "cases"]);
  });

  test("plan counts one request per task, with the three questions, without Jev", async () => {
    const plan = await pick.plan({ sample: () => { throw new Error("no sessions"); }, compare: false, env: {}, log: () => undefined });
    expect(plan).toEqual({ calls: 15, notes: "15 tasks, one request each with 3 questions (role, tier, effort)" });
  });

  test("a live run makes the planned requests and passes when every task gets its role", async () => {
    const fake = fakeJev((questions, state) => routed(questions, state, expected));
    const r = run(["pick"], fake.registry);
    expect(await r.code).toBe(0);
    expect(fake.calls).toEqual(Array(15).fill(3));
    expect(r.out.join("\n")).toMatch(/^scout\s+got scout\s+conf 0\.90 tier balanced effort medium/mu);
    expect(r.out.join("\n")).toMatch(/spend: \$0\.0150 over 15 calls/u);
    const [recorded] = last("pick", 1, r.env);
    expect(recorded).toMatchObject({ calls: 15, metrics: { cases: 15, correct: 15, accuracy: 1, misses: 0, "correct.01-scout": 1 } });
  });

  test("a task routed to the wrong agent is a miss and fails the target", async () => {
    const fake = fakeJev((questions, state) => routed(questions, state, () => "scout"));
    const r = run(["pick", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.targets.pick).toMatchObject({ pass: false, metrics: { correct: 3, misses: 12 } });
    expect(r.err.join("\n")).toContain("expected planner, got scout: Write a step-by-step implementation plan");
  });

  test("Jev calls that give no answer are counted as failures, and fail the target", async () => {
    const fake = fakeJev(() => ({ stopReason: "error", errorMessage: "boom" }));
    const r = run(["pick", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    expect(JSON.parse(r.out.at(-1)!)).toMatchObject({ pass: false, targets: { pick: { pass: false, failures: 15, calls: 15 } } });
  });

  test("with no key it skips cleanly: exit 0, no request", async () => {
    const fake = fakeJev((questions, state) => routed(questions, state, expected));
    expect(await run(["pick"], fake.registry, false).code).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});
