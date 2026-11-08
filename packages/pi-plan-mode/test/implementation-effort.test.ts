import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, onTestFinished, test } from "vitest";
import { pickImplementationEffort } from "../src/implementation-effort.js";
import { judgeTaskEffort, recommendTaskEffort } from "../src/task-effort.js";

let agentDir: string;
beforeEach(() => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  agentDir = mkdtempSync(join(tmpdir(), "implementation-effort-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  onTestFinished(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(agentDir, { recursive: true, force: true });
  });
});
const backend = (name: string) => writeFileSync(join(agentDir, "system1.json"), JSON.stringify({ backend: name }));
const probabilities = { low: 0.1, medium: 0.2, high: 0.3, xhigh: 0.4 };
const answer = (level: string) => ({ type: "choice", choice: level, probabilities, confidence: 0.8 });
const result = (value: unknown) => ({ stopReason: "stop", model: "resolved-model", answers: { effort: value } });
type Call = {
  context: {
    state: Record<string, unknown>;
    questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }>;
  };
  options: Record<string, unknown>;
};
function fakeRegistry(behavior: () => unknown, missing = false) {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const registry = {
    findOfType: (type: string, provider: string, id: string) => {
      lookups.push(`${type}:${provider}/${id}`);
      return missing
        ? undefined
        : { type, provider, id, api: "openai-decisions", baseUrl: "https://api.openai.com/v1" };
    },
    classify: async (_model: unknown, context: Call["context"], options: Call["options"]) => {
      calls.push({ context, options });
      return behavior();
    },
  };
  return { registry: registry as never, calls, lookups };
}
const base = { plan: "Implement the agreed plan", conversation: "Prior context", cwd: "/work/project" };

for (const level of ["low", "medium", "high", "xhigh"]) {
  test(`selects ${level} with one implementation-only question and actual Jev provenance`, async () => {
    const { registry, calls, lookups } = fakeRegistry(() => result(answer(level)));
    const pick = await pickImplementationEffort({ ...base, registry, provider: "custom", model: "alias" });
    assert.deepEqual(pick, {
      kind: "system1",
      choice: level,
      confidence: 0.8,
      probabilities,
      waterfall: ["jev"],
      targetKey: JSON.stringify(["jev", "custom", "alias"]),
      fallback: false,
      attempts: pick.kind === "system1" ? pick.attempts : [],
      backend: "jev",
      provider: "custom",
      model: "resolved-model",
      selectionKey: JSON.stringify(["jev", "custom", "alias"]),
    });
    assert.ok(pick.kind === "system1");
    assert.equal(pick.attempts[0]?.backend, "jev");
    assert.equal(pick.attempts[0]?.status, "succeeded");
    assert.equal(pick.attempts[0]?.sdkCalls, 1);
    assert.deepEqual(lookups, ["classifier:custom/alias"]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.context.state, {
      phase: "exec",
      task_untrusted: "",
      plan_untrusted: base.plan,
      conversation_untrusted: base.conversation,
      working_directory: "project",
    });
    assert.deepEqual(Object.keys(calls[0]?.context.questions ?? {}), ["effort"]);
    const question = calls[0]?.context.questions.effort;
    assert.equal(question?.type, "choice");
    assert.match(question?.instructions ?? "", /untrusted task data/u);
    assert.match(question?.instructions ?? "", /research and design decisions are settled/u);
    assert.match(question?.instructions ?? "", /reasoning remaining/u);
    assert.deepEqual(Object.keys(question?.criteria ?? {}), ["low", "medium", "high", "xhigh"]);
    assert.match(question?.criteria.xhigh ?? "", /not merely many files/u);
    const timeout = calls[0]?.options.timeoutMs;
    assert.ok(typeof timeout === "number" && timeout > 0 && timeout <= 1_500);
    assert.equal(calls[0]?.options.retries, 0);
    assert.equal(calls[0]?.options.maxRetries, 0);
  });
}

test("cumulative recommendations are monotone under pressure and preserve unavailable quota", async () => {
  const { registry } = fakeRegistry(() => result(answer("xhigh")));
  const judgment = await pickImplementationEffort({ ...base, registry });
  const picks = [0, 0.5, 1].map((p) => recommendTaskEffort(judgment, { state: "ready", tier: "none", p }));
  assert.deepEqual(
    picks.map((pick) => pick.kind === "system1" && pick.thinkingLevel),
    ["high", "high", "medium"],
  );
  const pressure = { state: "unavailable" as const, tier: "none" as const, p: 0, reason: "unknown" };
  const pick = recommendTaskEffort(judgment, pressure);
  assert.equal(pick.kind, "system1");
  if (pick.kind === "system1") {
    assert.deepEqual(pick.pressure, pressure);
    assert.deepEqual(pick.probabilities, probabilities);
    assert.equal(pick.theta, 0.5);
  }
});

for (const phase of ["general", "plan"] as const) {
  test(`${phase} uses bounded untrusted task evidence and phase-specific instructions`, async () => {
    const { registry, calls } = fakeRegistry(() => result(answer("low")));
    await judgeTaskEffort({ ...base, task: "t".repeat(7_000), registry, phase });
    const call = calls[0];
    assert.ok(call);
    assert.equal(call.context.state.phase, phase);
    assert.equal((call.context.state.task_untrusted as string).length, 6_000);
    assert.match(
      calls[0]?.context.questions.effort?.instructions ?? "",
      phase === "plan" ? /investigation and design/u : /requested work/u,
    );
    assert.doesNotMatch(JSON.stringify(calls[0]?.context.state), /quota|pressure/u);
  });
}

test("in-flight cancellation falls back without a reusable result", async () => {
  const { registry, calls } = fakeRegistry(() => new Promise(() => {}));
  const controller = new AbortController();
  const pending = pickImplementationEffort({ ...base, registry, signal: controller.signal });
  controller.abort();
  const judgment = await pending;
  assert.equal(judgment.kind, "fallback");
  assert.deepEqual(recommendTaskEffort(judgment, { state: "unavailable", tier: "none", p: 0 }), judgment);
  assert.equal(calls.length, 1);
});

test("caps plan with its head, tail and marker and keeps the conversation tail", async () => {
  const { registry, calls } = fakeRegistry(() => result(answer("medium")));
  const plan = `HEAD${"a".repeat(30_000)}TAIL`;
  const conversation = `START${"b".repeat(5_000)}END`;
  await pickImplementationEffort({ ...base, plan, conversation, registry });
  const state = calls[0]?.context.state;
  const clipped = state?.plan_untrusted as string;
  assert.equal(clipped.length, 24_000);
  assert.match(clipped, /^HEAD/u);
  assert.match(clipped, /plan truncated/u);
  assert.match(clipped, /TAIL$/u);
  assert.equal(state?.conversation_untrusted, conversation.slice(-4_000));
});

test("Decisions uses its selected target and actual provenance", async () => {
  backend("openai-decisions");
  const { registry, lookups } = fakeRegistry(() => result(answer("high")));
  const pick = await pickImplementationEffort({ ...base, registry, provider: "ignored", model: "ignored" });
  assert.deepEqual(pick, {
    kind: "system1",
    choice: "high",
    confidence: 0.8,
    probabilities,
    waterfall: ["openai-decisions"],
    targetKey: JSON.stringify(["openai-decisions", "system1-openai", "gpt-6-luna"]),
    fallback: false,
    attempts: pick.kind === "system1" ? pick.attempts : [],
    backend: "openai-decisions",
    provider: "system1-openai",
    model: "gpt-6-luna",
    selectionKey: JSON.stringify(["openai-decisions", "system1-openai", "gpt-6-luna"]),
  });
  assert.deepEqual(lookups, ["classifier:system1-openai/gpt-6-luna"]);
});

test("empty plans and pre-aborted requests never call the classifier", async () => {
  const { registry, calls, lookups } = fakeRegistry(() => assert.fail("unexpected call"));
  assert.equal((await pickImplementationEffort({ ...base, registry, plan: " \n" })).kind, "fallback");
  const controller = new AbortController();
  controller.abort();
  assert.equal((await pickImplementationEffort({ ...base, registry, signal: controller.signal })).kind, "fallback");
  assert.equal(calls.length, 0);
  assert.equal(lookups.length, 0);
});

test("missing registry, model, credentials, thrown errors and timeout fall back without retry", async () => {
  assert.equal((await pickImplementationEffort({ ...base, registry: undefined as never })).kind, "fallback");
  const missing = fakeRegistry(() => assert.fail("unexpected call"), true);
  assert.equal((await pickImplementationEffort({ ...base, registry: missing.registry })).kind, "fallback");
  assert.equal(missing.calls.length, 0);
  for (const behavior of [
    () => ({ stopReason: "error", errorMessage: "No API key", answers: {} }),
    () => {
      throw new Error("transport exploded");
    },
    () => new Promise(() => {}),
  ]) {
    const fake = fakeRegistry(behavior);
    assert.equal(
      (await pickImplementationEffort({ ...base, registry: fake.registry, timeoutMs: 10 })).kind,
      "fallback",
    );
    assert.equal(fake.calls.length, 1);
  }
});

test("rejects malformed choices, confidence and probability distributions", async () => {
  const valid = answer("high");
  for (const malformed of [
    undefined,
    { type: "bool", probability: 1 },
    { ...valid, choice: "max" },
    { ...valid, confidence: Number.NaN },
    { ...valid, confidence: -0.1 },
    { ...valid, confidence: 1.1 },
    { ...valid, probabilities: null },
    { ...valid, probabilities: { ...probabilities, low: NaN } },
    { ...valid, probabilities: { ...probabilities, low: -0.1 } },
    { ...valid, probabilities: { ...probabilities, low: 1.1 } },
    { ...valid, probabilities: { ...probabilities, low: 0.2 } },
    { ...valid, probabilities: { low: 0.1, medium: 0.2, high: 0.7 } },
    { ...valid, probabilities: { ...probabilities, max: 0 } },
  ]) {
    const { registry } = fakeRegistry(() => result(malformed));
    assert.equal((await pickImplementationEffort({ ...base, registry })).kind, "fallback");
  }
});

test("backend changes during a request discard the answer without another call", async () => {
  let finish!: (value: unknown) => void;
  const { registry, calls } = fakeRegistry(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = pickImplementationEffort({ ...base, registry });
  backend("openai-decisions");
  finish(result(answer("low")));
  const pick = await pending;
  assert.equal(pick.kind, "fallback");
  assert.match(pick.kind === "fallback" ? pick.reason : "", /System 1 changed/u);
  assert.equal(calls.length, 1);
});
