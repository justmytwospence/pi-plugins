import assert from "node:assert/strict";
import { test } from "vitest";
import {
  formatPlanModeQuestionCall,
  formatPlanModeQuestionResult,
  normalizePlanModeQuestionParams,
  type PlanModeQuestion,
  planModeQuestionAnswered,
  planModeQuestionCancelled,
} from "../src/question-tool.js";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

const questions: PlanModeQuestion[] = [
  {
    id: "scope",
    header: "Scope",
    question: "How broad?",
    options: [
      { label: "Small", description: "Only the bug." },
      { label: "Broad", description: "Include cleanup." },
    ],
  },
];

test("normalizePlanModeQuestionParams validates question shape without changing schema", () => {
  const result = normalizePlanModeQuestionParams({ questions: [questions[0]] });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.questions[0]?.options[1]?.label, "Broad");
  assert.deepEqual(normalizePlanModeQuestionParams({ questions: [] }), {
    ok: false,
    error: "questions must contain 1-3 items",
  });
});

test("question calls show headers and literal prompts, expanding options without touching frozen input", () => {
  const input = freeze({ questions: structuredClone(questions) });
  const before = structuredClone(input);
  assert.equal(formatPlanModeQuestionCall(input), "Plan question\nScope: How broad?");
  const expanded = formatPlanModeQuestionCall(input, true);
  assert.match(expanded, /Scope: How broad\?\n {2}1\. Small\n {5}Only the bug\./u);
  assert.match(expanded, /2\. Broad\n {5}Include cleanup\./u);
  assert.doesNotMatch(expanded, /"questions"|"id"|"scope"/u);
  assert.deepEqual(input, before);
  assert.match(formatPlanModeQuestionCall({}), /Preparing questions/u);
  assert.match(formatPlanModeQuestionCall({ questions: [null, { header: "Scope" }] }), /Preparing question/u);
  const long = freeze({ questions: [{ ...questions[0], question: `First\n${"界".repeat(2_000)}` }] });
  assert.ok(formatPlanModeQuestionCall(long).length < 250);
  assert.ok(formatPlanModeQuestionCall(long, true).includes(`First\n${"界".repeat(2_000)}`));
});

test("answers and notes have readable selected/custom labels while JSON and details remain identical", () => {
  const answers = [
    { id: "scope", header: "Scope", question: "How broad?", answer: "Small", wasCustom: false, optionIndex: 1 },
    {
      id: "other",
      header: "Other",
      question: "Anything else?",
      answer: "First line\nSecond line",
      wasCustom: true,
      note: "Keep tests\nRun them",
    },
  ];
  const result = freeze(planModeQuestionAnswered(questions, answers));
  const before = structuredClone(result);
  assert.equal(result.content[0]?.text, JSON.stringify({ cancelled: false, answers }, null, 2));
  assert.deepEqual(result.details, { cancelled: false, questions, answers });
  const compact = formatPlanModeQuestionResult(result);
  assert.match(compact, /Scope \(selected\): Small/u);
  assert.match(compact, /Other \(custom\): First line Second line/u);
  assert.match(compact, /Note: Keep tests Run them/u);
  const expanded = formatPlanModeQuestionResult(result, { expanded: true });
  assert.match(expanded, /Other: Anything else\?/u);
  assert.ok(expanded.includes("First line\nSecond line"));
  assert.ok(expanded.includes("Note: Keep tests\nRun them"));
  assert.doesNotMatch(expanded, /"wasCustom"|"optionIndex"/u);
  assert.deepEqual(result, before);
});

test("known cancellation JSON recovers the message missing from details, including validation", () => {
  for (const [reason, title] of [
    ["cancelled", "Questions cancelled"],
    ["invalid_input", "Invalid question"],
    ["ui_unavailable", "Question UI unavailable"],
    ["plan_mode_inactive", "Plan mode inactive"],
  ] as const) {
    const message = "Keep planning.\nState assumptions.";
    const result = freeze(planModeQuestionCancelled(questions, reason, message));
    const before = structuredClone(result);
    assert.equal(result.content[0]?.text, JSON.stringify({ cancelled: true, reason, message }, null, 2));
    assert.deepEqual(result.details, { cancelled: true, reason, questions });
    assert.equal(formatPlanModeQuestionResult(result), `${title}\nKeep planning. State assumptions.`);
    assert.equal(formatPlanModeQuestionResult(result, { expanded: true }), `${title}\n${message}`);
    assert.deepEqual(result, before);
  }
  assert.equal(
    formatPlanModeQuestionResult({ details: { cancelled: true }, content: [{ type: "text", text: "{" }] }),
    "Questions cancelled",
  );
  assert.equal(
    formatPlanModeQuestionResult({ details: { cancelled: true, message: "Already recorded" } }),
    "Questions cancelled\nAlready recorded",
  );
});

test("partial, failed and empty question results are distinct; arbitrary text is not JSON-decoded", () => {
  assert.equal(formatPlanModeQuestionResult({}, { isPartial: true }), "Waiting for answers…");
  assert.equal(formatPlanModeQuestionResult({}, { isError: true }), "Question failed.");
  assert.equal(formatPlanModeQuestionResult({}), "No answers recorded.");
  const literal = '{"message":"literal JSON is not a cancellation"}';
  const result = freeze({ content: [{ type: "text", text: literal }] });
  assert.equal(formatPlanModeQuestionResult(result, { expanded: true }), literal);
});
