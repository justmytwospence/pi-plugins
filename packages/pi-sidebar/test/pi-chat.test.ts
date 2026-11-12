import { stripVTControlCharacters } from "node:util";
import { AssistantMessageComponent, initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilities, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

beforeAll(() => initTheme("dark"));
import { PiChat } from "../src/pi-chat.ts";

// pi-cc-render gives AssistantMessageComponent a prototype setExpanded (Ctrl+O opens collapsed
// thinking). Stand in for it so the test does not need that sibling.
const proto = AssistantMessageComponent.prototype as unknown as { setExpanded?(value: boolean): void };
afterEach(() => {
  delete proto.setExpanded;
});

const shown = (chat: PiChat, width = 120) => chat.render(width).map(stripVTControlCharacters).join("\n");
const freeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const start = (chat: PiChat, args: unknown = {}, name = "remote_lookup") => {
  chat.apply({ type: "tool_execution_start", toolCallId: "opaque-call-id", toolName: name, args });
};
const finish = (chat: PiChat, result: unknown, isError = false) => {
  chat.apply({ type: "tool_execution_end", toolCallId: "opaque-call-id", result, isError });
};

describe("PiChat", () => {
  it("fills unknown seeded and live tools with readable fields without mutating frozen messages", () => {
    const args = freeze({ query: "cache", request: { prose: "first line\nsecond line", values: [false, 0, null, ""] } });
    const result = freeze({ role: "toolResult", toolCallId: "opaque-call-id", content: [], details: { count: 0, ready: false }, isError: false });
    const messages = freeze([
      { role: "assistant", content: [{ type: "toolCall", id: "opaque-call-id", name: "remote_lookup", arguments: args }] },
      result,
    ]);
    const snapshot = JSON.stringify(messages);
    const seeded = new PiChat(() => undefined, { cwd: process.cwd() });
    seeded.seed(messages, () => undefined);
    const live = new PiChat(() => undefined, { cwd: process.cwd() });
    start(live, args);
    finish(live, result);
    for (const chat of [seeded, live]) {
      expect(shown(chat)).toContain("Remote lookup");
      expect(shown(chat)).toContain("Query: cache");
      expect(shown(chat)).toContain("Count: 0");
      expect(shown(chat)).not.toContain("opaque-call-id");
      chat.setExpanded(true);
      const out = shown(chat);
      expect(out).toMatch(/Prose:\s*\n\s*first line\s*\n\s*second line/);
      expect(out).toContain("1. false");
      expect(out).toContain("2. 0");
      expect(out).toContain("3. null");
      expect(out).toContain('4. ""');
      expect(out).not.toContain('"prose"');
    }
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it("preserves literal JSON text instead of parsing it and expands bounded result previews", () => {
    const chat = new PiChat(() => undefined, { cwd: process.cwd() });
    start(chat);
    const literal = '{"literal":true}';
    const output = [literal, ...Array.from({ length: 15 }, (_, index) => `output ${index}`)].join("\n");
    finish(chat, freeze({ content: [{ type: "text", text: output }], details: { secret: "not displayed" } }));
    expect(shown(chat)).toContain(literal);
    expect(shown(chat)).toContain("expand to view");
    expect(shown(chat)).not.toContain("output 14");
    expect(shown(chat)).not.toContain("not displayed");
    chat.setExpanded(true);
    expect(shown(chat)).toContain("output 14");
    chat.setExpanded(false);
    expect(shown(chat)).not.toContain("output 14");
  });

  it("falls back from empty text to details or no output without mutating results", () => {
    for (const [details, expected] of [[{ count: 0, ready: false }, "Count: 0"], [undefined, "No output."]] as const) {
      const result = freeze({ content: [{ type: "text", text: "" }], details });
      const snapshot = JSON.stringify(result);
      const chat = new PiChat(() => undefined, { cwd: process.cwd() });
      start(chat);
      finish(chat, result);
      expect(shown(chat)).toContain(expected);
      if (details) expect(shown(chat)).toContain("Ready: false");
      expect(JSON.stringify(result)).toBe(snapshot);
    }
  });

  it("shows pending, partial, error and empty states as arguments and results arrive", () => {
    const chat = new PiChat(() => undefined, { cwd: process.cwd() });
    chat.apply({ type: "message_start", message: { role: "assistant", content: [] } });
    const message = (args: unknown) => ({ role: "assistant", content: [{ type: "toolCall", id: "opaque-call-id", name: "remote_lookup", arguments: args }] });
    chat.apply({ type: "message_update", message: message(undefined) });
    expect(shown(chat)).toContain("Pending…");
    chat.apply({ type: "message_update", message: message(freeze({ query: "partial" })) });
    expect(shown(chat)).toContain("Query: partial");
    start(chat);
    expect(shown(chat)).toContain("Working…");
    chat.apply({ type: "tool_execution_update", toolCallId: "opaque-call-id", partialResult: freeze({ content: [{ type: "text", text: "streaming" }] }) });
    expect(shown(chat)).toContain("streaming");
    finish(chat, freeze({ content: [{ type: "text", text: "permission denied" }] }), true);
    expect(shown(chat)).toContain("Error");
    expect(shown(chat)).toContain("permission denied");
    const empty = new PiChat(() => undefined, { cwd: process.cwd() });
    start(empty);
    finish(empty, { content: [] });
    expect(shown(empty)).toContain("Completed");
    expect(shown(empty)).toContain("No output.");
  });

  it("keeps image blocks for native image rendering alongside literal text", () => {
    const chat = new PiChat(() => undefined, { cwd: process.cwd() });
    start(chat);
    const image = freeze({ type: "image", data: "unchanged-image-data", mimeType: "image/png" });
    const result = freeze({ content: [{ type: "text", text: "image caption" }, image] });
    finish(chat, result);
    const tool = chat.children.at(-1) as unknown as { result: { content: unknown[] }; showImages: boolean };
    expect(tool.result.content[1]).toBe(image);
    expect(tool.showImages).toBe(true);
    expect(shown(chat)).toContain("image caption");
    const capabilities = getCapabilities();
    try {
      setCapabilities({ ...capabilities, images: null });
      chat.setExpanded(true);
      expect(shown(chat)).toContain("[Image: image/png]");
    } finally {
      setCapabilities(capabilities);
    }
  });

  it("prefers originating renderers, fills missing sides, and retains native built-ins", () => {
    const calls = new PiChat(() => undefined, { cwd: process.cwd(), toolDefinition: () => ({ renderCall: () => new Text("Session call", 0, 0) }) });
    start(calls, { query: "hidden call" });
    finish(calls, { content: [{ type: "text", text: "literal fallback result" }] });
    expect(shown(calls)).toContain("Session call");
    expect(shown(calls)).not.toContain("hidden call");
    expect(shown(calls)).toContain("literal fallback result");
    const results = new PiChat(() => undefined, { cwd: process.cwd(), toolDefinition: () => ({ renderResult: () => new Text("Session result", 0, 0) }) });
    start(results, { query: "visible call" });
    finish(results, { content: [{ type: "text", text: "hidden result" }] });
    expect(shown(results)).toContain("Query: visible call");
    expect(shown(results)).toContain("Session result");
    expect(shown(results)).not.toContain("hidden result");
    const native = new PiChat(() => undefined, { cwd: process.cwd() });
    start(native, { command: "printf native" }, "bash");
    finish(native, { content: [{ type: "text", text: "native output" }] });
    expect(shown(native)).toContain("$ printf native");
    expect(shown(native)).not.toContain("Command:");
  });

  it("bounds deeply nested and huge display values and sanitizes control characters", () => {
    const chat = new PiChat(() => undefined, { cwd: process.cwd() });
    start(chat, freeze({ text: `safe\x1b[31m${"界".repeat(30_000)}`, nested: { rows: Array.from({ length: 3_000 }, (_, i) => i) } }));
    expect(shown(chat).length).toBeLessThan(2_000);
    chat.setExpanded(true);
    expect(shown(chat).length).toBeLessThan(25_000);
    expect(shown(chat)).toContain("display limit reached");
  });
  it("keeps assistant messages in step with its own Ctrl+O state", () => {
    const calls: boolean[] = [];
    proto.setExpanded = function (value: boolean) {
      calls.push(value);
    };
    const chat = new PiChat(() => undefined, { cwd: process.cwd() });
    chat.setExpanded(true);
    chat.seed([{ role: "assistant", content: [{ type: "text", text: "hi" }] }], () => undefined);
    expect(calls.at(-1)).toBe(true); // a new message starts with the chat's state, not main's
    chat.setExpanded(false);
    expect(calls.at(-1)).toBe(false);
  });
  it("gives seeded and live prompts their recorded time for pi-cc-render's clock", () => {
    const chat = new PiChat(() => undefined, { cwd: process.cwd(), userMessagesFromEvents: true });
    chat.seed([{ role: "user", content: "earlier", timestamp: 1_000 }], (text) => ({ text }));
    chat.apply({ type: "message_start", message: { role: "user", content: "now", timestamp: 2_000 } });
    chat.user("untimed");
    const stamps = chat.children
      .filter((child) => child instanceof UserMessageComponent)
      .map((child) => (child as { timestamp?: number }).timestamp);
    expect(stamps).toEqual([1_000, 2_000, undefined]);
  });
});
