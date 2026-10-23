import { expect, test, vi } from "vitest";
import { fallbackRecap, oneLine, recap, recapModel, recapTranscript, type RecapRegistry } from "../src/summary.ts";

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
  user("Look at the CSV importer"),
  assistant("old reply"),
  user("Fix the parser"),
  assistant("", [{ name: "bash", arguments: { command: "npm test", description: "run tests" } }]),
  { type: "message", message: { role: "toolResult", content: "ok" } },
  assistant(LONG),
];

function registry(reply: string | (() => Promise<any>), models = ["claude-haiku-5-5", "claude-haiku-4-5"]) {
  const complete = vi.fn(typeof reply === "string" ? async () => ({ stopReason: "stop", content: [{ type: "text", text: reply }] }) : reply);
  const r: RecapRegistry = {
    find: (provider, id) => (models.includes(id) ? { provider, id } : undefined),
    hasConfiguredAuth: () => true,
    complete,
  };
  return { r, complete };
}

test("the transcript lists earlier prompts as context, then the latest turn", () => {
  const t = recapTranscript(branch as any)!;
  expect(t).toContain("Earlier prompts in this session (oldest first):\n- Look at the CSV importer");
  expect(t).toContain("Latest user prompt:\nFix the parser");
  expect(t).toContain("- bash: run tests");
  expect(t).toContain("Tests pass.");
  expect(t).not.toContain("old reply");
});

test("only the last five earlier prompts are listed, each clipped", () => {
  const many = [...Array.from({ length: 8 }, (_, i) => [user(`p${i} ${"y".repeat(300)}`), assistant("r")]).flat(), user("now"), assistant(LONG)];
  const t = recapTranscript(many as any)!;
  expect(t).not.toContain("p2 ");
  expect(t).toContain("p3 ");
  expect(t).toContain("p7 ");
  expect(t.split("\n").find((l) => l.startsWith("- p7"))!.length).toBeLessThanOrEqual(202);
});

test("a model's answer becomes one clipped line", async () => {
  const { r, complete } = registry(`"Fixed the parser to skip empty lines;\n tests pass ${"x".repeat(100)}"`);
  const s = await recap(r, branch as any, {});
  expect(complete).toHaveBeenCalledOnce();
  expect((complete.mock.calls[0] as unknown[])[0]).toEqual({ provider: "anthropic", id: "claude-haiku-5-5" });
  expect(s!.source).toBe("model");
  expect(s!.text.length).toBeLessThanOrEqual(80);
  expect(s!.text).toMatch(/^Fixed the parser to skip empty lines; tests pass x+…$/u);
});

test("a short one-line reply is its own recap, with no model call", async () => {
  const { r, complete } = registry("unused");
  expect(await recap(r, [user("hi"), assistant("Done: pushed the fix.\n\n<next>/reload</next>")] as any, {})).toEqual({ text: "Done: pushed the fix.", source: "reply" });
  expect(complete).not.toHaveBeenCalled();
});

test("without a model, on error, when disabled or interrupted, the reply's first sentence stands in", async () => {
  const fallback = { text: "I changed the parser so empty lines are skipped.", source: "fallback" };
  expect(fallbackRecap(branch as any)).toBe(fallback.text);
  expect(await recap(registry("x", []).r, branch as any, {})).toEqual(fallback);
  expect(await recap(registry(async () => { throw new Error("boom"); }).r, branch as any, {})).toEqual(fallback);
  expect(await recap(registry(async () => ({ stopReason: "error", content: [] })).r, branch as any, {})).toEqual(fallback);
  const off = registry("x");
  expect(await recap(off.r, branch as any, { PI_HERDR_SUMMARY: "0" })).toEqual(fallback);
  expect(off.complete).not.toHaveBeenCalled();
  const aborted = registry("x");
  expect(await recap(aborted.r, [user("go"), assistant(LONG, [], "aborted")] as any, {})).toEqual(fallback);
  expect(aborted.complete).not.toHaveBeenCalled();
  expect(await recap(registry("x").r, [user("go")] as any, {})).toBeUndefined();
});

test("model choice: PI_RECAP_MODEL, then PI_HERDR_SUMMARY_MODEL, else the first Haiku with credentials", () => {
  expect(recapModel(registry("x").r, {})).toEqual({ provider: "anthropic", id: "claude-haiku-5-5" });
  expect(recapModel(registry("x", ["claude-haiku-4-5"]).r, {})).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
  expect(recapModel(registry("x", ["mini"]).r, { PI_HERDR_SUMMARY_MODEL: "openai/mini" })).toEqual({ provider: "openai", id: "mini" });
  expect(recapModel(registry("x", ["mini", "nano"]).r, { PI_RECAP_MODEL: "openai/nano", PI_HERDR_SUMMARY_MODEL: "openai/mini" })).toEqual({ provider: "openai", id: "nano" });
  expect(recapModel({ ...registry("x").r, hasConfiguredAuth: () => false }, {})).toBeUndefined();
});

test("oneLine collapses whitespace and cuts with an ellipsis", () => {
  expect(oneLine("a\n  b", 10)).toBe("a b");
  expect(oneLine("abcdefghijk", 5)).toBe("abcd…");
});
