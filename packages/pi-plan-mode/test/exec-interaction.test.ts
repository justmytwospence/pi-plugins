import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { pausePresentation, pauseQuestion, stalledQuestion, statusQuestion } from "../src/exec-interaction.js";
import { createNegotiation, type NegotiationState } from "../src/negotiation.js";

function paused(
  reason: NonNullable<NegotiationState["pause"]>["reason"] = "user_needed",
): NegotiationState & { pause: NonNullable<NegotiationState["pause"]> } {
  return {
    ...createNegotiation("exec", 2),
    phase: "paused",
    latestExchangeId: "exec:review:1",
    pause: { reason, action: "Use the staging account.\nKeep production unchanged.", question: "Which account?\nWhy?" },
  };
}
test("pause presentation preserves exact question, recommendation and saved errors", () => {
  const n = paused();
  const before = structuredClone(n);
  assert.deepEqual(pausePresentation(n), {
    title: "Waiting for your answer",
    reason: n.pause.action,
    question: n.pause.question,
    next: "Answer below, or press Esc and answer later from the footer or /plan-exec.",
  });
  for (const reason of ["failure", "interrupted"] as const) {
    const failed = paused(reason);
    failed.pause.action = "Saved failure: network disconnected.\nNo response received.";
    assert.deepEqual(pausePresentation(failed), {
      title: "Review did not finish",
      reason: failed.pause.action,
      next: "Retry the review, finish without it, or stop.",
    });
  }
  assert.deepEqual(n, before);
});

test("exhaustion shows used revisions and retained outstanding finding count", () => {
  const n = paused("exhausted");
  n.revisionsUsed = 3;
  n.history = [
    {
      id: "previous",
      report: { report: "Done", verification: "Tests", concerns: "None" },
      responses: [],
      costUsd: 0,
      decision: {
        outcome: "changes_requested",
        summary: "Fix",
        evidence: [],
        limitations: [],
        findings: [{ id: "F1", title: "Fix", detail: "Broken", requestedChange: "Correct" }],
      },
    },
  ];
  assert.deepEqual(pausePresentation(n), {
    title: "Another revision needs your approval",
    reason: "Revisions used: 3. Outstanding findings: 1.",
    next: "Allow one more revision, finish without review, or stop.",
  });
});

test("pause dialogs offer stable choices and actions per reason", () => {
  const labels = (q: ReturnType<typeof pauseQuestion>["question"]) => q.options.map((o) => o.label);
  const failure = pauseQuestion(paused("failure"), false);
  assert.equal(failure.question.header, "Review");
  assert.match(failure.question.question, /^Review did not finish: /u);
  assert.deepEqual(labels(failure.question), ["Retry review", "Finish unreviewed", "Stop implementation"]);
  assert.deepEqual(failure.actions, {
    "Retry review": "retry",
    "Finish unreviewed": "accept",
    "Stop implementation": "stop",
  });
  assert.deepEqual(labels(pauseQuestion(paused("interrupted"), false).question), labels(failure.question));

  const exhausted = paused("exhausted");
  exhausted.revisionsUsed = 2;
  const extend = pauseQuestion(exhausted, false);
  assert.equal(extend.question.question, "Revisions used up (2). 0 findings remain.");
  assert.deepEqual(extend.actions, {
    "Allow one more revision": "extend",
    "Finish unreviewed": "accept",
    "Stop implementation": "stop",
  });

  const needed = paused("user_needed");
  needed.history = [
    {
      id: "r1",
      report: { report: "Done", verification: "Tests", concerns: "None" },
      responses: [],
      costUsd: 0,
      decision: {
        outcome: "user_needed",
        summary: "Needs a human",
        evidence: [],
        limitations: [],
        findings: [],
        question: "Which account?",
        recommendation: "Use staging.",
      },
    },
  ];
  const asked = pauseQuestion(needed, false);
  assert.equal(asked.question.header, "Reviewer");
  assert.deepEqual(labels(asked.question), ["Use recommendation", "Finish unreviewed", "Stop implementation"]);
  assert.equal(asked.question.options[0]?.description, "Use staging.");
  assert.equal(asked.actions["Use recommendation"], undefined, "the caller answers with the recommendation");

  const pending = pauseQuestion(paused("failure"), true);
  assert.equal(pending.question.header, "Completion");
  assert.deepEqual(pending.actions, { "Retry completion": "retry", "Stop implementation": "stop" });
});

test("pause questions and recommendations are cut to fit", () => {
  const n = paused("user_needed");
  n.pause.question = "Q".repeat(400);
  n.history = [
    {
      id: "r1",
      report: { report: "Done", verification: "Tests", concerns: "None" },
      responses: [],
      costUsd: 0,
      decision: {
        outcome: "user_needed",
        summary: "s",
        evidence: [],
        limitations: [],
        findings: [],
        question: "q",
        recommendation: "R".repeat(400),
      },
    },
  ];
  const { question } = pauseQuestion(n, false);
  assert.equal(question.question.length, 160);
  assert.ok(question.question.endsWith("…"));
  assert.equal(question.options[0]?.description.length, 120);
  const failed = paused("failure");
  failed.pause.action = "x".repeat(400);
  assert.equal(pauseQuestion(failed, false).question.question.length, 160);
});

test("stalled and status dialogs", () => {
  const stalled = stalledQuestion("Add rate limiting");
  assert.equal(stalled.question, 'The implementer stopped before finishing "Add rate limiting".');
  assert.deepEqual(
    stalled.options.map((o) => o.label),
    ["Continue", "Submit for review", "Stop implementation"],
  );
  const idle = statusQuestion("Add rate limiting", "Claude Sonnet 5.5", "Claude Opus 5.5", false);
  assert.equal(idle.question, 'Implementing "Add rate limiting" with Claude Sonnet 5.5; Claude Opus 5.5 on call.');
  assert.deepEqual(
    idle.options.map((o) => o.label),
    ["Continue", "Submit for review", "Stop implementation"],
  );
  const busy = statusQuestion("Add rate limiting", "Claude Sonnet 5.5", undefined, true);
  assert.equal(busy.question, 'Implementing "Add rate limiting" with Claude Sonnet 5.5.');
  assert.deepEqual(
    busy.options.map((o) => o.label),
    ["Keep going", "Stop implementation"],
  );
});

test("every dialog label fits the phone width", () => {
  const all = [
    ...(["failure", "interrupted", "exhausted", "user_needed"] as const).flatMap((reason) =>
      pauseQuestion(paused(reason), false).question.options.map((o) => o.label),
    ),
    ...pauseQuestion(paused("failure"), true).question.options.map((o) => o.label),
    ...stalledQuestion("t").options.map((o) => o.label),
    ...statusQuestion("t", "i", "p", true).options.map((o) => o.label),
    ...statusQuestion("t", "i", "p", false).options.map((o) => o.label),
  ];
  for (const label of all) assert.ok(label.length <= 24 && visibleWidth(label) <= 24, label);
  assert.throws(() => pausePresentation(createNegotiation("active", 2)), /not paused/);
  assert.throws(() => pauseQuestion(createNegotiation("active", 2), false), /not paused/);
});
