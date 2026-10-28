import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import replay from "../eval/replay.target.ts";
import { CURRENT, OLD, countCalls, fromSession } from "../eval/replay.ts";
import { last } from "../../../evals/shared/results.ts";
import { runEval } from "../../../evals/shared/runner.ts";
import type { Sample, SessionEntry } from "../../../evals/shared/sessions.ts";
import { answers, fakeJev, usage } from "./harness.ts";

const user = (text: string): SessionEntry => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string): SessionEntry => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const sample: Sample = {
  seed: 5,
  sessions: [{ file: "/sessions/2026-10-27T16-12-15-542Z_a.jsonl", cwd: "/Users/me/demo", entries: [user("Add caching"), assistant("Done; one test fails."), user("thanks!"), assistant("You're welcome."), user("now fix the test")] }],
};

// A Jev that bills a tenth of a cent per call, or fails every call.
const priced = () => fakeJev(() => ({ model: "jev-latest", stopReason: "stop" as const, answers: answers(2), usage: { ...usage(300), cost: { ...usage(300).cost, total: 0.001 } } }));
const failing = () => fakeJev(() => ({ model: "jev-latest", stopReason: "error" as const, answers: {}, errorMessage: "boom" }));

function run(argv: string[], registry: unknown, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const full = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "replay-target-")), ...env };
  const code = runEval(argv, { targets: [replay], env: full, hasCredentials: true, registry: async () => registry, sample: () => sample, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err, env: full };
}

describe("the replay eval target", () => {
  test("is registered as a replay of pi-auto-effort", () => {
    expect([replay.id, replay.package, replay.kind]).toEqual(["replay", "pi-auto-effort", "replay"]);
  });

  test("plan counts what the run would call, without Jev, and counts the old behaviour with compare", async () => {
    const sessions = sample.sessions.map(fromSession);
    const ctx = { sample: () => sample, compare: false, env: {}, log: () => undefined };
    expect(await replay.plan(ctx)).toEqual({ calls: countCalls(sessions, [CURRENT]), notes: "3 prompts, 1 settled by the pre-filter" });
    const compared = await replay.plan({ ...ctx, compare: true });
    expect(compared.calls).toBe(countCalls(sessions, [CURRENT, OLD]));
    expect(compared.notes).toContain("EVAL_COMPARE=1");
  });

  test("a live run through the runner: report, spend from the outcomes, one record with the metrics, exit 0", async () => {
    const fake = priced();
    const r = run(["replay"], fake.registry, { EVAL_COMPARE: "1" });
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(2 + 3);
    const text = r.out.join("\n");
    expect(text).toContain("auto-effort replay: EVAL_SEED=5, 1 sessions");
    expect(text).toMatch(/spend: \$0\.0050 over 5 calls/u);
    const [recorded] = last("replay", 1, r.env);
    expect(recorded).toMatchObject({ seed: 5, calls: 5, metrics: { sessions: 1, prompts: 3, settledByPrefilter: 1, jevCalls: 2, jevFailures: 0 }, compare: { jevCalls: 3, settledByPrefilter: 0 } });
    expect(recorded!.spend).toBeCloseTo(0.005);
  });

  test("fails, with the failures counted, when 20% or more of the Jev calls do not answer", async () => {
    const r = run(["replay", "--json"], failing().registry);
    expect(await r.code).toBe(1);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.targets.replay).toMatchObject({ pass: false, failures: 2, calls: 2 });
    expect(r.err.join("\n")).toContain("at or above the 20% limit");
  });
});
