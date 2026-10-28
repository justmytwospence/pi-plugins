import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import cacheGuard, { JEV_TIP, MODEL_OFFERS, type ModelOffers, OFFER_TIMEOUT_MS, OPTION_MAX, choiceMenu, cleanOffers, coldTitle, modelInfo, statusText } from "../src/index.ts";
import { lastRequest, view } from "../src/clock.ts";
import { HerdrReporter, alertHeld, soundFile } from "../src/herdr.ts";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const opus = {
  provider: "anthropic", id: "claude-opus-5-5", promptCache: { short: 300, long: 3600 },
  cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};
const sonnet = { ...opus, id: "claude-sonnet-5-5", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } };
const codex = { provider: "openai-codex", id: "gpt-6-astra", cost: { input: 10, output: 40, cacheRead: 1, cacheWrite: 0 } };

function assistant(at: number, prompt: number, model = opus, output = 1_000) {
  return {
    type: "message", timestamp: new Date(at).toISOString(),
    message: { role: "assistant", provider: model.provider, model: model.id, timestamp: at,
      usage: { input: 2, cacheRead: prompt - 2, cacheWrite: 0, output } },
  };
}
const warm = (at: number, cacheRead: number) => ({
  type: "usage", kind: "cache_warm", timestamp: new Date(at).toISOString(), usage: { input: 2, cacheRead, cacheWrite: 0, output: 1 },
});

describe("clock", () => {
  test("warming refreshes move the clock; compaction clears it", () => {
    const entries = [assistant(NOW - 900_000, 600_000), warm(NOW - 600_000, 600_000), warm(NOW - 330_000, 600_000)];
    const last = lastRequest(entries)!;
    expect(last.realAt).toBe(NOW - 900_000);
    expect(last.at).toBe(NOW - 332_000);
    expect(last.tokens).toBe(601_000);
    expect(lastRequest([...entries, { type: "compaction" }])).toBeUndefined();
  });

  test("a warm that missed does not count as a refresh", () => {
    const last = lastRequest([assistant(NOW - 900_000, 600_000), warm(NOW - 600_000, 0)])!;
    expect(last.at).toBe(NOW - 900_000);
  });

  test("views: warm, expired, model switch, no TTL", () => {
    const last = lastRequest([assistant(NOW - 60_000, 600_000)])!;
    expect(statusText(view(last, modelInfo(opus as any, {})!, NOW, 3 * 3_600_000))).toBe("cache 4:00");
    const old = lastRequest([assistant(NOW - 600_000, 600_000)])!;
    expect(view(old, modelInfo(opus as any, {})!, NOW, 3 * 3_600_000).cold).toEqual({ kind: "expired", idleMs: 300_000 });
    expect(statusText(view(old, modelInfo(opus as any, { PI_CACHE_RETENTION: "long" })!, NOW, 3 * 3_600_000))).toBe("cache 50:00");
    expect(statusText(view(last, modelInfo(sonnet as any, {})!, NOW, 3 * 3_600_000))).toBe("cache cold (model)");
    const c = lastRequest([assistant(NOW - 4 * 3_600_000, 200_000, codex as any)])!;
    expect(statusText(view(c, modelInfo(codex as any, {})!, NOW, 3 * 3_600_000))).toBe("cache cold?");
    expect(modelInfo(codex as any, {})!.price).toEqual({ input: 10, cacheRead: 1, cacheWrite: 10 });
  });

  test("views: an estimated lifetime goes probably cold, not expired", () => {
    const info = modelInfo(codex as any, {})!;
    expect(info).toMatchObject({ ttlMs: 1_800_000, likely: true });
    const recent = lastRequest([assistant(NOW - 600_000, 200_000, codex as any)])!;
    expect(statusText(view(recent, info, NOW, 3 * 3_600_000))).toBe("cache ~20:00");
    const old = lastRequest([assistant(NOW - 2_400_000, 200_000, codex as any)])!;
    expect(view(old, info, NOW, 3 * 3_600_000).cold).toEqual({ kind: "idle", idleMs: 2_400_000 });
    expect(modelInfo(codex as any, { PI_CACHE_RETENTION: "none" })).toBeUndefined();
  });
});

function harness(entries: unknown[], model: any = opus, registry: Record<string, unknown> = {}) {
  return harnessWith(entries, new HerdrReporter(undefined), model, registry);
}

function harnessWith(entries: unknown[], herdr: HerdrReporter, model: any = opus, registry: Record<string, unknown> = {}) {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, any>();
  const renderers = new Map<string, any>();
  const appended: Array<{ customType: string; data: any }> = [];
  const blocked: unknown[] = [];
  const alerts: string[] = [];
  const states: unknown[] = [];
  const choices: unknown[] = [];
  const listeners = new Map<string, Array<(data: any) => void>>();
  const listen = (channel: string, fn: (data: any) => void) => listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
  const pi = {
    events: {
      emit: (channel: string, data: unknown) => {
        if (channel === "herdr:blocked") blocked.push(data);
        if (channel === "cache:state") states.push(data);
        if (channel === "cache:model-choice") choices.push(data);
        for (const fn of listeners.get(channel) ?? []) fn(data);
      },
      on: (channel: string, fn: (data: any) => void) => { listen(channel, fn); return () => undefined; },
    },
    on: (name: string, handler: any) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => undefined; },
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerEntryRenderer: (type: string, renderer: any) => renderers.set(type, renderer),
    appendEntry: (customType: string, data: unknown) => appended.push({ customType, data }),
    getThinkingLevel: () => "high",
    setThinkingLevel: (level: string) => sent.push({ thinking: level }),
    setModel: async (m: any) => { sent.push({ model: m.id }); return true; },
    sendUserMessage: async (content: unknown, options?: any) => {
      if (typeof content === "string" && content.startsWith("/cache-guard ") && options?.expandPromptTemplates) {
        await commands.get("cache-guard").handler(content.slice("/cache-guard ".length), ctx);
      } else sent.push({ session: ctx.sessionManager.getBranch().length ? "old" : "new", content });
    },
  };
  const ui = {
    status: new Map<string, string | undefined>(),
    confirms: [] as string[],
    menus: [] as string[][],
    titles: [] as string[],
    // Answers to successive selects, each a prefix of the option to pick (undefined: escape).
    answers: [] as Array<string | undefined>,
    answer: "Send anyway" as string | undefined,
    inputs: [] as Array<string | undefined>,
    compactions: [] as any[],
    editor: "",
    notes: [] as string[],
    setStatus: (key: string, text: string | undefined) => ui.status.set(key, text),
    select: async (title: string, options: string[], opts?: { signal?: AbortSignal }) => {
      ui.menus.push(options);
      ui.titles.push(title);
      if (ui.answers[0] === "(wait)") {
        ui.answers.shift();
        return new Promise<undefined>((resolve) => opts?.signal?.addEventListener("abort", () => resolve(undefined)));
      }
      if (title.startsWith("Prompt cache miss.")) { ui.confirms.push(title); expect(options[0]).toMatch(/^Send /); }
      const answer = ui.answers.length ? ui.answers.shift() : ui.answer;
      return answer === undefined ? undefined : options.find((option) => option.startsWith(answer));
    },
    input: async () => ui.inputs.shift(),
    getEditorText: () => ui.editor,
    setEditorText: (text: string) => { ui.editor = text; },
    notify: (message: string) => ui.notes.push(message),
  };
  const sent: any[] = [];
  const sessions: any[] = [];
  const ctx: any = {
    cwd: "/nonexistent", hasUI: true, model, ui,
    sessionManager: { getBranch: () => entries, getSessionFile: () => "/sessions/old.jsonl" },
    compact: (options: any) => ui.compactions.push(options),
    modelRegistry: { find: (provider: string, id: string) => ({ ...model, provider, id }), ...registry },
    newSession: async (options: any) => {
      sessions.push(options.parentSession);
      ctx.sessionManager.getBranch = () => [];
      await emit("session_start", { type: "session_start", reason: "new" });
      return { cancelled: false };
    },
  };
  cacheGuard(pi as any, { herdr, alert: (body) => alerts.push(body) });
  const emit = async (name: string, event: any) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = (await handler(event, ctx)) ?? result;
    return result;
  };
  return { emit, ui, ctx, commands, sent, sessions, appended, renderers, blocked, alerts, states, choices, listen };
}

const input = (text: string, extra: Record<string, unknown> = {}) => ({ type: "input", text, source: "interactive", ...extra });

describe("extension", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  test("publishes and ticks the status", async () => {
    const h = harness([assistant(NOW - 60_000, 600_000)]);
    await h.emit("session_start", {});
    expect(h.ui.status.get("cache-guard")).toBe("cache 4:00");
    vi.advanceTimersByTime(5_000);
    expect(h.ui.status.get("cache-guard")).toBe("cache 3:55");
    vi.advanceTimersByTime(300_000);
    expect(h.ui.status.get("cache-guard")).toBe("cache cold");
    await h.emit("session_shutdown", {});
    expect(h.ui.status.get("cache-guard")).toBeUndefined();
  });

  test("the clock follows the cache lifetime the wire reports", async () => {
    const sol = { provider: "openai", id: "gpt-5.6-sol", api: "openai-responses", compat: { supportsExplicitPromptCacheMode: true },
      cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } };
    const h = harness([assistant(NOW - 60_000, 600_000, sol as any)], sol, { isUsingOAuth: () => false });
    await h.emit("session_start", {});
    expect(h.ui.status.get("cache-guard")).toBe("cache 29:00");
    // Another model's request (Jev, say) does not count.
    await h.emit("before_provider_request", { payload: { model: "jev-latest", prompt_cache_options: { ttl: "12h" } } });
    vi.advanceTimersByTime(1_000);
    expect(h.ui.status.get("cache-guard")).toBe("cache 28:59");
    await h.emit("before_provider_request", { payload: { model: "gpt-5.6-sol", prompt_cache_options: { ttl: "12h" } } });
    vi.advanceTimersByTime(1_000);
    expect(h.ui.status.get("cache-guard")).toBe("cache 11h58m");

    const c = harness([assistant(NOW - 600_000, 600_000, codex as any)], codex);
    await c.emit("session_start", {});
    expect(c.ui.status.get("cache-guard")).toBe("cache ~19:58");
    await c.emit("provider_stream_event", { provider: "openai-codex", model: "gpt-6-astra", data: { type: "response.completed", response: { prompt_cache_retention: "in_memory" } } });
    vi.advanceTimersByTime(1_000);
    expect(c.ui.status.get("cache-guard")).toBe("cache cold?");
  });

  test("emits cache:state on cold/warm changes, before each prompt and at agent start", async () => {
    const h = harness([assistant(NOW - 60_000, 600_000)]);
    await h.emit("session_start", {});
    expect(h.states).toEqual([{ cold: false, tokens: 601_000, model: "anthropic/claude-opus-5-5" }]);
    // Ticks while nothing changes send nothing.
    vi.advanceTimersByTime(5_000);
    expect(h.states).toHaveLength(1);
    // The TTL runs out: one cold state.
    vi.advanceTimersByTime(300_000);
    expect(h.states.slice(1)).toEqual([{ cold: true, tokens: 601_000, model: "anthropic/claude-opus-5-5" }]);
    vi.advanceTimersByTime(5_000);
    expect(h.states).toHaveLength(2);
    // A prompt and the run it starts each get a fresh value, changed or not.
    await h.emit("input", input("/cache-guard status"));
    await h.emit("agent_start", {});
    expect(h.states).toHaveLength(4);
    expect(h.states[3]).toEqual({ cold: true, tokens: 601_000, model: "anthropic/claude-opus-5-5" });
    // A model switch is cold for the old model's cache.
    const s = harness([assistant(NOW - 60_000, 600_000)], sonnet);
    await s.emit("session_start", {});
    expect(s.states).toEqual([{ cold: true, tokens: 601_000, model: "anthropic/claude-opus-5-5" }]);
    // Nothing cached yet (or just compacted): cold, no tokens, the session's model.
    const e = harness([]);
    await e.emit("session_start", {});
    expect(e.states).toEqual([{ cold: true, model: "anthropic/claude-opus-5-5" }]);
  });

  test("lets a warm prompt through without asking", async () => {
    const h = harness([assistant(NOW - 60_000, 600_000)]);
    await h.emit("session_start", {});
    expect(await h.emit("input", input("go on"))).toEqual({ action: "continue" });
    expect(h.ui.confirms).toEqual([]);
  });

  test("asks before a cold prompt and keeps it in the editor on No", async () => {
    const h = harness([assistant(NOW - 900_000, 600_000)]);
    await h.emit("session_start", {});
    h.ui.answer = undefined; // escape
    expect(await h.emit("input", input("next step please"))).toEqual({ action: "handled" });
    expect(h.ui.confirms[0]).toContain("expired 10m ago: this prompt re-caches 601k tokens");
    expect(h.ui.editor).toBe("next step please");
    expect(h.alerts).toEqual(["nonexistent: next step please"]);
    expect(h.blocked).toEqual([{ active: true, label: "Prompt cache miss" }, { active: false }]);
    h.ui.answer = "Send anyway";
    expect(await h.emit("input", input("next step please"))).toEqual({ action: "continue" });
  });

  test("small contexts, commands, steering and extension input pass", async () => {
    const small = harness([assistant(NOW - 900_000, 50_000)]);
    await small.emit("session_start", {});
    expect(await small.emit("input", input("hi"))).toEqual({ action: "continue" });
    expect(small.alerts).toEqual([]);
    expect(small.blocked).toEqual([]);
    const h = harness([assistant(NOW - 900_000, 600_000)]);
    await h.emit("session_start", {});
    expect(await h.emit("input", input("/compact"))).toEqual({ action: "continue" });
    expect(await h.emit("input", input("more", { streamingBehavior: "steer" }))).toEqual({ action: "continue" });
    expect(await h.emit("input", input("more", { source: "extension" }))).toEqual({ action: "continue" });
    expect(h.ui.confirms).toEqual([]);
  });

  test("asks before a model switch drops a large cache", async () => {
    const h = harness([assistant(NOW - 10_000, 600_000)], sonnet);
    await h.emit("session_start", {});
    h.ui.answer = undefined; // escape
    expect(await h.emit("input", input("continue"))).toEqual({ action: "handled" });
    expect(h.ui.confirms[0]).toContain("claude-sonnet-5-5 has no cache of this conversation");
  });

  test("the streaming message's start keeps the clock current", async () => {
    const h = harness([assistant(NOW - 290_000, 600_000)]);
    await h.emit("session_start", {});
    await h.emit("message_start", { message: { role: "assistant", timestamp: NOW, provider: "anthropic", model: "claude-opus-5-5" } });
    expect(h.ui.status.get("cache-guard")).toBe("cache 5:00");
  });
});

describe("held-prompt alert", () => {
  const bus = () => {
    const sent: unknown[] = [];
    return { sent, events: { emit: (channel: string, data: unknown) => sent.push({ channel, data }) } };
  };

  test("a sound name resolves to the macOS system sound; unknown names and blank do not", () => {
    expect(soundFile("")).toBeUndefined();
    expect(soundFile("NoSuchSound")).toBeUndefined();
    expect(soundFile("/nonexistent/thunk.aiff")).toBeUndefined();
    if (existsSync("/System/Library/Sounds/Basso.aiff")) expect(soundFile("Basso")).toBe("/System/Library/Sounds/Basso.aiff");
  });

  test("herdr gets a notification, with its own sound only when no macOS sound played", () => {
    const linux = bus();
    alertHeld(linux.events, "Basso", "proj: next step", "linux");
    expect(linux.sent).toEqual([{ channel: "herdr:notify", data: { title: "Prompt not sent: cache cold", body: "proj: next step", sound: "request" } }]);
    const silent = bus();
    alertHeld(silent.events, "", "proj: next step", "linux");
    expect(silent.sent).toEqual([{ channel: "herdr:notify", data: { title: "Prompt not sent: cache cold", body: "proj: next step", sound: "none" } }]);
  });
});

describe("herdr", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  function reporter() {
    const sent: any[] = [];
    const r = new HerdrReporter({ emit: (channel, data) => { expect(channel).toBe("herdr:token"); sent.push(data); } });
    return { r, sent };
  }

  test("reports the cache token only when a big cache goes cold, and clears it", async () => {
    const { r, sent } = reporter();
    const entries: unknown[] = [assistant(NOW - 60_000, 600_000)];
    const h = harnessWith(entries, r);
    await h.emit("session_start", {});
    expect(sent).toEqual([{ key: "cache", value: undefined }]); // the first report always goes out
    vi.advanceTimersByTime(60_000);
    expect(sent.length).toBe(1); // still warm: nothing new
    vi.advanceTimersByTime(200_000);
    expect(sent.at(-1)).toEqual({ key: "cache", value: "❄ 601k" });
    entries.push(assistant(Date.now(), 610_000));
    vi.advanceTimersByTime(1_000);
    expect(sent.at(-1).value).toBeUndefined();
    vi.advanceTimersByTime(400_000);
    expect(sent.at(-1).value).toBe("❄ 611k");
    r.resend();
    expect(sent.at(-1).value).toBe("❄ 611k");
    await h.emit("session_shutdown", {});
    expect(sent.at(-1).value).toBeUndefined();
  });

  test("small caches never show", async () => {
    const { r, sent } = reporter();
    const h = harnessWith([assistant(NOW - 900_000, 50_000)], r);
    await h.emit("session_start", {});
    vi.advanceTimersByTime(5_000);
    expect(sent.map((p) => p.value)).toEqual([undefined]);
  });

  test("without an event bus nothing is sent", () => {
    const r = new HerdrReporter(undefined);
    r.report("❄ 1M");
    r.resend();
    return expect(r.clear()).resolves.toBe(true);
  });
});

describe("choices", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());
  const cold = () => harness([assistant(NOW - 900_000, 600_000)]);

  test("the menu prices each way through", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answer = undefined;
    await h.emit("input", input("next"));
    expect(h.ui.menus[0]).toEqual([
      "Send anyway",
      "Send, and stop asking in this session",
      "Compact first, then send",
      "Start a new session with this prompt",
      "Keep the prompt in the editor",
    ]);
  });

  test("compact with focus on the prompt, then send it", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Compact", "Focus"];
    expect(await h.emit("input", input("fix the parser"))).toEqual({ action: "handled" });
    const compaction = h.ui.compactions[0];
    expect(compaction.customInstructions).toContain("continue with the user's next request");
    expect(compaction.customInstructions).toContain("fix the parser");
    compaction.onComplete({});
    await Promise.resolve();
    expect(h.sent).toEqual([{ session: "old", content: "fix the parser" }]);
  });

  test("compact with written guidance; escape at the guidance keeps the prompt", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Compact", "Write"];
    h.ui.inputs = ["keep the test plan"];
    await h.emit("input", input("go"));
    expect(h.ui.compactions[0].customInstructions).toBe("keep the test plan");
    h.ui.answers = ["Compact", "Write"];
    h.ui.inputs = [undefined];
    expect(await h.emit("input", input("go"))).toEqual({ action: "handled" });
    expect(h.ui.compactions.length).toBe(1);
    expect(h.ui.editor).toBe("go");
  });

  test("a failed compaction puts the prompt back", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Compact", "Default"];
    await h.emit("input", input("go"));
    expect(h.ui.compactions[0].customInstructions).toBeUndefined();
    h.ui.compactions[0].onError(new Error("nope"));
    expect(h.ui.editor).toBe("go");
  });

  test("start fresh carries the prompt into a new linked session", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Start a new session"];
    expect(await h.emit("input", input("new topic"))).toEqual({ action: "handled" });
    await vi.runOnlyPendingTimersAsync();
    expect(h.sessions).toEqual(["/sessions/old.jsonl"]);
    await vi.runOnlyPendingTimersAsync();
    expect(h.sent).toEqual([{ thinking: "high" }, { session: "new", content: "new topic" }]);
  });

  test("stop asking: sends now and later without the menu", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Send, and stop"];
    expect(await h.emit("input", input("a"))).toEqual({ action: "continue" });
    expect(await h.emit("input", input("b"))).toEqual({ action: "continue" });
    expect(h.ui.confirms.length).toBe(1);
  });

  test("status tells the truth about a muted or switched-off warning", async () => {
    const h = cold();
    await h.emit("session_start", {});
    const status = async () => {
      await h.commands.get("cache-guard").handler("status", h.ctx);
      return h.ui.notes.at(-1) as string;
    };
    expect(await status()).toContain("The next prompt asks before sending.");
    expect(await status()).toContain("Warning: on, from 100k tokens (warn.minTokens)");

    h.ui.answers = ["Send, and stop"];
    await h.emit("input", input("a"));
    const muted = await status();
    expect(muted).toContain("The next prompt is sent without asking: the warning is muted for this session.");
    expect(muted).toContain('Warning: muted for this session after "Send, and stop asking" (/cache-guard on turns it back on)');
    expect(muted).not.toContain("Warning: on");
    expect(h.ui.status.get("cache-guard")).toBe("cache cold");

    await h.commands.get("cache-guard").handler("on", h.ctx);
    expect(await status()).toContain("The next prompt asks before sending.");
    await h.commands.get("cache-guard").handler("off", h.ctx);
    const off = await status();
    expect(off).toContain("Warning: off for this session (/cache-guard on turns it back on)");
    expect(off).toContain("The next prompt is sent without asking: the warning is off.");
    expect(off).not.toContain("muted for this session");
    expect(h.ui.status.get("cache-guard")).toBeUndefined();
    const asked = h.ui.confirms.length;
    expect(await h.emit("input", input("while off"))).toEqual({ action: "continue" });
    expect(h.ui.confirms).toHaveLength(asked);
    await h.emit("session_start", { reason: "new" });
    expect(await status()).toContain("Warning: on");
  });

  test("unknown subcommands and stray arguments are refused without side effects", async () => {
    const registry = jevRegistry();
    const h = harness([assistant(NOW - 900_000, 600_000)], opus, registry);
    await h.emit("session_start", {});
    h.ui.editor = "keep this prompt";
    const run = async (args: string) => {
      await h.commands.get("cache-guard").handler(args, h.ctx);
      return h.ui.notes.at(-1) as string;
    };
    expect(await run("stats")).toBe('/cache-guard: unknown subcommand "stats". Use one of: status, on, off, fresh, compact, jev.');
    for (const command of ["status", "on", "off", "fresh", "jev"]) {
      expect(await run(`  ${command}  now  `)).toBe(`/cache-guard ${command} takes no argument (got "now").`);
    }
    expect(h.sessions).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(h.ui.editor).toBe("keep this prompt");
    expect(h.ui.compactions).toEqual([]);
    expect(h.ui.menus).toEqual([]);
    expect(registry.calls).toEqual([]);
    expect(h.ui.status.get("cache-guard")).toBe("cache cold");
    expect(await run("status")).toContain("The next prompt asks before sending.");
    expect(await run(" \t ")).toContain("Last request:");
    expect(h.ui.notes.filter((n) => n.includes("Last request:"))).toHaveLength(2);
    await h.emit("input", input("still asks"));
    expect(h.ui.confirms).toHaveLength(1);
  });
});

describe("model offers", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());
  const named = { ...opus, name: "Claude Opus 5.5" };
  const cold = () => harness([assistant(NOW - 900_000, 600_000)], named);
  const rest = [
    "Compact first, then send",
    "Start a new session with this prompt",
    "Keep the prompt in the editor",
  ];

  test("a recommended offer goes first, so Enter takes Jev's pick; the current model is named", async () => {
    const h = cold();
    const requests: any[] = [];
    h.listen(MODEL_OFFERS, (payload: ModelOffers) => {
      requests.push({ text: payload.text, tokens: payload.tokens });
      payload.offers.push(Promise.resolve([{ model: "anthropic/claude-sonnet-5-5", label: "Sonnet 5.5", recommended: true, note: "enough for this" }]));
    });
    await h.emit("session_start", {});
    h.ui.answers = ["Send with Sonnet"];
    expect(await h.emit("input", input("next step"))).toEqual({ action: "continue" });
    expect(requests).toEqual([{ text: "next step", tokens: 601_000 }]);
    expect(h.ui.menus[0]).toEqual([
      "Send with Sonnet 5.5 (recommended)",
      "Send with Claude Opus 5.5",
      "Send, and stop asking in this session",
      ...rest,
    ]);
    expect(h.choices).toEqual([{ text: "next step", model: "anthropic/claude-sonnet-5-5" }]);
    // The current model's line sends on it: no model chosen.
    h.ui.answers = ["Send with Claude Opus"];
    expect(await h.emit("input", input("again"))).toEqual({ action: "continue" });
    expect(h.choices.at(-1)).toEqual({ text: "again", model: null });
    // cache-guard never switches the model itself.
    expect(h.sent).toEqual([]);
  });

  test("plain offers follow the mute line; bad, duplicate and current-model offers are dropped", async () => {
    const h = cold();
    h.listen(MODEL_OFFERS, (payload: ModelOffers) => {
      payload.offers.push(Promise.resolve([
        { model: "anthropic/claude-haiku-5", label: "Haiku 5", note: "a note far too long to fit on one menu line" },
        { model: "anthropic/claude-opus-5-5", label: "Opus again" },
        { model: "anthropic/claude-haiku-5", label: "Haiku twice" },
        { model: "no-slash", label: "Broken" },
        { model: "anthropic/claude-fable-5-1", label: "  " },
        null,
      ] as any));
      payload.offers.push(Promise.resolve([{ model: "anthropic/claude-fable-5-1", label: "Fable\n5.1", note: "cheaper" }]));
      payload.offers.push(Promise.reject(new Error("listener failed")));
      payload.offers.push(Promise.resolve(undefined));
    });
    await h.emit("session_start", {});
    h.ui.answers = ["Send with Fable"];
    expect(await h.emit("input", input("go"))).toEqual({ action: "continue" });
    expect(h.ui.menus[0]).toEqual([
      "Send anyway",
      "Send, and stop asking in this session",
      "Send with Haiku 5 instead",
      "Send with Fable 5.1 instead",
      ...rest,
    ]);
    expect(h.choices).toEqual([{ text: "go", model: "anthropic/claude-fable-5-1" }]);
    h.ui.answers = ["Send anyway"];
    expect(await h.emit("input", input("go"))).toEqual({ action: "continue" });
    expect(h.choices.at(-1)).toEqual({ text: "go", model: null });
  });

  test("without offers the menu is unchanged, and every other answer chooses no model", async () => {
    const h = cold();
    h.listen(MODEL_OFFERS, () => undefined);
    await h.emit("session_start", {});
    h.ui.answer = undefined; // escape
    expect(await h.emit("input", input("keep me"))).toEqual({ action: "handled" });
    expect(h.ui.menus[0]).toEqual(["Send anyway", "Send, and stop asking in this session", ...rest]);
    h.ui.answers = ["Compact", "Default"];
    await h.emit("input", input("compact me"));
    h.ui.answers = ["Send, and stop"];
    await h.emit("input", input("mute me"));
    expect(h.choices).toEqual([{ text: "keep me", model: null }, { text: "compact me", model: null }, { text: "mute me", model: null }]);
    // No question, no choice event.
    await h.emit("input", input("muted now"));
    expect(h.choices).toHaveLength(3);
    const w = harness([assistant(NOW - 60_000, 600_000)]);
    await w.emit("session_start", {});
    await w.emit("input", input("warm"));
    expect(w.choices).toEqual([]);
  });

  test("offers not in after 2.5 s are left out; the question does not wait longer", async () => {
    const h = cold();
    h.listen(MODEL_OFFERS, (payload: ModelOffers) => {
      payload.offers.push(new Promise(() => undefined));
      payload.offers.push(Promise.resolve([{ model: "anthropic/claude-haiku-5", label: "Haiku 5" }]));
      payload.offers.push(new Promise((resolve) => setTimeout(() => resolve([{ model: "anthropic/claude-fable-5-1", label: "Fable", recommended: true }]), 5_000)));
    });
    await h.emit("session_start", {});
    h.ui.answer = undefined;
    const pending = h.emit("input", input("slow"));
    await vi.advanceTimersByTimeAsync(OFFER_TIMEOUT_MS - 1);
    expect(h.ui.menus).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ action: "handled" });
    expect(h.ui.menus[0]).toEqual([
      "Send anyway",
      "Send, and stop asking in this session",
      "Send with Haiku 5 instead",
      ...rest,
    ]);
  });

  test("cleanOffers keeps the first recommended pick and one line per label", () => {
    expect(cleanOffers([
      { model: "a/x", label: "X", recommended: true },
      { model: "a/y", label: "x" },
      { model: "a/z", label: "Z", recommended: "yes", note: 3 },
      { model: "a/ w", label: "W" },
      { model: "/w", label: "W" },
    ], "a/cur")).toEqual([{ model: "a/x", label: "X", recommended: true }, { model: "a/z", label: "Z" }]);
    const v = view(lastRequest([assistant(NOW - 900_000, 600_000)])!, modelInfo(opus as any, {})!, NOW, 3 * 3_600_000);
    const menu = choiceMenu(v, undefined, { current: "Opus", offers: [{ model: "a/x", label: "X", recommended: true }, { model: "a/y", label: "Y", recommended: true }] });
    expect(menu.slice(0, 4)).toEqual([
      { choice: "model", model: "a/x", label: "Send with X (recommended)" },
      { choice: "send", label: "Send with Opus" },
      { choice: "mute", label: "Send, and stop asking in this session" },
      { choice: "model", model: "a/y", label: "Send with Y instead" },
    ]);
  });

  test("every option fits a 46-column phone, so no row wraps; counts and Jev's reason are in the title", () => {
    const v = view(lastRequest([assistant(NOW - 900_000, 600_000)])!, modelInfo(opus as any, {})!, NOW, 3 * 3_600_000);
    const long = "Claude Sonnet 5.5 Extended Thinking Preview";
    const pick = { model: "a/x", label: long, recommended: true, note: "routine change" };
    for (const jev of [{ ready: true, filtered: true }, { ready: false, filtered: false }]) {
      const menu = choiceMenu(v, jev, { current: `${long} Current`, offers: [pick, { model: "a/y", label: `${long} Other` }] });
      for (const item of menu) expect(item.label.length).toBeLessThanOrEqual(OPTION_MAX);
      expect(menu[0]!.label).toMatch(/^Send with Claude Sonnet .*… \(recommended\)$/u);
    }
    const title = coldTitle(v, { ready: true, filtered: true }, pick);
    expect(title).toContain("Sending re-caches 601k tokens on any model; a summary reads up to 601k, a quick compaction none; a new session starts empty.");
    expect(title).toContain(`Recommended: ${long} (routine change).`);
    expect(coldTitle(v, { ready: false, filtered: false, missing: true })).toContain(JEV_TIP);
  });
});

describe("warning status", () => {
  const userFile = () => path.join(process.env.PI_CODING_AGENT_DIR!, "cache-guard.json");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); rmSync(userFile(), { force: true }); });

  test.each([
    { patch: { enabled: false }, line: 'off ("enabled": false in settings)' },
    { patch: { warn: { enabled: false } }, line: 'off ("warn.enabled": false in settings)' },
  ])("does not call disabled settings a threshold miss: $line", async ({ patch, line }) => {
    writeFileSync(userFile(), JSON.stringify(patch));
    const h = harness([assistant(NOW - 900_000, 600_000)]);
    await h.emit("session_start", {});
    await h.commands.get("cache-guard").handler("status", h.ctx);
    const status = h.ui.notes.at(-1)!;
    expect(status).toContain(`Warning: ${line}`);
    expect(status).toContain("The next prompt is sent without asking: the warning is off.");
    expect(status).not.toContain("Below the warning threshold.");
    expect(status).not.toContain("muted for this session");
    expect(await h.emit("input", input("go"))).toEqual({ action: "continue" });
    expect(h.ui.confirms).toEqual([]);
  });

  test("a small cold context really is below the threshold", async () => {
    const h = harness([assistant(NOW - 900_000, 50_000)]);
    await h.emit("session_start", {});
    await h.commands.get("cache-guard").handler("status", h.ctx);
    expect(h.ui.notes.at(-1)).toContain("Below the warning threshold.");
    expect(h.ui.notes.at(-1)).toContain("Warning: on");
  });

  test("the threshold is warn.minTokens even when prices are known, and 0 always asks", async () => {
    writeFileSync(userFile(), JSON.stringify({ warn: { minCost: 0, minTokens: 0 } }));
    const h = harness([assistant(NOW - 900_000, 5_000)]);
    await h.emit("session_start", {});
    await h.commands.get("cache-guard").handler("status", h.ctx);
    expect(h.ui.notes.at(-1)).toContain("Warning: on, from 0 tokens (warn.minTokens)");
    expect(h.ui.notes.at(-1)).not.toContain("$");
    h.ui.answer = undefined;
    await h.emit("input", input("next"));
    expect(h.ui.confirms).toHaveLength(1);

    writeFileSync(userFile(), JSON.stringify({ warn: { minCost: 0, minTokens: 10_000 } }));
    expect(await h.emit("input", input("again"))).toEqual({ action: "continue" });
    expect(h.ui.confirms).toHaveLength(1);
  });

  test("status does not promise a dialog without UI", async () => {
    const h = harness([assistant(NOW - 900_000, 600_000)]);
    h.ctx.hasUI = false;
    await h.emit("session_start", {});
    await h.commands.get("cache-guard").handler("status", h.ctx);
    expect(h.ui.notes.at(-1)).toContain("The next prompt is sent without asking: no UI is available.");
    expect(h.ui.notes.at(-1)).not.toContain("The next prompt asks before sending.");
    expect(await h.emit("input", input("go"))).toEqual({ action: "continue" });
    expect(h.ui.confirms).toEqual([]);
  });
});

describe("notices", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  test("a miss is written after the turn; new keep-warm refreshes once each", async () => {
    const entries: any[] = [assistant(NOW - 600_000, 600_000), { ...warm(NOW - 400_000, 600_000), id: "w0" }];
    const h = harness(entries);
    await h.emit("session_start", {});
    expect(h.appended).toEqual([]);
    const message = { role: "assistant", provider: "anthropic", model: opus.id, timestamp: NOW, stopReason: "stop",
      usage: { input: 2, cacheRead: 0, cacheWrite: 601_000, output: 10, cost: { input: 0, cacheRead: 0, cacheWrite: 3 } } };
    await h.emit("message_end", { message });
    expect(h.appended).toEqual([]);
    await h.emit("turn_end", {});
    expect(h.appended).toEqual([{ customType: "cache-guard-notice", data: expect.objectContaining({ kind: "miss", missedTokens: 600_002 }) }]);
    entries.push({ type: "message", message }, { ...warm(NOW + 1_000, 600_000), id: "w1", usage: { input: 2, cacheRead: 600_000, cacheWrite: 0, output: 1, cost: { total: 0.12 } } });
    vi.advanceTimersByTime(2_000);
    vi.advanceTimersByTime(2_000);
    expect(h.appended.slice(1)).toEqual([{ customType: "cache-guard-notice", data: { kind: "warm", cost: 0.12, note: undefined } }]);
    await h.emit("session_shutdown", {});
  });
});

/** A Pi model registry that serves Jev (or does not, with no `available`), answering with `answer`. */
function jevRegistry(answer: (questions: Record<string, any>) => any = keepAll, available = [{ provider: "typesafe", id: "jev-latest" }]) {
  const calls: any[] = [];
  return {
    calls,
    getAvailableOfType: async () => available,
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id }),
    classify: async (_model: unknown, context: any) => {
      calls.push(context);
      const answers = answer(context.questions);
      return answers && "stopReason" in answers ? answers : { model: "jev-latest", stopReason: "stop", answers };
    },
  };
}
function keepAll(questions: Record<string, any>) {
  return Object.fromEntries(Object.keys(questions).map((id) => [id, id.startsWith("keep::") ? { type: "choice", choice: "verbatim", probabilities: {}, confidence: 1 } : { type: "bool", probability: 0.9 }]));
}
const failing = () => ({ stopReason: "error", errorMessage: "401 Unauthorized", answers: {} });

const preparation = () => ({
  type: "session_before_compact", reason: "manual", willRetry: false, branchEntries: [], signal: new AbortController().signal,
  preparation: {
    firstKeptEntryId: "e9", tokensBefore: 600_000, isSplitTurn: false, turnPrefixMessages: [],
    messagesToSummarize: [{ role: "user", content: "Use pnpm, never npm." }],
    fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() }, settings: {},
  },
});

describe("jev", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(userFile(), { force: true });
  });
  const userFile = () => path.join(process.env.PI_CODING_AGENT_DIR!, "cache-guard.json");
  const cold = (registry: Record<string, unknown> = jevRegistry()) => harness([assistant(NOW - 900_000, 600_000)], opus, registry);

  test("with Jev the menu offers Jev's compaction and a summary, and no tip", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answer = undefined;
    await h.emit("input", input("next"));
    expect(h.ui.menus[0]).toEqual([
      "Send anyway",
      "Send, and stop asking in this session",
      "Compact quickly, then send (~1s)",
      "Compact with a summary, then send",
      "Start a new session with this prompt",
      "Keep the prompt in the editor",
    ]);
    expect(h.ui.titles[0]).not.toContain("Tip");
  });

  test("without Jev the question carries the setup tip", async () => {
    const h = cold(jevRegistry(keepAll, []));
    await h.emit("session_start", {});
    h.ui.answer = undefined;
    await h.emit("input", input("next"));
    expect(h.ui.titles[0]).toContain(JEV_TIP);
    expect(h.ui.menus[0]).toContain("Compact first, then send");
  });

  test("Compact with Jev judges the history against the held prompt, then sends it", async () => {
    const registry = jevRegistry();
    const h = cold(registry);
    await h.emit("session_start", {});
    h.ui.answers = ["Compact quickly"];
    expect(await h.emit("input", input("fix the parser"))).toEqual({ action: "handled" });
    const compaction = h.ui.compactions[0];
    expect(compaction.customInstructions).toBeUndefined();
    const out: any = await h.emit("session_before_compact", preparation());
    expect(registry.calls[0].state.current_goal).toBe("fix the parser");
    expect(out.compaction.summary).toContain("**User:** Use pnpm, never npm.");
    compaction.onComplete({});
    await Promise.resolve();
    expect(h.sent).toEqual([{ session: "old", content: "fix the parser" }]);
  });

  test("a failed Jev compaction cancels, says why and puts the prompt back", async () => {
    const h = cold(jevRegistry(failing));
    await h.emit("session_start", {});
    h.ui.answers = ["Compact quickly"];
    await h.emit("input", input("fix the parser"));
    expect(await h.emit("session_before_compact", preparation())).toEqual({ cancel: true });
    h.ui.compactions[0].onError(new Error("Compaction cancelled"));
    expect(h.ui.editor).toBe("fix the parser");
    expect(h.ui.notes.at(-1)).toBe("Quick compaction did not run: classification failed (invalid API key). Your prompt is back in the editor.");
    expect(h.sent).toEqual([]);
  });

  test("/cache-guard jev without Jev puts the login in the editor", async () => {
    const h = cold(jevRegistry(keepAll, []));
    await h.emit("session_start", {});
    h.ui.answers = ["Log in to TypeSafe"];
    await h.commands.get("cache-guard").handler("jev", h.ctx);
    expect(h.ui.titles[0]).toContain("Jev is not set up: no provider with Jev has credentials.");
    expect(h.ui.editor).toBe("/login typesafe");
  });

  test("/cache-guard jev checks Jev answers, and turning it off is saved and drops the tip", async () => {
    const h = cold();
    await h.emit("session_start", {});
    h.ui.answers = ["Turn Jev off"];
    await h.commands.get("cache-guard").handler("jev", h.ctx);
    expect(h.ui.titles[0]).toMatch(/^Jev: typesafe\/jev-latest, answered in \d+ ms\./u);
    expect(JSON.parse(readFileSync(userFile(), "utf8"))).toEqual({ jev: { enabled: false } });
    h.ui.answer = undefined;
    await h.emit("input", input("next"));
    expect(h.ui.titles[1]).not.toContain("Tip");
    expect(h.ui.menus[1]).toContain("Compact first, then send");
    // And back on.
    h.ui.answers = ["Turn Jev on", "Done"];
    await h.commands.get("cache-guard").handler("jev", h.ctx);
    expect(JSON.parse(readFileSync(userFile(), "utf8"))).toEqual({ jev: { enabled: true } });
    expect(h.ui.titles.at(-1)).toMatch(/^Jev: typesafe\/jev-latest, answered/u);
  });

  test("/cache-guard compact runs Jev's compaction with the focus", async () => {
    const registry = jevRegistry();
    const h = cold(registry);
    await h.emit("session_start", {});
    await h.commands.get("cache-guard").handler("compact keep the API notes", h.ctx);
    expect(h.ui.compactions[0].customInstructions).toBe("keep the API notes");
    const out: any = await h.emit("session_before_compact", { ...preparation(), customInstructions: "keep the API notes" });
    expect(registry.calls[0].state.current_goal).toBe("keep the API notes");
    expect(out.compaction.summary).toContain("Focus: keep the API notes");
  });

  test("/cache-guard compact without Jev offers Pi's summary", async () => {
    const h = cold(jevRegistry(keepAll, []));
    await h.emit("session_start", {});
    h.ui.answers = ["Compact with Pi's summary"];
    await h.commands.get("cache-guard").handler("compact", h.ctx);
    expect(h.ui.titles[0]).toBe("Jev is not set up (no provider with Jev has credentials). Compact with Pi's summary instead?");
    expect(h.ui.compactions).toHaveLength(1);
    expect(await h.emit("session_before_compact", preparation())).toBeUndefined();
  });

  test("status reports Jev", async () => {
    const h = cold();
    await h.emit("session_start", {});
    await h.commands.get("cache-guard").handler("status", h.ctx);
    expect(h.ui.notes.at(-1)).toContain("Jev: typesafe/jev-latest; trimming on; Quick compaction from the cold-cache menu and /cache-guard compact; it filters /compact too.");
    expect(existsSync(userFile())).toBe(false);
  });
});
