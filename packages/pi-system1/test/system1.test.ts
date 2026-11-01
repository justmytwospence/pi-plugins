import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addClassifierUsage, agentDir, askSystem1, bool, choice, readSystem1Setting,
  resolveSystem1Target, score, system1Path,
  type ClassifierConfig, type ClassifierQuestion, type ClassifierRegistry,
  type ClassifierResult, type ClassifierUsage,
} from "../src/system1.ts";

const config: ClassifierConfig = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 100 };
const questions: Record<string, ClassifierQuestion> = { q: { type: "bool", instructions: "Is this supported?", criteria: { true: "supported", false: "not supported" } } };
const usage: ClassifierUsage = { input: 10, output: 2, cacheRead: 1, cacheWrite: 0, totalTokens: 13, cost: { input: .1, output: .02, cacheRead: .01, cacheWrite: 0, total: .13 } };
const nativeModel = { type: "classifier", id: "gpt-6-luna", provider: "system1-openai", api: "openai-decisions", baseUrl: "https://api.openai.com/v1" };
const result = (answers: ClassifierResult["answers"] = { q: { type: "bool", probability: .8 } }): ClassifierResult => ({ model: "wire-model", answers, stopReason: "stop", usage });
function fake(run: ClassifierRegistry["classify"] = async () => result()) {
  const finds: unknown[][] = [];
  const calls: Parameters<ClassifierRegistry["classify"]>[] = [];
  const registry: ClassifierRegistry = {
    findOfType(...args) { finds.push(args); return args[1] === "system1-openai" ? nativeModel : { id: args[2] }; },
    classify(...args) { calls.push(args); return run(...args); },
  };
  return { registry, finds, calls };
}
let dir: string;
let previous: string | undefined;
function select(backend: string) { writeFileSync(system1Path(), JSON.stringify({ backend })); }
beforeEach(() => { previous = process.env.PI_CODING_AGENT_DIR; dir = mkdtempSync(path.join(tmpdir(), "system1-test-")); process.env.PI_CODING_AGENT_DIR = dir; });
afterEach(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); });

describe("global selection", () => {
  it("defaults only a missing agent file to Jev and honors the agent directory", () => {
    expect(agentDir()).toBe(dir); expect(system1Path()).toBe(path.join(dir, "system1.json"));
    expect(readSystem1Setting()).toMatchObject({ ok: true, backend: "jev" });
    expect(resolveSystem1Target(config)).toMatchObject({ ok: true, backend: "jev", provider: "typesafe", model: "jev-latest", key: JSON.stringify(["jev", "typesafe", "jev-latest"]) });
  });
  it("uses the physical target key, ignores future keys, and overrides legacy targets only under Decisions", () => {
    writeFileSync(system1Path(), JSON.stringify({ backend: "openai-decisions", future: 42 }));
    const setting = readSystem1Setting();
    expect(resolveSystem1Target({ provider: "legacy", model: "old" }, setting)).toEqual({ ok: true, backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna", key: JSON.stringify(["openai-decisions", "system1-openai", "gpt-6-luna"]) });
  });
  it.each(["{", "null", "[]", "{}", '{"backend":"other"}', '{"backend":42}'])("fails closed on broken setting %s", (raw) => {
    writeFileSync(system1Path(), raw); expect(readSystem1Setting().ok).toBe(false); expect(resolveSystem1Target(config).ok).toBe(false);
  });
  it("does not replace an unreadable existing file with Jev", () => { mkdirSync(system1Path()); expect(readSystem1Setting()).toMatchObject({ ok: false, reason: "System 1 configuration is unreadable" }); });
  it("does not read project configuration", () => {
    const project = path.join(dir, ".pi"); mkdirSync(project); writeFileSync(path.join(project, "system1.json"), '{"backend":"openai-decisions"}');
    expect(readSystem1Setting()).toMatchObject({ ok: true, backend: "jev" });
  });
});

describe("classification", () => {
  it("disabled and empty requests do not touch a registry, even with broken settings", async () => {
    writeFileSync(system1Path(), "broken");
    expect(await askSystem1(undefined, { ...config, enabled: false }, {}, questions)).toEqual({ ok: false, reason: "the classifier is off in settings" });
    expect(await askSystem1(undefined, config, {}, {})).toEqual({ ok: false, reason: "no questions to judge" });
  });
  it.each(["jev", "openai-decisions"])("uses only classifier lookup and reports actual %s provenance", async (backend) => {
    select(backend); const { registry, finds, calls } = fake();
    const answer = await askSystem1(registry, config, { evidence: "provided" }, questions);
    const target = resolveSystem1Target(config); expect(target.ok).toBe(true);
    expect(answer).toMatchObject({ ok: true, backend, provider: backend === "jev" ? "typesafe" : "system1-openai", model: backend === "jev" ? "wire-model" : "gpt-6-luna", selectionKey: target.key, usage });
    expect(finds).toHaveLength(1); expect(finds[0]?.[0]).toBe("classifier"); expect(calls[0]?.[2]).toMatchObject({ retries: 0, maxRetries: 0 });
  });
  it("supports older hosts in Jev mode but never falls back when Decisions is not registered", async () => {
    expect(await askSystem1({}, config, {}, questions)).toMatchObject({ ok: false, reason: expect.stringContaining("no classifier") });
    select("openai-decisions"); const { registry, calls } = fake(); registry.findOfType = () => undefined;
    expect(await askSystem1(registry, config, {}, questions)).toEqual({ ok: false, reason: "OpenAI Decisions is unavailable; enable pi-system1 and configure /login system1-openai" }); expect(calls).toHaveLength(0);
  });
  it.each([{ api: "openai-responses" }, { provider: "openai" }, { id: "chat" }, { baseUrl: "https://proxy.invalid/v1" }])("rejects native model overrides %j before classification", async (override) => {
    select("openai-decisions"); const { registry, calls } = fake(); registry.findOfType = () => ({ ...nativeModel, ...override });
    expect((await askSystem1(registry, config, {}, questions)).ok).toBe(false); expect(calls).toHaveLength(0);
  });
  it("returns real bool, distributions and fractional scores, ignoring extra IDs", async () => {
    select("openai-decisions");
    const qs: Record<string, ClassifierQuestion> = { ...questions, c: { type: "choice", instructions: "Choose", criteria: { a: "A", b: "B" } }, s: { type: "score", instructions: "Score", criteria: ["low", "middle", "high"] } };
    const { registry } = fake(async () => result({ q: { type: "bool", probability: .7 }, c: { type: "choice", choice: "a", probabilities: { a: .6, b: .4 }, confidence: .8 }, s: { type: "score", score: 1.25, confidence: .9 }, extra: { type: "bool", probability: 1 } }));
    const answer = await askSystem1(registry, config, {}, qs); expect(answer.ok).toBe(true); if (!answer.ok) return;
    expect(bool(answer.answers, "q")).toBe(.7); expect(choice(answer.answers, "c")?.probabilities).toEqual({ a: .6, b: .4 }); expect(score(answer.answers, "s")).toEqual({ score: 1.25, confidence: .9 }); expect(answer.answers.extra).toBeUndefined();
  });
  it.each([{}, { q: { type: "bool", probability: -1 } }, { q: { type: "bool", probability: 1.1 } }, { q: { type: "bool", probability: NaN } }, { q: { type: "score", score: 0, confidence: 1 } }])("rejects invalid or missing native bool answers %j, retaining usage", async (answers) => {
    select("openai-decisions"); const { registry } = fake(async () => result(answers as ClassifierResult["answers"]));
    expect(await askSystem1(registry, config, {}, questions)).toMatchObject({ ok: false, reason: "OpenAI Decisions API returned invalid answers", usage });
  });
  it.each([
    { choice: "absent", probabilities: { a: .5, b: .5 }, confidence: .8 },
    { choice: "a", probabilities: { a: 1 }, confidence: .8 },
    { choice: "a", probabilities: { a: .6, b: .6 }, confidence: .8 },
    { choice: "a", probabilities: { a: 1.1, b: -.1 }, confidence: .8 },
    { choice: "a", probabilities: { a: .5, b: .5 }, confidence: Infinity },
    { choice: "a", probabilities: { a: .5, b: .5, unexpected: .4 }, confidence: .8 },
  ])("validates full native choice distribution %j", async (a) => {
    select("openai-decisions"); const { registry } = fake(async () => result({ q: { type: "choice", ...a } } as ClassifierResult["answers"]));
    expect((await askSystem1(registry, config, {}, { q: { type: "choice", instructions: "choose", criteria: { a: "A", b: "B" } } })).ok).toBe(false);
  });
  it.each([{ score: -1, confidence: .9 }, { score: 2.1, confidence: .9 }, { score: 1, confidence: NaN }])("rejects invalid native score %j", async (a) => {
    select("openai-decisions"); const { registry } = fake(async () => result({ q: { type: "score", ...a } }));
    expect((await askSystem1(registry, config, {}, { q: { type: "score", instructions: "score", criteria: ["A", "B", "C"] } })).ok).toBe(false);
  });
  it("preserves concrete Jev model provenance while keying freshness by the configured alias", async () => {
    const { registry } = fake(async () => ({ ...result(), model: "jev-1.14" }));
    expect(await askSystem1(registry, config, {}, questions)).toMatchObject({ ok: true, model: "jev-1.14", selectionKey: JSON.stringify(["jev", "typesafe", "jev-latest"]) });
    const missing = fake(async () => ({ ...result(), model: "" }));
    expect(await askSystem1(missing.registry, config, {}, questions)).toMatchObject({ ok: true, model: "jev-latest" });
  });
  it("preserves permissive Jev accessors and caller validation", async () => {
    const { registry } = fake(async () => result({ q: { type: "bool", probability: 1.2 } }));
    const answer = await askSystem1(registry, config, {}, questions); expect(answer.ok).toBe(true); if (answer.ok) expect(bool(answer.answers, "q")).toBe(1.2);
  });
  it("validates every native question before the first batch", async () => {
    select("openai-decisions"); const qs = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`q${i}`, questions.q]));
    qs.q400 = { type: "box" } as unknown as ClassifierQuestion;
    const { registry, calls, finds } = fake(); expect((await askSystem1(registry, config, {}, qs)).ok).toBe(false); expect(calls).toHaveLength(0); expect(finds).toHaveLength(0);
  });
  it.each([400, 401])("batches %d questions in order, reuses state and aggregates usage", async (count) => {
    select("openai-decisions"); const qs = Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, questions.q]));
    const state = { evidence: ["unaltered"] }; const { registry, calls } = fake(async (_, ctx) => result(Object.fromEntries(Object.keys(ctx.questions).map((id) => [id, { type: "bool", probability: .7 }]))));
    const answer = await askSystem1(registry, config, state, qs); expect(answer.ok).toBe(true); expect(calls).toHaveLength(Math.ceil(count / 400)); expect(calls.every((c) => c[1].state === state)).toBe(true);
    expect(calls.map((c) => Object.keys(c[1].questions).length)).toEqual(count === 400 ? [400] : [400, 1]);
    if (answer.ok) { expect(Object.keys(answer.answers)).toEqual(Object.keys(qs)); expect(answer.usage?.totalTokens).toBe(usage.totalTokens * calls.length); }
  });
  it("fails the whole batch set without partial judgments and retains earlier and failed usage", async () => {
    select("openai-decisions"); let n = 0;
    const { registry, calls } = fake(async (_, ctx) => ++n === 1 ? result(Object.fromEntries(Object.keys(ctx.questions).map((id) => [id, { type: "bool", probability: .7 }]))) : { ...result(), stopReason: "error", errorMessage: "insufficient_quota SECRET" });
    const answer = await askSystem1(registry, config, {}, Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`q${i}`, questions.q])));
    expect(answer).toMatchObject({ ok: false, reason: "OpenAI Decisions API quota or credits exhausted", usage: { totalTokens: 26 } }); expect(answer).not.toHaveProperty("answers"); expect(calls).toHaveLength(2);
  });
  it.each([
    ["No API key found", "credentials missing"], ["401 SECRET", "credentials invalid"], ["429 SECRET", "rate limited"],
    ["insufficient_quota SECRET", "quota or credits exhausted"], ["504 SECRET", "timed out"], ["refused to answer SECRET", "invalid answers"], ["404 SECRET", "model unavailable"], ["SECRET body", "request failed"],
  ])("normalizes %s safely without retries", async (message, category) => {
    select("openai-decisions"); const { registry, calls } = fake(async () => ({ ...result(), stopReason: "error", errorMessage: message }));
    const answer = await askSystem1(registry, config, {}, questions); expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining(category), usage }); expect(JSON.stringify(answer)).not.toContain("SECRET"); expect(calls).toHaveLength(1);
  });
  it("normalizes thrown errors without exposing their body", async () => {
    select("openai-decisions"); const { registry } = fake(async () => { throw new Error("401 SECRET"); });
    expect(await askSystem1(registry, config, {}, questions)).toEqual({ ok: false, reason: "OpenAI Decisions API credentials invalid" });
  });
  it("retries a Jev timeout once, disables host retries and accumulates failed usage", async () => {
    let n = 0; const { registry, calls } = fake(async () => ++n === 1 ? { ...result(), stopReason: "error", errorMessage: "timeout" } : result());
    const answer = await askSystem1(registry, config, {}, questions); expect(answer).toMatchObject({ ok: true, usage: { totalTokens: 26 } }); expect(calls).toHaveLength(2); expect(calls.every((c) => c[2]?.retries === 0 && c[2]?.maxRetries === 0)).toBe(true);
  });
  it("honors retryTimeout false for Jev", async () => {
    const { registry, calls } = fake(async () => ({ ...result(), stopReason: "error", errorMessage: "timeout" }));
    expect(await askSystem1(registry, config, {}, questions, undefined, { retryTimeout: false })).toMatchObject({ ok: false, reason: "timed out", usage }); expect(calls).toHaveLength(1);
  });
  it("enforces a total native deadline, aborts the host, and never retries", async () => {
    select("openai-decisions"); const { registry, calls } = fake(async () => new Promise(() => {}));
    expect(await askSystem1(registry, { ...config, timeoutMs: 5 }, {}, questions)).toEqual({ ok: false, reason: "timed out" }); expect(calls).toHaveLength(1); expect(calls[0]?.[2]?.signal?.aborted).toBe(true);
  });
  it("retains usage but refuses a success that synchronously exceeds the native deadline", async () => {
    select("openai-decisions"); const { registry } = fake(async () => {
      const until = Date.now() + 10; while (Date.now() < until) { /* Simulate a blocking custom host. */ }
      return result();
    });
    expect(await askSystem1(registry, { ...config, timeoutMs: 5 }, {}, questions)).toEqual({ ok: false, reason: "timed out", usage });
  });
  it("uses remaining native time for subsequent batches rather than resetting the deadline", async () => {
    select("openai-decisions"); const { registry, calls } = fake(async (_, ctx) => { await new Promise((r) => setTimeout(r, 10)); return result(Object.fromEntries(Object.keys(ctx.questions).map((id) => [id, { type: "bool", probability: .7 }]))); });
    const answer = await askSystem1(registry, config, {}, Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`q${i}`, questions.q])));
    expect(answer.ok).toBe(true); expect(calls[1]?.[2]?.timeoutMs).toBeLessThan(calls[0]?.[2]?.timeoutMs ?? 0);
  });
  it("cancels before a call and while a call ignores its signal", async () => {
    select("openai-decisions"); const controller = new AbortController(); const { registry, calls } = fake(async () => new Promise(() => {}));
    const pending = askSystem1(registry, config, {}, questions, controller.signal); controller.abort(); expect(await pending).toEqual({ ok: false, reason: "cancelled" });
    expect(await askSystem1(registry, config, {}, questions, controller.signal)).toEqual({ ok: false, reason: "cancelled" }); expect(calls).toHaveLength(1);
  });
  it.each(["jev", "openai-decisions"])("discards stale %s success and preserves usage", async (backend) => {
    select(backend); const { registry } = fake(async () => { select(backend === "jev" ? "openai-decisions" : "jev"); return result(); });
    expect(await askSystem1(registry, config, {}, questions)).toEqual({ ok: false, reason: "System 1 changed while judging; retry the request", usage });
  });
  it("effective target recheck tolerates unrelated setting keys changing", async () => {
    const { registry } = fake(async () => { writeFileSync(system1Path(), '{"backend":"jev","future":true}'); return result(); });
    expect((await askSystem1(registry, config, {}, questions)).ok).toBe(true); expect(readFileSync(system1Path(), "utf8")).toContain("future");
  });
  it("adds only actual usage without inventing absent counters", () => {
    expect(addClassifierUsage(undefined, undefined)).toBeUndefined(); expect(addClassifierUsage(usage, undefined)).toEqual(usage); expect(addClassifierUsage(undefined, usage)).toEqual(usage);
    expect(addClassifierUsage(usage, usage)).toEqual({ input: 20, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 26, cost: { input: .2, output: .04, cacheRead: .02, cacheWrite: 0, total: .26 } });
  });
});
