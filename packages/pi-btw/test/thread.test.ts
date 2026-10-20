import { expect, test } from "vitest";
import { duplicateBtwCommands } from "../src/index.ts";
import {
  BTW_CONTINUE_THREAD_ASSISTANT_TEXT,
  BTW_CONTINUE_THREAD_USER_TEXT,
  BTW_ENTRY_TYPE,
  BTW_MESSAGE_TYPE,
  BTW_MODEL_OVERRIDE_TYPE,
  BTW_RESET_TYPE,
  BTW_THINKING_OVERRIDE_TYPE,
  BTW_TOOLS_BY_MODE,
  buildBtwMessageContent,
  buildBtwNoteContent,
  buildBtwSeedState,
  extractBtwHandoffThread,
  formatThread,
  isCustomEntry,
  isVisibleBtwMessage,
  parseBtwArgs,
  parseBtwModelArgs,
  parseBtwThinkingArgs,
  type BtwDetails,
} from "../src/thread.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 1 });
const assistant = (text: string, stopReason = "stop") => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason,
  provider: "p",
  model: "m",
  api: "a",
  usage: {},
  timestamp: 1,
});

test("persisted entry type names are the upstream ones", () => {
  expect([BTW_MESSAGE_TYPE, BTW_ENTRY_TYPE, BTW_RESET_TYPE, BTW_MODEL_OVERRIDE_TYPE, BTW_THINKING_OVERRIDE_TYPE]).toEqual([
    "btw-note",
    "btw-thread-entry",
    "btw-thread-reset",
    "btw-model-override",
    "btw-thinking-override",
  ]);
  expect(isCustomEntry({ type: "custom", customType: "btw-thread-entry" }, BTW_ENTRY_TYPE)).toBe(true);
  expect(isCustomEntry({ type: "message", customType: "btw-thread-entry" }, BTW_ENTRY_TYPE)).toBe(false);
  expect(isVisibleBtwMessage({ role: "custom", customType: "btw-note" })).toBe(true);
  expect(isVisibleBtwMessage({ role: "user" })).toBe(false);
});

test("argument parsing: --save/-s flags, model triples, thinking levels", () => {
  expect(parseBtwArgs("--save explain this")).toEqual({ question: "explain this", save: true });
  expect(parseBtwArgs("explain -s this")).toEqual({ question: "explain  this", save: true }); // upstream keeps the gap
  expect(parseBtwArgs("explain --saved")).toEqual({ question: "explain --saved", save: false });
  expect(parseBtwModelArgs("")).toEqual({ action: "show" });
  expect(parseBtwModelArgs("clear")).toEqual({ action: "clear" });
  expect(parseBtwModelArgs("openai gpt-5-mini openai-responses")).toEqual({ action: "set", model: { provider: "openai", id: "gpt-5-mini", api: "openai-responses" } });
  expect(parseBtwModelArgs("openai gpt-5-mini")).toMatchObject({ action: "invalid" });
  expect(parseBtwThinkingArgs("")).toEqual({ action: "show" });
  expect(parseBtwThinkingArgs("clear")).toEqual({ action: "clear" });
  expect(parseBtwThinkingArgs("low")).toEqual({ action: "set", thinkingLevel: "low" });
});

test("read-only mode exposes only Pi's read-only tools; the other modes get the coding set", () => {
  expect(BTW_TOOLS_BY_MODE.readonly).toEqual(["read", "grep", "find", "ls"]);
  expect(BTW_TOOLS_BY_MODE.contextual).toEqual(["read", "bash", "edit", "write"]);
  expect(BTW_TOOLS_BY_MODE.tangent).toEqual(["read", "bash", "edit", "write"]);
});

test("handoff extraction skips the continuation marker, merges assistant parts, drops aborted and failed turns", () => {
  const messages = [
    user("context from main"),
    user(BTW_CONTINUE_THREAD_USER_TEXT),
    assistant(BTW_CONTINUE_THREAD_ASSISTANT_TEXT),
    user("q1"),
    assistant("a1 part 1"),
    assistant("a1 part 2"),
    user("q2"),
    assistant("partial", "aborted"),
    user("q3"),
    assistant("", "error"),
    user("q4"),
    assistant("a4"),
  ];
  expect(extractBtwHandoffThread(messages, 1)).toEqual([
    { user: "q1", assistant: "a1 part 1\n\na1 part 2" },
    { user: "q4", assistant: "a4" },
  ]);
  expect(formatThread([{ user: " q ", assistant: " a " }, { user: "x", assistant: "y" }])).toBe("User: q\nAssistant: a\n\n---\n\nUser: x\nAssistant: y");
  expect(buildBtwMessageContent("q", "a")).toBe("**Question**\n\nq\n\n**Answer**\n\na");
  expect(buildBtwNoteContent("\nwhy is it slow?\nmore", "a")).toBe("Side question (/btw): why is it slow?\n\n**Question**\n\n\nwhy is it slow?\nmore\n\n**Answer**\n\na");
});

test("seed state: tangent threads inherit nothing, contextual threads inherit the branch minus BTW notes", () => {
  const entries = [
    { type: "message", id: "1", parentId: null, timestamp: "t", message: user("hello") },
    { type: "message", id: "2", parentId: "1", timestamp: "t", message: { role: "custom", customType: BTW_MESSAGE_TYPE, content: "note", timestamp: 1 } },
  ];
  const ctx = { sessionManager: { getEntries: () => entries, getLeafId: () => "2" }, model: { api: "openai-responses" } } as never;
  const thread: BtwDetails[] = [{ question: "q", thinking: "", answer: "a", provider: "p", model: "m", api: "", thinkingLevel: "off", timestamp: 5 }];

  const tangent = buildBtwSeedState(ctx, thread, "tangent", null);
  expect(tangent.sideThreadStartIndex).toBe(0);
  expect(tangent.messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect((tangent.messages[2] as { content: Array<{ text: string }> }).content[0]!.text).toBe("q");
  expect((tangent.messages[3] as { api: string }).api).toBe("openai-responses");

  const contextual = buildBtwSeedState(ctx, [], "contextual", null);
  expect(contextual.sideThreadStartIndex).toBe(1);
  expect(contextual.messages.map((message) => message.role)).toEqual(["user"]);
  expect(buildBtwSeedState(ctx, [], "readonly", null).sideThreadStartIndex).toBe(1);
});

test("duplicate registrations are the renamed command names Pi produces", () => {
  expect(duplicateBtwCommands([{ name: "btw" }, { name: "btw:ask" }, { name: "side" }])).toEqual([]);
  expect(duplicateBtwCommands([{ name: "btw:1", source: "extension" }, { name: "btw:2", source: "extension" }, { name: "btw:ask:1" }, { name: "side:1" }, { name: "skill:btw", source: "skill" }])).toEqual([
    "btw:1",
    "btw:2",
    "btw:ask:1",
    "side:1",
  ]);
  expect(duplicateBtwCommands([{ name: "btw:1", source: "prompt" }])).toEqual([]);
});
