import { expect, test } from "vitest";
import { askJev } from "../src/jev.ts";
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

const config = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 10 };
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

test("askJev retries a timed-out request once", async () => {
  const reg = registry([timedOut, ok]);
  const outcome = await askJev(reg, config, {}, {});
  expect(outcome).toMatchObject({ ok: true, answers: ok.answers });
  expect(reg.calls).toEqual([{ timeoutMs: 10 }, { timeoutMs: 10 }]);
});

test("askJev gives up after the retry also times out", async () => {
  const reg = registry([timedOut, new Error("Request timed out after 10ms")]);
  expect(await askJev(reg, config, {}, {})).toEqual({ ok: false, reason: "timed out" });
  expect(reg.calls).toHaveLength(2);
});

test("askJev does not retry other errors or a cancelled request", async () => {
  const failing = registry([{ ...timedOut, errorMessage: "System One API error (400)" }]);
  expect(await askJev(failing, config, {}, {})).toMatchObject({ ok: false });
  expect(failing.calls).toHaveLength(1);

  const controller = new AbortController();
  controller.abort();
  const cancelled = registry([timedOut, ok]);
  expect(await askJev(cancelled, config, {}, {}, controller.signal)).toEqual({ ok: false, reason: "timed out" });
  expect(cancelled.calls).toHaveLength(1);
});
