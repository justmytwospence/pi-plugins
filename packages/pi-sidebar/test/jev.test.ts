import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askJevBool } from "../src/jev.ts";
import * as system1 from "../src/system1.ts";

const question = { instructions: "Does it change anything?", criteria: { true: "yes", false: "no" } };
let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "sidebar-system1-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});
const select = (backend: string) => writeFileSync(join(agentDir, "system1.json"), JSON.stringify({ backend }));
const waterfall = (order: string[]) => writeFileSync(join(agentDir, "system1.json"), JSON.stringify({ waterfall: order }));
const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function registry(results: unknown[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    findOfType: vi.fn((_type: string, provider: string, id: string) => ({ provider, id, api: provider === "system1-openai" ? "openai-decisions" : "typesafe", baseUrl: "https://api.openai.com/v1" })),
    classify: vi.fn(async () => {
      calls++;
      return results.shift();
    }),
  };
}

describe("askJevBool", () => {
  it("retries a timed-out request once", async () => {
    const reg = registry([
      { answers: {}, stopReason: "error", errorMessage: "Request timed out after 5000ms" },
      { answers: { q: { type: "bool", probability: 0.2 } }, stopReason: "stop" },
    ]);
    expect(await askJevBool(reg, {}, question)).toMatchObject({ ok: true, probability: 0.2, backend: "jev", provider: "typesafe", model: "jev-latest" });
    expect(reg.calls).toBe(2);
  });

  it("does not retry other errors", async () => {
    const reg = registry([{ answers: {}, stopReason: "error", errorMessage: "400" }]);
    expect(await askJevBool(reg, {}, question)).toMatchObject({ ok: false });
    expect(reg.calls).toBe(1);
  });

  it.each(["jev", "openai-decisions"])("uses the actual %s classifier and retains usage", async (backend) => {
    select(backend);
    const reg = registry([{ answers: { q: { type: "bool", probability: 0.02 } }, stopReason: "stop", usage }]);
    const provider = backend === "jev" ? "typesafe" : "system1-openai";
    const model = backend === "jev" ? "jev-latest" : "gpt-6-luna";
    expect(await askJevBool(reg, {}, question)).toMatchObject({ ok: true, probability: 0.02, backend, provider, model,
      selectionKey: JSON.stringify([backend, provider, model]), usage });
    expect(reg.findOfType).toHaveBeenCalledExactlyOnceWith("classifier", provider, model);
    expect(reg.classify).toHaveBeenCalledWith(expect.objectContaining({ provider, id: model }),
      { state: {}, questions: { q: { type: "bool", ...question } } },
      expect.objectContaining({ timeoutMs: expect.any(Number), retries: 0 }));
    const options = (reg.classify.mock.calls as unknown as Array<[unknown, unknown, { timeoutMs: number }]>)[0]![2];
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(5_000);
  });

  it.each([undefined, -0.01, 1.01, NaN, Infinity])("refuses missing or invalid probabilities: %s", async (probability) => {
    const reg = registry([{ answers: probability === undefined ? {} : { q: { type: "bool", probability } }, stopReason: "stop", usage }]);
    expect(await askJevBool(reg, {}, question)).toMatchObject({ ok: false, usage });
  });

  it.each([undefined, { type: "score", score: 0, confidence: 1 }, ...[-0.01, 1.01, NaN, Infinity].map((probability) => ({ type: "bool", probability }))])("defensively rejects an invalid successful transport answer: %j", async (answer) => {
    vi.spyOn(system1, "askSystem1").mockResolvedValueOnce({
      ok: true, answers: answer === undefined ? {} : { q: answer },
      backend: "jev", provider: "typesafe", model: "jev-latest",
      waterfall: ["jev"], selectionKey: '["jev","typesafe","jev-latest"]',
      targetKey: '["jev","typesafe","jev-latest"]', fallback: false,
      attempts: [], latencyMs: 12, usage,
    } as never);
    expect(await askJevBool({}, {}, question)).toEqual({
      ok: false, code: "invalid_answers", reason: "no valid answer",
      selectionKey: '["jev","typesafe","jev-latest"]', attempts: [], latencyMs: 12, usage,
    });
  });

  it.each(["429 quota exhausted", "Request timed out after 5000ms"])("does not retry or fall back from Decisions: %s", async (errorMessage) => {
    select("openai-decisions");
    const reg = registry([{ answers: {}, stopReason: "error", errorMessage, usage }]);
    expect(await askJevBool(reg, {}, question)).toMatchObject({ ok: false, usage });
    expect(reg.calls).toBe(1);
    expect(reg.findOfType).toHaveBeenCalledExactlyOnceWith("classifier", "system1-openai", "gpt-6-luna");
  });

  it("never tries Jev when the native component is missing", async () => {
    select("openai-decisions");
    const reg = { findOfType: vi.fn(() => undefined), classify: vi.fn() };
    expect(await askJevBool(reg, {}, question)).toMatchObject({ ok: false });
    expect(reg.classify).not.toHaveBeenCalled();
    expect(reg.findOfType).toHaveBeenCalledExactlyOnceWith("classifier", "system1-openai", "gpt-6-luna");
  });

  it.each([false, true])("forwards complete fallback provenance and aggregate attempted usage (OpenAI first: %s)", async (openaiFirst) => {
    const order = openaiFirst ? ["openai-decisions", "jev"] : ["jev", "openai-decisions"];
    waterfall(order);
    const winner = openaiFirst ? { backend: "jev", provider: "typesafe", model: "jev-server-version" }
      : { backend: "openai-decisions", provider: "system1-openai", model: "gpt-6-luna" };
    const targets = order.map((backend) => backend === "jev"
      ? [backend, "typesafe", "jev-latest"] : [backend, "system1-openai", "gpt-6-luna"]);
    const reg = registry([
      { answers: {}, stopReason: "error", errorMessage: "429 quota exhausted", usage },
      { model: winner.model, answers: { q: { type: "bool", probability: 0.02 } }, stopReason: "stop", usage },
    ]);
    const outcome = await askJevBool(reg, {}, question);
    expect(outcome).toMatchObject({
      ok: true, probability: 0.02, ...winner, waterfall: order, fallback: true,
      selectionKey: JSON.stringify(["waterfall", targets, 0]),
      targetKey: JSON.stringify(targets[1]),
      latencyMs: expect.any(Number),
      attempts: [
        expect.objectContaining({ backend: order[0], status: "failed", code: "quota_exhausted", targetKey: JSON.stringify(targets[0]), usage }),
        expect.objectContaining({ backend: order[1], status: "succeeded", targetKey: JSON.stringify(targets[1]), usage }),
      ],
      usage: { ...usage, input: 4, output: 2, totalTokens: 6 },
    });
    expect(outcome).not.toHaveProperty("answers");
    expect(reg.calls).toBe(2);
  });

  it("forwards typed whole-chain exhaustion, attempts, latency and aggregate usage", async () => {
    waterfall(["jev", "openai-decisions"]);
    const reg = registry([
      { answers: {}, stopReason: "error", errorMessage: "quota exhausted", usage },
      { answers: {}, stopReason: "error", errorMessage: "invalid API key", usage },
    ]);
    expect(await askJevBool(reg, {}, question)).toMatchObject({
      ok: false, code: "exhausted", reason: expect.any(String), latencyMs: expect.any(Number),
      attempts: [
        expect.objectContaining({ backend: "jev", status: "failed", code: "quota_exhausted", usage }),
        expect.objectContaining({ backend: "openai-decisions", status: "failed", code: "invalid_credentials", usage }),
      ],
      usage: { ...usage, input: 4, output: 2, totalTokens: 6 },
    });
    expect(reg.calls).toBe(2);
  });

  it("forwards a terminal safety refusal without trying the next configured provider", async () => {
    waterfall(["openai-decisions", "jev"]);
    const reg = registry([
      { answers: {}, stopReason: "error", errorMessage: "OpenAI Decisions refused to answer q", usage },
      { answers: { q: { type: "bool", probability: 0 } }, stopReason: "stop" },
    ]);
    expect(await askJevBool(reg, {}, question)).toMatchObject({
      ok: false, code: "refused", latencyMs: expect.any(Number), usage,
      attempts: [expect.objectContaining({ backend: "openai-decisions", code: "refused", status: "failed", usage })],
    });
    expect(reg.calls).toBe(1);
  });

  it.each([0, 0.5, 0.99])("does not shop providers after a valid probability of %s", async (probability) => {
    waterfall(["jev", "openai-decisions"]);
    const reg = registry([{ answers: { q: { type: "bool", probability } }, stopReason: "stop", usage }]);
    expect(await askJevBool(reg, {}, question)).toMatchObject({
      ok: true, probability, backend: "jev", fallback: false, waterfall: ["jev", "openai-decisions"],
      attempts: [expect.objectContaining({ backend: "jev", status: "succeeded" })], usage,
    });
    expect(reg.calls).toBe(1);
  });

  it("discards a judgment when the backend changes while it is pending, retaining usage", async () => {
    let complete!: (result: unknown) => void;
    const reg = { findOfType: () => ({}), classify: () => new Promise((resolve) => { complete = resolve; }) };
    const pending = askJevBool(reg, {}, question);
    select("openai-decisions");
    complete({ answers: { q: { type: "bool", probability: 0 } }, stopReason: "stop", usage });
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringMatching(/changed/), usage });
  });
});
