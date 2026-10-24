import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { derivedSessionId, finishedMessages, interleave, newPartAt, renderMessage, TranscriptParts } from "../src/foreign.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;
const assistant = (content: unknown[]) => ({ role: "assistant", content, provider: "anthropic", model: "claude-x", api: "anthropic-messages", stopReason: "stop", timestamp: 0 }) as unknown as AgentMessage;
const call = (id: string, name = "read", args: unknown = { path: "a.ts" }) => ({ type: "toolCall", id, name, arguments: args });
const result = (id: string, text: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError, timestamp: 0 }) as unknown as AgentMessage;
const textOf = (m: AgentMessage) => ((m as { content: Array<{ text: string }> }).content[0]!.text);

describe("main's transcript", () => {
  it("renders turns as someone else's work, clipping long tool results", () => {
    expect(renderMessage(user("fix it"))).toBe("[user]\nfix it");
    const turn = renderMessage(assistant([{ type: "thinking", thinking: "Hmm." }, { type: "text", text: "Reading." }, call("c1")]));
    expect(turn).toBe('[main agent]\n(reasoning)\nHmm.\n\nReading.\n\n→ read {"path":"a.ts"}');
    const long = renderMessage(result("c1", "x".repeat(10_000), true));
    expect(long.startsWith("[tool error: read]\nxxx")).toBe(true);
    expect(long).toContain("characters left out");
    expect(long.length).toBeLessThan(2_000);
    expect(renderMessage({ role: "system", content: "S", timestamp: 0 } as unknown as AgentMessage)).toBe("");
  });

  it("leaves out a turn whose tool calls are still running", () => {
    const messages = [user("go"), assistant([{ type: "text", text: "Two reads." }, call("a"), call("b", "bash", { command: "ls" })]), result("a", "A")];
    const { finished, pending } = finishedMessages(messages);
    expect(finished).toHaveLength(1);
    expect(pending).toEqual([{ name: "bash", summary: "ls" }]);
    expect(finishedMessages([...messages, result("b", "B")]).finished).toHaveLength(4);
  });

  it("only grows at the end, one part per request", () => {
    const parts = new TranscriptParts();
    const messages = [user("one"), assistant([{ type: "text", text: "Done." }])];
    const first = parts.build(messages, undefined, 0);
    expect(first.messages).toHaveLength(1);
    expect(first.continued).toBe(false);
    expect(textOf(first.messages[0]!)).toBe('<main-transcript part="1">\n[user]\none\n\n[main agent]\nDone.\n</main-transcript>');
    // Nothing new: the same single part.
    expect(parts.build(messages, undefined, 1).messages.map(textOf)).toEqual(first.messages.map(textOf));
    const more = [...messages, user("two"), assistant([{ type: "text", text: "Also done." }])];
    const second = parts.build(more, undefined, 2);
    expect(second.continued).toBe(true);
    expect(second.messages).toHaveLength(2);
    expect(textOf(second.messages[0]!)).toBe(textOf(first.messages[0]!));
    expect(textOf(second.messages[1]!)).toContain("[user]\ntwo");
    // peek records nothing.
    parts.peek([...more, user("three")], undefined, 3);
    expect(parts.build(more, undefined, 4).messages).toHaveLength(2);
  });

  it("starts over when earlier messages change (a compaction, /tree)", () => {
    const parts = new TranscriptParts();
    parts.build([user("one"), user("two")], undefined, 0);
    parts.build([user("one"), user("two"), user("three")], undefined, 1);
    const after = parts.build([user("summary"), user("three"), user("four")], undefined, 2);
    expect(after.continued).toBe(false);
    expect(after.messages).toHaveLength(1);
  });

  it("leaves out the oldest messages to fit the model's window, then keeps that start", () => {
    const parts = new TranscriptParts();
    const big = (i: number) => [user(`question ${i}`), assistant([{ type: "text", text: "y".repeat(1_000) }])];
    const messages = Array.from({ length: 20 }, (_, i) => big(i)).flat();
    // A 2,000-token window: 60% of it is about 4,200 characters, so only the last turns fit.
    const view = parts.build(messages, 2_000, 0);
    expect(view.omitted).toBeGreaterThan(0);
    expect(view.tokens).toBeLessThan(1_200);
    expect(textOf(view.messages[0]!)).toContain(`The first ${view.omitted} messages`);
    expect(textOf(view.messages[0]!)).toContain("[user]\nquestion");
    const next = parts.build([...messages, user("short")], 2_000, 1);
    expect(next.continued).toBe(true);
    expect(next.omitted).toBe(view.omitted);
  });

  it("places each part where Sidebar's conversation stood, never before an earlier one", () => {
    const q1 = user("q1");
    const a1 = assistant([{ type: "text", text: "a1" }]);
    const q2 = user("q2");
    expect(newPartAt([q1])).toBe(0);
    expect(newPartAt([q1, a1, q2])).toBe(2);
    expect(newPartAt([q1, a1, result("c", "r")])).toBe(3);
    const parts = new TranscriptParts();
    parts.build([user("one")], undefined, 0, 0);
    const view = parts.build([user("one"), user("two")], undefined, 1, 2);
    expect(view.threadAt).toEqual([0, 2]);
    expect(interleave(view.messages, view.threadAt, [q1, a1, q2]).map((m) => textOf(m).split("\n")[0])).toEqual(['<main-transcript part="1">', "q1", "a1", '<main-transcript part="2">', "q2"]);
    // A replaced thread (a fresh one, /tree) goes after every part.
    parts.rebase();
    expect(parts.build([user("one"), user("two")], undefined, 2, 0).threadAt).toEqual([0, 0]);
    expect(interleave(view.messages, [0, 9], [q1])).toHaveLength(3);
  });

  it("derives a stable, UUID-shaped cache id per purpose", () => {
    const a = derivedSessionId("main", "sidebar");
    expect(a).toBe(derivedSessionId("main", "sidebar"));
    expect(a).not.toBe(derivedSessionId("main", "headsup"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
