import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import routing, { AVAILABLE, CASES, scoreCase } from "../eval/routing.target.ts";
import { last } from "../../../evals/shared/results.ts";
import { runEval } from "../../../evals/shared/runner.ts";
import type { Resolved, TierConfig } from "../src/pick.ts";

const usage = { input: 300, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
const suffix = (role: string, task: string) => CASES.find((c) => c.role === role && c.task === task)?.id.split("-").at(-1);
const expected = (role: string, task: string): [string, string] => {
  switch (suffix(role, task)) {
    case "lookup": case "mechanical": return ["fast", "low"];
    case "specified": return ["balanced", "medium"];
    case "docs": return ["balanced", "medium"];
    default: return ["strong", "high"];
  }
};
function fakeJev(answer: (questions: Record<string, any>, state: Record<string, any>) => [string, string] | "timeout" | "error" = (q, s) => expected(s.role, s.task)) {
  const calls: Array<{ questions: Record<string, any>; state: Record<string, any> }> = [];
  const registry = {
    findOfType: (type: string, provider: string, id: string) => {
      if (type !== "classifier") throw new Error("chat model was requested");
      return { provider, id };
    },
    classify: async (_model: unknown, { questions, state }: { questions: Record<string, any>; state: Record<string, any> }) => {
      calls.push({ questions, state });
      const decision = answer(questions, state);
      if (typeof decision === "string") return { model: "jev-latest", answers: {}, stopReason: "error", errorMessage: decision === "timeout" ? "timed out" : "other error", ...(decision === "error" ? { usage } : {}) };
      const [tier, effort] = decision;
      const chosen = (id: string, key: string) => ({ type: "choice", choice: key, confidence: 0.99, probabilities: Object.fromEntries(Object.keys(questions[id].criteria).map((k) => [k, k === key ? 0.99 : 0])) });
      return { model: "jev-latest", stopReason: "stop", answers: { tier: chosen("tier", tier), effort: chosen("effort", effort) }, usage };
    },
  };
  return { registry, calls };
}
function run(argv: string[], registry: unknown, overrides: Record<string, string> = {}, withKey = true) {
  const out: string[] = [], err: string[] = [];
  const env = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "routing-target-")), ...overrides };
  const code = runEval(argv, { targets: [routing], env, hasCredentials: withKey, registry: async () => registry,
    io: { out: (line) => out.push(line), err: (line) => err.push(line) } });
  return { code, out, err, env };
}
const fixture = (id: string) => CASES.find((c) => c.id === id)!;
const tiers: TierConfig = { models: { fast: "m/spark", balanced: "m/spark", strong: "m/wonder" }, descriptions: {} as TierConfig["descriptions"] };
const resolved = (tier: Resolved["tier"], thinking: string, model: string): Resolved => ({
  tier, thinking, model, agent: { name: "worker", description: "", prompt: "", source: "builtin" },
  byJev: { agent: false, model: true, thinking: true }, source: { model: "tier", thinking: "jev" },
});

describe("the bounded routing eval target", () => {
  test("contains 24 stable cases crossed with the four parent families", () => {
    expect([routing.id, routing.package, routing.kind, routing.title]).toEqual(["routing", "pi-subagents", "cases", "Task-calibrated subagent model and effort selection"]);
    expect(CASES.map((c) => c.id)).toEqual(["anthropic", "openai", "google", "muse"].flatMap((p) =>
      ["lookup", "mechanical", "specified", "docs", "debug", "design"].map((s) => `${p}-${s}`)));
    expect(CASES.every((c) => c.parent.thinking === "xhigh")).toBe(true);
    expect(AVAILABLE.every((m) => m.type === "chat" && m.api !== "pi-virtual")).toBe(true);
  });

  test("default dry plan counts 72 requests without touching Jev", async () => {
    const fake = fakeJev();
    const r = run(["routing", "--dry", "--json"], fake.registry);
    expect(await r.code).toBe(0);
    expect(JSON.parse(r.out[0]!).targets.routing).toMatchObject({ calls: 72 });
    expect(fake.calls).toHaveLength(0);
  });

  test("exact case filtering and integer repeats are validated before calls", async () => {
    const fake = fakeJev();
    const ids = "muse-docs,anthropic-debug";
    expect((await routing.plan({ env: { EVAL_ROUTING_CASE_IDS: ids, EVAL_ROUTING_REPEATS: "2" }, sample: () => { throw Error("no sample"); }, compare: false, log: () => {} })).calls).toBe(4);
    for (const env of [{ EVAL_ROUTING_REPEATS: "0" }, { EVAL_ROUTING_REPEATS: "4" }, { EVAL_ROUTING_REPEATS: "1.5" }, { EVAL_ROUTING_REPEATS: "foo" },
      { EVAL_ROUTING_CASE_IDS: "" }, { EVAL_ROUTING_CASE_IDS: "unknown" }, { EVAL_ROUTING_CASE_IDS: "muse-docs," }, { EVAL_ROUTING_CASE_IDS: "muse-docs,muse-docs" }] as Array<Record<string, string>>) {
      const r = run(["routing", "--dry", "--json"], fake.registry, env);
      expect(await r.code).toBe(1);
      expect(JSON.parse(r.out[0]!).targets.routing.error).toBeTruthy();
    }
    expect(fake.calls).toHaveLength(0);
    const invalid = run(["routing", "--json"], fake.registry, { EVAL_ROUTING_CASE_IDS: "unknown" });
    expect(await invalid.code).toBe(1);
    expect(fake.calls).toHaveLength(0);
    const r = run(["routing", "--json"], fake.registry, { EVAL_ROUTING_CASE_IDS: ids, EVAL_ROUTING_REPEATS: "2" });
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(4);
  });

  test("without credentials no requests are made and no success is claimed", async () => {
    const fake = fakeJev();
    const r = run(["routing", "--json"], fake.registry, {}, false);
    expect(await r.code).toBe(0);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ skipped: true, targets: {} });
    expect(fake.calls).toHaveLength(0);
  });

  test("all expected selections pass with exact usage, report and recorded metrics; only classifier models are called", async () => {
    const fake = fakeJev();
    const r = run(["routing", "--json"], fake.registry, { EVAL_ROUTING_REPEATS: "1" });
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(24);
    expect(fake.calls.every(({ questions, state }) => Object.keys(questions).join() === "tier,effort" && state.parent_request.includes("This child owns only the delegated task.") && state.role)).toBe(true);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.spend).toBeCloseTo(0.024);
    expect(result).toMatchObject({ calls: 24, targets: { routing: { pass: true, calls: 24, metrics: { calls: 24, failures: 0, tierAccuracy: 1, effortAccuracy: 1, jointAccuracy: 1, hardTaskAccuracy: 1, overEscalations: 0, underEscalations: 0 } } } });
    expect(r.err.join("\n")).toMatch(/anthropic-lookup #1: fast\/low anthropic\/claude-haiku-5-5; answers fast\(0\.99\)\/low\(0\.99\); OK/u);
    expect(r.err.join("\n")).toContain("spend: $0.0240 over 24 calls");
    expect(last("routing", 1, r.env)[0]).toMatchObject({ calls: 24, metrics: { calls: 24, jointAccuracy: 1, hardTaskAccuracy: 1 } });
    expect(last("routing", 1, r.env)[0]!.spend).toBeCloseTo(0.024);
  });

  test("routine premium or xhigh overshoot fails; independent tier/effort misses are reported", async () => {
    const fake = fakeJev((_q, state) => state.role === "explorer" ? ["premium", "xhigh"] as [string, string] : expected(state.role, state.task));
    const r = run(["routing", "--json"], fake.registry, { EVAL_ROUTING_REPEATS: "1" });
    expect(await r.code).toBe(1);
    const result = JSON.parse(r.out.at(-1)!).targets.routing;
    expect(result.metrics.overEscalations).toBeGreaterThan(0);
    expect(result.metrics.jointAccuracy).toBeLessThan(1);
    expect(r.err.join("\n")).toContain("MISS tier=false effort=false");
    const caseData = fixture("anthropic-lookup");
    expect(scoreCase(caseData, resolved("fast", "xhigh", "m/spark"), { ...tiers, models: { fast: "m/spark", balanced: "m/spark", premium: "m/fable" } })).toMatchObject({ tierOK: true, effortOK: false, jointOK: false, overEscalated: true });
  });

  test("hard fast/balanced underselection fails, even with high effort", async () => {
    const fake = fakeJev((_q, state) => state.task.includes("stale-owner race") || state.task.includes("cross-process recovery") ? ["balanced", "high"] as [string, string] : expected(state.role, state.task));
    const r = run(["routing", "--json"], fake.registry, { EVAL_ROUTING_REPEATS: "1" });
    expect(await r.code).toBe(1);
    expect(JSON.parse(r.out.at(-1)!).targets.routing.metrics).toMatchObject({ underEscalations: 8, hardTaskAccuracy: 0 });
  });

  test("two tier labels for one physical Spark/Flash model are equivalent, but effort is independent", () => {
    expect(scoreCase(fixture("muse-lookup"), resolved("fast", "low", "m/spark"), tiers)).toMatchObject({ tierOK: true, effortOK: true, jointOK: true });
    expect(scoreCase(fixture("muse-specified"), resolved("fast", "medium", "m/spark"), tiers)).toMatchObject({ tierOK: true, effortOK: true, jointOK: true });
    expect(scoreCase(fixture("muse-specified"), resolved("fast", "low", "m/spark"), tiers)).toMatchObject({ tierOK: true, effortOK: false, jointOK: false });
    expect(scoreCase(fixture("muse-debug"), { error: "cannot resolve" }, tiers)).toMatchObject({ tierOK: false, effortOK: false, jointOK: false });
  });

  test("a failed request with reported usage is counted without treating its selection as correct", async () => {
    const fake = fakeJev(() => "error");
    const r = run(["routing", "--json"], fake.registry, { EVAL_ROUTING_CASE_IDS: "muse-lookup", EVAL_ROUTING_REPEATS: "1" });
    expect(await r.code).toBe(1);
    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(r.out.at(-1)!)).toMatchObject({ calls: 1, spend: 0.001, targets: { routing: { failures: 1, metrics: { calls: 1, failures: 1, jointAccuracy: 0 } } } });
  });

  test("a failed Jev request is a miss; no unreported timeout charge is invented and no retry is made", async () => {
    const fake = fakeJev((_q, state) => state.task.includes("resolveProviderFlow") ? "timeout" : expected(state.role, state.task));
    const r = run(["routing", "--json"], fake.registry, { EVAL_ROUTING_REPEATS: "1" });
    expect(await r.code).toBe(1);
    expect(fake.calls).toHaveLength(24);
    const result = JSON.parse(r.out.at(-1)!);
    expect(result.spend).toBeCloseTo(0.020);
    expect(result).toMatchObject({ calls: 24, targets: { routing: { pass: false, failures: 4, metrics: { calls: 24, failures: 4, tierAccuracy: 20 / 24, effortAccuracy: 20 / 24, jointAccuracy: 20 / 24 } } } });
    expect(r.err.join("\n")).toContain("anthropic-lookup #1: FAILED timed out (tier/effort/joint miss)");
    expect(last("routing", 1, r.env)[0]).toMatchObject({ calls: 24 });
    expect(last("routing", 1, r.env)[0]!.spend).toBeCloseTo(0.020);
  });
});
