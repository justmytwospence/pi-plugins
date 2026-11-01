import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import vet from "../eval/vet.target.ts";
import { auc, buildCases, countRequests, isSuggestible, lowestReal, scoreTurns, summarize, turnsOf } from "../eval/vet.ts";
import type { JevOutcome, System1Attempt } from "../src/jev.ts";
import { Spend } from "../../../evals/shared/spend.ts";
import { last } from "../../../evals/shared/results.ts";
import { runEval } from "../../../evals/shared/runner.ts";
import type { Sample, Session, SessionEntry } from "../../../evals/shared/sessions.ts";
import { fakeJev, usage } from "./harness.ts";

// harness.ts installs a fresh temporary agent directory for each test.
afterEach(() => vi.restoreAllMocks());
const preferred = { backend: "jev", provider: "typesafe", model: "jev-latest" } as const;
const decisions = { backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna" } as const;

const user = (text: string): SessionEntry => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string): SessionEntry => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolOnly = (): SessionEntry => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: {} }] } });
const session = (name: string, entries: SessionEntry[]): Session => ({ file: `/sessions/${name}.jsonl`, cwd: "/x", entries });

const a = session("a", [user("Add caching"), assistant("Done; tests next."), user("run the tests"), assistant("All pass."), user("/model"), assistant("ok"), user("!ls"), assistant("listed"), user("ok"), assistant("x"), user("commit this change please")]);
const b = session("b", [user("Fix the build"), assistant("Fixed the import."), user("now update the changelog"), assistant("Updated."), user("push it")]);
const sample: Sample = { seed: 3, sessions: [a, b] };

describe("vet eval: selecting turns", () => {
  test("a suggestion is a short message that is not a command", () => {
    expect(["run the tests", "  now\n fix it  "].every(isSuggestible)).toBe(true);
    expect(["/model", "!ls", "ok", "", "x".repeat(301)].some(isSuggestible)).toBe(false);
  });

  test("turns pair the latest assistant text with the prompt it answered and the user's next message", () => {
    expect(turnsOf(a)).toEqual([
      { userPrompt: "Add caching", assistantTail: "Done; tests next.", next: "run the tests" },
      { userPrompt: "ok", assistantTail: "x", next: "commit this change please" },
    ]);
    // A final message with only a tool call is not vetted live (no suggestion), so it is no turn.
    expect(turnsOf(session("t", [user("go on"), assistant("Working."), toolOnly(), user("then run the tests")]))).toEqual([]);
  });

  test("each turn is a positive and a negative with another session's next message; the cap and seed are respected", () => {
    const cases = buildCases(sample.sessions, 3);
    expect(cases.candidates).toBe(4);
    expect(cases.positives.map((c) => c.suggestion).sort()).toEqual(["commit this change please", "now update the changelog", "push it", "run the tests"]);
    expect(cases.negatives).toHaveLength(4);
    for (const [i, negative] of cases.negatives.entries()) {
      const own = cases.positives[i]!;
      expect(negative).toMatchObject({ kind: "mismatch", userPrompt: own.userPrompt, assistantTail: own.assistantTail });
      expect(negative.file).toBe(own.file);
      const donor = cases.positives.find((p) => p.suggestion === negative.suggestion)!;
      expect(donor.file).not.toBe(own.file);
    }
    expect(countRequests(cases)).toBe(8);
    expect(buildCases(sample.sessions, 3)).toEqual(cases);
    const capped = buildCases(sample.sessions, 3, 1);
    expect(capped.positives).toHaveLength(2);
    expect(capped.negatives).toHaveLength(2);
  });

  test("a single session has no one to borrow a mismatch from", () => {
    const cases = buildCases([a], 3);
    expect(cases.positives).toHaveLength(2);
    expect(cases.negatives).toEqual([]);
  });
});

describe("vet eval: numbers", () => {
  test("auc counts ties half", () => {
    expect(auc([0.9, 0.8], [0.1, 0.2])).toBe(1);
    expect(auc([0.5], [0.5])).toBe(0.5);
    expect(auc([0.1], [0.9])).toBe(0);
    expect(auc([], [0.1])).toBeNaN();
  });

  test("summarize and lowestReal", () => {
    const c = (kind: "real" | "mismatch", suggestion: string, probability?: number) => ({ case: { kind, file: "f", turn: 0, userPrompt: "p", assistantTail: "t", suggestion }, ...(probability === undefined ? {} : { probability }) });
    const real = [c("real", "one", 0.9), c("real", "two", 0.3), c("real", "three")];
    const mismatch = [c("mismatch", "m", 0.1), c("mismatch", "n", 0.7)];
    expect(summarize(real, mismatch)).toMatchObject({ positives: 2, negatives: 2, passRateReal: 0.5, rejectRateMismatch: 0.5, separation: 0.75, jevFailures: 1 });
    expect(lowestReal(real).map((s) => s.case.suggestion)).toEqual(["two", "one"]);
  });
});

// A Jev that likes only the first session's messages: the other session's turns, given those as mismatches, pass.
const discerning = () => fakeJev((_q, state) => ({ useful: { type: "bool", probability: ["run the tests", "commit this change please"].includes(state.suggestion as string) ? 0.9 : 0.2 } }));
const priced = () => fakeJev(() => ({ model: "jev-latest", stopReason: "stop" as const, answers: { useful: { type: "bool", probability: 0.9 } }, usage: { ...usage(300), cost: { ...usage(300).cost, total: 0.001 } } }));
const failing = () => fakeJev(() => ({ model: "jev-latest", stopReason: "error" as const, answers: {}, errorMessage: "boom" }));

function run(argv: string[], registry: unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "vet-target-")) };
  const code = runEval(argv, { targets: [vet], env, hasCredentials: true, registry: async () => registry, sample: () => sample, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err, env };
}

describe("the vet eval target", () => {
  test("is registered as a replay of pi-next-prompt", () => {
    expect([vet.id, vet.package, vet.kind]).toEqual(["vet", "pi-next-prompt", "replay"]);
  });

  test("plan counts the requests without Jev", async () => {
    const plan = await vet.plan({ sample: () => sample, compare: false, env: {}, log: () => undefined });
    expect(plan.calls).toBe(countRequests(buildCases(sample.sessions, 3)));
    expect(plan.notes).toContain("4 real next messages and 4 mismatched");
  });

  test("a live run asks the vet's own state and question, records the numbers and spend, exit 0", async () => {
    const fake = priced();
    const r = run(["vet"], fake.registry);
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(8);
    expect(Object.keys(fake.calls[0]!.questions)).toEqual(["useful"]);
    expect(Object.keys(fake.calls[0]!.state).sort()).toEqual(["assistant_text_tail", "last_user_prompt", "suggestion"]);
    const text = r.out.join("\n");
    expect(text).toMatch(/spend: \$0\.0080 over 8 calls/u);
    expect(text).toContain("the 4 real next messages the vet scored lowest");
    const [recorded] = last("vet", 1, r.env);
    expect(recorded).toMatchObject({ seed: 3, calls: 8, metrics: { positives: 4, negatives: 4, passRateReal: 1, rejectRateMismatch: 0, separation: 0.5, jevFailures: 0 } });
  });

  test("separates real from mismatched messages when Jev does", async () => {
    const r = run(["vet", "--json"], discerning().registry);
    expect(await r.code).toBe(0);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.targets.vet.metrics).toMatchObject({ passRateReal: 0.5, rejectRateMismatch: 0.5, meanProbReal: 0.55 });
    expect(result.targets.vet.metrics.separation).toBe(0.5);
  });

  test.each([false, true])("retains the whole outcome and counts aggregate usage only once (exhausted=%s)", async (failed) => {
    const reported = { ...usage(300), cost: { ...usage(300).cost, total: 0.001 } };
    const attempts: System1Attempt[] = [
      { ...preferred, targetKey: "preferred", status: "failed", code: "quota_exhausted", reason: "quota or credits exhausted", sdkCalls: 1, latencyMs: 1, usage: reported },
      { ...decisions, targetKey: "fallback", status: failed ? "failed" : "succeeded", ...(failed ? { code: "timeout" as const, reason: "timed out" } : {}), sdkCalls: 1, latencyMs: 1, usage: reported },
    ];
    const aggregate = { ...reported, cost: { ...reported.cost, total: 0.002 } };
    const outcome: JevOutcome = failed
      ? { ok: false, code: "exhausted", reason: "all providers unavailable", attempts, latencyMs: 2, usage: aggregate, selectionKey: "chain" }
      : { ok: true, answers: { useful: { type: "bool", probability: 0.9 } }, ...decisions, waterfall: ["jev", "openai-decisions"], selectionKey: "chain", targetKey: "fallback", fallback: true, attempts, latencyMs: 2, usage: aggregate };
    const add = vi.spyOn(Spend.prototype, "addOutcome");
    const item = buildCases(sample.sessions, 3).positives[0]!;
    const result = await scoreTurns({}, [item], { concurrency: 1, timeoutMs: 1000, ask: async () => outcome });
    expect(add).toHaveBeenCalledExactlyOnceWith(outcome);
    expect(add.mock.calls[0]![0]).toBe(outcome);
    expect(result.scored[0]!.outcome).toBe(outcome);
    expect(result.scored[0]!.outcome!.attempts).toBe(attempts);
    expect(result.spend.calls).toBe(1);
    expect(result.spend.total).toBeCloseTo(0.002);
    expect(result.spend.backendAttempts).toEqual({ jev: 1, "openai-decisions": 1 });
    expect(result.spend.registryCalls).toBe(2);
    expect(result.spend.attempts).toMatchObject(attempts);
    expect(result.spend.attempts.every((attempt) => !("error" in attempt))).toBe(true);
    expect(result.spend.actualProviders).toEqual(failed ? {} : { [JSON.stringify([decisions.backend, decisions.provider, decisions.model])]: 1 });
    expect(result.failures).toBe(Number(failed));
    expect(result.scored[0]!.probability).toBe(failed ? undefined : 0.9);
  });

  test("a configured waterfall retains actual fallback provenance and failed-attempt usage", async () => {
    writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR!, "system1.json"), JSON.stringify({ waterfall: ["jev", "openai-decisions"] }));
    const reported = { ...usage(300), cost: { ...usage(300).cost, total: 0.001 } };
    const models: string[] = [];
    const registry = {
      findOfType: (_type: string, provider: string, id: string) => ({ provider, id, type: "classifier", api: provider === decisions.provider ? "openai-decisions" : "typesafe", baseUrl: "https://api.openai.com/v1" }),
      classify: async (model: { provider: string }) => {
        models.push(model.provider);
        return model.provider === preferred.provider
          ? { stopReason: "error", errorMessage: "quota exhausted", answers: {}, usage: reported }
          : { stopReason: "stop", answers: { useful: { type: "bool", probability: 0.9 } }, usage: reported };
      },
    };
    const item = buildCases(sample.sessions, 3).positives[0]!;
    const result = await scoreTurns(registry, [item], { concurrency: 1, timeoutMs: 1000 });
    expect(models).toEqual([preferred.provider, decisions.provider]);
    expect(result.scored[0]!.outcome).toMatchObject({
      ok: true, ...decisions, waterfall: ["jev", "openai-decisions"], fallback: true,
      attempts: [
        { ...preferred, status: "failed", code: "quota_exhausted", sdkCalls: 1, usage: reported },
        { ...decisions, status: "succeeded", sdkCalls: 1, usage: reported },
      ],
    });
    expect(result.failures).toBe(0);
    expect(result.spend.calls).toBe(1);
    expect(result.spend.total).toBeCloseTo(0.002);
  });

  test("fails when 20% or more of the requests do not answer", async () => {
    const r = run(["vet", "--json"], failing().registry);
    expect(await r.code).toBe(1);
    expect(JSON.parse(r.out.at(-1)!).targets.vet).toMatchObject({ pass: false, failures: 8, calls: 8 });
  });
});
