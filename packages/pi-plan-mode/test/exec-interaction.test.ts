import assert from "node:assert/strict";
import type { InputEvent, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { ExecReplyTracker, pausePresentation, recoveryChoices } from "../src/exec-interaction.js";
import { createNegotiation, type NegotiationState, recoverNegotiation } from "../src/negotiation.js";

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
function input(text = "  Use staging.\nKeep production.  ", source: InputEvent["source"] = "interactive"): InputEvent {
  return { type: "input", text, source };
}
function delivered(text: string): MessageEndEvent {
  return { type: "message_end", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } };
}
function capture(tracker: ExecReplyTracker, n: NegotiationState, text = "Answer") {
  tracker.input(n, input(text));
  tracker.messageEnd(n, delivered(text));
  const reply = tracker.eligible(n);
  assert.ok(reply);
  return reply;
}

test("pause presentation preserves exact question, recommendation and saved errors", () => {
  const n = paused();
  const before = structuredClone(n);
  assert.deepEqual(pausePresentation(n), {
    title: "Waiting for your answer",
    reason: n.pause.action,
    question: n.pause.question,
    next: "Reply here. Ask for clarification if you need it; answering lets implementation continue.",
  });
  for (const reason of ["failure", "interrupted"] as const) {
    const failed = paused(reason);
    failed.pause.action = "Saved failure: network disconnected.\nNo response received.";
    assert.deepEqual(pausePresentation(failed), {
      title: "Review did not finish",
      reason: failed.pause.action,
      next: "Ask to retry the review, or discuss what happened. No retry has been authorized.",
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
    next: "Allow one more attempt, discuss the findings, or finish without review.",
  });
});

test("choice tables have stable actions, native select labels and widths at most 42", () => {
  for (const reason of ["failure", "interrupted", "exhausted", "user_needed"] as const) {
    const n = paused(reason);
    const before = structuredClone(n);
    const choices = recoveryChoices(n);
    assert.deepEqual(choices, [
      ...(reason === "user_needed"
        ? [{ action: "answer", label: "Answer in chat" }]
        : [
            reason === "exhausted"
              ? { action: "extend", label: "Allow one more attempt" }
              : { action: "retry", label: "Retry review" },
            { action: "discuss", label: "Discuss first" },
          ]),
      { action: "accept", label: "Finish without review" },
      { action: "stop", label: "Stop implementation" },
    ]);
    for (const choice of choices) assert.ok(visibleWidth(choice.label) <= 42);
    choices[0].label = "Changed by caller";
    assert.notEqual(recoveryChoices(n)[0].label, choices[0].label);
    assert.deepEqual(n, before);
  }
  const active = createNegotiation("active", 2);
  assert.throws(() => pausePresentation(active), /not paused/);
  assert.throws(() => recoveryChoices(active), /not paused/);
});

test("trusted replies require delivery, retain verbatim human text and consume only once", () => {
  for (const source of ["interactive", "rpc"] as const) {
    const tracker = new ExecReplyTracker();
    const n = paused();
    const before = structuredClone(n);
    const event = input(undefined, source);
    tracker.input(n, event);
    assert.equal(tracker.eligible(n), undefined);
    tracker.messageEnd(n, delivered(event.text));
    const reply = tracker.eligible(n);
    assert.ok(reply?.id);
    assert.deepEqual(
      { ...reply, id: undefined },
      {
        id: undefined,
        text: event.text,
        source,
        executionId: n.executionId,
        exchangeId: n.latestExchangeId,
      },
    );
    reply.text = "Model-authored substitution";
    assert.equal(tracker.consume(n, "fabricated"), undefined);
    assert.equal(tracker.consume(n, reply.id)?.text, event.text);
    assert.equal(tracker.consume(n, reply.id), undefined);
    tracker.messageEnd(n, delivered(event.text));
    assert.equal(tracker.eligible(n), undefined);
    assert.deepEqual(n, before);
  }
});

test("a single queued input requires delivery and every new input invalidates older IDs", () => {
  const tracker = new ExecReplyTracker();
  const n = paused();
  const first = capture(tracker, n, "First");
  tracker.input(n, input("Second"));
  assert.equal(tracker.eligible(n), undefined);
  tracker.messageEnd(n, delivered("Second"));
  const second = tracker.eligible(n);
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.equal(tracker.consume(n, first.id), undefined);
  assert.equal(tracker.consume(n, second.id)?.text, "Second");
  const third = capture(tracker, n);
  tracker.messageEnd(n, delivered("Unmatched message"));
  assert.equal(tracker.consume(n, third.id), undefined);
  tracker.input(n, input("Cannot authorize before settlement"));
  tracker.messageEnd(n, delivered("Cannot authorize before settlement"));
  assert.equal(tracker.eligible(n), undefined);
  tracker.settled();
  assert.ok(capture(tracker, n, "Fresh after settlement").id);
});

test("untrusted, command, transformed and uncaptured text cannot authorize recovery", () => {
  const n = paused();
  for (const event of [input("Extension answer", "extension"), input("/plan-exec resume yes"), input("  !echo yes")]) {
    const tracker = new ExecReplyTracker();
    tracker.input(n, event);
    tracker.messageEnd(n, delivered(event.text));
    assert.equal(tracker.eligible(n), undefined);
  }
  const tracker = new ExecReplyTracker();
  tracker.input(n, input("Original"));
  tracker.messageEnd(n, delivered("Transformed"));
  assert.equal(tracker.eligible(n), undefined);
  tracker.messageEnd(n, delivered("Original"));
  assert.equal(tracker.eligible(n), undefined, "transformed capture cannot authorize a later replay");
  tracker.messageEnd(n, delivered("No input event"));
  assert.equal(tracker.eligible(n), undefined);
});

test("identical pending text with different sources fails closed in either order", () => {
  for (const sources of [
    ["interactive", "extension"],
    ["extension", "rpc"],
    ["interactive", "rpc"],
  ] as const) {
    for (const order of [sources, [...sources].reverse()]) {
      const tracker = new ExecReplyTracker();
      const n = paused();
      for (const source of order) tracker.input(n, input("Same", source));
      tracker.messageEnd(n, delivered("Same"));
      assert.equal(tracker.eligible(n), undefined);
      tracker.messageEnd(n, delivered("Same"));
      assert.equal(tracker.eligible(n), undefined);
      tracker.settled();
      assert.ok(capture(tracker, n, "Fresh textual reply").id);
    }
  }
});

test("concurrent trusted replies quarantine through intermediate deliveries until settlement", () => {
  const tracker = new ExecReplyTracker();
  const n = paused();
  tracker.input(n, input("First"));
  tracker.input(n, input("Second", "rpc"));
  tracker.messageEnd(n, delivered("First"));
  tracker.messageEnd(n, delivered("Second"));
  tracker.input(n, input("Intermediate"));
  tracker.messageEnd(n, delivered("Intermediate"));
  assert.equal(tracker.eligible(n), undefined);
  tracker.settled();
  assert.ok(capture(tracker, n, "Fresh").id);
});

test("transformed extension input cannot borrow a queued trusted capture", () => {
  const tracker = new ExecReplyTracker();
  const n = paused();
  tracker.input(n, input("Yes", "rpc"));
  tracker.input(n, input("Notification", "extension"));
  tracker.messageEnd(n, delivered("Yes"));
  assert.equal(tracker.eligible(n), undefined);
  tracker.messageEnd(n, delivered("Notification"));
  assert.equal(tracker.eligible(n), undefined);
  tracker.settled();
  assert.ok(capture(tracker, n, "Yes").id);
});

test("noneligible blank, image-only and command inputs participate in quarantine", () => {
  const n = paused();
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  for (const second of [input(""), { ...input(""), images: [image] }, input("/plan-exec resume yes")]) {
    const tracker = new ExecReplyTracker();
    tracker.input(n, input("Trusted"));
    tracker.input(n, second);
    tracker.messageEnd(n, delivered("Trusted"));
    assert.equal(tracker.eligible(n), undefined);
    tracker.settled();
    tracker.input(n, second);
    tracker.messageEnd(n, delivered(second.text));
    assert.equal(tracker.eligible(n), undefined);
  }
});

test("recovery, new execution/exchange/pause and lifecycle invalidation clear tokens and queued input", () => {
  for (const transition of [
    (n: NegotiationState) => recoverNegotiation(n, "resume"),
    (n: NegotiationState) => ({ ...n, executionId: "other" }),
    (n: NegotiationState) => ({ ...n, latestExchangeId: "exec:review:2" }),
    (n: NegotiationState) => ({
      ...n,
      pause: { reason: "user_needed" as const, action: "Ask", question: "New question?" },
    }),
    () => undefined,
  ]) {
    const tracker = new ExecReplyTracker();
    const n = paused();
    const reply = capture(tracker, n);
    tracker.input(n, input("Queued"));
    tracker.sync(transition(n));
    assert.equal(tracker.consume(n, reply.id), undefined);
    tracker.messageEnd(n, delivered("Queued"));
    assert.equal(tracker.eligible(n), undefined);
  }
  for (const _lifecycle of ["reload", "navigation", "shutdown"]) {
    const tracker = new ExecReplyTracker();
    const n = paused();
    const reply = capture(tracker, n);
    tracker.input(n, input("Queued"));
    tracker.invalidate();
    assert.equal(tracker.consume(n, reply.id), undefined);
    tracker.messageEnd(n, delivered("Queued"));
    assert.equal(tracker.eligible(n), undefined);
    tracker.settled();
    assert.notEqual(capture(tracker, n).id, reply.id);
  }
});

test("image-only replies invalidate old authority and need a fresh textual answer", () => {
  const tracker = new ExecReplyTracker();
  const n = paused();
  const reply = capture(tracker, n);
  const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
  const event: InputEvent = { ...input(""), images: [image] };
  tracker.input(n, event);
  tracker.messageEnd(n, { type: "message_end", message: { role: "user", content: [image], timestamp: 2 } });
  assert.equal(tracker.consume(n, reply.id), undefined);
  assert.equal(tracker.eligible(n), undefined);
  assert.ok(capture(tracker, n, "Textual answer").id);
});

test("only user-needed pauses capture replies; tokens are not shared with a restored tracker", () => {
  for (const n of [undefined, createNegotiation("active", 2), paused("failure"), paused("exhausted")]) {
    const tracker = new ExecReplyTracker();
    tracker.input(n, input("Answer"));
    tracker.messageEnd(n, delivered("Answer"));
    assert.equal(tracker.eligible(n), undefined);
  }
  const n = paused();
  const original = new ExecReplyTracker();
  const reply = capture(original, n);
  const restored = new ExecReplyTracker();
  assert.equal(restored.consume(structuredClone(n), reply.id), undefined);
  restored.messageEnd(n, delivered(reply.text));
  assert.equal(restored.eligible(n), undefined);
});

test("new delivery of the same trusted text generates a fresh ID", () => {
  const tracker = new ExecReplyTracker();
  const n = paused();
  const first = capture(tracker, n);
  const second = capture(tracker, n);
  assert.notEqual(first.id, second.id);
  assert.equal(tracker.consume(n, first.id), undefined);
  assert.equal(tracker.consume(n, second.id)?.text, first.text);
});

test("non-user message endings do not consume pending input; new input invalidates older authority", () => {
  const tracker = new ExecReplyTracker();
  const n = paused();
  const reply = capture(tracker, n);
  tracker.input(n, input("Next"));
  tracker.messageEnd(n, {
    type: "message_end",
    message: { role: "custom", customType: "status", content: "Next", display: true, timestamp: 2 },
  });
  assert.equal(tracker.eligible(n), undefined);
  assert.equal(tracker.consume(n, reply.id), undefined);
  tracker.messageEnd(n, delivered("Next"));
  assert.equal(tracker.eligible(n)?.text, "Next");
});
