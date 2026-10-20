import { expect, test, vi } from "vitest";
import { blockedSummary, fallbackSummary, oneLine, summaryModel, turnSummary, turnTranscript, type SummaryRegistry } from "../src/summary.ts";

const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string, calls: Array<{ name: string; arguments?: unknown }> = [], stopReason = "stop") => ({
  type: "message",
  message: {
    role: "assistant",
    stopReason,
    content: [...(text ? [{ type: "text", text }] : []), ...calls.map((c) => ({ type: "toolCall", ...c }))],
  },
});

const LONG = "I changed the parser so empty lines are skipped.\n\n| file | change |\n|---|---|\n| a.ts | x |\n\nTests pass.";
const branch = [
  user("old prompt"),
  assistant("old reply"),
  user("Fix the parser"),
  assistant("", [{ name: "bash", arguments: { command: "npm test", description: "run tests" } }]),
  { type: "message", message: { role: "toolResult", content: "ok" } },
  assistant(LONG),
];

function registry(reply: string | (() => Promise<any>), models = ["claude-haiku-5-5", "claude-haiku-4-5"]) {
  const complete = vi.fn(typeof reply === "string" ? async () => ({ stopReason: "stop", content: [{ type: "text", text: reply }] }) : reply);
  const r: SummaryRegistry = {
    find: (provider, id) => (models.includes(id) ? { provider, id } : undefined),
    hasConfiguredAuth: () => true,
    complete,
  };
  return { r, complete };
}

test("the transcript is the current turn: its prompt, its calls, its final reply", () => {
  const t = turnTranscript(branch as any)!;
  expect(t).toContain("Fix the parser");
  expect(t).not.toContain("old prompt");
  expect(t).toContain("- bash: run tests");
  expect(t).toContain("Tests pass.");
});

test("a model's answer becomes one clipped line", async () => {
  const { r, complete } = registry(`"Fixed the parser to skip empty lines;\n tests pass ${"x".repeat(100)}"`);
  const s = await turnSummary(r, branch as any, {});
  expect(complete).toHaveBeenCalledOnce();
  expect((complete.mock.calls[0] as unknown[])[0]).toEqual({ provider: "anthropic", id: "claude-haiku-5-5" });
  expect(s!.length).toBeLessThanOrEqual(80);
  expect(s).toMatch(/^Fixed the parser to skip empty lines; tests pass x+…$/u);
});

test("a short one-line reply is its own summary, with no model call", async () => {
  const { r, complete } = registry("unused");
  expect(await turnSummary(r, [user("hi"), assistant("Done: pushed the fix.\n\n<next>/reload</next>")] as any, {})).toBe("Done: pushed the fix.");
  expect(complete).not.toHaveBeenCalled();
});

test("without a model, on error or when disabled, the reply's first sentence stands in", async () => {
  const fallback = "I changed the parser so empty lines are skipped.";
  expect(fallbackSummary(branch as any)).toBe(fallback);
  expect(await turnSummary(registry("x", []).r, branch as any, {})).toBe(fallback);
  expect(await turnSummary(registry(async () => { throw new Error("boom"); }).r, branch as any, {})).toBe(fallback);
  expect(await turnSummary(registry(async () => ({ stopReason: "error", content: [] })).r, branch as any, {})).toBe(fallback);
  const off = registry("x");
  expect(await turnSummary(off.r, branch as any, { PI_HERDR_SUMMARY: "0" })).toBe(fallback);
  expect(off.complete).not.toHaveBeenCalled();
  const aborted = registry("x");
  expect(await turnSummary(aborted.r, [user("go"), assistant(LONG, [], "aborted")] as any, {})).toBe(fallback);
  expect(aborted.complete).not.toHaveBeenCalled();
  expect(await turnSummary(registry("x").r, [user("go")] as any, {})).toBeUndefined();
});

test("model choice: the configured one, else the first Haiku with credentials", () => {
  expect(summaryModel(registry("x").r, {})).toEqual({ provider: "anthropic", id: "claude-haiku-5-5" });
  expect(summaryModel(registry("x", ["claude-haiku-4-5"]).r, {})).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  expect(summaryModel(registry("x", ["mini"]).r, { PI_HERDR_SUMMARY_MODEL: "openai/mini" })).toEqual({ provider: "openai", id: "mini" });
  const noAuth = { ...registry("x").r, hasConfiguredAuth: () => false };
  expect(summaryModel(noAuth, {})).toBeUndefined();
});

test("a blocked dialog: the pending question, else the dialog's label", () => {
  const asking = [user("plan it"), assistant("", [{ name: "ask_user_question", arguments: { questions: [
    { header: "Approach", question: "Which approach should the importer use?" },
    { header: "Scope", question: "Include tests?" },
  ] } }])];
  expect(blockedSummary("Approach · Scope", asking as any)).toBe("Which approach should the importer use? (+1 more)");
  expect(blockedSummary("Allow? bash rm -rf build", asking as any)).toBe("Allow? bash rm -rf build");
  expect(blockedSummary("Review the plan", branch as any)).toBe("Review the plan");
  expect(blockedSummary(undefined, branch as any)).toBeUndefined();
});

test("oneLine collapses whitespace and cuts with an ellipsis", () => {
  expect(oneLine("a\n  b", 10)).toBe("a b");
  expect(oneLine("abcdefghijk", 5)).toBe("abcd…");
});
