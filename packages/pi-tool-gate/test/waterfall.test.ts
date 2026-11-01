import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import toolGate, { CLASSIFIER_UNAVAILABLE } from "../src/index.ts";
import * as judge from "../src/judge.ts";
import {
  addClassifierUsage, resetSystem1Runtime, resolveSystem1Target, SYSTEM1_CHANGED,
  type ClassifierUsage, type System1Backend,
} from "../src/system1.js";
import { assistantEntry, harness, userEntry } from "./harness.ts";

let dir: string;
let stop: (() => Promise<unknown>) | undefined;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pi-tool-gate-waterfall-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(dir, "pi"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(dir, "xdg"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected live request in offline gate test"); }));
});
afterEach(async () => {
  await stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const config = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 6000 };
const safe = {
  requested: { type: "bool", probability: 0.1 },
  in_scope: { type: "bool", probability: 0.95 },
  irreversible: { type: "bool", probability: 0.05 },
  remote_change: { type: "bool", probability: 0.02 },
  exfiltration: { type: "bool", probability: 0.01 },
  impact: { type: "score", score: 1, confidence: 0.9 },
};
const unsafe = { ...safe, remote_change: { type: "bool", probability: 0.99 } };
const workaround = { workaround: {
  type: "choice", choice: "local", confidence: 1,
  probabilities: Object.fromEntries(Object.keys(judge.WORKAROUNDS).map(key => [key, key === "local" ? 1 : 0])),
} };
const usage = (n: number): ClassifierUsage => ({
  input: n, output: n * 2, cacheRead: n * 3, cacheWrite: n * 4, totalTokens: n * 10,
  cost: { input: n / 1000, output: n / 2000, cacheRead: n / 4000, cacheWrite: n / 8000, total: n * 0.001875 },
});
const failed = (message: string, n = 1) => ({ stopReason: "error", answers: {}, errorMessage: message, usage: usage(n) });
const success = (answers: unknown = safe, n = 2) => ({ stopReason: "stop", answers, usage: usage(n) });
const call = (command = "npm test", id = "t1") => ({ type: "tool_call", toolName: "bash", input: { command }, toolCallId: id });
const result = (id = "t1") => ({ toolCallId: id, toolName: "bash", content: [], isError: false });
const targetKey = (backend: System1Backend) => JSON.stringify(backend === "jev"
  ? ["jev", config.provider, config.model] : [backend, "system1-openai", "gpt-6-luna"]);
function select(waterfall: System1Backend[]) {
  mkdirSync(path.join(dir, "pi"), { recursive: true });
  writeFileSync(path.join(dir, "pi", "system1.json"), JSON.stringify({ waterfall, backend: waterfall[0] }));
}
function setup(answer: (backend: System1Backend, questions: Record<string, unknown>) => unknown, hasUI = true) {
  select(["jev", "openai-decisions"]);
  const cwd = path.join(dir, "app");
  mkdirSync(cwd, { recursive: true });
  const h = harness({ nonGitCwd: cwd });
  toolGate(h.pi);
  const branch = [userEntry("Fix the failing test; private user text"), assistantEntry("I'll rerun the tests.")];
  const classify = vi.fn(async (model: { provider: string; id: string }, context: { questions: Record<string, unknown> }) => ({
    model: model.provider === "typesafe" ? "jev-server-version" : model.id,
    ...answer(model.provider === "typesafe" ? "jev" : "openai-decisions", context.questions) as object,
  }));
  const registry = {
    findOfType: vi.fn((_type: string, provider: string, id: string) => ({ provider, id,
      ...(provider === "system1-openai" ? { api: "openai-decisions", baseUrl: "https://api.openai.com/v1" } : {}),
    })),
    classify,
  };
  const ctx = h.ctx({ cwd, hasUI, modelRegistry: registry,
    sessionManager: { getBranch: () => branch, getSessionId: () => "waterfall-session", getLeafId: () => null },
  });
  stop = () => h.emit("session_shutdown", {}, ctx);
  return { h, ctx, registry, classify };
}
const entries = (h: ReturnType<typeof harness>, type: string): any[] => h.entries.filter(e => e.customType === type).map(e => e.data);
const backends = (classify: ReturnType<typeof vi.fn>) => classify.mock.calls.map(([model]) => model.provider);
function expectProvenance(record: any, backend: System1Backend, fallback: boolean, selectionKey: string) {
  expect(record).toMatchObject({
    backend, provider: backend === "jev" ? "typesafe" : "system1-openai",
    model: backend === "jev" ? "jev-server-version" : "gpt-6-luna",
    waterfall: ["jev", "openai-decisions"], selectionKey, targetKey: targetKey(backend), fallback,
    attempts: expect.any(Array),
  });
  expect(record.attempts.at(-1)).toMatchObject({ backend, targetKey: targetKey(backend), status: "succeeded" });
}

describe("tool gate System 1 waterfall", () => {
  test("fallback succeeds before any identical-call failure hold, reports aggregate usage once, and audits metadata only", async () => {
    const { h, ctx, registry, classify } = setup(backend => backend === "jev"
      ? failed("insufficient_quota private-provider-secret", 3) : success(safe, 5));
    await h.emit("session_start", {}, ctx);
    const key = resolveSystem1Target(config).key;
    expect(await h.emit("tool_call", call(), ctx)).toBeUndefined();
    expect(backends(classify)).toEqual(["typesafe", "system1-openai"]);
    expect(ctx.ui.selects).toEqual([]);
    const decision = entries(h, "tool-gate:decision")[0];
    expect(decision.action).toBe("allow");
    expectProvenance(decision.classifier, "openai-decisions", true, key);
    expect(decision.classifier.attempts[0]).toMatchObject({ backend: "jev", status: "failed", code: "quota_exhausted", usage: usage(3) });
    const total = addClassifierUsage(usage(3), usage(5));
    expect(decision.usage).toEqual(total);
    expect(await h.emit("tool_result", { ...result(), usage: usage(7) }, ctx)).toEqual({ usage: addClassifierUsage(total, usage(7)) });
    expect(await h.emit("tool_result", result(), ctx)).toBeUndefined();
    // A failed preferred provider is not a cached whole-chain failure on an identical call.
    expect(await h.emit("tool_call", call("npm test", "t2"), ctx)).toBeUndefined();
    expect(backends(classify)).toEqual(["typesafe", "system1-openai", "system1-openai"]);
    expect(ctx.ui.selects).toEqual([]);
    expect(registry.findOfType).toHaveBeenCalledWith("classifier", "system1-openai", "gpt-6-luna");
    const audit = entries(h, "system1:decision");
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ ok: true, ...decision.classifier, usage: total });
    expect(JSON.stringify(audit)).not.toMatch(/private-provider-secret|private user text|user_requests|tool_call|"answers"/u);
    expect(JSON.stringify(ctx.ui.notes)).not.toContain("private-provider-secret");
    expect(ctx.ui.notes.some((note: { message: string }) => note.message.includes("trying OpenAI Decisions"))).toBe(true);
    expect(h.events.some(e => e.channel === SYSTEM1_CHANGED)).toBe(false);
  });

  test.each([true, false])("only total exhaustion caches an identical-call allow-once hold (UI=%s)", async hasUI => {
    const { h, ctx, classify } = setup(() => failed("malformed probability private-provider-secret", 3), hasUI);
    await h.emit("session_start", {}, ctx);
    expect(await h.emit("tool_call", call(), ctx)).toMatchObject({ block: true, reason: expect.stringContaining("ClassifierUnavailableError") });
    expect(backends(classify)).toEqual(["typesafe", "system1-openai"]);
    const decision = entries(h, "tool-gate:decision")[0];
    expect(decision).toMatchObject({ action: "block", code: "exhausted", attempts: [
      { backend: "jev", status: "failed", code: "invalid_answers" },
      { backend: "openai-decisions", status: "failed", code: "invalid_answers" },
    ] });
    expect(decision.usage).toEqual(addClassifierUsage(usage(3), usage(3)));
    ctx.ui.selectAnswers.push("Allow once");
    const retry = await h.emit("tool_call", call(), ctx);
    if (hasUI) {
      expect(retry).toBeUndefined();
      expect(ctx.ui.selects[0].options).toEqual(["Allow once", "Block", "Block with a message"]);
    } else {
      expect(retry).toMatchObject({ block: true, reason: expect.stringContaining("no user to approve") });
      expect(ctx.ui.selects).toEqual([]);
    }
    expect(classify).toHaveBeenCalledTimes(2);
    expect(await h.emit("tool_result", result(), ctx)).toBeUndefined();
    expect(JSON.stringify(h.entries)).not.toContain("private-provider-secret");
  });

  test.each(["order", "suffix", "reset"] as const)("an exhausted hold is keyed by full chain and reset identity (%s)", async change => {
    const { h, ctx, registry, classify } = setup(() => failed("malformed probability"));
    await h.emit("session_start", {}, ctx);
    const before = resolveSystem1Target(config).key;
    expect(await h.emit("tool_call", call(), ctx)).toMatchObject({ block: true });
    expect(classify).toHaveBeenCalledTimes(2);
    if (change === "order") select(["openai-decisions", "jev"]);
    else if (change === "suffix") select(["jev"]);
    else resetSystem1Runtime(registry);
    expect(resolveSystem1Target(config).key).not.toBe(before);
    classify.mockImplementation(async model => ({ model: model.id, ...success() }));
    // No event: the consumer must poll the chain/reset identity itself.
    expect(await h.emit("tool_call", call(), ctx)).toBeUndefined();
    expect(classify).toHaveBeenCalledTimes(3);
    expect(ctx.ui.selects).toEqual([]);
  });

  test("a native safety refusal is terminal, never fails over or becomes an exhausted retry hold", async () => {
    const { h, ctx, classify } = setup(backend => backend === "openai-decisions"
      ? failed("OpenAI Decisions refused to answer requested", 4) : success());
    select(["openai-decisions", "jev"]);
    await h.emit("session_start", {}, ctx);
    for (let i = 0; i < 2; i++) {
      expect(await h.emit("tool_call", call(), ctx)).toMatchObject({ block: true, reason: expect.stringContaining("ClassifierRefusedError") });
    }
    expect(backends(classify)).toEqual(["system1-openai", "system1-openai"]);
    expect(ctx.ui.selects).toEqual([]);
    for (const decision of entries(h, "tool-gate:decision")) {
      expect(decision).toMatchObject({ code: "refused", usage: usage(4), attempts: [{ backend: "openai-decisions", code: "refused" }] });
    }
  });

  test("a successful unsafe verdict stays held instead of shopping another backend for a safe answer", async () => {
    const { h, ctx, classify } = setup((backend, questions) => success(questions.workaround ? workaround : backend === "jev" ? unsafe : safe));
    await h.emit("session_start", {}, ctx);
    expect(await h.emit("tool_call", call("npm publish"), ctx)).toMatchObject({ block: true, reason: expect.stringContaining("make your case") });
    expect(backends(classify)).toEqual(["typesafe", "typesafe"]);
    expect(entries(h, "tool-gate:decision")[0].action).toBe("hold");
    expect(ctx.ui.selects).toEqual([]);
    expect(await h.emit("tool_result", result(), ctx)).toBeUndefined();
  });

  test("verdict and workaround retain separate actual winners, complete attempts, and all reported usage", async () => {
    const { h, ctx, classify } = setup((backend, questions) => questions.workaround
      ? backend === "jev" ? failed("invalid probability private-provider-secret", 5) : success(workaround, 7)
      : success(unsafe, 3));
    await h.emit("session_start", {}, ctx);
    const key = resolveSystem1Target(config).key;
    expect(await h.emit("tool_call", call("npm publish"), ctx)).toMatchObject({ block: true, reason: expect.stringContaining("Keep it local") });
    expect(backends(classify)).toEqual(["typesafe", "typesafe", "system1-openai"]);
    const decision = entries(h, "tool-gate:decision")[0];
    const advice = entries(h, "tool-gate:workaround")[0];
    expectProvenance(decision.classifier, "jev", false, key);
    expectProvenance(advice.classifier, "openai-decisions", true, key);
    expect(decision.usage).toEqual(usage(3));
    expect(advice).toMatchObject({ toolCallId: "t1", tool: "bash", usage: addClassifierUsage(usage(5), usage(7)) });
    expect(advice.classifier.attempts[0]).toMatchObject({ code: "invalid_answers", usage: usage(5) });
    expect(advice.classifier.attempts[1]).toMatchObject({ usage: usage(7) });
    expect(entries(h, "system1:decision")).toHaveLength(2);
    expect(await h.emit("tool_result", result(), ctx)).toBeUndefined();
    expect(JSON.stringify(h.entries)).not.toContain("private-provider-secret");
  });

  test("an exhausted workaround records typed failures and aggregate usage without overwriting the valid verdict", async () => {
    const { h, ctx } = setup((_backend, questions) => questions.workaround ? failed("invalid probability", 5) : success(unsafe, 3));
    await h.emit("session_start", {}, ctx);
    expect(await h.emit("tool_call", call("npm publish"), ctx)).toMatchObject({ block: true });
    expect(entries(h, "tool-gate:decision")[0]).toMatchObject({ action: "hold", classifier: { backend: "jev", fallback: false }, usage: usage(3) });
    const advice = entries(h, "tool-gate:workaround")[0];
    expect(advice).toMatchObject({ code: "exhausted", attempts: [
      { backend: "jev", code: "invalid_answers", usage: usage(5) },
      { backend: "openai-decisions", code: "invalid_answers", usage: usage(5) },
    ], usage: addClassifierUsage(usage(5), usage(5)) });
    expect(advice).not.toHaveProperty("classifier");
    expect(await h.emit("tool_result", result(), ctx)).toBeUndefined();
  });

  test("consumer-invalid verdicts are not cached as chain exhaustion", async () => {
    const { h, ctx, classify } = setup(() => success());
    await h.emit("session_start", {}, ctx);
    vi.spyOn(judge, "verdict").mockReturnValueOnce(undefined);
    expect(await h.emit("tool_call", call(), ctx)).toMatchObject({ block: true, reason: expect.stringContaining("ClassifierInvalidAnswerError") });
    expect(entries(h, "tool-gate:decision")[0]).toMatchObject({ classifier: { backend: "jev" }, usage: usage(2) });
    expect(await h.emit("tool_call", call(), ctx)).toBeUndefined();
    expect(backends(classify)).toEqual(["typesafe", "typesafe"]);
    expect(ctx.ui.selects).toEqual([]);
  });

  test("disabled and invalid settings never gain a cached allow-once bypass", async () => {
    const { h, ctx, classify } = setup(() => success());
    writeFileSync(path.join(dir, "pi", "tool-gate.json"), JSON.stringify({ jev: { enabled: false } }));
    await h.emit("session_start", {}, ctx);
    for (let i = 0; i < 2; i++) expect(await h.emit("tool_call", call(), ctx)).toMatchObject({ block: true, reason: expect.stringContaining("ClassifierDisabledError") });
    writeFileSync(path.join(dir, "pi", "tool-gate.json"), "{}");
    writeFileSync(path.join(dir, "pi", "system1.json"), JSON.stringify({ waterfall: [] }));
    for (let i = 0; i < 2; i++) expect(await h.emit("tool_call", call(), ctx)).toMatchObject({ block: true, reason: expect.stringContaining(CLASSIFIER_UNAVAILABLE) });
    expect(classify).not.toHaveBeenCalled();
    expect(ctx.ui.selects).toEqual([]);
  });
});
