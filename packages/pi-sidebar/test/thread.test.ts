import { describe, expect, it } from "vitest";
import { hiddenPrompt, isNoteMarker, turnReply } from "../src/headsup/thread.ts";
import { compactExchange, EXCHANGE_ENTRY, RESET_ENTRY, threadFromBranch } from "../src/thread.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as never;
const exchange = (...messages: never[]) => ({ type: "custom", customType: EXCHANGE_ENTRY, data: { version: 1, messages, timestamp: 0 } });

describe("threadFromBranch", () => {
  it("joins the exchanges after the last reset, ignoring other entries", () => {
    const branch = [
      exchange(user("old")),
      { type: "custom", customType: RESET_ENTRY, data: {} },
      { type: "message", message: user("main's own") },
      exchange(user("q1")),
      { type: "custom", customType: "other", data: { messages: [user("x")] } },
      exchange(user("q2")),
    ];
    expect(threadFromBranch(branch).map((m: any) => m.content[0].text)).toEqual(["q1", "q2"]);
  });

  it("is empty for a branch without Sidebar entries", () => {
    expect(threadFromBranch([{ type: "message" }])).toEqual([]);
  });
});

describe("compactExchange", () => {
  it("cuts long tool results and drops images, leaving other messages as they are", () => {
    const messages = [
      user("q"),
      { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "y".repeat(50) }, { type: "image", data: "…" }] },
    ] as never[];
    const compact = compactExchange(messages, 10) as any[];
    expect(compact[0]).toEqual(messages[0]);
    expect(compact[1].content[0].text).toMatch(/^y{10}\n… \(40 more characters/);
    expect(compact[1].content[1]).toEqual({ type: "text", text: "(image not kept in Sidebar's history)" });
    expect((messages[1] as any).content[0].text).toHaveLength(50);
  });
});

describe("hiddenPrompt", () => {
  it("is a note marker, so the thread never shows it", () => {
    const prompt = hiddenPrompt("Write a draft.\n\n<sidebar-share-idea>x</sidebar-share-idea>");
    expect(isNoteMarker(prompt)).toBe(true);
    expect(prompt).toContain("Write a draft.");
    expect(isNoteMarker("Write a draft.")).toBe(false);
  });
});

describe("turnReply", () => {
  const assistant = (content: unknown, stopReason = "stop", errorMessage?: string) => ({ role: "assistant", content, stopReason, ...(errorMessage ? { errorMessage } : {}) }) as never;

  it("is the text of the last assistant message, not an earlier one or a tool call", () => {
    const added = [
      user("ask"),
      assistant([{ type: "text", text: "Looking." }, { type: "toolCall", id: "t", name: "codemode", arguments: {} }], "toolUse"),
      { role: "toolResult", toolCallId: "t", content: [{ type: "text", text: "found" }] } as never,
      assistant([{ type: "thinking", thinking: "hm" }, { type: "text", text: "# Title" }, { type: "text", text: "Body" }]),
    ];
    expect(turnReply(added)).toEqual({ ok: true, text: "# Title\nBody" });
    expect(turnReply([user("ask"), assistant([{ type: "toolCall", id: "t", name: "x", arguments: {} }])])).toEqual({ ok: true, text: "" });
  });

  it("says why when the turn has no answer, errored or was stopped", () => {
    expect(turnReply([user("ask")])).toEqual({ ok: false, reason: "Sidebar did not answer" });
    expect(turnReply([assistant([], "error", "overloaded")])).toEqual({ ok: false, reason: "overloaded" });
    expect(turnReply([assistant([], "error")])).toEqual({ ok: false, reason: "Sidebar's answer failed" });
    expect(turnReply([assistant([{ type: "text", text: "half" }], "aborted")])).toEqual({ ok: false, reason: "Sidebar's answer was stopped" });
  });
});
