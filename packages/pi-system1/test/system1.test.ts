import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addClassifierUsage,
  agentDir,
  askSystem1,
  bool,
  choice,
  getSystem1RoutingKey,
  provenanceOf,
  readSystem1Setting,
  resetSystem1Runtime,
  resolveSystem1Route,
  resolveSystem1Target,
  score,
  system1Path,
  system1TargetKey,
  type ClassifierConfig,
  type ClassifierQuestion,
  type ClassifierRegistry,
  type ClassifierResult,
  type ClassifierUsage,
  type System1Backend,
  type System1FailureCode,
  type System1Notice,
} from "../src/system1.ts";

const config: ClassifierConfig = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 100 };
const questions: Record<string, ClassifierQuestion> = {
  q: { type: "bool", instructions: "Is this supported?", criteria: { true: "supported", false: "not supported" } },
};
const choiceQuestions: Record<string, ClassifierQuestion> = {
  q: { type: "choice", instructions: "Choose", criteria: { a: "A", b: "B" } },
};
const scoreQuestions: Record<string, ClassifierQuestion> = {
  q: { type: "score", instructions: "Score", criteria: ["low", "middle", "high"] },
};
const usage: ClassifierUsage = {
  input: 10,
  output: 2,
  cacheRead: 1,
  cacheWrite: 0,
  totalTokens: 13,
  cost: { input: 0.1, output: 0.02, cacheRead: 0.01, cacheWrite: 0, total: 0.13 },
};
const jevTarget = { backend: "jev" as const, provider: "typesafe", model: "jev-latest" };
const openaiTarget = { backend: "openai-decisions" as const, provider: "system1-openai", model: "gpt-6-luna" };
const nativeModel = {
  type: "classifier",
  id: "gpt-6-luna",
  provider: "system1-openai",
  api: "openai-decisions",
  baseUrl: "https://api.openai.com/v1",
};
const orders: System1Backend[][] = [
  ["jev", "openai-decisions"],
  ["openai-decisions", "jev"],
];
const result = (
  answers: ClassifierResult["answers"] = { q: { type: "bool", probability: 0.8 } },
): ClassifierResult => ({ model: "wire-model", answers, stopReason: "stop", usage });
const failed = (errorMessage: string): ClassifierResult => ({ ...result(), stopReason: "error", errorMessage });
const manyQuestions = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, questions.q]));
const boolAnswers = (qs: Record<string, ClassifierQuestion>, probability = 0.7): ClassifierResult["answers"] =>
  Object.fromEntries(Object.keys(qs).map((id) => [id, { type: "bool", probability }]));
function fake(run: ClassifierRegistry["classify"] = async () => result()) {
  const finds: unknown[][] = [];
  const calls: Parameters<ClassifierRegistry["classify"]>[] = [];
  const registry: ClassifierRegistry = {
    findOfType(...args) {
      finds.push(args);
      return args[1] === "system1-openai" ? nativeModel : { id: args[2], provider: args[1] };
    },
    classify(...args) {
      calls.push(args);
      return run(...args);
    },
  };
  return { registry, finds, calls };
}
const calledProviders = (calls: Parameters<ClassifierRegistry["classify"]>[]) =>
  calls.map((call) => (call[0] as { provider: string }).provider);
let dir: string;
let previous: string | undefined;
function select(backend: System1Backend) {
  writeFileSync(system1Path(), JSON.stringify({ backend }));
}
function order(waterfall: readonly System1Backend[]) {
  writeFileSync(system1Path(), JSON.stringify({ waterfall, backend: waterfall[0] }));
}
beforeEach(() => {
  previous = process.env.PI_CODING_AGENT_DIR;
  dir = mkdtempSync(path.join(tmpdir(), "system1-test-"));
  process.env.PI_CODING_AGENT_DIR = dir;
});
afterEach(() => {
  vi.useRealTimers();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});

describe("global selection", () => {
  it("defaults only a missing agent file to Jev and honors the agent directory", () => {
    expect(agentDir()).toBe(dir);
    expect(system1Path()).toBe(path.join(dir, "system1.json"));
    expect(readSystem1Setting()).toEqual({ ok: true, waterfall: ["jev"], key: JSON.stringify(["jev"]), legacy: false });
    expect(resolveSystem1Target(config)).toEqual({ ok: true, ...jevTarget, key: system1TargetKey(jevTarget) });
  });
  it.each(["jev", "openai-decisions"] as const)(
    "migrates legacy %s to a singleton without changing its effective key",
    (backend) => {
      select(backend);
      const legacy = readSystem1Setting();
      const target = resolveSystem1Target(config);
      expect(legacy).toEqual({ ok: true, waterfall: [backend], key: JSON.stringify([backend]), legacy: true });
      order([backend]);
      expect(readSystem1Setting()).toEqual({ ...legacy, legacy: false });
      expect(resolveSystem1Target(config)).toEqual(target);
    },
  );
  it("overrides the caller's legacy target only for Decisions and ignores future setting keys", () => {
    writeFileSync(system1Path(), JSON.stringify({ backend: "openai-decisions", future: 42 }));
    expect(resolveSystem1Target({ provider: "legacy", model: "old" })).toEqual({
      ok: true,
      ...openaiTarget,
      key: system1TargetKey(openaiTarget),
    });
    select("jev");
    expect(resolveSystem1Target({ provider: "legacy", model: "old" })).toMatchObject({
      backend: "jev",
      provider: "legacy",
      model: "old",
    });
  });
  for (const waterfall of orders)
    it(`resolves ${waterfall.join(" → ")} in order with full-chain freshness and separate physical keys`, () => {
      order(waterfall);
      const targets = waterfall.map((backend) => (backend === "jev" ? jevTarget : openaiTarget));
      const key = JSON.stringify(["waterfall", targets.map((t) => [t.backend, t.provider, t.model]), 0]);
      expect(readSystem1Setting()).toEqual({ ok: true, waterfall, key: JSON.stringify(waterfall), legacy: false });
      expect(resolveSystem1Route(config)).toEqual({ ok: true, waterfall, targets, key });
      expect(resolveSystem1Target(config)).toEqual({ ok: true, ...targets[0], key });
      expect(key).not.toBe(system1TargetKey(targets[0]));
      expect(getSystem1RoutingKey({}, config)).toBe(JSON.stringify([key, system1TargetKey(targets[0])]));
    });
  it("makes waterfall authoritative over the deprecated backend mirror", () => {
    writeFileSync(
      system1Path(),
      JSON.stringify({ waterfall: ["openai-decisions", "jev"], backend: "jev", future: true }),
    );
    expect(readSystem1Setting()).toMatchObject({ ok: true, waterfall: ["openai-decisions", "jev"], legacy: false });
    expect(resolveSystem1Target(config)).toMatchObject(openaiTarget);
    writeFileSync(system1Path(), JSON.stringify({ waterfall: ["jev"], backend: "not-supported" }));
    expect(readSystem1Setting()).toMatchObject({ ok: true, waterfall: ["jev"] });
  });
  it.each([
    "{",
    "null",
    "[]",
    "{}",
    '{"backend":"other"}',
    '{"backend":42}',
    ...[
      null,
      [],
      "jev",
      ["other"],
      ["jev", "jev"],
      ["openai-decisions", "openai-decisions"],
      ["jev", 42],
      ["jev", "openai-decisions", "jev"],
    ].map((waterfall) => JSON.stringify({ waterfall, backend: "jev" })),
  ])("fails closed on broken setting %s even with a valid legacy mirror", (raw) => {
    writeFileSync(system1Path(), raw);
    expect(readSystem1Setting().ok).toBe(false);
    expect(resolveSystem1Target(config).ok).toBe(false);
    expect(resolveSystem1Route(config).ok).toBe(false);
  });
  it("does not replace an unreadable existing file with Jev", () => {
    mkdirSync(system1Path());
    expect(readSystem1Setting()).toMatchObject({ ok: false, reason: "System 1 configuration is unreadable" });
  });
  it("does not read project configuration", () => {
    const project = path.join(dir, ".pi");
    mkdirSync(project);
    writeFileSync(path.join(project, "system1.json"), '{"backend":"openai-decisions"}');
    expect(readSystem1Setting()).toMatchObject({ ok: true, waterfall: ["jev"] });
  });
  it("manual reset changes chain identity but not file-policy or physical target identity", () => {
    const setting = readSystem1Setting();
    const before = resolveSystem1Target(config);
    resetSystem1Runtime({});
    expect(readSystem1Setting()).toEqual(setting);
    expect(resolveSystem1Target(config).key).not.toBe(before.key);
    expect(resolveSystem1Target(config)).toMatchObject(jevTarget);
    expect(system1TargetKey(jevTarget)).toBe(JSON.stringify(["jev", "typesafe", "jev-latest"]));
  });
});

describe("input validation and provenance", () => {
  it("disabled, empty and invalid-setting requests do not touch a registry or emit failover notices", async () => {
    writeFileSync(system1Path(), "broken");
    const { registry, finds, calls } = fake();
    const onNotice = vi.fn();
    expect(
      await askSystem1(registry, { ...config, enabled: false }, {}, questions, undefined, { onNotice }),
    ).toMatchObject({ ok: false, code: "disabled", reason: "the classifier is off in settings", attempts: [] });
    expect(await askSystem1(registry, config, {}, {}, undefined, { onNotice })).toMatchObject({
      ok: false,
      code: "invalid_input",
      attempts: [],
    });
    expect(await askSystem1(registry, config, {}, questions, undefined, { onNotice })).toMatchObject({
      ok: false,
      code: "invalid_input",
      attempts: [],
    });
    expect(finds).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(onNotice).not.toHaveBeenCalled();
  });
  it.each([null, [], "state", 42])("rejects invalid state %j before lookup under either order", async (state) => {
    for (const waterfall of orders) {
      order(waterfall);
      const { registry, finds, calls } = fake();
      const onNotice = vi.fn();
      expect(
        await askSystem1(registry, config, state as unknown as Record<string, unknown>, questions, undefined, {
          onNotice,
        }),
      ).toMatchObject({ ok: false, code: "invalid_input", attempts: [] });
      expect(finds).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(onNotice).not.toHaveBeenCalled();
    }
  });
  it.each([
    null,
    [],
    {},
    { q: null },
    { q: { type: "box", instructions: "unsupported" } },
    { q: { type: "bool", instructions: 42, criteria: { true: "yes", false: "no" } } },
    { q: { type: "bool", instructions: "judge", criteria: { true: "yes" } } },
    { q: { type: "choice", instructions: "judge", criteria: {} } },
    { q: { type: "choice", instructions: "judge", criteria: { a: 1 } } },
    { q: { type: "score", instructions: "judge", criteria: [] } },
    { q: { type: "score", instructions: "judge", criteria: ["low", 1] } },
  ])("rejects invalid questions %j before lookup under either order", async (qs) => {
    for (const waterfall of orders) {
      order(waterfall);
      const { registry, finds, calls } = fake();
      const onNotice = vi.fn();
      expect(
        await askSystem1(registry, config, {}, qs as unknown as Record<string, ClassifierQuestion>, undefined, {
          onNotice,
        }),
      ).toMatchObject({ ok: false, code: "invalid_input", attempts: [] });
      expect(finds).toHaveLength(0);
      expect(calls).toHaveLength(0);
      expect(onNotice).not.toHaveBeenCalled();
    }
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid total timeout %s before lookup", async (timeoutMs) => {
    const { registry, finds, calls } = fake();
    expect(await askSystem1(registry, { ...config, timeoutMs }, {}, questions)).toMatchObject({
      ok: false,
      code: "invalid_input",
      attempts: [],
    });
    expect(finds).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
  it("validates every question before the first native batch or Jev lookup", async () => {
    const qs = manyQuestions(401);
    qs.q400 = { type: "box" } as unknown as ClassifierQuestion;
    for (const waterfall of orders) {
      order(waterfall);
      const { registry, calls, finds } = fake();
      expect(await askSystem1(registry, config, {}, qs)).toMatchObject({
        ok: false,
        code: "invalid_input",
        attempts: [],
      });
      expect(calls).toHaveLength(0);
      expect(finds).toHaveLength(0);
    }
  });
  it.each(["jev", "openai-decisions"] as const)(
    "uses only classifier lookup and reports actual %s provenance",
    async (backend) => {
      select(backend);
      const { registry, finds, calls } = fake();
      const state = { evidence: "provided" };
      const answer = await askSystem1(registry, config, state, questions);
      const target = backend === "jev" ? jevTarget : openaiTarget;
      expect(answer).toMatchObject({
        ok: true,
        ...target,
        model: backend === "jev" ? "wire-model" : target.model,
        waterfall: [backend],
        selectionKey: resolveSystem1Target(config).key,
        targetKey: system1TargetKey(target),
        fallback: false,
        usage,
        attempts: [{ ...target, targetKey: system1TargetKey(target), status: "succeeded", sdkCalls: 1, usage }],
        latencyMs: expect.any(Number),
      });
      expect(finds).toEqual([["classifier", target.provider, target.model]]);
      expect(calls[0]?.[1].state).toBe(state);
      expect(calls[0]?.[2]).toMatchObject({ retries: 0, maxRetries: 0 });
      if (!answer.ok) throw new Error("expected a valid answer");
      const provenance = provenanceOf(answer);
      expect(provenance).toEqual({
        backend,
        provider: target.provider,
        model: answer.model,
        waterfall: [backend],
        selectionKey: answer.selectionKey,
        targetKey: answer.targetKey,
        fallback: false,
        attempts: answer.attempts,
      });
      expect(provenance).not.toHaveProperty("answers");
      expect(provenance).not.toHaveProperty("usage");
    },
  );
  it("returns typed operational exhaustion on an older host or an unregistered Decisions model", async () => {
    expect(await askSystem1({}, config, {}, questions)).toMatchObject({
      ok: false,
      code: "exhausted",
      attempts: [{ backend: "jev", code: "unavailable_model", sdkCalls: 0 }],
    });
    select("openai-decisions");
    const { registry, calls } = fake();
    registry.findOfType = () => undefined;
    expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
      ok: false,
      code: "exhausted",
      attempts: [{ backend: "openai-decisions", code: "unavailable_model", sdkCalls: 0 }],
    });
    expect(calls).toHaveLength(0);
  });
  it.each([
    { api: "openai-responses" },
    { provider: "openai" },
    { id: "chat" },
    { baseUrl: "https://proxy.invalid/v1" },
  ])("rejects native model overrides %j before classification", async (override) => {
    select("openai-decisions");
    const { registry, calls } = fake();
    registry.findOfType = () => ({ ...nativeModel, ...override });
    expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
      ok: false,
      code: "exhausted",
      attempts: [{ code: "unavailable_model", sdkCalls: 0 }],
    });
    expect(calls).toHaveLength(0);
  });
  it("preserves concrete Jev provenance but keys freshness by the configured alias", async () => {
    const { registry } = fake(async () => ({ ...result(), model: "jev-1.14" }));
    expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
      ok: true,
      model: "jev-1.14",
      selectionKey: system1TargetKey(jevTarget),
      targetKey: system1TargetKey(jevTarget),
      attempts: [{ model: "jev-latest" }],
    });
    const missing = fake(async () => ({ ...result(), model: "" }));
    expect(await askSystem1(missing.registry, config, {}, questions)).toMatchObject({ ok: true, model: "jev-latest" });
  });
});

describe("waterfall execution", () => {
  for (const waterfall of orders) {
    it(`stops at a successful preferred answer under ${waterfall.join(" → ")}`, async () => {
      order(waterfall);
      const { registry, finds, calls } = fake();
      expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
        ok: true,
        backend: waterfall[0],
        waterfall,
        fallback: false,
        attempts: [{ backend: waterfall[0], status: "succeeded", sdkCalls: 1 }],
      });
      expect(finds).toHaveLength(1);
      expect(calls).toHaveLength(1);
    });
    it(`advances on quota failure under ${waterfall.join(" → ")} without changing chain identity`, async () => {
      order(waterfall);
      let n = 0;
      const { registry, calls } = fake(async () => (++n === 1 ? failed("insufficient_quota SECRET") : result()));
      const chainKey = resolveSystem1Target(config).key;
      const answer = await askSystem1(registry, config, {}, questions);
      const target = waterfall[1] === "jev" ? jevTarget : openaiTarget;
      expect(answer).toMatchObject({
        ok: true,
        backend: waterfall[1],
        waterfall,
        fallback: true,
        selectionKey: chainKey,
        targetKey: system1TargetKey(target),
        attempts: [
          { backend: waterfall[0], status: "failed", code: "quota_exhausted", sdkCalls: 1, usage },
          { backend: waterfall[1], status: "succeeded", sdkCalls: 1, usage },
        ],
        usage: addClassifierUsage(usage, usage),
      });
      expect(calledProviders(calls)).toEqual(waterfall.map((b) => (b === "jev" ? "typesafe" : "system1-openai")));
      expect(resolveSystem1Target(config).key).toBe(chainKey);
      expect(JSON.stringify(answer)).not.toContain("SECRET");
    });
  }
  it.each([0, 0.1, 0.5])("a valid negative/uncertain Jev probability %s never shops providers", async (probability) => {
    order(["jev", "openai-decisions"]);
    const { registry, finds, calls } = fake(async () => result({ q: { type: "bool", probability } }));
    const onNotice = vi.fn();
    expect(await askSystem1(registry, config, {}, questions, undefined, { onNotice })).toMatchObject({
      ok: true,
      backend: "jev",
      fallback: false,
      answers: { q: { probability } },
    });
    expect(finds).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(onNotice).not.toHaveBeenCalled();
  });
  it("a valid low-confidence Jev choice is final, not a trigger for a more confident provider", async () => {
    order(["jev", "openai-decisions"]);
    const answers = { q: { type: "choice", choice: "a", confidence: 0 } } as unknown as ClassifierResult["answers"];
    const { registry, finds, calls } = fake(async () => result(answers));
    const onNotice = vi.fn();
    expect(await askSystem1(registry, config, {}, choiceQuestions, undefined, { onNotice })).toMatchObject({
      ok: true,
      backend: "jev",
      answers,
    });
    expect(finds).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(onNotice).not.toHaveBeenCalled();
  });
  it("missing Jev credentials advance only to the configured OpenAI target", async () => {
    order(["jev", "openai-decisions"]);
    let n = 0;
    const { registry, finds, calls } = fake(async () => {
      if (++n === 1) throw new Error("No API key found SECRET");
      return result();
    });
    const answer = await askSystem1(registry, config, {}, questions);
    expect(answer).toMatchObject({
      ok: true,
      backend: "openai-decisions",
      fallback: true,
      usage,
      attempts: [
        { code: "missing_credentials", sdkCalls: 1 },
        { status: "succeeded", sdkCalls: 1, usage },
      ],
    });
    expect(finds).toEqual([
      ["classifier", "typesafe", "jev-latest"],
      ["classifier", "system1-openai", "gpt-6-luna"],
    ]);
    expect(calls).toHaveLength(2);
    expect(answer.attempts[0]).not.toHaveProperty("usage");
    expect(JSON.stringify(answer)).not.toContain("SECRET");
  });
  it("an unavailable preferred model does not hide an explicitly configured viable fallback", async () => {
    order(["openai-decisions", "jev"]);
    const { registry, calls } = fake();
    registry.findOfType = (_, provider) => (provider === "system1-openai" ? undefined : { provider, id: "jev-latest" });
    expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
      ok: true,
      backend: "jev",
      fallback: true,
      attempts: [
        { code: "unavailable_model", sdkCalls: 0 },
        { status: "succeeded", sdkCalls: 1 },
      ],
    });
    expect(calledProviders(calls)).toEqual(["typesafe"]);
  });
  it("returns sanitized whole-chain exhaustion and all attempted usage when both providers fail", async () => {
    order(["jev", "openai-decisions"]);
    let n = 0;
    const { registry, calls } = fake(async () =>
      failed(++n === 1 ? "insufficient_quota SECRET_JEV" : "401 SECRET_OPENAI"),
    );
    const answer = await askSystem1(registry, config, {}, questions);
    expect(answer).toMatchObject({
      ok: false,
      code: "exhausted",
      reason: expect.stringContaining("quota or credits exhausted"),
      usage: addClassifierUsage(usage, usage),
      attempts: [
        { backend: "jev", status: "failed", code: "quota_exhausted" },
        { backend: "openai-decisions", status: "failed", code: "invalid_credentials" },
      ],
    });
    expect(answer).toMatchObject({ reason: expect.stringContaining("credentials invalid") });
    expect(answer).not.toHaveProperty("answers");
    expect(JSON.stringify(answer)).not.toContain("SECRET");
    expect(calls).toHaveLength(2);
  });
  it.each([
    "OpenAI Decisions refused to answer q",
    "OpenAI Decisions error (400): OpenAI Decisions refused to answer q",
  ])("treats the SDK refusal form as terminal: %s", async (message) => {
    order(["openai-decisions", "jev"]);
    const { registry, finds, calls } = fake(async () => failed(message));
    const answer = await askSystem1(registry, config, {}, questions);
    expect(answer).toMatchObject({
      ok: false,
      code: "refused",
      attempts: [{ backend: "openai-decisions", code: "refused", sdkCalls: 1 }],
      usage,
    });
    expect(answer).not.toHaveProperty("answers");
    expect(finds).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
  it.each([
    "OpenAI Decisions did not return an answer for refused",
    "OpenAI Decisions error (400): OpenAI Decisions returned invalid probabilities for user_refused_request",
  ])("does not mistake a malformed answer for an ID containing refused as a safety refusal: %s", async (message) => {
    order(["openai-decisions", "jev"]);
    let n = 0;
    const qs = { user_refused_request: questions.q, refused: questions.q };
    const { registry, calls } = fake(async () => (++n === 1 ? failed(message) : result(boolAnswers(qs))));
    expect(await askSystem1(registry, config, {}, qs)).toMatchObject({
      ok: true,
      backend: "jev",
      fallback: true,
      attempts: [{ code: "invalid_answers" }, { status: "succeeded" }],
    });
    expect(calls).toHaveLength(2);
  });
  it("valid answers for IDs containing refused remain ordinary judgments", async () => {
    order(["openai-decisions", "jev"]);
    const qs = { refused: questions.q };
    const { registry, calls } = fake(async () => result(boolAnswers(qs, 0)));
    expect(await askSystem1(registry, config, {}, qs)).toMatchObject({
      ok: true,
      backend: "openai-decisions",
      answers: { refused: { probability: 0 } },
    });
    expect(calls).toHaveLength(1);
  });
});

describe("answer validation", () => {
  it.each(["jev", "openai-decisions"] as const)(
    "returns genuine %s bool, distributions and fractional scores while ignoring extra IDs",
    async (backend) => {
      select(backend);
      const qs: Record<string, ClassifierQuestion> = { ...questions, c: choiceQuestions.q, s: scoreQuestions.q };
      const { registry } = fake(async () =>
        result({
          q: { type: "bool", probability: 0.7 },
          c: { type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.8 },
          s: { type: "score", score: 1.25, confidence: 0.9 },
          extra: { type: "bool", probability: 1 },
        }),
      );
      const answer = await askSystem1(registry, config, {}, qs);
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      expect(bool(answer.answers, "q")).toBe(0.7);
      expect(choice(answer.answers, "c")?.probabilities).toEqual({ a: 0.6, b: 0.4 });
      expect(score(answer.answers, "s")).toEqual({ score: 1.25, confidence: 0.9 });
      expect(answer.answers.extra).toBeUndefined();
    },
  );
  const invalidBools = [
    null,
    [],
    {},
    { q: null },
    { q: { type: "bool", probability: -1 } },
    { q: { type: "bool", probability: 1.1 } },
    { q: { type: "bool", probability: NaN } },
    { q: { type: "bool", probability: Infinity } },
    { q: { type: "bool", probability: "0.8" } },
    { q: { type: "score", score: 0, confidence: 1 } },
  ];
  for (const backend of ["jev", "openai-decisions"] as const) {
    it.each(invalidBools)(
      `rejects malformed or missing ${backend} bool answers %j, retaining billed usage`,
      async (answers) => {
        select(backend);
        const { registry } = fake(async () => result(answers as unknown as ClassifierResult["answers"]));
        expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
          ok: false,
          code: "exhausted",
          attempts: [{ backend, code: "invalid_answers", sdkCalls: 1, usage }],
          usage,
        });
      },
    );
    it.each([
      { choice: "absent", probabilities: { a: 0.5, b: 0.5 }, confidence: 0.8 },
      { choice: "a", probabilities: { a: 1.1, b: -0.1 }, confidence: 0.8 },
      { choice: "a", probabilities: { a: 0.5, b: 0.5 }, confidence: Infinity },
      { choice: "a", probabilities: { a: 0.5, b: 0.5 }, confidence: -0.1 },
      { choice: "a", probabilities: { a: 0.5, b: 0.5 }, confidence: 1.1 },
      { choice: "a", probabilities: { a: NaN }, confidence: 0.8 },
      { choice: "a", probabilities: { unexpected: 0.4 }, confidence: 0.8 },
      { choice: "a", probabilities: null, confidence: 0.8 },
    ])(`rejects invalid ${backend} choice labels, probabilities or confidence %j`, async (a) => {
      select(backend);
      const { registry } = fake(async () =>
        result({ q: { type: "choice", ...a } } as unknown as ClassifierResult["answers"]),
      );
      expect(await askSystem1(registry, config, {}, choiceQuestions)).toMatchObject({
        ok: false,
        code: "exhausted",
        attempts: [{ code: "invalid_answers" }],
      });
    });
    it(`rejects a non-string ${backend} choice even when it coerces to a requested label`, async () => {
      select(backend);
      const qs: Record<string, ClassifierQuestion> = {
        q: { type: "choice", instructions: "Choose", criteria: { "1": "one", "2": "two" } },
      };
      const { registry } = fake(async () =>
        result({
          q: { type: "choice", choice: 1, probabilities: { "1": 0.8, "2": 0.2 }, confidence: 0.8 },
        } as unknown as ClassifierResult["answers"]),
      );
      expect(await askSystem1(registry, config, {}, qs)).toMatchObject({
        ok: false,
        code: "exhausted",
        attempts: [{ code: "invalid_answers" }],
      });
    });
    it.each([
      { score: -1, confidence: 0.9 },
      { score: 2.1, confidence: 0.9 },
      { score: Infinity, confidence: 0.9 },
      { score: 1, confidence: NaN },
      { score: 1, confidence: -0.1 },
      { score: 1, confidence: 1.1 },
    ])(`rejects invalid ${backend} scores %j`, async (a) => {
      select(backend);
      const { registry } = fake(async () => result({ q: { type: "score", ...a } }));
      expect(await askSystem1(registry, config, {}, scoreQuestions)).toMatchObject({
        ok: false,
        code: "exhausted",
        attempts: [{ code: "invalid_answers" }],
      });
    });
  }
  it.each([
    { choice: "a", confidence: 0.8 },
    { choice: "a", probabilities: { a: 0.6 }, confidence: 0.8 },
    { choice: "a", probabilities: { a: 0.6, b: 0.6 }, confidence: 0.8 },
  ])(
    "retains Jev confidence-only/partial-distribution compatibility without inventing probabilities, but native is strict: %j",
    async (a) => {
      const answers = { q: { type: "choice", ...a } } as unknown as ClassifierResult["answers"];
      const jev = fake(async () => result(answers));
      const answer = await askSystem1(jev.registry, config, {}, choiceQuestions);
      expect(answer).toMatchObject({ ok: true, backend: "jev", answers });
      if (answer.ok) expect(answer.answers).toEqual(answers);
      select("openai-decisions");
      const native = fake(async () => result(answers));
      expect(await askSystem1(native.registry, config, {}, choiceQuestions)).toMatchObject({
        ok: false,
        code: "exhausted",
        attempts: [{ code: "invalid_answers" }],
      });
    },
  );
  it.each(invalidBools)(
    "malformed Jev answers %j advance instead of passing through permissive accessors",
    async (answers) => {
      order(["jev", "openai-decisions"]);
      let n = 0;
      const { registry, calls } = fake(async () =>
        ++n === 1 ? result(answers as unknown as ClassifierResult["answers"]) : result(),
      );
      expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
        ok: true,
        backend: "openai-decisions",
        fallback: true,
        answers: { q: { probability: 0.8 } },
        attempts: [{ code: "invalid_answers" }, { status: "succeeded" }],
      });
      expect(calls).toHaveLength(2);
    },
  );
});

describe("batching and usage", () => {
  it.each([400, 401])("batches %d native questions in order, reuses state and aggregates usage", async (count) => {
    select("openai-decisions");
    const qs = manyQuestions(count);
    const state = { evidence: ["unaltered"] };
    const { registry, calls } = fake(async (_, ctx) => result(boolAnswers(ctx.questions)));
    const answer = await askSystem1(registry, config, state, qs);
    expect(answer.ok).toBe(true);
    expect(calls).toHaveLength(Math.ceil(count / 400));
    expect(calls.every((c) => c[1].state === state)).toBe(true);
    expect(calls.map((c) => Object.keys(c[1].questions).length)).toEqual(count === 400 ? [400] : [400, 1]);
    expect(answer.attempts).toMatchObject([
      { sdkCalls: calls.length, usage: { totalTokens: usage.totalTokens * calls.length } },
    ]);
    if (answer.ok) {
      expect(Object.keys(answer.answers)).toEqual(Object.keys(qs));
      expect(answer.usage?.totalTokens).toBe(usage.totalTokens * calls.length);
    }
  });
  it("fails the whole native batch set without partial judgments and retains earlier and failed usage", async () => {
    select("openai-decisions");
    let n = 0;
    const { registry, calls } = fake(async (_, ctx) =>
      ++n === 1 ? result(boolAnswers(ctx.questions)) : failed("insufficient_quota SECRET"),
    );
    const answer = await askSystem1(registry, config, {}, manyQuestions(401));
    expect(answer).toMatchObject({
      ok: false,
      code: "exhausted",
      attempts: [{ code: "quota_exhausted", sdkCalls: 2, usage: { totalTokens: 26 } }],
      usage: addClassifierUsage(usage, usage),
    });
    expect(answer).not.toHaveProperty("answers");
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(answer)).not.toContain("SECRET");
  });
  it("discards a partial native batch and restarts every question on Jev, retaining all three calls' usage", async () => {
    order(["openai-decisions", "jev"]);
    const qs = manyQuestions(401);
    const state = { evidence: ["same evidence"] };
    let n = 0;
    const { registry, calls } = fake(async (_, ctx) =>
      ++n === 2 ? failed("insufficient_quota SECRET") : result(boolAnswers(ctx.questions, n === 1 ? 0.9 : 0.1)),
    );
    const answer = await askSystem1(registry, config, state, qs);
    expect(answer).toMatchObject({
      ok: true,
      backend: "jev",
      fallback: true,
      usage: addClassifierUsage(addClassifierUsage(usage, usage), usage),
      attempts: [
        { backend: "openai-decisions", code: "quota_exhausted", sdkCalls: 2, usage: addClassifierUsage(usage, usage) },
        { backend: "jev", status: "succeeded", sdkCalls: 1, usage },
      ],
    });
    expect(calledProviders(calls)).toEqual(["system1-openai", "system1-openai", "typesafe"]);
    expect(calls.map((c) => Object.keys(c[1].questions).length)).toEqual([400, 1, 401]);
    expect(calls.every((c) => c[1].state === state)).toBe(true);
    expect(calls[2]?.[1].questions).toEqual(qs);
    if (!answer.ok) throw new Error("expected Jev to restart the full set");
    expect(answer.answers).toEqual(boolAnswers(qs, 0.1));
  });
  it("a malformed Jev set causes a complete native restart, never a merge of valid subsets", async () => {
    order(["jev", "openai-decisions"]);
    const qs = manyQuestions(401);
    let n = 0;
    const { registry, calls } = fake(async (_, ctx) =>
      ++n === 1
        ? result({ ...boolAnswers(ctx.questions, 0.9), q400: { type: "bool", probability: 2 } })
        : result(boolAnswers(ctx.questions, 0.2)),
    );
    const answer = await askSystem1(registry, config, {}, qs);
    expect(answer).toMatchObject({
      ok: true,
      backend: "openai-decisions",
      attempts: [
        { code: "invalid_answers", sdkCalls: 1 },
        { status: "succeeded", sdkCalls: 2 },
      ],
      usage: { totalTokens: 39 },
    });
    expect(calls.map((c) => Object.keys(c[1].questions).length)).toEqual([401, 400, 1]);
    if (answer.ok) expect(answer.answers).toEqual(boolAnswers(qs, 0.2));
  });
  it("keeps missing usage unknown rather than fabricating zero counters", async () => {
    order(["jev", "openai-decisions"]);
    const { registry } = fake(async () => ({
      ...result(),
      usage: undefined,
      stopReason: "error",
      errorMessage: "timeout",
    }));
    const answer = await askSystem1(registry, config, {}, questions);
    expect(answer).toMatchObject({
      ok: false,
      code: "exhausted",
      attempts: [{ code: "timeout" }, { code: "timeout" }],
    });
    expect(answer.usage).toBeUndefined();
    expect(answer.attempts.every((a) => a.usage === undefined)).toBe(true);
  });
  it("adds only actual usage without inventing absent counters", () => {
    expect(addClassifierUsage(undefined, undefined)).toBeUndefined();
    expect(addClassifierUsage(usage, undefined)).toEqual(usage);
    expect(addClassifierUsage(undefined, usage)).toEqual(usage);
    expect(addClassifierUsage(usage, usage)).toEqual({
      input: 20,
      output: 4,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 26,
      cost: { input: 0.2, output: 0.04, cacheRead: 0.02, cacheWrite: 0, total: 0.26 },
    });
  });
});

describe("safe operational errors", () => {
  const errors: [string, System1FailureCode, string][] = [
    ["No API key found SECRET", "missing_credentials", "credentials missing"],
    ["401 SECRET", "invalid_credentials", "credentials invalid"],
    ["429 SECRET", "rate_limited", "rate limited"],
    ["insufficient_quota SECRET", "quota_exhausted", "quota or credits exhausted"],
    ["504 SECRET", "timeout", "timed out"],
    ["OpenAI Decisions returned invalid probabilities SECRET", "invalid_answers", "invalid answers"],
    ["404 SECRET", "unavailable_model", "model unavailable"],
    ["SECRET body", "provider_error", "request failed"],
  ];
  it.each(errors)(
    "normalizes %s safely, putting %s on the attempt without retries",
    async (message, code, category) => {
      select("openai-decisions");
      const { registry, calls } = fake(async () => failed(message));
      const answer = await askSystem1(registry, config, {}, questions);
      expect(answer).toMatchObject({
        ok: false,
        code: "exhausted",
        reason: expect.stringContaining(category),
        attempts: [{ status: "failed", code, usage, sdkCalls: 1 }],
        usage,
      });
      expect(JSON.stringify(answer)).not.toContain("SECRET");
      expect(calls).toHaveLength(1);
    },
  );
  it("normalizes thrown errors without exposing their body or inventing usage", async () => {
    select("openai-decisions");
    const { registry } = fake(async () => {
      throw new Error("401 SECRET");
    });
    const answer = await askSystem1(registry, config, {}, questions);
    expect(answer).toMatchObject({
      ok: false,
      code: "exhausted",
      attempts: [{ code: "invalid_credentials", sdkCalls: 1 }],
    });
    expect(answer.usage).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain("SECRET");
  });
});

describe("total deadline and retry budgets", () => {
  it("does not call a provider or claim probing when setup consumes the whole request deadline", async () => {
    order(["jev", "openai-decisions"]);
    const { registry, calls, finds } = fake();
    const onNotice = vi.fn();
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(1_000).mockReturnValue(2_000);
    try {
      expect(await askSystem1(registry, config, {}, questions, undefined, { onNotice })).toMatchObject({
        ok: false,
        code: "timeout",
        attempts: [],
        latencyMs: 1_000,
      });
      expect(calls).toHaveLength(0);
      expect(finds).toHaveLength(0);
      expect(onNotice).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  for (const waterfall of orders)
    it(`reserves fair time for each rung under ${waterfall.join(" → ")} with no retry multiplication`, async () => {
      order(waterfall);
      const { registry, calls } = fake(async () => new Promise(() => {}));
      const pending = askSystem1(registry, config, {}, questions);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[2]?.timeoutMs).toBe(50);
      await vi.advanceTimersByTimeAsync(50);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[2]?.signal?.aborted).toBe(true);
      expect(calls[1]?.[2]?.timeoutMs).toBe(50);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({
        ok: false,
        code: "exhausted",
        latencyMs: 100,
        attempts: [
          { backend: waterfall[0], code: "timeout", sdkCalls: 1, latencyMs: 50 },
          { backend: waterfall[1], code: "timeout", sdkCalls: 1, latencyMs: 50 },
        ],
      });
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c[2]?.retries === 0 && c[2]?.maxRetries === 0 && c[2]?.signal?.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  it("gives the final rung all unspent request time rather than a fixed fresh timeout", async () => {
    order(["jev", "openai-decisions"]);
    let n = 0;
    const { registry, calls } = fake(async () => {
      if (++n === 1) {
        await new Promise((r) => setTimeout(r, 10));
        return failed("429 SECRET");
      }
      return new Promise(() => {});
    });
    const pending = askSystem1(registry, config, {}, questions);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls[0]?.[2]?.timeoutMs).toBe(50);
    expect(calls[1]?.[2]?.timeoutMs).toBe(90);
    await vi.advanceTimersByTimeAsync(90);
    expect(await pending).toMatchObject({
      ok: false,
      code: "exhausted",
      latencyMs: 100,
      usage,
      attempts: [{ code: "rate_limited" }, { code: "timeout" }],
    });
    expect(calls).toHaveLength(2);
  });
  it("splits a singleton Jev timeout budget across at most two attempts", async () => {
    const { registry, calls } = fake(async () => new Promise(() => {}));
    const pending = askSystem1(registry, config, {}, questions);
    expect(calls[0]?.[2]?.timeoutMs).toBe(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[2]?.timeoutMs).toBe(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({
      ok: false,
      code: "exhausted",
      latencyMs: 100,
      attempts: [{ backend: "jev", code: "timeout", sdkCalls: 2 }],
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c[2]?.signal?.aborted)).toBe(true);
  });
  it("retries a singleton Jev SDK timeout once, retains both usages, and disables host retries", async () => {
    let n = 0;
    const { registry, calls } = fake(async () => (++n === 1 ? failed("timeout") : result()));
    expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
      ok: true,
      usage: addClassifierUsage(usage, usage),
      attempts: [{ sdkCalls: 2, usage: addClassifierUsage(usage, usage) }],
    });
    expect(calls.map((c) => c[2]?.timeoutMs)).toEqual([50, 100]);
    expect(calls.every((c) => c[2]?.retries === 0 && c[2]?.maxRetries === 0)).toBe(true);
  });
  it("honors retryTimeout false by giving singleton Jev one unsplit budget", async () => {
    const { registry, calls } = fake(async () => new Promise(() => {}));
    const pending = askSystem1(registry, config, {}, questions, undefined, { retryTimeout: false });
    expect(calls[0]?.[2]?.timeoutMs).toBe(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ ok: false, code: "exhausted", attempts: [{ code: "timeout", sdkCalls: 1 }] });
    expect(calls).toHaveLength(1);
  });
  it("does not multiply retries across a native batch set and a Jev fallback", async () => {
    order(["openai-decisions", "jev"]);
    let n = 0;
    const { registry, calls } = fake(async (_, ctx) =>
      ++n === 1 ? result(boolAnswers(ctx.questions)) : failed("timeout"),
    );
    expect(await askSystem1(registry, config, {}, manyQuestions(401))).toMatchObject({
      ok: false,
      code: "exhausted",
      attempts: [
        { code: "timeout", sdkCalls: 2 },
        { code: "timeout", sdkCalls: 1 },
      ],
      usage: { totalTokens: 39 },
    });
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => Object.keys(c[1].questions).length)).toEqual([400, 1, 401]);
  });
  it("enforces a singleton native deadline, aborts the host and never retries", async () => {
    select("openai-decisions");
    const { registry, calls } = fake(async () => new Promise(() => {}));
    const pending = askSystem1(registry, { ...config, timeoutMs: 5 }, {}, questions);
    await vi.advanceTimersByTimeAsync(5);
    expect(await pending).toMatchObject({
      ok: false,
      code: "exhausted",
      latencyMs: 5,
      attempts: [{ code: "timeout", sdkCalls: 1 }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[2]?.signal?.aborted).toBe(true);
  });
  it("retains usage but rejects a synchronous host success past the deadline", async () => {
    select("openai-decisions");
    const { registry } = fake(async () => {
      vi.setSystemTime(101);
      return result();
    });
    expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
      ok: false,
      code: "exhausted",
      latencyMs: 101,
      attempts: [{ code: "timeout" }],
      usage,
    });
  });
  it("uses remaining native time for later batches instead of resetting their deadline", async () => {
    select("openai-decisions");
    const { registry, calls } = fake(async (_, ctx) => {
      await new Promise((r) => setTimeout(r, 10));
      return result(boolAnswers(ctx.questions));
    });
    const pending = askSystem1(registry, config, {}, manyQuestions(401));
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toMatchObject({ ok: true, latencyMs: 20 });
    expect(calls.map((c) => c[2]?.timeoutMs)).toEqual([100, 90]);
  });
});

describe("cancellation and configuration fences", () => {
  it("already-aborted requests do not perform lookup or emit notices", async () => {
    order(["jev", "openai-decisions"]);
    const controller = new AbortController();
    controller.abort();
    const { registry, finds, calls } = fake();
    const onNotice = vi.fn();
    expect(await askSystem1(registry, config, {}, questions, controller.signal, { onNotice })).toMatchObject({
      ok: false,
      code: "cancelled",
      attempts: [],
    });
    expect(finds).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(onNotice).not.toHaveBeenCalled();
  });
  for (const waterfall of orders)
    it(`caller abort stops ${waterfall.join(" → ")} even when the host ignores its signal`, async () => {
      order(waterfall);
      const controller = new AbortController();
      const { registry, finds, calls } = fake(async () => new Promise(() => {}));
      const onNotice = vi.fn();
      const pending = askSystem1(registry, config, {}, questions, controller.signal, { onNotice });
      controller.abort();
      expect(await pending).toMatchObject({
        ok: false,
        code: "cancelled",
        attempts: [{ code: "cancelled", sdkCalls: 1 }],
      });
      expect(calls[0]?.[2]?.signal?.aborted).toBe(true);
      expect(finds).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(onNotice).not.toHaveBeenCalled();
    });
  it("a provider-aborted response is terminal and preserves reported usage", async () => {
    order(["jev", "openai-decisions"]);
    const { registry, calls } = fake(async () => ({ ...result(), stopReason: "aborted" }));
    const onNotice = vi.fn();
    expect(await askSystem1(registry, config, {}, questions, undefined, { onNotice })).toMatchObject({
      ok: false,
      code: "cancelled",
      usage,
      attempts: [{ code: "cancelled" }],
    });
    expect(calls).toHaveLength(1);
    expect(onNotice).not.toHaveBeenCalled();
  });
  it.each(["success", "operational failure"] as const)(
    "discards a stale %s on chain reorder without advancing or warning",
    async (kind) => {
      order(["jev", "openai-decisions"]);
      const { registry, calls } = fake(async () => {
        order(["openai-decisions", "jev"]);
        return kind === "success" ? result() : failed("insufficient_quota SECRET");
      });
      const onNotice = vi.fn();
      const answer = await askSystem1(registry, config, {}, questions, undefined, { onNotice });
      expect(answer).toMatchObject({
        ok: false,
        code: "selection_changed",
        usage,
        attempts: [{ code: "selection_changed" }],
      });
      expect(answer).not.toHaveProperty("answers");
      expect(calls).toHaveLength(1);
      expect(onNotice).not.toHaveBeenCalled();
    },
  );
  it("manual runtime reset stops pending work rather than trying the next rung", async () => {
    order(["jev", "openai-decisions"]);
    const { registry, finds, calls } = fake(async () => {
      resetSystem1Runtime(registry);
      return failed("timeout");
    });
    const onNotice = vi.fn();
    expect(await askSystem1(registry, config, {}, questions, undefined, { onNotice })).toMatchObject({
      ok: false,
      code: "selection_changed",
      usage,
      attempts: [{ code: "selection_changed" }],
    });
    expect(finds).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(onNotice).not.toHaveBeenCalled();
  });
  it.each(["cancel", "reorder", "reset"] as const)(
    "rechecks %s between a failure notice and the next rung",
    async (action) => {
      order(["jev", "openai-decisions"]);
      const controller = new AbortController();
      const { registry, finds, calls } = fake(async () => failed("insufficient_quota SECRET"));
      const notices: System1Notice[] = [];
      const answer = await askSystem1(registry, config, {}, questions, controller.signal, {
        onNotice(notice) {
          notices.push(notice);
          if (action === "cancel") controller.abort();
          else if (action === "reorder") order(["openai-decisions", "jev"]);
          else resetSystem1Runtime(registry);
        },
      });
      expect(answer).toMatchObject({ ok: false, code: action === "cancel" ? "cancelled" : "selection_changed", usage });
      expect(notices).toHaveLength(1);
      expect(finds).toHaveLength(1);
      expect(calls).toHaveLength(1);
    },
  );
  it("cancellation during a later native batch discards earlier answers but retains completed usage", async () => {
    order(["openai-decisions", "jev"]);
    const controller = new AbortController();
    let n = 0;
    const { registry, calls } = fake(async (_, ctx) => {
      if (++n === 1) return result(boolAnswers(ctx.questions));
      controller.abort();
      return new Promise(() => {});
    });
    const onNotice = vi.fn();
    const answer = await askSystem1(registry, config, {}, manyQuestions(801), controller.signal, { onNotice });
    expect(answer).toMatchObject({ ok: false, code: "cancelled", attempts: [{ sdkCalls: 2, usage }], usage });
    expect(answer).not.toHaveProperty("answers");
    expect(calls).toHaveLength(2);
    expect(onNotice).not.toHaveBeenCalled();
    expect(calls[1]?.[2]?.signal?.aborted).toBe(true);
  });
  it.each(["reorder", "reset"] as const)(
    "rechecks %s before another native batch and discards partial answers",
    async (action) => {
      order(["openai-decisions", "jev"]);
      const { registry, calls } = fake(async (_, ctx) => {
        if (action === "reorder") order(["jev", "openai-decisions"]);
        else resetSystem1Runtime(registry);
        return result(boolAnswers(ctx.questions));
      });
      const onNotice = vi.fn();
      const answer = await askSystem1(registry, config, {}, manyQuestions(401), undefined, { onNotice });
      expect(answer).toMatchObject({ ok: false, code: "selection_changed", attempts: [{ sdkCalls: 1 }], usage });
      expect(answer).not.toHaveProperty("answers");
      expect(calls).toHaveLength(1);
      expect(onNotice).not.toHaveBeenCalled();
    },
  );
  it.each(["jev", "openai-decisions"] as const)(
    "discards stale singleton %s success and preserves usage",
    async (backend) => {
      select(backend);
      const { registry } = fake(async () => {
        select(backend === "jev" ? "openai-decisions" : "jev");
        return result();
      });
      expect(await askSystem1(registry, config, {}, questions)).toMatchObject({
        ok: false,
        code: "selection_changed",
        usage,
      });
    },
  );
  it("effective chain recheck tolerates unrelated keys and legacy canonicalization", async () => {
    select("jev");
    const { registry } = fake(async () => {
      writeFileSync(system1Path(), '{"waterfall":["jev"],"backend":"jev","future":true}');
      return result();
    });
    expect(await askSystem1(registry, config, {}, questions)).toMatchObject({ ok: true, backend: "jev" });
    expect(readFileSync(system1Path(), "utf8")).toContain("future");
  });
});
