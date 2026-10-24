import { describe, expect, it } from "vitest";
import { anchorForeign, replayMessages, replayPayload, SidebarAgent, subagentsGuarded, toolSources } from "../src/child.ts";
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
  { type: "message", id: "a1", parentId: "u1", timestamp: "", message: { role: "assistant", content: [{ type: "text", text: "Fixed a.ts." }], provider: "anthropic", model: "claude-x", api: "anthropic-messages", usage: { input: 100, cacheRead: 21_900, cacheWrite: 0 }, stopReason: "stop", timestamp: 0 } },
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
    expect(out.messages[3]).toBe(question);
    expect(out.messages[4].content[0].text).toContain("Main is idle");
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

  it("rebuilds main's request from its session when none is in memory", async () => {
    const { cpi, cctx, aborted } = setup({ request: false });
    const system = { role: "system", content: "", timestamp: 0 };
    const question = { role: "user", content: [{ type: "text", text: "q" }], timestamp: 0 };
    const out = await cpi.emit("context_with_system", { messages: [system, question] }, cctx);
    // Main's transcript has no system message here, so Sidebar's own stands in.
    expect(out.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "user", "user", "user"]);
    expect(out.messages[0]).toBe(system);
    const sent = await cpi.emit("before_provider_request", { payload: sidePayload() }, cctx);
    expect(sent).toEqual(sidePayload());
    expect(aborted()).toBe(0);
  });

  it("aborts without sending when main's request disappears mid-request", async () => {
    const { cpi, cctx, events, aborted, state } = setup();
    await cpi.emit("context_with_system", { messages: [] }, cctx);
    state.request = undefined;
    const sent = await cpi.emit("before_provider_request", { payload: sidePayload() }, cctx);
    expect(aborted()).toBe(1);
    expect(sent.messages).toEqual([]);
    expect(events[0]).toMatchObject({ type: "sidebar_error", message: expect.stringMatching(/Nothing was spent/) });
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

describe("quiz mode in requests", () => {
  it("adds its rules to the role note and its status last, and sends main's request unchanged", async () => {
    const { agent, cpi, cctx, aborted } = setup();
    agent.quiz = { role: () => "QUIZ MODE IS ON.", status: () => "<quiz-status>\nprofile\n</quiz-status>" };
    const system = { role: "system", content: "", timestamp: 0 };
    const question = { role: "user", content: [{ type: "text", text: "Quiz me." }], timestamp: 0 };
    const out = await cpi.emit("context_with_system", { messages: [system, question] }, cctx);
    const texts = out.messages.map((m: any) => (Array.isArray(m.content) ? m.content[0]?.text : m.content));
    expect(texts[2]).toMatch(/^<sidebar>\nYou are Sidebar[\s\S]*QUIZ MODE IS ON\.\n<\/sidebar>$/);
    expect(out.messages[3]).toBe(question);
    expect(texts[4]).toMatch(/Main is idle[\s\S]*<quiz-status>\nprofile\n<\/quiz-status>\n<\/sidebar-status>$/);
    const sent = await cpi.emit("before_provider_request", { payload: sidePayload() }, cctx);
    expect(aborted()).toBe(0);
    expect(sent.system).toEqual(mainPayload().system);
    expect(sent.tools).toEqual(mainPayload().tools);
    expect(sent.messages[0]).toEqual(mainPayload().messages[0]);
  });

  it("adds nothing while quiz mode is off", async () => {
    const { agent, cpi, cctx } = setup();
    agent.quiz = { role: () => undefined, status: () => "" };
    const out = await cpi.emit("context_with_system", { messages: [] }, cctx);
    const role = out.messages.find((m: any) => m.content?.[0]?.text?.startsWith("<sidebar>"));
    expect(role.content[0].text).not.toContain("QUIZ");
    expect(out.messages.at(-1).content[0].text).not.toContain("quiz-status");
  });
});

describe("preflight", () => {
  it("sends while main's cache is warm", () => {
    expect(setup().agent.preflight()).toEqual({ kind: "send" });
  });

  it("sends without a request in memory while main's last answer is recent", () => {
    expect(setup({ request: false }).agent.preflight()).toEqual({ kind: "send" });
  });

  it("asks without a request in memory when main's last answer is older than its cache", () => {
    const check = setup({ request: false, now: 2 * 60 * 60_000 }).agent.preflight();
    expect(check).toMatchObject({ kind: "confirm", title: expect.stringMatching(/expired/), message: expect.stringMatching(/22k tokens/) });
  });

  it("sends right away when main has no conversation yet", () => {
    const { agent, state } = setup({ request: false });
    state.bind(fakeCtx({ entries: [] }).ctx as never);
    expect(agent.preflight()).toEqual({ kind: "send" });
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

describe("replayPayload", () => {
  const H = { type: "ephemeral", ttl: "1h" };
  const rebuilt = () => ({
    model: "claude-x",
    prompt_cache_key: "side-session",
    system: [{ type: "text", text: "identity", cache_control: H }, { type: "text", text: "MAIN", cache_control: H }],
    tools: [{ name: "read", cache_control: H }],
    messages: [
      { role: "user", content: [{ type: "text", text: "fix it" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "tool_use", id: "1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "Fixed." }] },
      { role: "user", content: [{ type: "text", text: "<sidebar>\nYou are Sidebar" }, { type: "text", text: "q1" }, { type: "text", text: "q", cache_control: { type: "ephemeral" } }, { type: "text", text: "<sidebar-status>" }] },
    ],
  });

  it("puts the breakpoint where main's last request ended, and Sidebar's own on its last block", () => {
    const out = replayPayload("anthropic-messages", rebuilt(), "side-session", "main-session") as any;
    expect(out.messages[2].content[0].cache_control).toEqual(H);
    // The redundant first system breakpoint goes to Sidebar's last block (not the status note).
    expect(out.system[0].cache_control).toBeUndefined();
    expect(out.messages[4].content[2].cache_control).toEqual({ type: "ephemeral" });
    expect(out.messages[4].content[1].cache_control).toBeUndefined();
    expect(JSON.stringify(out).match(/cache_control/g)).toHaveLength(4);
    expect(out.prompt_cache_key).toBe("main-session");
  });

  it("keeps both system breakpoints when there is a spare slot", () => {
    const input = rebuilt();
    input.system = [input.system[1]!];
    const out = replayPayload("anthropic-messages", input, "side-session", "main-session") as any;
    expect(out.system[0].cache_control).toEqual(H);
    expect(out.messages[2].content[0].cache_control).toEqual(H);
    expect(out.messages[4].content[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("leaves a request without Sidebar's part alone", () => {
    const input = { model: "m", messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }] }] };
    expect(replayPayload("anthropic-messages", input, "a", "b")).toEqual(input);
  });
});

describe("helpers", () => {
  it("replays main's conversation without a turn whose tool calls are still running", () => {
    const { ctx } = fakeCtx({
      leafId: "a2",
      entries: [
        ...entries,
        { type: "message", id: "a2", parentId: "a1", timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "npm test" } }], provider: "anthropic", model: "claude-x", api: "anthropic-messages", usage: {}, stopReason: "toolUse", timestamp: 0 } },
      ],
    });
    const replay = replayMessages(ctx as never);
    expect(replay.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(replay.pending).toEqual([{ name: "bash", summary: "npm test" }]);
  });

  it("keeps the finished calls of a parallel turn when it replays", () => {
    const { ctx } = fakeCtx({
      leafId: "r1",
      entries: [
        ...entries,
        { type: "message", id: "a2", parentId: "a1", timestamp: "", message: { role: "assistant", content: [{ type: "toolCall", id: "r", name: "read", arguments: { path: "a.ts" } }, { type: "toolCall", id: "b", name: "bash", arguments: { command: "sleep 9" } }], provider: "anthropic", model: "claude-x", api: "anthropic-messages", usage: {}, stopReason: "toolUse", timestamp: 0 } },
        { type: "message", id: "r1", parentId: "a2", timestamp: "", message: { role: "toolResult", toolCallId: "r", toolName: "read", content: [{ type: "text", text: "export const a = 1;" }], isError: false, timestamp: 0 } },
      ],
    });
    const replay = replayMessages(ctx as never);
    expect(replay.messages.map((m) => m.role)).toEqual(["user", "assistant", "assistant", "toolResult"]);
    expect((replay.messages[2] as any).content).toEqual([{ type: "toolCall", id: "r", name: "read", arguments: { path: "a.ts" } }]);
    expect(replay.pending).toEqual([{ name: "bash", summary: "sleep 9" }]);
  });

  it("loads every tool main has, switched on or not, except refused ones and pi-sidebar", () => {
    const pi = new FakePi();
    pi.tools = [
      { name: "web_search", sourceInfo: { path: "/ext/web/index.ts" } },
      { name: "fetch_content", sourceInfo: { path: "/ext/web/index.ts" } },
      { name: "subagent", sourceInfo: { path: "/suite/packages/pi-subagents/src/index.ts" } },
      { name: "todo", sourceInfo: { path: "/suite/packages/pi-todo/index.ts" } },
      { name: "read", sourceInfo: { path: "builtin:read" } },
      { name: "codemode", sourceInfo: { path: "builtin:codemode" } },
      { name: "mcp__docs__search", sourceInfo: { path: "builtin:mcp" } },
      { name: "peek", sourceInfo: { path: "/suite/packages/pi-sidebar/src/index.ts" } },
    ];
    const sources = toolSources(pi as never);
    expect(sources.paths).toEqual(["/ext/web/index.ts", "/suite/packages/pi-subagents/src/index.ts"]);
    expect(sources.builtins).toHaveLength(2);
    expect(sources.names).toEqual(["read", "grep", "find", "ls", "bash", "web_search", "fetch_content", "subagent", "codemode", "mcp__docs__search"]);
  });

  it("knows whether pi-subagents will give its subagents the guard", () => {
    const pi = new FakePi();
    expect(subagentsGuarded(pi.events)).toBe(false);
    pi.events.on("pi-plugins.subagent-env.v1", (data) => { if ((data as { probe?: boolean }).probe) (data as { supported?: boolean }).supported = true; });
    expect(subagentsGuarded(pi.events)).toBe(true);
  });

});

describe("messages added outside a turn", () => {
  it("join the thread and are stored like an exchange", async () => {
    const { pi, agent } = setup();
    const note = [{ role: "user", content: [{ type: "text", text: "<sidebar-headsup-note>x" }], timestamp: 1 }] as never[];
    await agent.appendMessages(note);
    expect(agent.messages).toEqual(note);
    expect(pi.entries.at(-1)).toMatchObject({ customType: "sidebar:exchange", data: { version: 1, messages: note } });
    expect(agent.idle).toBe(true);
  });
});

describe("Sidebar on another model", () => {
  const SOL = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", name: "GPT-6.1 Sol", contextWindow: 500_000 };
  const FABLE = { provider: "anthropic", id: "claude-fable-5-1", api: "anthropic-messages", name: "Claude Fable 5.1", contextWindow: 1_000_000 };

  function foreignSetup(model: typeof SOL = SOL, opts: { now?: number } = {}) {
    const pi = new FakePi();
    let now = opts.now ?? 10_000;
    const state = new MainState(pi as never, () => now);
    const { ctx } = fakeCtx({ leafId: "a1", entries, contextTokens: 22_000 });
    state.bind(ctx as never);
    state.request = { api: "anthropic-messages", provider: "anthropic", model: "claude-x", leafId: "u1", sentAt: now, payload: mainPayload() };
    const agent = new SidebarAgent(pi as never, state, () => now);
    agent.modelChoice = () => ({ kind: "other", pattern: "p", model, label: model.name });
    const cpi = new FakePi();
    (agent as unknown as { policy(f: unknown): (api: unknown) => void }).policy({ model, label: model.name })(cpi);
    const cctx = { cwd: "/repo", model: { api: model.api }, abort: () => {}, sessionManager: { getSessionId: () => "derived-session" } };
    return { pi, state, agent, cpi, cctx, setNow: (t: number) => { now = t; } };
  }

  it("puts its role first, then main's transcript as someone else's work, then the question", async () => {
    const { cpi, cctx } = foreignSetup();
    const system = { role: "system", content: "OWN PROMPT", timestamp: 0 };
    const question = { role: "user", content: [{ type: "text", text: "is this right?" }], timestamp: 0 };
    const out = await cpi.emit("context_with_system", { messages: [system, question] }, cctx);
    expect(out.messages.map((m: any) => m.role)).toEqual(["system", "user", "user", "user", "user"]);
    expect(out.messages[0]).toBe(system);
    expect(out.messages[1].content[0].text).toMatch(/^<sidebar>\nYou are Sidebar: the user's read-only side chat, running on GPT-6\.1 Sol[\s\S]*second opinion/);
    expect(out.messages[2].content[0].text).toBe('<main-transcript part="1">\n[user]\nfix it\n\n[main agent]\nFixed a.ts.\n</main-transcript>');
    expect(out.messages[3]).toBe(question);
    expect(out.messages[4].content[0].text).toContain("Main is idle");
  });

  it("interleaves main's new activity with its own exchanges, so each request extends the last", async () => {
    const { cpi, cctx, state } = foreignSetup();
    const system = { role: "system", content: "OWN PROMPT", timestamp: 0 };
    const q1 = { role: "user", content: [{ type: "text", text: "q1" }], timestamp: 0 };
    const a1 = { role: "assistant", content: [{ type: "text", text: "a1" }], timestamp: 0 };
    const q2 = { role: "user", content: [{ type: "text", text: "q2" }], timestamp: 0 };
    const first = await cpi.emit("context_with_system", { messages: [system, q1] }, cctx);
    const more = [
      ...entries,
      { type: "message", id: "u2", parentId: "a1", timestamp: "", message: { role: "user", content: [{ type: "text", text: "and b.ts" }], timestamp: 0 } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "", message: { role: "assistant", content: [{ type: "text", text: "Fixed b.ts." }], provider: "anthropic", model: "claude-x", api: "anthropic-messages", usage: {}, stopReason: "stop", timestamp: 0 } },
    ];
    state.bind(fakeCtx({ leafId: "a2", entries: more }).ctx as never);
    const second = await cpi.emit("context_with_system", { messages: [system, q1, a1, q2] }, cctx);
    const text = (m: any) => (Array.isArray(m.content) ? m.content[0].text : m.content);
    // Everything before the first request's status is unchanged at the start of the second.
    expect(second.messages.slice(0, first.messages.length - 1).map(text)).toEqual(first.messages.slice(0, -1).map(text));
    expect(second.messages.slice(first.messages.length - 1).map(text)).toEqual(["a1", '<main-transcript part="2">\n[user]\nand b.ts\n\n[main agent]\nFixed b.ts.\n</main-transcript>', "q2", expect.stringContaining("<sidebar-status")]);
  });

  it("keeps its own session id for cache routing instead of main's", async () => {
    const { cpi, cctx } = foreignSetup();
    await cpi.emit("context_with_system", { messages: [] }, cctx);
    const payload = { model: "gpt-6.1-sol", prompt_cache_key: "derived-session", input: [] };
    expect(await cpi.emit("before_provider_request", { payload }, cctx)).toEqual(payload);
    const headers: Record<string, string> = { session_id: "derived-session" };
    await cpi.emit("before_provider_headers", { headers }, cctx);
    expect(headers).toEqual({ session_id: "derived-session" });
  });

  it("on Anthropic, marks the end of everything before the status, and the newest part", async () => {
    const { cpi, cctx } = foreignSetup(FABLE as never);
    await cpi.emit("context_with_system", { messages: [] }, cctx);
    const H = { type: "ephemeral", ttl: "1h" };
    const payload = {
      model: "claude-fable-5-1",
      system: [{ type: "text", text: "OWN", cache_control: H }],
      tools: [{ name: "read", cache_control: H }],
      messages: [
        { role: "user", content: [{ type: "text", text: "<sidebar>\nYou are Sidebar" }, { type: "text", text: '<main-transcript part="1">\n…' }, { type: "text", text: "q1" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a1" }] },
        { role: "user", content: [{ type: "text", text: '<main-transcript part="2">\n…' }, { type: "text", text: "q2" }, { type: "text", text: "<sidebar-status>", cache_control: H }] },
      ],
    };
    const out = await cpi.emit("before_provider_request", { payload }, { ...cctx, model: { api: "anthropic-messages" } });
    const marks = out.messages.flatMap((m: any) => m.content).map((b: any) => b.cache_control ?? null);
    expect(marks).toEqual([null, null, null, null, null, H, H, null]);
    expect(out.system[0].cache_control).toEqual(H);
  });

  it("on a Claude subscription login, gives the redundant system mark to its own end", () => {
    const H = { type: "ephemeral", ttl: "1h" };
    const payload = {
      system: [{ type: "text", text: "identity", cache_control: H }, { type: "text", text: "OWN", cache_control: H }],
      tools: [{ name: "read", cache_control: H }],
      messages: [{ role: "user", content: [{ type: "text", text: '<main-transcript part="1">\n…' }, { type: "text", text: "q" }, { type: "text", text: "<sidebar-status>" }] }],
    };
    const out = anchorForeign("anthropic-messages", payload) as any;
    expect(out.system[0].cache_control).toBeUndefined();
    expect(out.messages[0].content.map((b: any) => b.cache_control ?? null)).toEqual([H, H, null]);
    expect(JSON.stringify(out).match(/cache_control/g)).toHaveLength(4);
  });

  it("asks before reading a large transcript into a cold cache, then sends while it is warm", async () => {
    const big = [
      ...entries,
      { type: "message", id: "a2", parentId: "a1", timestamp: "", message: { role: "user", content: [{ type: "text", text: "z".repeat(60_000) }], timestamp: 0 } },
    ];
    const { agent, cpi, cctx, state, setNow } = foreignSetup();
    state.bind(fakeCtx({ leafId: "a2", entries: big }).ctx as never);
    expect(agent.preflight()).toMatchObject({ kind: "confirm", title: "GPT-6.1 Sol has no warm cache of main's session", message: expect.stringMatching(/17k tokens/) });
    await cpi.emit("context_with_system", { messages: [] }, cctx);
    await cpi.emit("before_provider_request", { payload: { input: [] } }, cctx);
    expect(agent.preflight()).toEqual({ kind: "send" });
    setNow(10_000 + 10 * 60_000);
    expect(agent.preflight()).toMatchObject({ kind: "confirm" });
  });

  it("counts a miss only when its own cache should have served the request", async () => {
    const { agent, cpi, cctx } = foreignSetup();
    const record = (usage: unknown) => (agent as unknown as { recordUsage(m: unknown): void }).recordUsage({ role: "assistant", usage });
    await cpi.emit("context_with_system", { messages: [] }, cctx);
    await cpi.emit("before_provider_request", { payload: { input: [] } }, cctx);
    record({ input: 30_000, cacheRead: 0, cacheWrite: 0 });
    expect(agent.missed).toBeUndefined();
    await cpi.emit("context_with_system", { messages: [] }, cctx);
    await cpi.emit("before_provider_request", { payload: { input: [] } }, cctx);
    record({ input: 30_000, cacheRead: 0, cacheWrite: 0 });
    expect(agent.missed).toEqual({ read: 0, expected: 30_000, own: true });
    expect(agent.preflight()).toMatchObject({ kind: "confirm", title: "The last answer missed GPT-6.1 Sol's cache" });
  });

  it("refuses a favorite that matches no model with a login", () => {
    const { agent } = foreignSetup();
    agent.modelChoice = () => ({ kind: "unavailable", pattern: "nope/x" });
    expect(agent.preflight()).toMatchObject({ kind: "refuse", reason: expect.stringMatching(/nope\/x/) });
  });
});
