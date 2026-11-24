import { describe, expect, it } from "vitest";
import { draftPrompt, MAX_QUESTIONS, outlineContext, parsePlan, refinePrompt, replyText, summaryPrompt } from "../src/protocol.ts";

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
  it("states the next prompt, or keeps what the current work needs", () => {
    expect(draftPrompt("wire the retry into the CLI")).toContain("their next prompt, sent unchanged once the summary is written): wire the retry into the CLI");
    expect(draftPrompt("  ")).toContain("keep what is needed to continue the current work");
  });

  it("asks for a focus, not a plan for the next task", () => {
    const prompt = draftPrompt("ship it\nthen verify");
    expect(prompt).toContain("ship it\nthen verify");
    expect(prompt).toContain("Do not plan the next task");
    for (const heading of ["Keep verbatim", "Keep briefly", "Drop"]) expect(prompt).toContain(`**${heading}:**`);
    expect(prompt).not.toContain("Next task");
    expect(prompt).toContain("Be specific to this session, never generic");
    expect(prompt).toContain(`questions: 0 to ${MAX_QUESTIONS}`);
    expect(prompt).toContain("If you ask questions, still write your best draft.");
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

describe("outline prompts", () => {
  it("wraps the outline", () => {
    const text = outlineContext("[user]\nhi");
    expect(text.startsWith("<session-outline>")).toBe(true);
    expect(text.endsWith("</session-outline>")).toBe(true);
    expect(text).toContain("[user]\nhi");
  });

});

describe("summaryPrompt", () => {
  it("names the focus, where the kept part starts, and Pi's format", () => {
    const text = summaryPrompt("- **Drop:** the tangent", { role: "user", excerpt: "now wire it", splitTurn: false });
    expect(text).toContain("- **Drop:** the tangent");
    expect(text).toContain('starts with the user message that begins: "now wire it"');
    expect(text).not.toContain("middle of a turn");
    for (const heading of ["## Goal", "## Constraints & Preferences", "## Progress", "## Key Decisions", "## Next Steps", "## Critical Context"]) expect(text).toContain(heading);
    expect(summaryPrompt("f", { role: "assistant", excerpt: "x", splitTurn: true })).toContain("middle of a turn");
  });
});
