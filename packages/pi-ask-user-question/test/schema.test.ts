import { describe, expect, test } from "vitest";
import { normalize, type Question, shownQuestions, validate } from "../src/schema.ts";
import { dialog, q } from "./harness.ts";

const follow = (question: string, header: string, answers: string[]) => q(question, `F-${question}`, ["a", "b"], { showIf: { header, answers } });
const ok = (n: number, options = 2) => Array.from({ length: n }, (_, i) => q(`Question ${i}?`, `H${i}`, Array.from({ length: options }, (_, j) => `L${j}`)));

describe("validate", () => {
  test("1-4 questions with 2-4 options pass", () => {
    for (let n = 1; n <= 4; n++) for (let o = 2; o <= 4; o++) expect(validate(ok(n, o))).toBeUndefined();
  });

  test.each<[string, Question[], RegExp]>([
    ["no_questions", [], /at least one question/u],
    ["too_many_questions", ok(5), /at most 4 questions/u],
    ["too_many_questions", [...ok(4), follow("Five?", "H0", ["L0"]), follow("Six?", "H0", ["L0"]), follow("Seven?", "H0", ["L0"])], /or 6 when/u],
    ["invalid_show_if", [follow("First?", "H0", ["L0"]), ...ok(1)], /no earlier question has that header/u],
    ["invalid_show_if", [...ok(1), q("Again?", "H0", ["x", "y"]), follow("Which?", "H0", ["x"])], /more than one earlier question/u],
    ["invalid_show_if", [...ok(1), follow("Which?", "H0", ["L9"])], /"L9", which is not an option of "H0" \("L0", "L1"\)/u],
    ["invalid_show_if", [...ok(1), follow("Which?", "H0", [])], /at least one label/u],
    ["duplicate_question", [q("Same?", "A", ["x", "y"]), q("Same?", "B", ["x", "y"])], /appears twice/u],
    ["empty_options", [q("One?", "A", ["x"])], /at least 2 options/u],
    ["too_many_options", [q("Many?", "A", ["a", "b", "c", "d", "e"])], /more than 4 options/u],
    ["duplicate_option_label", [q("Dup?", "A", ["x", "x"])], /two options labelled "x"/u],
    ["reserved_label", [q("Other?", "A", ["x", "Other"])], /"Other" is reserved/u],
    ["reserved_label", [q("Typed?", "A", ["x", "type something"])], /is reserved/u],
  ])("%s", (error, questions, message) => {
    const result = validate(questions);
    expect(result?.error).toBe(error);
    expect(result?.message).toMatch(/^Error: /u);
    expect(result?.message).toMatch(message);
  });
});

test("normalize: line endings, one-line headers and labels, multiSelect default", () => {
  const [n] = normalize({
    questions: [
      {
        question: "Which?\r\nReally? ",
        header: " Auth\nmethod ",
        options: [
          { label: " A ", description: "a\r\nb", preview: "```ts\r\nx\r\n```" },
          { label: "B", description: "", preview: "  " },
        ],
      },
    ],
  });
  expect(n).toEqual({
    question: "Which?\nReally?",
    header: "Auth method",
    options: [
      { label: "A", description: "a\nb", preview: "```ts\nx\n```" },
      { label: "B", description: "" },
    ],
    multiSelect: false,
  });
});

test("a long header is accepted and cut in the tab bar", () => {
  const questions = [q("First?", "A very long header indeed", ["x", "y"]), q("Second?", "Short", ["x", "y"])];
  expect(validate(questions)).toBeUndefined();
  const { frames } = dialog(questions, []);
  const bar = frames[0]!.find((line) => line.includes("Short"))!;
  expect(bar).toContain("→ A very long hea…");
  expect(bar).not.toContain("indeed");
});

test("follow-ups: up to 6 questions when no more than 4 are unconditional", () => {
  expect(validate([...ok(4), follow("Five?", "H0", ["L0"]), follow("Six?", "H1", ["L1"])])).toBeUndefined();
});

test("shownQuestions: a follow-up shows when its question is shown and picked a listed label", () => {
  const questions = [ok(1)[0]!, follow("Second?", "H0", ["L1"]), follow("Third?", "F-Second?", ["b"])];
  expect(shownQuestions(questions, [])).toEqual([true, false, false]);
  expect(shownQuestions(questions, [["L1"]])).toEqual([true, true, false]);
  expect(shownQuestions(questions, [["L1"], ["b"]])).toEqual([true, true, true]);
  // A hidden follow-up hides its own follow-ups, even if it still holds an answer.
  expect(shownQuestions(questions, [["L0"], ["b"]])).toEqual([true, false, false]);
  // Multi-select: any listed label.
  expect(shownQuestions(questions, [["L0", "L1"]])).toEqual([true, true, false]);
});

test("normalize keeps showIf on one line", () => {
  const [, n] = normalize({
    questions: [
      { question: "A?", header: "Auth", options: [{ label: "OAuth", description: "" }, { label: "Keys", description: "" }] },
      { question: "B?", header: "B", options: [{ label: "x", description: "" }, { label: "y", description: "" }], showIf: { header: " Auth\n", answers: [" OAuth "] } },
    ],
  });
  expect(n!.showIf).toEqual({ header: "Auth", answers: ["OAuth"] });
});
