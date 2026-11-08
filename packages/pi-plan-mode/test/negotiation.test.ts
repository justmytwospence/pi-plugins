import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createNegotiation,
  finishReview,
  outstanding,
  parseReviewDecision,
  recoverNegotiation,
  restoreNegotiation,
  reviseNegotiationPlan,
  startReview,
  validateResponses,
} from "../src/negotiation.js";

const accepted = { outcome: "accepted", summary: "Meets approved plan.", evidence: [], limitations: [], findings: [] };
const findings = [{ id: "F1", title: "Fix", detail: "Broken", requestedChange: "Correct it" }];
const changes = parseReviewDecision(JSON.stringify({ ...accepted, outcome: "changes_requested", findings }));
const report = { report: "Changed.", verification: "Passed.", concerns: "None" };
test("strict object and single json fence only, bounded output and valid contradictions", () => {
  assert.equal(parseReviewDecision(JSON.stringify(accepted)).outcome, "accepted");
  assert.equal(parseReviewDecision("```json\n" + JSON.stringify(accepted) + "\n```").outcome, "accepted");
  for (const reply of [
    "Verdict: done",
    "[]",
    "null",
    "prefix " + JSON.stringify(accepted),
    "```json\n" + JSON.stringify(accepted) + "\n```\nprose",
    JSON.stringify({ ...accepted, outcome: "Accepted" }),
    JSON.stringify({ ...accepted, outcome: ["accepted"] }),
    JSON.stringify({ ...accepted, summary: " " }),
    JSON.stringify({ ...accepted, findings }),
    JSON.stringify({ ...accepted, outcome: "changes_requested" }),
    JSON.stringify({ ...accepted, outcome: "user_needed" }),
    JSON.stringify({ ...accepted, evidence: [""] }),
    " ".repeat(65537),
  ])
    assert.throws(() => parseReviewDecision(reply), reply.slice(0, 80));
  assert.throws(() =>
    parseReviewDecision(
      JSON.stringify({ ...accepted, outcome: "changes_requested", findings: [...findings, ...findings] }),
    ),
  );
  assert.throws(() =>
    parseReviewDecision(
      JSON.stringify({
        ...accepted,
        outcome: "changes_requested",
        findings: Array.from({ length: 31 }, (_, i) => ({ ...findings[0], id: String(i) })),
      }),
    ),
  );
  assert.equal(
    parseReviewDecision(
      JSON.stringify({ ...accepted, outcome: "user_needed", question: "Check?", recommendation: "Verify manually." }),
    ).question,
    "Check?",
  );
});
test("responses cover every finding exactly once without duplicates or unknown IDs", () => {
  const response = { id: "F1", status: "disputed", response: "Evidence disproves this." };
  assert.equal(validateResponses([response], findings).length, 1);
  for (const value of [
    undefined,
    [],
    [response, response],
    [{ ...response, id: "unknown" }],
    [{ ...response, status: "done" }],
    [{ ...response, status: ["addressed"] }],
    [{ ...response, response: " " }],
  ])
    assert.throws(() => validateResponses(value, findings));
});
test("default two fix cycles allow three reviews, failure consumes no revision and extension is explicit", () => {
  let n = createNegotiation("exec", 2);
  for (let round = 1; round <= 3; round++)
    n = finishReview(startReview(n, report, []), { decision: changes, costUsd: 0.1 });
  assert.equal(n.phase, "paused");
  assert.equal(n.revisionsUsed, 2);
  assert.equal(n.attempts, 3);
  assert.throws(() => startReview(n, report, []));
  n = recoverNegotiation(n, "resume");
  n = finishReview(startReview(n, report, []), { decision: changes, costUsd: 0.1 });
  assert.equal(n.phase, "paused");
  assert.equal(n.revisionsUsed, 3);
  assert.equal(n.history.length, 4);
  const failed = finishReview(startReview(createNegotiation("failure", 2), report, []), {
    error: "Invalid response",
    costUsd: 0.2,
  });
  assert.equal(failed.revisionsUsed, 0);
  assert.equal(failed.phase, "paused");
  const retried = finishReview(startReview(recoverNegotiation(failed, "retry"), report, []), {
    decision: parseReviewDecision(JSON.stringify(accepted)),
    costUsd: 0.1,
  });
  assert.equal(retried.reviewCostUsd, 0.30000000000000004);
  assert.equal(retried.attempts, 2);
});
test("zero/max revision settings and persisted record validation", () => {
  const n = finishReview(startReview(createNegotiation("zero", 0), report, []), { decision: changes, costUsd: 0 });
  assert.equal(n.phase, "paused");
  assert.equal(n.attempts, 1);
  assert.equal(createNegotiation("max", 5).maxRevisions, 5);
  assert.deepEqual(restoreNegotiation(n), n);
  for (const invalid of [
    { ...n, attempts: NaN },
    { ...n, maxRevisions: 6 },
    { ...n, reviewCostUsd: Infinity },
    { ...n, history: [] },
    { ...n, revisionsUsed: -1 },
    { ...n, phase: ["paused"] },
    { ...n, pause: { reason: ["failure"], action: "Retry" } },
    { ...n, reviewCostUsd: 1 },
  ])
    assert.equal(restoreNegotiation(invalid), undefined);
});

test("attempt records do not share mutable external decisions, reports or responses", () => {
  const input = { ...report };
  const response = [{ id: "F1", status: "addressed" as const, response: "Fixed." }];
  const d = structuredClone(changes);
  const initial = createNegotiation("immutable", 2);
  const reviewing = startReview(initial, input, response);
  const result = finishReview(reviewing, { decision: d, costUsd: 0.1 });
  d.findings[0].title = "Rewritten";
  input.report = "Rewritten";
  response[0].response = "Rewritten";
  assert.equal(result.history[0].decision?.findings[0].title, "Fix");
  assert.equal(result.history[0].report.report, "Changed.");
  assert.equal(result.history[0].responses[0].response, "Fixed.");
  assert.equal(initial.history.length, 0);
  assert.equal(reviewing.history[0].decision, undefined);
});

test("human-needed interlude cannot erase outstanding changes or forbid retained IDs", () => {
  let n = finishReview(startReview(createNegotiation("mixed", 2), report, []), { decision: changes, costUsd: 0 });
  const human = parseReviewDecision(
    JSON.stringify({ ...accepted, outcome: "user_needed", question: "Permission?", recommendation: "Ask user." }),
  );
  n = finishReview(startReview(n, report, [{ id: "F1", status: "blocked", response: "Need permission." }]), {
    decision: human,
    costUsd: 0,
  });
  n = recoverNegotiation(n, "resume");
  assert.throws(() => validateResponses([], outstanding(n)));
  n = finishReview(startReview(n, report, [{ id: "F1", status: "addressed", response: "Permission granted." }]), {
    decision: changes,
    costUsd: 0,
  });
  assert.equal(n.phase, "revising");
  assert.equal(n.history.at(-1)?.error, undefined);
});

test("revised plans retain identity, findings, evidence and every pause without granting recovery", () => {
  const exhausted = finishReview(startReview(createNegotiation("replan", 0), report, []), {
    decision: changes,
    costUsd: 0.25,
  });
  for (const reason of ["failure", "interrupted", "user_needed", "exhausted"] as const) {
    const state = {
      ...exhausted,
      pause: { reason, action: "Explicit recovery required.", question: "Permission?" },
      userAnswers: ["Keep the existing changes."],
    };
    const before = structuredClone(state);
    const revised = reviseNegotiationPlan(state);
    const expected = { ...before, planRevision: 2 };
    delete expected.latestReport;
    delete expected.latestExchangeId;
    assert.deepEqual(revised, expected);
    assert.deepEqual(state, before);
    assert.deepEqual(outstanding(revised), findings);
    assert.equal(revised.revisionAuthorized, false);
    assert.throws(() => startReview(revised, report, []));
    assert.deepEqual(restoreNegotiation(revised), revised);

    // The clone detaches nested evidence, pause and history, not just the state object.
    assert.ok(revised.userAnswers);
    assert.ok(revised.pause);
    assert.ok(revised.history[0].decision);
    revised.userAnswers.push("Another answer.");
    revised.pause.action = "Changed";
    revised.history[0].decision.findings[0].title = "Changed";
    assert.deepEqual(state, before);
  }
});

test("replanning preserves explicit extension permission and the spent budget", () => {
  const exhausted = finishReview(startReview(createNegotiation("extension", 0), report, []), {
    decision: changes,
    costUsd: 0.1,
  });
  const authorized = recoverNegotiation(exhausted, "resume");
  const revised = reviseNegotiationPlan(authorized);
  assert.equal(revised.phase, "revising");
  assert.equal(revised.revisionAuthorized, true);
  assert.equal(revised.revisionsUsed, 1);
  assert.equal(revised.maxRevisions, 0);
  assert.equal(revised.reviewCostUsd, 0.1);
  const reviewed = finishReview(startReview(revised, report, []), { decision: changes, costUsd: 0.2 });
  assert.equal(reviewed.phase, "paused");
  assert.equal(reviewed.pause?.reason, "exhausted");
  assert.equal(reviewed.revisionsUsed, 1);
  assert.equal(reviewed.attempts, 2);
  assert.equal(reviewed.revisionAuthorized, false);
});

test("replanning an exhausted task never replenishes automatic revision cycles", () => {
  let state = createNegotiation("bounded", 2);
  for (let round = 0; round < 3; round++)
    state = finishReview(startReview(state, report, []), { decision: changes, costUsd: 0.1 });
  state = reviseNegotiationPlan(reviseNegotiationPlan(state));
  assert.equal(state.planRevision, 3);
  assert.equal(state.phase, "paused");
  assert.equal(state.pause?.reason, "exhausted");
  assert.equal(state.revisionsUsed, 2);
  assert.equal(state.attempts, 3);
  assert.equal(state.history.length, 3);
  assert.throws(() => startReview(state, report, []));
  const resumed = recoverNegotiation(state, "resume");
  const reviewed = finishReview(startReview(resumed, report, []), { decision: changes, costUsd: 0.1 });
  assert.equal(reviewed.pause?.reason, "exhausted");
  assert.equal(reviewed.revisionsUsed, 3);
  assert.equal(reviewed.attempts, 4);
});

test("attempts stamp their plan revision, retaining revision-1 IDs and global attempt counts", () => {
  const initial = createNegotiation("identity", 2);
  assert.equal(initial.planRevision, 1);
  const first = finishReview(startReview(initial, report, []), { decision: changes, costUsd: 0.1 });
  assert.equal(first.latestExchangeId, "identity:review:1");
  assert.equal(first.history[0].planRevision, 1);
  const revised = reviseNegotiationPlan(first);
  assert.equal(revised.phase, "revising");
  assert.equal(revised.latestReport, undefined);
  assert.equal(revised.latestExchangeId, undefined);
  const responses = validateResponses([{ id: "F1", status: "addressed", response: "Fixed." }], outstanding(revised));
  const second = finishReview(startReview(revised, report, responses), { decision: changes, costUsd: 0.2 });
  assert.equal(second.latestExchangeId, "identity:plan:2:review:2");
  assert.equal(second.history[1].planRevision, 2);
  assert.deepEqual(second.history[0], first.history[0]);
  const third = startReview(reviseNegotiationPlan(second), report, responses);
  assert.equal(third.latestExchangeId, "identity:plan:3:review:3");
  assert.equal(third.history[2].planRevision, 3);
  assert.deepEqual(restoreNegotiation(third), third);
});

test("legacy states and attempts mean revision 1 without rewriting historical IDs", () => {
  const legacy = finishReview(startReview(createNegotiation("legacy", 2), report, []), {
    error: "Retry required.",
    costUsd: 0.1,
  });
  delete legacy.planRevision;
  delete legacy.history[0].planRevision;
  assert.deepEqual(restoreNegotiation(legacy), legacy);
  const retry = startReview(recoverNegotiation(legacy, "retry"), report, []);
  assert.equal(retry.latestExchangeId, "legacy:review:2");
  assert.equal(retry.history[1].planRevision, 1);
  const revised = reviseNegotiationPlan(legacy);
  assert.equal(revised.planRevision, 2);
  assert.deepEqual(revised.history, legacy.history);
  assert.deepEqual(restoreNegotiation(revised), revised);
  const current = startReview(recoverNegotiation(revised, "retry"), report, []);
  assert.equal(current.latestExchangeId, "legacy:plan:2:review:2");
  assert.equal(current.history[1].planRevision, 2);
  assert.deepEqual(restoreNegotiation(current), current);
});

test("replanning refuses in-flight reviews and consultations without mutating state", () => {
  const initial = createNegotiation("busy", 2);
  for (const state of [startReview(initial, report, []), { ...initial, phase: "consulting" as const }]) {
    const before = structuredClone(state);
    assert.throws(() => reviseNegotiationPlan(state), /in progress/);
    assert.deepEqual(state, before);
  }
  assert.equal(reviseNegotiationPlan(initial).phase, "implementing");
  assert.throws(() => reviseNegotiationPlan({ ...initial, planRevision: Number.MAX_SAFE_INTEGER }), /revision/);
});

test("restore rejects invalid state/attempt revisions and attempts from a future plan", () => {
  const state = finishReview(startReview(createNegotiation("restore-revision", 2), report, []), {
    decision: changes,
    costUsd: 0.1,
  });
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "2", null, [], {}]) {
    assert.equal(restoreNegotiation({ ...state, planRevision: invalid }), undefined);
    assert.equal(
      restoreNegotiation({ ...state, history: [{ ...state.history[0], planRevision: invalid }] }),
      undefined,
    );
  }
  const futureAttempt = { ...state.history[0], planRevision: 2 };
  assert.equal(restoreNegotiation({ ...state, history: [futureAttempt] }), undefined);
  const legacy = { ...state };
  delete legacy.planRevision;
  assert.equal(restoreNegotiation({ ...legacy, history: [futureAttempt] }), undefined);
  assert.deepEqual(restoreNegotiation({ ...state, planRevision: Number.MAX_SAFE_INTEGER }), {
    ...state,
    planRevision: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(restoreNegotiation(reviseNegotiationPlan(state)), reviseNegotiationPlan(state));
});
