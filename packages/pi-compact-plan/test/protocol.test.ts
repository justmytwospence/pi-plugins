import { describe, expect, it } from "vitest";
import { draftPrompt, MAX_QUESTIONS, parsePlan, refinePrompt, replyText } from "../src/protocol.ts";

describe("parsePlan", () => {
  it("reads the JSON reply", () => {
    const plan = parsePlan('{"questions":[{"question":"Keep approach A?","options":["Keep","Drop"]}],"draft":"Next task: x"}');
    expect(plan).toEqual({ questions: [{ question: "Keep approach A?", options: ["Keep", "Drop"] }], draft: "Next task: x" });
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
    const questions = Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}`, options: ["a", "", 3, "b", "c", "d", "e"] }));
    const plan = parsePlan(JSON.stringify({ questions: [{ question: " " }, ...questions], draft: "D" }));
    expect(plan?.questions).toHaveLength(MAX_QUESTIONS);
    expect(plan?.questions[0]).toEqual({ question: "Q0", options: ["a", "b", "c", "d"] });
  });
});

describe("prompts", () => {
  it("states the goal, or asks the model to infer it", () => {
    expect(draftPrompt("wire the retry into the CLI")).toContain("wire the retry into the CLI");
    expect(draftPrompt("  ")).toContain("infer the most likely next step");
  });

  it("lists the answers", () => {
    expect(refinePrompt([{ question: "Keep A?", answer: "Drop it" }])).toContain("Q: Keep A?\nA: Drop it");
  });
});

describe("replyText", () => {
  it("joins text blocks and skips the rest", () => {
    expect(replyText({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(replyText({ content: "plain" })).toBe("plain");
    expect(replyText(undefined)).toBe("");
  });
});
