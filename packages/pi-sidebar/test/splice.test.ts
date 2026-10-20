import { describe, expect, it } from "vitest";
import { inertPayload, requestedCacheTtlMs, splicePayload } from "../src/splice.ts";

const H1 = { type: "ephemeral", ttl: "1h" };
const M5 = { type: "ephemeral" };

function anthropicMain(oauth = true) {
  return {
    model: "claude-x",
    max_tokens: 1,
    stream: true,
    betas: ["b1"],
    system: oauth
      ? [{ type: "text", text: "identity", cache_control: H1 }, { type: "text", text: "MAIN PROMPT", cache_control: H1 }]
      : [{ type: "text", text: "MAIN PROMPT", cache_control: H1 }],
    tools: [{ name: "read" }, { name: "edit", cache_control: H1 }],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    messages: [
      { role: "user", content: [{ type: "text", text: "do it" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x", cache_control: H1 }] },
    ],
  };
}

function anthropicSide() {
  return {
    model: "claude-x",
    max_tokens: 32000,
    stream: true,
    system: [{ type: "text", text: "SIDE PROMPT", cache_control: M5 }],
    tools: [{ name: "read", cache_control: M5 }],
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    messages: [
      { role: "assistant", content: [{ type: "text", text: "main's final answer" }] },
      { role: "user", content: [{ type: "text", text: "<sidebar>…</sidebar>" }, { type: "text", text: "what now?", cache_control: M5 }] },
      { role: "user", content: [{ type: "text", text: "<sidebar-status at=\"x\">\nMain is idle.\n</sidebar-status>" }] },
    ],
  };
}

describe("splicePayload: Anthropic", () => {
  it("keeps main's request intact and appends Sidebar's messages", () => {
    const main = anthropicMain();
    const result = splicePayload("anthropic-messages", main, anthropicSide());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const p = result.payload as any;
    // Main's system text and tools are unchanged; only the redundant first breakpoint moved to Sidebar.
    expect(p.system.map((b: any) => b.text)).toEqual(main.system.map((b) => b.text));
    expect(p.system[1]).toEqual(main.system[1]);
    expect(p.tools).toEqual(main.tools);
    expect(p.thinking).toEqual(main.thinking);
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.betas).toEqual(["b1"]);
    expect(p.messages.slice(0, 3)).toEqual(main.messages);
    expect(p.messages).toHaveLength(6);
    expect(p.max_tokens).toBe(32000);
    expect(result.mainItems).toBe(3);
    expect(result.sideItems).toBe(3);
  });

  it("with OAuth's four breakpoints, moves the redundant first system one to Sidebar's last block", () => {
    const result = splicePayload("anthropic-messages", anthropicMain(true), anthropicSide());
    if (!result.ok) throw new Error(result.reason);
    const p = result.payload as any;
    expect(JSON.stringify(p).match(/cache_control/g)).toHaveLength(4);
    expect(p.system[0].cache_control).toBeUndefined();
    expect(p.system[1].cache_control).toEqual(H1);
    expect(p.messages[2].content[0].cache_control).toEqual(H1);
    // Sidebar's breakpoint: its last block before the live status, 5 minutes (after the 1-hour ones).
    expect(p.messages[4].content[1].cache_control).toEqual({ type: "ephemeral" });
    expect(p.messages[5].content[0].cache_control).toBeUndefined();
  });

  it("uses a spare breakpoint on Sidebar's last block without touching main's", () => {
    const main = anthropicMain(false);
    const result = splicePayload("anthropic-messages", main, anthropicSide());
    if (!result.ok) throw new Error(result.reason);
    const p = result.payload as any;
    expect(JSON.stringify(p).match(/cache_control/g)).toHaveLength(4);
    expect(p.system).toEqual(main.system);
    expect(p.messages[4].content[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds no breakpoint when main's request leaves no slot it can free", () => {
    const main = anthropicMain(false);
    (main.messages[0]!.content[0] as any).cache_control = H1;
    const result = splicePayload("anthropic-messages", main, anthropicSide());
    if (!result.ok) throw new Error(result.reason);
    expect(JSON.stringify(result.payload).match(/cache_control/g)).toHaveLength(4);
    expect((result.payload as any).messages[4].content[1].cache_control).toBeUndefined();
  });

  it("does not mutate its inputs", () => {
    const main = anthropicMain();
    const side = anthropicSide();
    const before = JSON.stringify([main, side]);
    splicePayload("anthropic-messages", main, side);
    expect(JSON.stringify([main, side])).toBe(before);
  });

  it("fails closed on a model mismatch, a missing request or an unknown API", () => {
    expect(splicePayload("anthropic-messages", anthropicMain(), { ...anthropicSide(), model: "other" }).ok).toBe(false);
    expect(splicePayload("anthropic-messages", undefined, anthropicSide()).ok).toBe(false);
    expect(splicePayload("anthropic-messages", { ...anthropicMain(), messages: [] }, anthropicSide()).ok).toBe(false);
    const unknown = splicePayload("google-generative-ai", anthropicMain(), anthropicSide());
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toMatch(/not supported/);
  });

  it("refuses when main alone already uses every breakpoint", () => {
    const main = anthropicMain(true);
    (main.messages[0]!.content[0] as any).cache_control = H1;
    const result = splicePayload("anthropic-messages", main, anthropicSide());
    expect(result.ok).toBe(false);
  });
});

describe("splicePayload: OpenAI", () => {
  const main = {
    model: "gpt-x",
    instructions: "MAIN",
    prompt_cache_key: "main-session",
    reasoning: { effort: "high" },
    max_output_tokens: 1,
    stream: true,
    input: [{ role: "developer", content: "MAIN" }, { role: "user", content: "hi" }],
  };
  it("Responses: drops Sidebar's own instructions and keeps main's cache key", () => {
    const side = {
      model: "gpt-x",
      instructions: "SIDE",
      prompt_cache_key: "side-session",
      reasoning: { effort: "low" },
      max_output_tokens: 9000,
      stream: true,
      input: [{ role: "developer", content: "SIDE" }, { role: "user", content: "q" }],
    };
    const result = splicePayload("openai-codex-responses", main, side);
    if (!result.ok) throw new Error(result.reason);
    const p = result.payload as any;
    expect(p.instructions).toBe("MAIN");
    expect(p.prompt_cache_key).toBe("main-session");
    expect(p.reasoning).toEqual({ effort: "high" });
    expect(p.input).toEqual([...main.input, { role: "user", content: "q" }]);
    expect(p.max_output_tokens).toBe(9000);
  });

  it("Responses: refuses chained requests", () => {
    expect(splicePayload("openai-responses", { ...main, previous_response_id: "r1" }, { model: "gpt-x", input: [] }).ok).toBe(false);
  });

  it("Chat Completions: drops Sidebar's system message", () => {
    const m = { model: "gpt-x", messages: [{ role: "system", content: "MAIN" }, { role: "user", content: "hi" }], max_tokens: 1, stream: true };
    const s = { model: "gpt-x", messages: [{ role: "system", content: "SIDE" }, { role: "user", content: "q" }], max_tokens: 500, stream: true };
    const result = splicePayload("openai-completions", m, s);
    if (!result.ok) throw new Error(result.reason);
    expect((result.payload as any).messages).toEqual([...m.messages, { role: "user", content: "q" }]);
    expect((result.payload as any).max_tokens).toBe(500);
  });
});

describe("helpers", () => {
  it("inertPayload empties the conversation", () => {
    expect((inertPayload("anthropic-messages", anthropicSide()) as any).messages).toEqual([]);
    expect((inertPayload("openai-responses", { input: [1] }) as any).input).toEqual([]);
  });

  it("reads the requested cache TTL", () => {
    expect(requestedCacheTtlMs("anthropic-messages", anthropicMain())).toBe(3_600_000);
    const short = JSON.parse(JSON.stringify(anthropicMain()).replaceAll(',"ttl":"1h"', ""));
    expect(requestedCacheTtlMs("anthropic-messages", short)).toBe(300_000);
    expect(requestedCacheTtlMs("openai-responses", { prompt_cache_retention: "24h" })).toBe(86_400_000);
  });
});
