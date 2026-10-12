import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import {
  appendPersistedTranscriptTurn,
  applyTranscriptEvent,
  buildOverlayTranscript,
  createEmptyTranscriptState,
  finishTranscriptTurn,
  getCompletedExchangeCount,
  getOverlayTitle,
  hasStreamingTranscriptEntry,
  setTranscriptFailure,
  summarizeToolResult,
} from "../src/transcript.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

const assistant = (text: string, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason });

test("sub-session events project into one turn with user, tool and assistant entries", () => {
  const state = createEmptyTranscriptState();
  const apply = (event: unknown) => applyTranscriptEvent(state, event as never);
  apply({ type: "turn_start" });
  apply({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "what is this?" }] } });
  apply({ type: "message_start", message: assistant("") });
  apply({ type: "message_update", message: assistant("Looking") });
  apply({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "a.ts" } });
  apply({ type: "tool_execution_update", toolCallId: "c1", toolName: "read", partialResult: { content: [{ type: "text", text: "partial" }] } });
  apply({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", isError: false, result: { content: [{ type: "text", text: "x".repeat(500) }] } });
  apply({ type: "message_update", message: assistant("Looking at a.ts") });
  expect(hasStreamingTranscriptEntry(state.entries)).toBe(true);
  expect(getCompletedExchangeCount(state.entries)).toBe(0);
  apply({ type: "message_end", message: assistant("Looking at a.ts") });
  apply({ type: "turn_end", message: assistant("Looking at a.ts") });

  expect(state.entries.map((entry) => entry.type)).toEqual(["turn-boundary", "user-message", "assistant-text", "tool-call", "tool-result", "turn-boundary"]);
  const result = state.entries.find((entry) => entry.type === "tool-result");
  expect(result).toMatchObject({ toolName: "read", truncated: true, isError: false, streaming: false });
  expect(state.entries.find((entry) => entry.type === "tool-call")).toMatchObject({ args: "a.ts" });
  expect(state.entries.at(-1)).toMatchObject({ phase: "end", outcome: "completed" });
  expect(hasStreamingTranscriptEntry(state.entries)).toBe(false);
  expect(getCompletedExchangeCount(state.entries)).toBe(1);
  expect(state.currentTurnId).toBeNull();
  expect(state.lastTurnId).toBe(1);
});

test("aborted and failed turns are marked and not counted as exchanges", () => {
  const state = createEmptyTranscriptState();
  applyTranscriptEvent(state, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "q" }] } } as never);
  applyTranscriptEvent(state, { type: "message_update", message: assistant("partial") } as never);
  applyTranscriptEvent(state, { type: "turn_end", message: assistant("partial", "aborted") } as never);
  expect(state.entries.at(-1)).toMatchObject({ type: "turn-boundary", phase: "end", outcome: "aborted" });
  expect(getCompletedExchangeCount(state.entries)).toBe(0);

  const failed = createEmptyTranscriptState();
  applyTranscriptEvent(failed, { type: "message_start", message: { role: "user", content: [{ type: "text", text: "q" }] } } as never);
  setTranscriptFailure(failed, "boom");
  expect(failed.entries.find((entry) => entry.type === "assistant-text")).toMatchObject({ text: "Error: boom", streaming: false });
  expect(failed.entries.at(-1)).toMatchObject({ outcome: "failed" });
  // Finishing an already finished turn only updates its outcome.
  finishTranscriptTurn(failed, 1, "completed");
  expect(failed.entries.filter((entry) => entry.type === "turn-boundary")).toHaveLength(2);
});

test("persisted exchanges rehydrate as completed turns", () => {
  const state = createEmptyTranscriptState();
  appendPersistedTranscriptTurn(state, { question: "q", thinking: "t", answer: "a", provider: "p", model: "m", api: "x", thinkingLevel: "off", timestamp: 1 });
  expect(state.entries.map((entry) => entry.type)).toEqual(["turn-boundary", "user-message", "thinking", "assistant-text", "turn-boundary"]);
  expect(getCompletedExchangeCount(state.entries)).toBe(1);
});

test("tool results summarize text content, errors and plain values", () => {
  expect(summarizeToolResult({ content: [{ type: "text", text: "ok" }] })).toEqual({ content: "ok", truncated: false });
  expect(summarizeToolResult({ error: "bad" })).toEqual({ content: "bad", truncated: false });
  expect(summarizeToolResult("plain")).toEqual({ content: "plain", truncated: false });
  expect(summarizeToolResult(undefined)).toEqual({ content: "(no tool output)", truncated: false });
  expect(summarizeToolResult("x".repeat(10), 8)).toEqual({ content: "xxxxx...", truncated: true });
});

test("the overlay transcript renders badges, markdown and tool blocks", () => {
  const state = createEmptyTranscriptState();
  appendPersistedTranscriptTurn(state, { question: "why?", thinking: "", answer: "Because **x**.", provider: "p", model: "m", api: "x", thinkingLevel: "off", timestamp: 1 });
  applyTranscriptEvent(state, { type: "tool_execution_start", toolCallId: "c", toolName: "grep", args: "foo" } as never);
  applyTranscriptEvent(state, { type: "tool_execution_end", toolCallId: "c", toolName: "grep", isError: true, result: { error: "no match" } } as never);
  const lines = buildOverlayTranscript(state.entries, theme, getMarkdownTheme(), 60);
  const text = lines.join("\n");
  expect(text).toContain(" You  why?");
  expect(text).toContain(" Assistant ");
  expect(text).toContain("Because");
  expect(text).toContain(" Tool  grep · foo");
  expect(text).toContain("↳ error");
  expect(text).toContain("    no match");
  expect(buildOverlayTranscript([], theme, getMarkdownTheme(), 60)).toEqual(["No BTW thread yet. Ask a side question to start one."]);
  expect(getOverlayTitle("readonly")).toBe("BTW ask · read-only");
  expect(getOverlayTitle("tangent")).toBe("BTW tangent");
  expect(getOverlayTitle("contextual")).toBe("BTW");
});
