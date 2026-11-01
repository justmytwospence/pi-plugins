import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { askJevBool } from "../src/jev.ts";

const question = { instructions: "Does it change anything?", criteria: { true: "yes", false: "no" } };
let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "sidebar-system1-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});
const select = (backend: string) => writeFileSync(join(agentDir, "system1.json"), JSON.stringify({ backend }));
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

  it("discards a judgment when the backend changes while it is pending, retaining usage", async () => {
    let complete!: (result: unknown) => void;
    const reg = { findOfType: () => ({}), classify: () => new Promise((resolve) => { complete = resolve; }) };
    const pending = askJevBool(reg, {}, question);
    select("openai-decisions");
    complete({ answers: { q: { type: "bool", probability: 0 } }, stopReason: "stop", usage });
    expect(await pending).toMatchObject({ ok: false, reason: expect.stringMatching(/changed/), usage });
  });
});
