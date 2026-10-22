import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MainState } from "../src/main-state.ts";
import { runCheck } from "../src/headsup/check.ts";
import { HeadsUp, headsUpChange } from "../src/headsup/headsup.ts";
import { HEADSUP_ENTRY, headsUpDefault, headsUpFromBranch, HeadsUpStats, headsUpWhereDefault } from "../src/headsup/mode.ts";
import { NoteState, quoteForMain } from "../src/headsup/note.ts";
import { parseHeadsUp } from "../src/headsup/protocol.ts";
import { isNoteMarker, noteMessages } from "../src/headsup/thread.ts";
import { HeadsUpScheduler } from "../src/headsup/scheduler.ts";
import { addRecent, knownTopics, markKnown, ProfileStore, emptyProfile } from "../src/quiz/profile.ts";
import { splicePayload } from "../src/splice.ts";
import { FakePi, fakeCtx } from "./fake.ts";

const NOTE = '<headsup topic="Skipped Tests" kind="risk">Main skipped the failing integration tests.</headsup><headsup-detail>It ran with --skip. The suite never ran.</headsup-detail>';

describe("heads-up reply protocol", () => {
  it("reads one note with its detail", () => {
    expect(parseHeadsUp({ text: NOTE })).toEqual({ topic: "skipped-tests", kind: "risk", text: "Main skipped the failing integration tests.", detail: "It ran with --skip. The suite never ran." });
  });

  it("treats none, prose, malformed blocks and tool calls as no note", () => {
    expect(parseHeadsUp({ text: "<headsup-none/>" })).toBeUndefined();
    expect(parseHeadsUp({ text: "Looks fine to me." })).toBeUndefined();
    expect(parseHeadsUp({ text: '<headsup topic="x">unclosed' })).toBeUndefined();
    expect(parseHeadsUp({ text: "<headsup>   </headsup>" })).toBeUndefined();
    expect(parseHeadsUp({ text: NOTE, toolCalls: 1 })).toBeUndefined();
  });

  it("falls back to a context kind and a topic from the text", () => {
    expect(parseHeadsUp({ text: '<headsup kind="bogus">Odd number</headsup>' })).toMatchObject({ kind: "context", topic: "odd-number", detail: "" });
  });
});

describe("heads-up scheduler", () => {
  const opts = { minReplies: 3, minRunMs: 60_000, intervalMs: 100_000, endIntervalMs: 10_000 };

  it("waits for a long run, then throttles", () => {
    const s = new HeadsUpScheduler(opts);
    s.runStarted(0);
    expect(s.replied(1, false)).toBe(false);
    expect(s.replied(2, false)).toBe(false);
    expect(s.replied(3, false)).toBe(true);
    s.started(3);
    s.finished();
    expect(s.replied(50_000, false)).toBe(false);
    expect(s.replied(100_003, false)).toBe(true);
  });

  it("counts a run as long by time too, and never checks while one is in flight or a note shows", () => {
    const s = new HeadsUpScheduler(opts);
    s.runStarted(0);
    expect(s.replied(60_000, true)).toBe(false);
    s.inFlight = true;
    expect(s.replied(60_001, false)).toBe(false);
    s.inFlight = false;
    expect(s.replied(60_002, false)).toBe(true);
  });

  it("checks once more when a long run ends with replies since the last check", () => {
    const s = new HeadsUpScheduler(opts);
    s.runStarted(0);
    for (let i = 0; i < 3; i++) s.replied(i, false);
    s.started(5);
    s.finished();
    s.replied(6, false);
    expect(s.ended(20_000, false)).toBe(true);
    s.runStarted(30_000);
    s.replied(30_001, false);
    expect(s.ended(30_002, false)).toBe(false); // short run
  });
});

describe("heads-up setting", () => {
  it("is on by default, unless the env says otherwise, and follows the branch", () => {
    expect(headsUpDefault({})).toBe(true);
    expect(headsUpDefault({ PI_SIDEBAR_HEADSUP: "0" })).toBe(false);
    expect(headsUpFromBranch([])).toBeUndefined();
    const entry = (on: boolean, at: number) => ({ type: "custom", customType: HEADSUP_ENTRY, data: { version: 1, on, at } });
    expect(headsUpFromBranch([entry(false, 1), entry(true, 2)])).toEqual({ version: 1, on: true, at: 2 });
  });

  it("adds up what checks cost", () => {
    const stats = new HeadsUpStats();
    stats.record("none", { input: 10, cacheRead: 1000, output: 5 });
    stats.record("note", { input: 20, cacheRead: 2000, output: 50 });
    stats.record("skipped", undefined, "cold");
    expect(stats).toMatchObject({ checks: 2, notes: 1, skipped: 1, lastSkip: "cold", usage: { input: 30, cacheRead: 3000, output: 55, cacheWrite: 0 } });
  });
});

describe("heads-up memory in the knowledge profile", () => {
  it("keeps known topics and recent notes, and loads old profiles", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "headsup-"));
    const store = new ProfileStore(dir, "/repo");
    writeFileSync(store.file, JSON.stringify(emptyProfile("/repo")));
    expect(store.load().headsUp).toBeUndefined();
    store.update((p) => markKnown(addRecent(p, { id: "a", text: "A", at: 1 }), { id: "b", text: "B", at: 2 }));
    const again = new ProfileStore(dir, "/repo").load();
    expect(knownTopics(again, 3)).toEqual({ known: ["b: B"], recent: ["a: A"] });
  });

  it("re-reads the file before a change, so another writer's change is kept", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "headsup-"));
    const one = new ProfileStore(dir, "/repo");
    const two = new ProfileStore(dir, "/repo");
    one.load();
    two.update((p) => markKnown(p, { id: "x", text: "X", at: 1 }));
    one.apply([{ concept: "c", title: "C", result: "correct", difficulty: 1, paths: [] }], 2);
    const saved = JSON.parse(readFileSync(one.file, "utf8"));
    expect(saved.headsUp.known[0].id).toBe("x");
    expect(Object.keys(saved.concepts)).toEqual(["c"]);
  });
});

describe("heads-up note", () => {
  const note = { topic: "t", kind: "risk" as const, text: "Something", detail: "Why it matters." };

  it("answers only the digits on screen, per phase", () => {
    const state = new NoteState();
    expect(state.action("1")).toBeUndefined();
    state.show(note);
    expect(state.action("3")).toBeUndefined();
    expect(state.action("1")).toEqual({ type: "expand" });
    state.apply({ type: "expand" }, 0);
    expect(state.action("3")).toEqual({ type: "ask-sidebar" });
    state.apply({ type: "dismiss" }, 0);
    expect(state.showing).toBe(false);
    state.show(note);
    state.apply({ type: "dismiss" }, 100);
    expect(state.phase).toBe("dismissed");
    expect(state.action("9")).toEqual({ type: "turn-off" });
    expect(state.expired(100 + 19_999)).toBe(false);
    expect(state.expired(100 + 20_000)).toBe(true);
  });

  it("renders within the width", () => {
    const state = new NoteState();
    state.show({ ...note, text: "word ".repeat(40).trim() });
    const theme = { fg: (_c: string, t: string) => t } as never;
    for (const width of [30, 46, 120]) {
      const lines = state.lines(width, theme);
      expect(lines[0]).toContain("✦ Heads up");
      expect(lines[lines.length - 1]).toContain("1: Learn more");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("quotes the note for main", () => {
    expect(quoteForMain(note)).toBe("Sidebar's heads-up check noted:\n> Something\n>\n> Why it matters.\n\n");
  });
});

const PROMPT = "You are an expert coding assistant operating inside pi.";
function mainPayload() {
  return {
    model: "claude-x",
    max_tokens: 32000,
    system: [{ type: "text", text: PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [{ name: "read" }],
    messages: [{ role: "user", content: [{ type: "text", text: "do it", cache_control: { type: "ephemeral" } }] }],
  };
}

async function primedMain(now: number, usage = { input: 10, output: 5, cacheRead: 20_000, cacheWrite: 0 }) {
  const pi = new FakePi();
  const main = new MainState(pi as never, () => now);
  const { ctx } = fakeCtx({ systemPrompt: PROMPT });
  await pi.emit("session_start", { reason: "startup" }, ctx);
  await pi.emit("before_provider_request", { payload: mainPayload() }, ctx);
  await pi.emit("message_end", { message: { role: "assistant", usage } }, ctx);
  return { pi, main, ctx };
}

function stubStream(reply: string, usage = { input: 300, output: 40, cacheRead: 20_000, cacheWrite: 0 }) {
  const sent: unknown[] = [];
  const stream = (_model: unknown, context: any, options: any) => ({
    result: async () => {
      const side = { model: "claude-x", max_tokens: 32000, system: "own", messages: context.messages.map((m: any) => ({ role: m.role, content: m.content.map((b: any) => ({ ...b, cache_control: { type: "ephemeral" } })) })) };
      sent.push(await options.onPayload(side));
      return { role: "assistant", content: [{ type: "text", text: reply }], usage, stopReason: "stop" };
    },
  });
  return { stream, sent };
}

describe("a heads-up check", () => {
  it("sends main's request byte for byte, then its own part, with no side breakpoint", async () => {
    const { main } = await primedMain(1000);
    const { stream, sent } = stubStream(NOTE);
    const result = await runCheck({ main, known: ["k: K"], recent: [], now: 1000, stream });
    expect(result).toMatchObject({ outcome: "note", missed: false, note: { topic: "skipped-tests" } });
    const payload = sent[0] as ReturnType<typeof mainPayload>;
    const main0 = mainPayload();
    expect(payload.system).toEqual(main0.system);
    expect(payload.tools).toEqual(main0.tools);
    expect(payload.messages.slice(0, 1)).toEqual(main0.messages);
    const side = payload.messages.slice(1);
    expect(JSON.stringify(side)).toContain("<sidebar-headsup>");
    expect(JSON.stringify(side)).toContain("k: K");
    expect(JSON.stringify(side)).not.toContain("cache_control");
  });

  it("skips without sending when main's cache has probably expired or nothing is in memory", async () => {
    const { main } = await primedMain(1000);
    const { stream, sent } = stubStream(NOTE);
    expect(await runCheck({ main, known: [], recent: [], now: 1000 + 10 * 60_000, stream })).toMatchObject({ outcome: "skipped" });
    main.request = undefined;
    expect(await runCheck({ main, known: [], recent: [], now: 1000, stream })).toMatchObject({ outcome: "skipped" });
    expect(sent).toHaveLength(0);
  });

  it("reports a miss when the cache read falls short", async () => {
    const { main } = await primedMain(1000);
    const { stream } = stubStream("<headsup-none/>", { input: 20_000, output: 5, cacheRead: 0, cacheWrite: 0 });
    expect(await runCheck({ main, known: [], recent: [], now: 1000, stream })).toMatchObject({ outcome: "none", missed: true });
  });
});

describe("HeadsUp in main", () => {
  async function setup(reply = NOTE, deliver = false) {
    const now = 1000;
    const { pi, main, ctx } = await primedMain(now);
    const widgets: unknown[] = [];
    let editor = "";
    (ctx.ui as any).setWidget = (_key: string, content: unknown) => widgets.push(content);
    (ctx.ui as any).setEditorText = (text: string) => { editor = text; };
    (ctx as any).ui.getEditorText = () => editor;
    const asked: string[] = [];
    const delivered: unknown[] = [];
    const dir = mkdtempSync(path.join(tmpdir(), "headsup-"));
    const { stream } = stubStream(reply);
    const headsUp = new HeadsUp(pi as never, main, { deliver: (note) => { if (deliver) delivered.push(note); return deliver; }, askSidebar: (text) => { asked.push(text); return true; } }, {
      knowledgeDir: dir,
      logFile: path.join(dir, "log"),
      run: async () => undefined,
      stream,
      now: () => now,
      env: {},
    });
    return { pi, ctx, headsUp, widgets, asked, delivered, dir, editor: () => editor };
  }

  it("shows a note above the editor and takes its digits only when the editor is idle", async () => {
    const { headsUp, widgets, editor } = await setup();
    await headsUp.check("turn");
    expect(headsUp.note.showing).toBe(true);
    expect(widgets.at(-1)).toBeTypeOf("function");
    expect(headsUp.handleKey("1", false)).toBe(false);
    expect(headsUp.handleKey("x", true)).toBe(false);
    expect(headsUp.handleKey("1", true)).toBe(true);
    expect(headsUp.note.phase).toBe("detail");
    expect(headsUp.handleKey("2", true)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(editor()).toContain("> Main skipped the failing integration tests.");
    expect(headsUp.note.showing).toBe(false);
  });

  it("hands the note to Sidebar when it is open, and /known marks it", async () => {
    const { headsUp, widgets, delivered, dir } = await setup(NOTE, true);
    await headsUp.check("turn");
    expect(delivered).toHaveLength(1);
    expect(widgets).toHaveLength(0);
    expect(headsUp.note.showing).toBe(false);
    expect(await headsUp.markLastKnown()).toMatchObject({ topic: "skipped-tests" });
    expect(knownTopics(new ProfileStore(dir, "/repo").load(), 0).known[0]).toMatch(/^skipped-tests:/);
  });

  it("remembers a topic marked as known and lists it in the next check", async () => {
    const { headsUp, dir } = await setup();
    await headsUp.check("turn");
    headsUp.handleKey("2", true);
    await new Promise((r) => setTimeout(r, 0));
    const profile = new ProfileStore(dir, "/repo").load();
    expect(knownTopics(profile, 0).known).toEqual(["skipped-tests: Main skipped the failing integration tests."]);
  });

  it("is switched off and on through main's session", async () => {
    const { pi, headsUp } = await setup();
    expect(headsUp.on).toBe(true);
    headsUp.setOn(false);
    expect(pi.entries.at(-1)).toMatchObject({ customType: HEADSUP_ENTRY, data: { on: false } });
    headsUp.restore([{ type: "custom", customType: HEADSUP_ENTRY, data: { version: 1, on: false, at: 1 } }], false);
    expect(headsUp.on).toBe(false);
    headsUp.restore([], true);
    expect(headsUp.on).toBe(true);
  });

  it("asks Sidebar to keep the note when it shows only in Sidebar", async () => {
    const { headsUp, widgets } = await setup();
    const onlySidebar: boolean[] = [];
    (headsUp as any).host.deliver = (_note: unknown, only: boolean) => { onlySidebar.push(only); return only; };
    headsUp.setOn(true, "sidebar");
    await headsUp.check("turn");
    expect(onlySidebar).toEqual([true]);
    expect(widgets).toHaveLength(0);
  });

  it("stores where notes go, defaulting from the env", async () => {
    const { pi, headsUp } = await setup();
    expect(headsUp.where).toBe("any");
    headsUp.setOn(true, "sidebar");
    expect(pi.entries.at(-1)).toMatchObject({ customType: HEADSUP_ENTRY, data: { on: true, where: "sidebar" } });
    headsUp.restore([{ type: "custom", customType: HEADSUP_ENTRY, data: { version: 1, on: true, at: 1 } }], false);
    expect(headsUp.where).toBe("any");
    expect(headsUpWhereDefault({ PI_SIDEBAR_HEADSUP: "sidebar" })).toBe("sidebar");
    expect(headsUpDefault({ PI_SIDEBAR_HEADSUP: "sidebar" })).toBe(true);
    expect(headsUpChange("sidebar")).toEqual({ on: true, where: "sidebar" });
    expect(headsUpChange("off")).toEqual({ on: false });
  });

  it("gives up a showing note to Sidebar, but not a dismissed one", async () => {
    const { headsUp } = await setup();
    await headsUp.check("turn");
    expect(headsUp.take()).toMatchObject({ topic: "skipped-tests" });
    expect(headsUp.note.showing).toBe(false);
    await headsUp.check("turn");
    headsUp.handleKey("0", true);
    await new Promise((r) => setTimeout(r, 0));
    expect(headsUp.take()).toBeUndefined();
  });

  it("checks at main's turn boundaries once a run is long", async () => {
    const { pi, ctx, headsUp } = await setup("<headsup-none/>");
    await pi.emit("agent_start", {}, ctx);
    for (let i = 0; i < 5; i++) await pi.emit("message_end", { message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 20_000, cacheWrite: 0 } } }, ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(headsUp.stats.checks).toBe(1);
  });
});

describe("splice without Sidebar's breakpoint", () => {
  it("leaves main's breakpoints and strips the side's", () => {
    const side = { model: "claude-x", messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] };
    const result = splicePayload("anthropic-messages", mainPayload(), side, { sideBreakpoint: false });
    expect(result.ok).toBe(true);
    const messages = (result as any).payload.messages;
    expect(messages[0]).toEqual(mainPayload().messages[0]);
    expect(messages[1].content[0].cache_control).toBeUndefined();
  });
});

describe("a note in Sidebar's thread", () => {
  it("is a hidden marker and an answer carrying the note", () => {
    const messages = noteMessages({ topic: "t", kind: "risk", text: "Careful.", detail: "Because." }, { api: "anthropic-messages", provider: "anthropic", model: "m" }, 5) as any[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(isNoteMarker(messages[0].content[0].text)).toBe(true);
    expect(isNoteMarker("a question")).toBe(false);
    expect(messages[1].content[0].text).toBe("**Heads up: a risk.** Careful.\n\nBecause.");
    expect(messages[1]).toMatchObject({ provider: "anthropic", model: "m", stopReason: "stop" });
  });
});
