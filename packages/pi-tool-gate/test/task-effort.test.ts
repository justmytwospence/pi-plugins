import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, onTestFinished, test } from "vitest";
import { judgeTaskEffort, recommendTaskEffort } from "../src/task-effort.js";

beforeEach(() => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "task-effort-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  onTestFinished(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
});
const distribution = { low: 0.1, medium: 0.2, high: 0.3, xhigh: 0.4 };
const answer = { type: "choice", choice: "xhigh", confidence: 0.8, probabilities: distribution };
function fake(value: unknown = answer) {
  const calls: Array<{ state: Record<string, unknown>; questions: Record<string, { instructions: string }> }> = [];
  const registry = {
    findOfType: (type: string, provider: string, id: string) => ({ type, provider, id, api: "openai-decisions", baseUrl: "https://api.openai.com/v1" }),
    classify: async (_model: unknown, context: (typeof calls)[number]) => {
      calls.push(context);
      return { stopReason: "stop", model: "actual", answers: { effort: value } };
    },
  };
  return { registry: registry as never, calls };
}
const base = { task: "build it", conversation: "context", cwd: "/work/project" };
const pressure = (p: number) => ({ state: "ready" as const, tier: "ok" as never, p });

for (const phase of ["general", "plan", "exec"] as const) {
  test(`${phase} sends bounded untrusted evidence and phase instructions`, async () => {
    const { registry, calls } = fake();
    const plan = `HEAD${"p".repeat(30_000)}TAIL`;
    const judgment = await judgeTaskEffort({ ...base, registry, phase, task: "t".repeat(7_000), plan, conversation: "c".repeat(5_000) });
    assert.equal(judgment.kind, "system1");
    const state = calls[0].state;
    assert.equal((state.task_untrusted as string).length, 6_000);
    assert.equal((state.plan_untrusted as string).length, 24_000);
    assert.match(state.plan_untrusted as string, /^HEAD[\s\S]*plan truncated[\s\S]*TAIL$/u);
    assert.equal((state.conversation_untrusted as string).length, 4_000);
    assert.equal(state.phase, phase);
    assert.equal(state.working_directory, "project");
    assert.equal(Object.hasOwn(state, "pressure"), false);
    assert.match(calls[0].questions.effort.instructions, /untrusted/u);
    assert.match(calls[0].questions.effort.instructions, { general: /requested work/u, plan: /investigation and design/u, exec: /design decisions are settled/u }[phase]);
  });
}

test("cumulative threshold tightens monotonically and retains unknown pressure", async () => {
  const { registry } = fake();
  const judgment = await judgeTaskEffort({ ...base, phase: "general", registry });
  const picks = [0, 0.5, 1].map((p) => recommendTaskEffort(judgment, pressure(p)));
  assert.deepEqual(picks.map((p) => p.kind === "system1" && p.thinkingLevel), ["high", "high", "medium"]);
  const unknown = { state: "unavailable" as const, tier: "ok" as never, p: 0, reason: "unknown" };
  const pick = recommendTaskEffort(judgment, unknown);
  assert.equal(pick.kind, "system1");
  if (pick.kind === "system1") assert.deepEqual(pick.pressure, unknown);
});

test("rejects malformed distributions and empty input without I/O", async () => {
  for (const value of [undefined, { ...answer, choice: "max" }, { ...answer, confidence: NaN },
    { ...answer, probabilities: { ...distribution, low: -1 } },
    { ...answer, probabilities: { ...distribution, low: 0.2 } },
    { ...answer, probabilities: { ...distribution, extra: 0 } }]) {
    const { registry } = fake(value === undefined ? null : value);
    assert.equal((await judgeTaskEffort({ ...base, phase: "exec", registry })).kind, "fallback");
  }
  const { registry, calls } = fake();
  assert.equal((await judgeTaskEffort({ ...base, task: " ", phase: "plan", registry })).kind, "fallback");
  assert.equal(calls.length, 0);
});

test("cancellation preserves fallback, including an in-flight request", async () => {
  const controller = new AbortController();
  const registry = { findOfType: () => ({}), classify: () => new Promise(() => {}) } as never;
  const pending = judgeTaskEffort({ ...base, phase: "general", registry, signal: controller.signal });
  controller.abort();
  const judgment = await pending;
  assert.equal(judgment.kind, "fallback");
  assert.deepEqual(recommendTaskEffort(judgment, pressure(1)), judgment);
});

test("captures actual configured System 1 provenance", async () => {
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "system1.json"), JSON.stringify({ backend: "openai-decisions" }));
  const { registry } = fake();
  const judgment = await judgeTaskEffort({ ...base, phase: "exec", registry });
  assert.equal(judgment.kind, "system1");
  if (judgment.kind === "system1") {
    assert.equal(judgment.backend, "openai-decisions");
    assert.equal(judgment.provider, "system1-openai");
    assert.equal(judgment.model, "gpt-6-luna");
    assert.ok(judgment.selectionKey);
  }
});
