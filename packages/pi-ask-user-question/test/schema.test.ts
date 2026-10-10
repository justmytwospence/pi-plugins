import { describe, expect, test } from "vitest";
import { normalize, type Question, validate } from "../src/schema.ts";
import { dialog, q } from "./harness.ts";

const ok = (n: number, options = 2) => Array.from({ length: n }, (_, i) => q(`Question ${i}?`, `H${i}`, Array.from({ length: options }, (_, j) => `L${j}`)));

describe("validate", () => {
  test("1-4 questions with 2-4 options pass", () => {
    for (let n = 1; n <= 4; n++) for (let o = 2; o <= 4; o++) expect(validate(ok(n, o))).toBeUndefined();
  });

  test.each<[string, Question[], RegExp]>([
    ["no_questions", [], /at least one question/u],
    ["too_many_questions", ok(5), /at most 4 questions/u],
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
  expect(bar).toContain("□ A very long hea…");
  expect(bar).not.toContain("indeed");
});
