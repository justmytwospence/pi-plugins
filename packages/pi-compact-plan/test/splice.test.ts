import { describe, expect, it } from "vitest";
import { entryText, isConversationRequest, splicePayload } from "../src/splice.ts";

const main = {
  model: "claude-x",
  system: [{ type: "text", text: "You are pi", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "bash" }],
  thinking: { type: "adaptive" },
  max_tokens: 32000,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
    { role: "user", content: [{ type: "text", text: "do it", cache_control: { type: "ephemeral" } }] },
  ],
};

describe("splicePayload", () => {
  it("keeps the session's request and appends the drafting messages with one breakpoint", () => {
    const side = {
      model: "claude-x",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done", cache_control: { type: "ephemeral" } }] },
        { role: "user", content: [{ type: "text", text: "<compact-plan>" }] },
      ],
    };
    const result = splicePayload("anthropic-messages", main, side);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.payload as any;
    expect(p.system).toEqual(main.system);
    expect(p.tools).toEqual(main.tools);
    expect(p.thinking).toEqual(main.thinking);
    expect(p.messages.slice(0, 3)).toEqual(main.messages);
    expect(p.messages[3].content[0].cache_control).toBeUndefined();
    expect(p.messages[4].content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(main.messages).toHaveLength(3);
  });

  it("adds no breakpoint past Anthropic's limit", () => {
    const full = { ...main, tools: [{ name: "a", cache_control: {} }, { name: "b", cache_control: {} }] };
    const result = splicePayload("anthropic-messages", full, { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] });
    expect(result.ok && (result.payload as any).messages[3].content[0].cache_control).toBeUndefined();
  });

  it("refuses other models, unknown APIs and missing requests", () => {
    expect(splicePayload("anthropic-messages", main, { model: "other", messages: [] }).ok).toBe(false);
    expect(splicePayload("google-gemini", main, { messages: [] }).ok).toBe(false);
    expect(splicePayload("anthropic-messages", undefined, { messages: [] }).ok).toBe(false);
  });

  it("appends Responses input without the side's instructions", () => {
    const result = splicePayload(
      "openai-responses",
      { model: "gpt", instructions: "sys", input: [{ role: "user", content: "hi" }] },
      { model: "gpt", input: [{ role: "developer", content: "" }, { role: "user", content: "plan" }], stream: true },
    );
    expect(result.ok && (result.payload as any).input).toEqual([{ role: "user", content: "hi" }, { role: "user", content: "plan" }]);
    expect(splicePayload("openai-responses", { input: [1], previous_response_id: "r" }, { input: [] }).ok).toBe(false);
  });

  it("appends chat messages", () => {
    const result = splicePayload(
      "openai-completions",
      { model: "m", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }], max_tokens: 5 },
      { model: "m", messages: [{ role: "system", content: "" }, { role: "user", content: "plan" }], stream: true },
    );
    expect(result.ok && (result.payload as any).messages).toHaveLength(3);
    expect(result.ok && (result.payload as any).stream).toBe(true);
  });
});

describe("isConversationRequest", () => {
  it("matches the session's model and a request that ends with its latest entry", () => {
    expect(isConversationRequest(main, "claude-x", "do it")).toBe(true);
    expect(isConversationRequest(main, "claude-y", "do it")).toBe(false);
    expect(isConversationRequest(main, "claude-x", "Summarize the conversation")).toBe(false);
    expect(isConversationRequest({ model: "gpt", input: [{ role: "user", content: 'say "hi"\nnow' }] }, "gpt", 'say "hi"\nnow')).toBe(true);
    expect(isConversationRequest({ model: "gpt" }, "gpt", "x")).toBe(false);
  });
});

describe("entryText", () => {
  it("reads prompts, tool results and custom messages", () => {
    expect(entryText({ type: "message", message: { role: "user", content: "hi" } })).toBe("hi");
    expect(entryText({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "a" }, { type: "image" }] } })).toBe("a");
    expect(entryText({ type: "custom_message", content: [{ type: "text", text: "c" }] })).toBe("c");
    expect(entryText(undefined)).toBe("");
  });
});
