import { expect, test } from "vitest";
import { INSTRUCTION, INTERACTIVE_INSTRUCTION, PROMPT_OFFER_INSTRUCTION, extractNext } from "../src/tag.ts";

test("a last tag line is removed and becomes the suggestion", () => {
  expect(extractNext("Edited a.ts.\n\n<next>Run the tests</next>")).toEqual({ text: "Edited a.ts.", suggestion: "Run the tests", found: true });
});

test("trailing whitespace and indentation around the tag are tolerated", () => {
  expect(extractNext("Done.\n  <next> Commit the change </next>  \n\n")).toEqual({ text: "Done.", suggestion: "Commit the change", found: true });
});

test("no tag leaves the text untouched", () => {
  const text = "All done, nothing pending.\n";
  expect(extractNext(text)).toEqual({ text, found: false });
});

test("several tag lines are all removed; the last one wins", () => {
  const out = extractNext("A\n<next>first</next>\nB\n<next>second</next>");
  expect(out).toEqual({ text: "A\nB", suggestion: "second", found: true });
});

test("a tag inside prose is not a tag line and stays", () => {
  const text = "The model may end with `<next>…</next>` on its own line.";
  expect(extractNext(text)).toEqual({ text, found: false });
});

test("long suggestions are offered whole unless maxChars caps them; empty ones are stripped", () => {
  const command = `!i pi mcp add obsidian --url https://obsidian.mcp.example.com/mcp --oauth-client-id obsidian-mcp --oauth-callback-port 8765`;
  expect(extractNext(`Done.\n<next>${command}</next>`)).toEqual({ text: "Done.", suggestion: command, found: true });
  expect(extractNext(`Done.\n<next>${"x".repeat(111)}</next>`, 110)).toEqual({ text: "Done.", found: true });
  expect(extractNext(`Done.\n<next>${"x".repeat(110)}</next>`, 110).suggestion).toHaveLength(110);
  expect(extractNext("Done.\n<next>  </next>")).toEqual({ text: "Done.", found: true });
  expect(extractNext("Done.\n<next>abcdef</next>", 5)).toEqual({ text: "Done.", found: true });
});

test("explicit handoffs require the tool and a displayed receipt independently of optional tags", () => {
  expect(PROMPT_OFFER_INSTRUCTION).toContain("use offer_prompt with the complete exact text");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Only status displayed");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("not inserted until the user accepts");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Do not rely on prose or a <next> tag");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Tab/Right to copy the suggestion immediately into an editable draft");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Enter is a separate submission");
  expect(PROMPT_OFFER_INSTRUCTION).not.toContain("after the response finishes");
  expect(PROMPT_OFFER_INSTRUCTION).not.toContain("Wait for the current response to finish");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("On blocked, state the blocker");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Shell handoffs use offer_terminal");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Never include credentials");
});

test("terminal offers allow immediate draft acceptance but require waiting before interactive execution", () => {
  expect(INTERACTIVE_INSTRUCTION).toContain("Acceptance is available once displayed");
  expect(INTERACTIVE_INSTRUCTION).toContain("Tab only fills an editable draft and the user must press Enter to run it");
  expect(INTERACTIVE_INSTRUCTION).toContain("Wait for the current response to finish before pressing Enter to run an interactive command");
  expect(INTERACTIVE_INSTRUCTION).not.toContain("Acceptance becomes available after the response finishes");
});

test("the instruction is short", () => {
  expect(INSTRUCTION.length).toBeLessThan(800);
  expect(INSTRUCTION).toContain("<next>");
});

test("pending rollout is explicit without making suggestions unconditional", () => {
  expect(INSTRUCTION).toContain("release a finished implementation when rollout is still pending");
  expect(INSTRUCTION).toContain("if, and only if");
  expect(INSTRUCTION).toContain("exactly one obvious, concrete step");
  expect(INSTRUCTION).toContain("task is complete with nothing pending");
  expect(INSTRUCTION).toContain("several next steps are equally plausible");
  expect(INSTRUCTION).toContain("when you need information from the user");
  expect(INSTRUCTION).toContain("response ended in an error");
});
