import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import rank, { SESSIONS } from "../eval/rank.target.ts";
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

const WANTS = SESSIONS.map((s) => s.want);
// Scores the piece that holds a wanted text 3 (the most likely to be copied), every other piece 0.
const wanted = (questions: Record<string, any>, state: Record<string, any>) =>
  Object.fromEntries(
    Object.keys(questions).map((id) => {
      const kind = id.slice(0, id.indexOf("::"));
      const piece = id.slice(id.indexOf("::") + 2);
      if (kind === "copyable") return [id, { type: "bool", probability: 0.9 }];
      const text = String(state.pieces[piece].text);
      return [id, { type: "score", score: WANTS.some((w) => text.includes(w)) ? 3 : 0, confidence: 0.9 }];
    }),
  );

function run(argv: string[], registry: unknown, withKey = true) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "rank-target-")) };
  const code = runEval(argv, { targets: [rank], env, hasCredentials: withKey, registry: async () => registry, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err, env };
}

describe("the rank eval target", () => {
  test("is registered as cases of pi-copy", () => {
    expect([rank.id, rank.package, rank.kind]).toEqual(["rank", "pi-copy", "cases"]);
  });

  test("plan counts one request per session, without Jev", async () => {
    const plan = await rank.plan({ sample: () => { throw new Error("no sessions"); }, compare: false, env: {}, log: () => undefined });
    expect(plan).toEqual({ calls: 5, notes: "5 sessions, one request each: 32 pieces and 41 questions in all" });
  });

  test("a live run makes the planned requests and passes when every wanted piece is in the top 3", async () => {
    const fake = fakeJev(wanted);
    const r = run(["rank"], fake.registry);
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(5);
    expect(r.out.join("\n")).toMatch(/the deploy command \(\d+ ms\): command:vercel deploy/u);
    expect(r.out.join("\n")).toMatch(/spend: \$0\.0050 over 5 calls/u);
    const [recorded] = last("rank", 1, r.env);
    expect(recorded).toMatchObject({ calls: 5, metrics: { sessions: 5, hits: 5, misses: 0, "hit.a-file-path": 1 } });
  });

  test("a session whose wanted piece is out of the top 3 is a miss and fails the target", async () => {
    // Every piece scored 0 and every prose piece judged not copyable: the wanted prose is filtered out.
    const fake = fakeJev((questions, state) => Object.fromEntries(Object.entries(wanted(questions, state)).map(([id, a]) => [id, id.startsWith("copyable::") ? { type: "bool", probability: 0.05 } : { ...(a as object), score: 0 }])));
    const r = run(["rank", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.targets.rank.pass).toBe(false);
    expect(result.targets.rank.metrics.misses).toBeGreaterThan(0);
    expect(r.err.join("\n")).toContain("misses:");
  });

  test("Jev calls that give no answer are counted as failures, and fail the target", async () => {
    const fake = fakeJev(() => ({ stopReason: "error", errorMessage: "boom" }));
    const r = run(["rank", "--json"], fake.registry);
    expect(await r.code).toBe(1);
    expect(JSON.parse(r.out.at(-1)!)).toMatchObject({ pass: false, targets: { rank: { pass: false, failures: 5, calls: 5 } } });
  });

  test("with no key it skips cleanly: exit 0, no request", async () => {
    const fake = fakeJev(wanted);
    expect(await run(["rank"], fake.registry, false).code).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });
});
