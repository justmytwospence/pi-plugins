import { expect, test } from "vitest";
import { DECLINED, envelope, makeAnswer, toolResult } from "../src/result.ts";
import { q } from "./harness.ts";

const questions = [
  q("Which library?", "Library", ["date-fns", "dayjs"]),
  q("Which features?", "Features", ["Auth", "Billing", "Search"], { multiSelect: true }),
  q("Anything else?", "Other", ["No", "Yes"]),
  q("Deploy where?", "Target", ["Fly", "Vercel"]),
];

test("the answered envelope: option with preview, multi, custom with notes, unanswered", () => {
  const answers = [
    makeAnswer(questions, 0, { kind: "option", label: "date-fns", preview: "```ts\nformat(d)\n```" }),
    makeAnswer(questions, 1, { kind: "multi", selected: ["Auth", "Search", "Admin pages"] }),
    makeAnswer(questions, 2, { kind: "custom", text: "  Keep it small  " }, "only if cheap"),
    makeAnswer(questions, 3, undefined),
  ];
  expect(answers[1]).toMatchObject({ kind: "multi", answer: "Auth, Search, Admin pages", selected: ["Auth", "Search", "Admin pages"] });
  expect(answers[3]).toMatchObject({ kind: "unanswered", answer: null });
  expect(envelope({ questions, answers, cancelled: false })).toBe(
    'User has answered your questions: "Which library?"="date-fns". selected preview: ```ts\nformat(d)\n```. ' +
      '"Which features?"="Auth, Search, Admin pages". ' +
      '"Anything else?"="Keep it small". user notes: only if cheap. ' +
      '"Deploy where?"="Unanswered". ' +
      "You can now continue with the user's answers in mind.",
  );
});

test("empty multi and blank typed text count as unanswered", () => {
  expect(makeAnswer(questions, 1, { kind: "multi", selected: [] }).kind).toBe("unanswered");
  expect(makeAnswer(questions, 2, { kind: "custom", text: "  " }).kind).toBe("unanswered");
});

test("declining keeps the partial answers in details", () => {
  const partial = [makeAnswer(questions, 0, { kind: "option", label: "dayjs" })];
  const result = toolResult({ questions, answers: partial, cancelled: true });
  expect(result.content[0]!.text).toBe(DECLINED);
  expect(result.details.answers).toEqual([{ index: 0, header: "Library", question: "Which library?", kind: "option", answer: "dayjs" }]);
});
