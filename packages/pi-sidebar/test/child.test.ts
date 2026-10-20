import { describe, expect, it } from "vitest";
import { SidebarAgent, replayMessages, webToolSources } from "../src/child.ts";
import { MainState } from "../src/main-state.ts";
import { FakePi, fakeCtx } from "./fake.ts";

const H1 = { type: "ephemeral", ttl: "1h" };
const mainPayload = () => ({
  model: "claude-x",
  max_tokens: 1,
  stream: true,
  system: [{ type: "text", text: "MAIN", cache_control: H1 }],
  tools: [{ name: "read", cache_control: H1 }],
  messages: [{ role: "user", content: [{ type: "text", text: "fix it", cache_control: H1 }] }],
});
const sidePayload = () => ({
  model: "claude-x",
  max_tokens: 9000,
  system: [{ type: "text", text: "SIDE" }],
  messages: [{ role: "user", content: [{ type: "text", text: "what now?" }] }],
});

const entries = [
  { type: "message", id: "u1", parentId: null, timestamp: "", message: { role: "user", content: [{ type: "text", text: "fix it" }], timestamp: 0 } },
  { type: "message", id: "a1", parentId: "u1", timestamp: "", message: { role: "assistant", content: [{ type: "text", text: "Fixed a.ts." }], provider: "anthropic", model: "claude-x", api: "anthropic-messages", usage: {}, stopReason: "stop", timestamp: 0 } },
];

function setup(opts: { request?: boolean; sentAt?: number; now?: number; api?: string } = {}) {
  const pi = new FakePi();
  const now = opts.now ?? 10_000;
  const state = new MainState(pi as never, () => now);
  const { ctx } = fakeCtx({ leafId: "a1", entries, contextTokens: 22_000 });
  state.bind(ctx as never);
  if (opts.request !== false) {
    state.request = { api: opts.api ?? "anthropic-messages", provider: "anthropic", model: "claude-x", leafId: "u1", sentAt: opts.sentAt ?? now, payload: mainPayload() };
  }
  const agent = new SidebarAgent(pi as never, state, () => now);
  const cpi = new FakePi();
  (agent as unknown as { policy(): (api: unknown) => void }).policy()(cpi);
  let aborted = 0;
  const cctx = { cwd: "/repo", model: { api: "anthropic-messages" }, abort: () => { aborted++; }, sessionManager: { getSessionId: () => "side-session" } };
  const events: Array<Record<string, unknown>> = [];
  agent.onEvent((event) => events.push(event));
  return { pi, state, agent, cpi, cctx, events, aborted: () => aborted };
}

describe("Sidebar's requests", () => {
  it("adds main's newer entries, the role and the live status around Sidebar's question", async () => {
    const { cpi, cctx } = setup();
    const system = { role: "system", content: "", timestamp: 0 };
    const question = { role: "user", content: [{ type: "text", text: "what now?" }], timestamp: 0 };
    const out = await cpi.emit("context_with_system", { messages: [system, question] }, cctx);
    expect(out.messages.map((m: any) => m.role)).toEqual(["system", "assistant", "user", "user", "user"]);
    expect(out.messages[1].content[0].text).toBe("Fixed a.ts.");
    expect(out.messages[2].content[0].text).toContain("You are Sidebar");
    expect(out.messages[3].content[0].text).toContain("Main is idle");
    expect(out.messages[4]).toBe(question);
  });

  it("sends main's request unchanged with Sidebar's messages after it", async () => {
    const { cpi, cctx, aborted } = setup();
    await cpi.emit("context_with_system", { messages: [] }, cctx);
    const sent = await cpi.emit("before_provider_request", { payload: sidePayload() }, cctx);
    expect(sent.system).toEqual(mainPayload().system);
    expect(sent.tools).toEqual(mainPayload().tools);
    expect(sent.messages[0]).toEqual(mainPayload().messages[0]);
    expect(sent.messages[1].content[0].text).toBe("what now?");
    expect(sent.max_tokens).toBe(9000);
    expect(aborted()).toBe(0);
  });

  it("aborts without sending when there is no request to build on", async () => {
    const { cpi, cctx, events, aborted } = setup({ request: false });
    expect(await cpi.emit("context_with_system", { messages: [] }, cctx)).toBeUndefined();
    const sent = await cpi.emit("before_provider_request", { payload: sidePayload() }, cctx);
    expect(aborted()).toBe(1);
    expect(sent.messages).toEqual([]);
    expect(events[0]).toMatchObject({ type: "sidebar_error", message: expect.stringMatching(/Nothing was spent/) });
  });

  it("replays main's conversation only when a send without a request was confirmed", async () => {
    const { agent, cpi, cctx } = setup({ request: false });
    (agent as unknown as { allowReplay: boolean }).allowReplay = true;
    const system = { role: "system", content: "", timestamp: 0 };
    const question = { role: "user", content: [{ type: "text", text: "q" }], timestamp: 0 };
    const out = await cpi.emit("context_with_system", { messages: [system, question] }, cctx);
    // Main's transcript has no system message yet, so Sidebar's own stands in.
    expect(out.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user", "user", "user"]);
    expect(out.messages[0]).toBe(system);
    expect(await cpi.emit("before_provider_request", { payload: sidePayload() }, cctx)).toBeUndefined();
  });

  it("aborts when main and Sidebar are on different APIs", async () => {
    const { cpi, cctx, aborted } = setup({ api: "openai-responses" });
    await cpi.emit("context_with_system", { messages: [] }, cctx);
    await cpi.emit("before_provider_request", { payload: sidePayload() }, cctx);
    expect(aborted()).toBe(1);
  });

  it("is read-only, never warms its own cache, and routes by main's session id", async () => {
    const { cpi, cctx } = setup();
    expect(await cpi.emit("tool_call", { toolName: "edit", input: {} }, cctx)).toEqual({ block: true, reason: expect.stringMatching(/read-only/) });
    expect(await cpi.emit("tool_call", { toolName: "read", input: { path: "a" } }, cctx)).toBeUndefined();
    expect(await cpi.emit("cache_warming_decision", { action: "warm" }, cctx)).toEqual({ action: "stop" });
    const headers: Record<string, string> = { "x-session-affinity": "side-session", other: "keep" };
    await cpi.emit("before_provider_headers", { headers }, cctx);
    expect(headers).toEqual({ "x-session-affinity": "main-session", other: "keep" });
  });
});

describe("preflight", () => {
  it("sends while main's cache is warm", () => {
    expect(setup().agent.preflight()).toEqual({ kind: "send" });
  });

  it("asks when main has not sent a request since Pi started", () => {
    const check = setup({ request: false }).agent.preflight();
    expect(check).toMatchObject({ kind: "confirm", title: expect.stringMatching(/not sent a request/), message: expect.stringMatching(/22k tokens/) });
  });

  it("asks when main's cache has probably expired", () => {
    const check = setup({ sentAt: 0, now: 2 * 60 * 60_000 }).agent.preflight();
    expect(check).toMatchObject({ kind: "confirm", title: expect.stringMatching(/expired/) });
  });

  it("refuses an API it cannot share a cache with", () => {
    expect(setup({ api: "google-generative-ai" }).agent.preflight()).toMatchObject({ kind: "refuse" });
  });

  it("asks after an answer that missed main's cache", async () => {
    const { agent, cpi, cctx, state } = setup();
    state.live.lastUsage = { input: 0, output: 0, cacheRead: 30_000, cacheWrite: 0 };
    await cpi.emit("context_with_system", { messages: [] }, cctx);
    const usage = { input: 30_000, cacheRead: 0, cacheWrite: 0, output: 10 };
    (agent as unknown as { recordUsage(m: unknown): void }).recordUsage({ role: "assistant", usage });
    expect(agent.missed).toEqual({ read: 0, expected: expect.any(Number) });
    expect(agent.preflight()).toMatchObject({ kind: "confirm", title: expect.stringMatching(/missed/) });
    (agent as unknown as { recordUsage(m: unknown): void }).recordUsage({ role: "assistant", usage: { input: 500, cacheRead: 29_500, cacheWrite: 0 } });
    expect(agent.missed).toBeUndefined();
    expect(agent.lastAnswer).toBe("98% cached · 500 new");
  });
});

describe("helpers", () => {
  it("replays main's conversation without a turn whose tool calls are still running", () => {
    const { ctx } = fakeCtx({
      leafId: "a2",
      entries: [
        ...entries,
        { type: "message", id: "a2", parentId: "a1", timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: {} }], provider: "anthropic", model: "claude-x", api: "anthropic-messages", usage: {}, stopReason: "toolUse", timestamp: 0 } },
      ],
    });
    expect(replayMessages(ctx as never).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("loads main's web tools from the extensions that provide them", () => {
    const pi = new FakePi();
    pi.tools = [
      { name: "web_search", sourceInfo: { path: "/ext/web/index.ts" } },
      { name: "fetch_content", sourceInfo: { path: "/ext/web/index.ts" } },
      { name: "read", sourceInfo: { path: "builtin:read" } },
      { name: "codemode", sourceInfo: { path: "builtin:codemode" } },
      { name: "subagent", sourceInfo: { path: "/ext/sub.ts" } },
    ];
    expect(webToolSources(pi as never)).toEqual({ names: ["web_search", "fetch_content"], paths: ["/ext/web/index.ts"] });
  });
});
