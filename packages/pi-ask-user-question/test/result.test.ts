import { expect, test } from "vitest";
import { DECLINED, envelope, makeAnswer, shortenImagePaths, skippedAnswer, toolResult, userWords } from "../src/result.ts";
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

test("skipped follow-ups stay in details but not in the answer text", () => {
  const answers = [makeAnswer(questions, 0, { kind: "option", label: "dayjs" }), skippedAnswer(questions, 1)];
  expect(answers[1]).toEqual({ index: 1, header: "Features", question: "Which features?", kind: "skipped", answer: null });
  expect(envelope({ questions: questions.slice(0, 2), answers, cancelled: false })).toBe(
    'User has answered your questions: "Which library?"="dayjs". You can now continue with the user\'s answers in mind.',
  );
});

test("userWords: the answers and notes the user gave, nothing when declined", () => {
  const answers = [
    makeAnswer(questions, 0, { kind: "option", label: "date-fns" }),
    makeAnswer(questions, 1, { kind: "multi", selected: ["Auth", "Search"] }),
    makeAnswer(questions, 2, { kind: "custom", text: "Keep it small" }, "only if cheap"),
    makeAnswer(questions, 3, undefined),
    skippedAnswer(questions, 3),
  ];
  expect(userWords({ questions, answers, cancelled: false, note: "ship it" })).toBe("date-fns · Auth, Search · Keep it small (only if cheap) · ship it");
  expect(userWords({ questions, answers, cancelled: true })).toBeUndefined();
  expect(userWords({ questions, answers: [makeAnswer(questions, 3, undefined)], cancelled: false })).toBeUndefined();
  expect(userWords(undefined)).toBeUndefined();
});

test("pasted images: attached ones are named in order, the rest point to the read tool", () => {
  const answers = [makeAnswer(questions, 0, { kind: "custom", text: "see /t/p1.png and /t/p2.png" })];
  const details = { questions, answers, cancelled: false, images: ["/t/p1.png", "/t/p2.png"] };
  const result = toolResult(details, [{ path: "/t/p1.png", block: { type: "image", data: "QQ==", mimeType: "image/png" } }]);
  expect(result.content).toHaveLength(2);
  expect(result.content[1]).toEqual({ type: "image", data: "QQ==", mimeType: "image/png" });
  const text = (result.content[0] as { text: string }).text;
  expect(text).toContain("Attached below in this order: /t/p1.png.");
  expect(text).toContain("Not attached (view them with the read tool): /t/p2.png.");
  expect(envelope({ questions, answers, cancelled: false })).not.toContain("pasted");
});

test("image paths shorten to [image N]", () => {
  expect(shortenImagePaths("a p1 b", ["p1"])).toBe("a [image 1] b");
  const answers = [makeAnswer(questions, 0, { kind: "custom", text: "look /t/p1.png" })];
  expect(userWords({ questions, answers, cancelled: false, images: ["/t/p1.png"] })).toBe("look [image 1]");
});
