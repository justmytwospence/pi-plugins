import { describe, expect, it } from "vitest";
import { isConversationRequest, MainState, payloadSystemText, resultPreview } from "../src/main-state.ts";
import { FakePi, fakeCtx } from "./fake.ts";

const PROMPT = "You are an expert coding assistant operating inside pi.";
const payload = () => ({
  model: "claude-x",
  system: [{ type: "text", text: "identity" }, { type: "text", text: `${PROMPT}\nmore` }],
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
});

describe("telling main's requests apart", () => {
  it("reads the system text of each API shape", () => {
    expect(payloadSystemText(payload())).toContain(PROMPT);
    expect(payloadSystemText({ instructions: "INS", input: [] })).toBe("INS");
    expect(payloadSystemText({ messages: [{ role: "system", content: "SYS" }] })).toBe("SYS");
  });

  it("accepts main's conversation requests only", () => {
    expect(isConversationRequest(payload(), "claude-x", PROMPT)).toBe(true);
    expect(isConversationRequest(payload(), "other", PROMPT)).toBe(false);
    expect(isConversationRequest({ ...payload(), system: [{ type: "text", text: "Summarize" }] }, "claude-x", PROMPT)).toBe(false);
  });
});

describe("MainState", () => {
  it("keeps main's last request by reference, with the leaf it covered", async () => {
    const pi = new FakePi();
    const state = new MainState(pi as never, () => 1000);
    const { ctx } = fakeCtx({ leafId: "leaf-7", systemPrompt: PROMPT });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    const sent = payload();
    await pi.emit("before_provider_request", { payload: sent }, ctx);
    expect(state.request).toMatchObject({ api: "anthropic-messages", model: "claude-x", leafId: "leaf-7", sentAt: 1000 });
    expect(state.request!.payload).toBe(sent);
    await pi.emit("before_provider_request", { payload: { ...payload(), system: [{ type: "text", text: "Summarize" }] } }, ctx);
    expect(state.request!.payload).toBe(sent);
  });

  it("forgets the request after /tree or a compaction, and reads main's last answer from its session", async () => {
    const pi = new FakePi();
    const state = new MainState(pi as never);
    const branch = [{ type: "message", timestamp: "1970-01-01T00:00:05.000Z", message: { role: "assistant", usage: { input: 10, cacheRead: 990, cacheWrite: 0 } } }];
    const { ctx } = fakeCtx({ systemPrompt: PROMPT, entries: branch });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("before_provider_request", { payload: payload() }, ctx);
    await pi.emit("session_tree", {}, ctx);
    expect(state.request).toBeUndefined();
    await pi.emit("before_provider_request", { payload: payload() }, ctx);
    await pi.emit("session_compact", {}, ctx);
    expect(state.request).toBeUndefined();
    expect(state.lastAnswer()).toEqual({ at: 5000, promptTokens: 1000 });
    expect(state.promptTokens()).toBe(1000);
  });

  it("forgets the request when main switches session", async () => {
    const pi = new FakePi();
    const state = new MainState(pi as never);
    await pi.emit("before_provider_request", { payload: payload() }, fakeCtx({ systemPrompt: PROMPT }).ctx);
    await pi.emit("session_start", { reason: "new" }, fakeCtx({ sessionId: "other" }).ctx);
    expect(state.request).toBeUndefined();
    expect(state.sessionId).toBe("other");
  });

  it("tracks running tools, finished results until committed, and the streaming tail", async () => {
    const pi = new FakePi();
    const state = new MainState(pi as never, () => 5);
    const changes: number[] = [];
    state.onChange(() => changes.push(1));
    const { ctx } = fakeCtx();
    await pi.emit("agent_start", {}, ctx);
    await pi.emit("tool_execution_start", { toolCallId: "r", toolName: "read", args: { path: "a.ts" } }, ctx);
    await pi.emit("tool_execution_start", { toolCallId: "b", toolName: "bash", args: { command: "sleep 9" } }, ctx);
    await pi.emit("tool_execution_end", { toolCallId: "r", toolName: "read", isError: false, result: { content: [{ type: "text", text: "export const a = 1;" }] } }, ctx);
    expect(state.live.tools.map((t) => t.name)).toEqual(["bash"]);
    expect(state.live.finished).toEqual([expect.objectContaining({ name: "read", summary: "a.ts", preview: "export const a = 1;" })]);
    await pi.emit("message_end", { message: { role: "toolResult", toolCallId: "r" } }, ctx);
    expect(state.live.finished).toEqual([]);
    await pi.emit("message_update", { message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "Tests pass" }] } }, ctx);
    expect(state.live.streaming).toBe("Tests pass");
    await pi.emit("message_end", { message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 90, cacheWrite: 0 } } }, ctx);
    expect(state.promptTokens()).toBe(100);
    await pi.emit("agent_end", {}, ctx);
    expect(state.live.state).toBe("idle");
    expect(changes.length).toBeGreaterThan(3);
  });

  it("previews long results", () => {
    expect(resultPreview({ content: [{ type: "text", text: "x".repeat(2000) }] })).toMatch(/500 more characters/);
  });
});
