import assert from "node:assert/strict";
import { test } from "vitest";
import { ASK_SERVICE_CHANNEL, type AskQuestion, askUser, toAskQuestions, toPlannerAnswers } from "../src/exec-ask.js";
import type { PlanModeQuestion } from "../src/question-tool.js";

const question: AskQuestion = {
  header: "Review",
  question: "Retry?",
  options: [
    { label: "Retry review", description: "Run it again" },
    { label: "Stop", description: "End" },
  ],
};

function harness(options: { service?: (...args: unknown[]) => Promise<unknown>; hasUI?: boolean } = {}) {
  const blocked: unknown[] = [];
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const events = {
    emit: (channel: string, data: unknown) => {
      if (channel === "herdr:blocked") blocked.push(data);
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
    on: (channel: string, handler: (data: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
      return () => undefined;
    },
  };
  const calls: Array<{ kind: string; title: string; options?: string[] }> = [];
  const script: Array<string | undefined> = [];
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      select: async (title: string, choices: string[]) => {
        calls.push({ kind: "select", title, options: choices });
        return script.shift();
      },
      input: async (title: string) => {
        calls.push({ kind: "input", title });
        return script.shift();
      },
    },
  };
  if (options.service) {
    events.on(ASK_SERVICE_CHANNEL, (data) => {
      (data as { ask?: unknown }).ask = options.service;
    });
  }
  return { pi: { events } as never, ctx: ctx as never, blocked, calls, script };
}

test("without a UI nothing is asked", async () => {
  const h = harness({ hasUI: false });
  assert.equal(await askUser(h.pi, h.ctx, [question], { label: "x" }), undefined);
  assert.equal(h.calls.length, 0);
});

test("the ask service answers, receives the label, and holds herdr:blocked itself", async () => {
  const seen: unknown[] = [];
  const result = {
    cancelled: false,
    answers: [{ index: 0, header: "Review", question: "Retry?", kind: "option", answer: "Stop" }],
  };
  const h = harness({
    service: async (_ctx, params, opts) => {
      seen.push(params, opts);
      return result;
    },
  });
  assert.deepEqual(await askUser(h.pi, h.ctx, [question], { label: "Review" }), result);
  assert.deepEqual((seen[0] as { questions: unknown }).questions, [question]);
  assert.equal((seen[1] as { label: string }).label, "Review");
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.blocked, [], "the service holds it, not this caller");
});

test("a service error or throw falls back to Pi's own dialogs, holding herdr:blocked", async () => {
  for (const service of [
    async () => ({ error: "no_ui", message: "x" }),
    async () => {
      throw new Error("boom");
    },
  ]) {
    const h = harness({ service });
    h.script.push("Retry review");
    const result = await askUser(h.pi, h.ctx, [question], { label: "Review" });
    assert.deepEqual(result, {
      cancelled: false,
      answers: [{ index: 0, header: "Review", question: "Retry?", kind: "option", answer: "Retry review" }],
    });
    assert.deepEqual(h.calls[0]?.options, ["Retry review", "Stop", "Type something."]);
    assert.deepEqual(h.blocked, [{ active: true, label: "Review" }, { active: false }]);
  }
});

test("the fallback turns Type something into an input, and cancellation into cancelled", async () => {
  const h = harness();
  h.script.push("Type something.", "use staging");
  const typed = await askUser(h.pi, h.ctx, [question], { label: "Review" });
  assert.deepEqual(typed?.answers[0], {
    index: 0,
    header: "Review",
    question: "Retry?",
    kind: "custom",
    answer: "use staging",
  });
  assert.equal(h.calls[1]?.kind, "input");

  const cancelled = harness();
  cancelled.script.push(undefined);
  assert.deepEqual(await askUser(cancelled.pi, cancelled.ctx, [question], { label: "Review" }), {
    cancelled: true,
    answers: [],
  });
  assert.deepEqual(cancelled.blocked.at(-1), { active: false });

  const empty = harness();
  empty.script.push("Type something.", "  ");
  assert.equal((await askUser(empty.pi, empty.ctx, [question], { label: "Review" }))?.cancelled, true);
});

const planner: PlanModeQuestion[] = [
  {
    id: "lang",
    header: "A very long header",
    question: "Which?",
    options: [
      { label: "Python", description: "Py" },
      { label: "Node", description: "" },
    ],
  },
];

test("planner questions become dialog questions with a short header", () => {
  assert.deepEqual(toAskQuestions(planner), [
    {
      question: "Which?",
      header: "A very long ",
      options: [
        { label: "Python", description: "Py" },
        { label: "Node", description: "" },
      ],
      multiSelect: false,
    },
  ]);
  assert.equal(toAskQuestions(planner)[0]?.header.length, 12);
});

test("dialog answers map back to the planner's answers", () => {
  const base = { index: 0, header: "h", question: "Which?" };
  assert.deepEqual(
    toPlannerAnswers(planner, { cancelled: false, answers: [{ ...base, kind: "option", answer: "Node", notes: "n" }] }),
    [
      {
        id: "lang",
        header: "A very long header",
        question: "Which?",
        answer: "Node",
        wasCustom: false,
        optionIndex: 2,
        note: "n",
      },
    ],
  );
  assert.deepEqual(
    toPlannerAnswers(planner, { cancelled: false, answers: [{ ...base, kind: "custom", answer: "Rust" }] }),
    [{ id: "lang", header: "A very long header", question: "Which?", answer: "Rust", wasCustom: true }],
  );
  for (const answers of [[], [{ ...base, kind: "skipped" as const, answer: null }]]) {
    assert.deepEqual(toPlannerAnswers(planner, { cancelled: false, answers }), [
      {
        id: "lang",
        header: "A very long header",
        question: "Which?",
        answer: "No answer. Use your recommendation.",
        wasCustom: true,
      },
    ]);
  }
});
