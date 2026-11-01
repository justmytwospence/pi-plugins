import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { askJev, bool, choice, score } from "../src/jev.ts";
import { askSystem1, resolveSystem1Target } from "../src/system1.js";
import { DEFAULT_THRESHOLDS, judgeQuestions, judgeState, verdict } from "../src/judge.ts";

const rules = ["Never deploy without current approval", "Do not send private data"];
const completeAnswers = () => ({
  in_scope: { type: "bool", probability: 1 },
  requested: { type: "bool", probability: 1 },
  irreversible: { type: "bool", probability: 0 },
  remote_change: { type: "bool", probability: 0 },
  exfiltration: { type: "bool", probability: 0 },
  impact: { type: "score", score: 0, confidence: 1 },
  "rule::0": { type: "bool", probability: 0 },
  "rule::1": { type: "bool", probability: 0 },
});

let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "pi-tool-gate-jev-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", configDir);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

const config = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 10 };
const questions = { q: { type: "bool", instructions: "Is this safe?", criteria: { true: "Safe", false: "Unsafe" } } } as const;
const ok = { model: "jev-latest", answers: { q: { type: "bool", probability: 0.9 } }, stopReason: "stop" } as const;
const timedOut = { model: "jev-latest", answers: {}, stopReason: "error", errorMessage: "Request timed out after 10ms" } as const;

function registry(results: unknown[]) {
  const calls: unknown[] = [];
  return {
    calls,
    findOfType: () => ({ provider: "typesafe", id: "jev-latest" }),
    classify: async (_model: never, _context: unknown, options: unknown) => {
      calls.push(options);
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

test("verdict accepts complete bounded answers and preserves project-rule holds despite approval", () => {
  expect(verdict(completeAnswers(), rules, DEFAULT_THRESHOLDS)?.allow).toBe(true);
  const answers = completeAnswers();
  answers["rule::1"].probability = 1;
  expect(verdict(answers, rules, DEFAULT_THRESHOLDS)).toMatchObject({ allow: false, brokenRules: [rules[1]] });
  answers.impact = { type: "score", score: 3, confidence: 0 };
  expect(verdict(answers, rules, DEFAULT_THRESHOLDS)).toBeDefined();
});

test.each([null, undefined, false, 0, "answers", [], {}])("verdict rejects a malformed answer container: %j", (answers) => {
  expect(verdict(answers, rules, DEFAULT_THRESHOLDS)).toBeUndefined();
});

for (const id of Object.keys(completeAnswers())) {
  test(`verdict requires a valid ${id} answer`, () => {
    const answers: Record<string, unknown> = completeAnswers();
    delete answers[id];
    expect(verdict(answers, rules, DEFAULT_THRESHOLDS)).toBeUndefined();
    const invalid = [null, undefined, false, 1, "answer", [], {}, { type: "choice", choice: "yes" }];
    for (const answer of invalid) {
      answers[id] = answer;
      expect(verdict(answers, rules, DEFAULT_THRESHOLDS), `${id}: ${JSON.stringify(answer)}`).toBeUndefined();
    }
    if (id === "impact") {
      for (const value of [NaN, Infinity, -Infinity, -0.01, 3.01, "1", null, undefined]) {
        answers[id] = { type: "score", score: value, confidence: 1 };
        expect(verdict(answers, rules, DEFAULT_THRESHOLDS)).toBeUndefined();
      }
      for (const confidence of [NaN, Infinity, -Infinity, -0.01, 1.01, "1", null, undefined]) {
        answers[id] = { type: "score", score: 1, confidence };
        expect(verdict(answers, rules, DEFAULT_THRESHOLDS)).toBeUndefined();
      }
      answers[id] = { type: "bool", probability: 0 };
      expect(verdict(answers, rules, DEFAULT_THRESHOLDS)).toBeUndefined();
    } else {
      for (const probability of [NaN, Infinity, -Infinity, -0.01, 1.01, "1", null, undefined]) {
        answers[id] = { type: "bool", probability };
        expect(verdict(answers, rules, DEFAULT_THRESHOLDS)).toBeUndefined();
      }
      answers[id] = { type: "score", score: 0, confidence: 1 };
      expect(verdict(answers, rules, DEFAULT_THRESHOLDS)).toBeUndefined();
    }
  });
}

test("judge exposes approved snapshots as subordinate context alongside later withdrawals", () => {
  const input = {
    userRequest: ["Implement the approved plan", "Do not deploy after all"],
    approvedPlan: "Approved plan: deploy the service",
    recentIntent: "Deploying", cwd: "/project", tool: "bash", args: "deploy", rules,
  };
  const state = judgeState(input);
  expect(state.approved_plan).toBe(input.approvedPlan);
  expect(state.user_requests).toEqual(input.userRequest);
  expect(state.approved_plan_context).toMatch(/Later user instructions.*take precedence/);
  expect(state.approved_plan_context).toMatch(/plan approval never overrides/);
  expect(judgeState({ ...input, approvedPlan: undefined })).not.toHaveProperty("approved_plan");
  for (const question of Object.values(judgeQuestions(rules))) {
    expect(question.instructions).toContain("stored snapshot");
    expect(question.instructions).toContain("not as blanket permission");
    expect(question.instructions).toContain("Explicit permission rules and project rules still apply");
  }
});

test("askJev retries a timed-out singleton once within its remaining budget", async () => {
  vi.useFakeTimers();
  const reg = registry([timedOut, ok]);
  const outcome = await askJev(reg, config, {}, questions);
  expect(outcome).toMatchObject({
    ok: true, answers: ok.answers, backend: "jev", provider: config.provider, model: config.model,
    selectionKey: resolveSystem1Target(config).key,
    waterfall: ["jev"], targetKey: resolveSystem1Target(config).key, fallback: false,
    attempts: [{ backend: "jev", status: "succeeded", sdkCalls: 2 }],
  });
  expect(reg.calls).toEqual([
    { timeoutMs: 5, retries: 0, maxRetries: 0, signal: expect.any(AbortSignal) },
    { timeoutMs: 10, retries: 0, maxRetries: 0, signal: expect.any(AbortSignal) },
  ]);
});

test("singleton timeout retry cannot double the total logical deadline even when the host ignores abort", async () => {
  vi.useFakeTimers();
  const classify = vi.fn(async (_model: unknown, _context: unknown, _options: unknown) => new Promise<never>(() => {}));
  const reg = { findOfType: () => ({ provider: "typesafe", id: "jev-latest" }), classify };
  const pending = askJev(reg, { ...config, timeoutMs: 100 }, {}, questions);
  let settled = false;
  void pending.then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(49);
  expect(classify).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(classify).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(49);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({
    ok: false, code: "exhausted", latencyMs: 100,
    attempts: [{ code: "timeout", sdkCalls: 2, latencyMs: 100 }],
  });
  expect(classify.mock.calls.map(([, , options]) => options)).toEqual([
    { timeoutMs: 50, retries: 0, maxRetries: 0, signal: expect.any(AbortSignal) },
    { timeoutMs: 50, retries: 0, maxRetries: 0, signal: expect.any(AbortSignal) },
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test("askJev gives up after the retry also times out", async () => {
  const reg = registry([timedOut, new Error("Request timed out after 10ms")]);
  expect(await askJev(reg, config, {}, questions)).toMatchObject({
    ok: false, code: "exhausted", attempts: [{ backend: "jev", status: "failed", code: "timeout", sdkCalls: 2 }],
  });
  expect(reg.calls).toHaveLength(2);
});

test("askJev does not retry other errors or a cancelled request", async () => {
  const failing = registry([{ ...timedOut, errorMessage: "System One API error (400)" }]);
  expect(await askJev(failing, config, {}, questions)).toMatchObject({
    ok: false, code: "exhausted", attempts: [{ backend: "jev", status: "failed", code: "provider_error", sdkCalls: 1 }],
  });
  expect(failing.calls).toHaveLength(1);

  const controller = new AbortController();
  controller.abort();
  const cancelled = registry([timedOut, ok]);
  expect(await askJev(cancelled, config, {}, questions, controller.signal)).toMatchObject({
    ok: false, code: "cancelled", reason: "cancelled", attempts: [], latencyMs: expect.any(Number),
  });
  expect(cancelled.calls).toHaveLength(0);
});

test("compatibility exports retain accessors and use the selected target", async () => {
  expect(askJev).toBe(askSystem1);
  expect(bool(ok.answers, "q")).toBe(0.9);
  expect(choice({ q: { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1 } } }, "q")?.choice).toBe("yes");
  expect(score({ q: { type: "score", score: 1.5, confidence: 0.8 } }, "q")).toEqual({ score: 1.5, confidence: 0.8 });
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "system1.json"), JSON.stringify({ backend: "openai-decisions" }));
  const native = { provider: "system1-openai", id: "gpt-6-luna", api: "openai-decisions", baseUrl: "https://api.openai.com/v1" };
  const reg = {
    findOfType: vi.fn(() => native),
    classify: vi.fn(async () => ({ ...ok, model: native.id })),
  };
  expect(await askJev(reg, config, {}, questions)).toMatchObject({
    ok: true, backend: "openai-decisions", provider: native.provider, model: native.id,
    selectionKey: resolveSystem1Target(config).key,
  });
  expect(reg.findOfType).toHaveBeenCalledWith("classifier", native.provider, native.id);
  expect(reg.classify).toHaveBeenCalledTimes(1);
});

test("an empty question set fails without touching the registry", async () => {
  const reg = registry([ok]);
  expect(await askJev(reg, config, {}, {})).toMatchObject({
    ok: false, code: "invalid_input", attempts: [], latencyMs: expect.any(Number),
  });
  expect(reg.calls).toHaveLength(0);
});
