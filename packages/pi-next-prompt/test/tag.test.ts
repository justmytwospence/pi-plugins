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

test("explicit handoffs require the tool and a displayed receipt to claim visibility independently of tags", () => {
  expect(PROMPT_OFFER_INSTRUCTION).toContain("use offer_prompt with the complete exact text");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Only status displayed permits claiming a visible offer");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("not inserted until the user accepts");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Do not rely on prose or a <next> tag");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("do not explain keys");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("drive your own experiment or verification");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Do not re-offer");
  expect(PROMPT_OFFER_INSTRUCTION).not.toContain("Tab/Right");
  expect(PROMPT_OFFER_INSTRUCTION).not.toMatch(/\bexplain Tab/);
  expect(PROMPT_OFFER_INSTRUCTION).not.toContain("after the response finishes");
  expect(PROMPT_OFFER_INSTRUCTION).not.toContain("Wait for the current response to finish");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("On blocked, state the blocker");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Shell handoffs use offer_terminal");
  expect(PROMPT_OFFER_INSTRUCTION).toContain("Never include credentials");
});

test.each([
  ["prompt", PROMPT_OFFER_INSTRUCTION],
  ["terminal", INTERACTIVE_INSTRUCTION],
])("%s queued guidance is distinct from display or insertion", (_kind, instruction) => {
  expect(instruction).toContain("On status queued");
  expect(instruction).toContain("appears when their draft is cleared or stashed");
  expect(instruction).toContain("do not claim it was displayed or inserted");
  expect(instruction).toContain("Never include credentials");
});

test("blocked terminal guidance still names the blocker without executing or exposing private interaction", () => {
  expect(INTERACTIVE_INSTRUCTION).toContain("Only displayed permits claiming a visible command offer");
  expect(INTERACTIVE_INSTRUCTION).toContain("Unsupported layouts return an explicit blocked reason and do not run the command");
  expect(INTERACTIVE_INSTRUCTION).toContain("Keystrokes (passwords included) are never sent to the model");
  expect(INTERACTIVE_INSTRUCTION).toContain("a failure or cancellation also records the last lines of its terminal output");
  expect(INTERACTIVE_INSTRUCTION).toContain("after a failure, read the recorded output, diagnose the cause");
  expect(INTERACTIVE_INSTRUCTION).toContain("Lay out a longer one over several lines");
  expect(INTERACTIVE_INSTRUCTION).toContain("complete command however long it is: never truncate or abbreviate it");
  expect(INTERACTIVE_INSTRUCTION).toContain("Do not retry a command that may already have made changes without checking its state");
});

test("terminal offers are made last and leave running to the user without explaining keys", () => {
  expect(INTERACTIVE_INSTRUCTION).toContain("Offer it as your last action before ending your turn");
  expect(INTERACTIVE_INSTRUCTION).toContain("nothing runs until the user submits it");
  expect(INTERACTIVE_INSTRUCTION).not.toContain("Wait for the current response to finish before pressing Enter");
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

test("suggestions are requests to the agent, not manual chores for the user", () => {
  expect(INSTRUCTION).toContain("ask you to do next");
  expect(INSTRUCTION).toContain("Never use it to tell the user to do something themselves");
  expect(INTERACTIVE_INSTRUCTION).toContain("a manual step that is not a shell command belongs in prose");
});
