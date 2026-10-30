import { describe, expect, it } from "vitest";
import { draftPrompt, MAX_QUESTIONS, parsePlan, refinePrompt, replyText } from "../src/protocol.ts";

describe("parsePlan", () => {
  it("reads the JSON reply", () => {
    const plan = parsePlan('{"questions":[{"question":"Keep approach A?","header":"Approach A","options":[{"label":"Keep","description":"It still matters"},"Drop"]}],"draft":"Next task: x"}');
    expect(plan).toEqual({
      questions: [{ question: "Keep approach A?", header: "Approach A", options: [{ label: "Keep", description: "It still matters" }, { label: "Drop", description: "" }] }],
      draft: "Next task: x",
    });
  });

  it("reads JSON in a code fence or with text around it", () => {
    expect(parsePlan('```json\n{"questions":[],"draft":"D"}\n```')).toEqual({ questions: [], draft: "D" });
    expect(parsePlan('Here you go:\n{"questions":[],"draft":"D"}\nDone.')).toEqual({ questions: [], draft: "D" });
  });

  it("uses the whole text as the draft when it is not the expected JSON", () => {
    expect(parsePlan("Next task: ship it\nDrop: the tangent")).toEqual({ questions: [], draft: "Next task: ship it\nDrop: the tangent" });
    expect(parsePlan('{"draft": ""}')).toEqual({ questions: [], draft: '{"draft": ""}' });
  });

  it("returns undefined for an empty reply", () => {
    expect(parsePlan("  \n")).toBeUndefined();
  });

  it("caps and cleans the questions", () => {
    const questions = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}`, options: ["a", "", 3, "Other", "a", "b", "c", "d", "e"] }));
    const plan = parsePlan(JSON.stringify({ questions: [{ question: " " }, ...questions], draft: "D" }));
    expect(plan?.questions).toHaveLength(MAX_QUESTIONS);
    expect(plan?.questions[0]).toEqual({ question: "Q0", header: "Q0", options: ["a", "b", "c", "d"].map((label) => ({ label, description: "" })) });
  });
});

describe("prompts", () => {
  it("states the goal, or asks the model to infer it", () => {
    expect(draftPrompt("wire the retry into the CLI")).toContain("wire the retry into the CLI");
    expect(draftPrompt("  ")).toContain("infer the most likely next step");
  });

  it("prohibits questions in automatic mode while retaining the goal and draft structure", () => {
    const prompt = draftPrompt("ship it\nthen verify", true);
    expect(prompt).toContain("ship it\nthen verify");
    expect(prompt).toContain('{"questions": [], "draft": "..."}');
    expect(prompt).toContain("questions: must be []");
    expect(prompt).toContain("No questions will be asked");
    expect(prompt).toContain("make reasonable assumptions from the session context");
    for (const heading of ["Next task", "Preserve verbatim", "Preserve briefly", "Drop"]) {
      expect(prompt).toContain(`**${heading}:**`);
    }
    expect(prompt).toContain("Be specific to this session, never generic");
    expect(prompt).not.toContain("If you ask questions");
    expect(draftPrompt("ship it")).toContain(`questions: 0 to ${MAX_QUESTIONS}`);
    expect(draftPrompt("ship it")).toContain("If you ask questions, still write your best draft.");
  });

  it("lists the answers and their notes", () => {
    expect(refinePrompt([{ question: "Keep A?", answer: "Drop it", note: "but keep its test" }])).toContain("Q: Keep A?\nA: Drop it\nNote: but keep its test");
  });

  it("makes a header from the question when the model gives none or a long one", () => {
    const plan = parsePlan(JSON.stringify({ questions: [{ question: "Is the flaky test in scope?", options: ["y", "n"] }, { question: "Q", header: "A very long header", options: [] }], draft: "D" }));
    expect(plan?.questions.map((q) => q.header)).toEqual(["Is the flaky", "A very long…"]);
  });
});

describe("replyText", () => {
  it("joins text blocks and skips the rest", () => {
    expect(replyText({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(replyText({ content: "plain" })).toBe("plain");
    expect(replyText(undefined)).toBe("");
  });
});
