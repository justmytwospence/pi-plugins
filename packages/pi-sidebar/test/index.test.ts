import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import piSidebar from "../src/index.ts";
import { DRAFT_TIMEOUT_MS, SidebarController } from "../src/controller.ts";
import { NOTE_MARKER } from "../src/headsup/thread.ts";
import { SplitRoot } from "../src/layout.ts";
import { fitStatus } from "../src/panel.ts";
import { EXCHANGE_ENTRY, RESET_ENTRY } from "../src/thread.ts";
import { QUIZ_ENTRY } from "../src/quiz/mode.ts";
import { QUIZ_NEXT, QUIZ_ROLE, QUIZ_START } from "../src/quiz/prompt.ts";
import { FakePi, fakeCtx } from "./fake.ts";

const saved = process.env.PI_SIDEBAR_KEYS;
afterEach(() => {
  if (saved === undefined) delete process.env.PI_SIDEBAR_KEYS;
  else process.env.PI_SIDEBAR_KEYS = saved;
});

const leaf = (): Component => ({ render: () => [], invalidate() {} });

function fakeTui() {
  const mainEditor = leaf();
  const tui = {
    mode: "fullscreen",
    layoutRoot: leaf() as Component | undefined,
    terminal: { columns: 165, rows: 50 },
    focused: mainEditor as Component | null,
    setLayoutRoot(component: Component | undefined) { this.layoutRoot = component; },
    requestRender() {},
    setFocus(component: Component | null) {
      // As Pi's TUI does: focusable components learn when they gain or lose focus.
      if (this.focused && "focused" in this.focused) (this.focused as { focused: boolean }).focused = false;
      this.focused = component;
      if (component && "focused" in component) (component as { focused: boolean }).focused = true;
    },
    getFocusedComponent() { return this.focused; },
  };
  return { tui, mainEditor };
}

function setup(entries: unknown[] = []) {
  const pi = new FakePi();
  const controller = new SidebarController(pi as never, ["ctrl+t"]);
  const { tui, mainEditor } = fakeTui();
  const { ctx, notes } = fakeCtx({ entries });
  (ctx.ui as { setWidget: unknown }).setWidget = (_key: string, factory?: (t: unknown, theme: unknown) => unknown) => factory?.(tui, ctx.ui.theme);
  return { pi, controller, tui, mainEditor, ctx, notes };
}

// Main answered long ago: its cache has expired, so a send asks first.
const OLD_ANSWER = [{ type: "message", timestamp: "1970-01-01T00:00:00.000Z", message: { role: "assistant", timestamp: 0, usage: { input: 10, cacheRead: 20000, cacheWrite: 0 } } }];

const panelOf = (controller: SidebarController) => (controller as unknown as { panel: any }).panel;

describe("registration", () => {
  it("registers /sidebar and ctrl+'", () => {
    delete process.env.PI_SIDEBAR_KEYS;
    const pi = new FakePi();
    piSidebar(pi as never);
    expect([...pi.commands.keys()]).toEqual(["sidebar"]);
    expect([...pi.shortcuts.keys()]).toEqual(["ctrl+'"]);
    expect(pi.handlers.has("before_provider_request")).toBe(true);
  });

  it("takes its keys from PI_SIDEBAR_KEYS", () => {
    process.env.PI_SIDEBAR_KEYS = "ctrl+., alt+s";
    const pi = new FakePi();
    piSidebar(pi as never);
    expect([...pi.shortcuts.keys()]).toEqual(["ctrl+.", "alt+s"]);
  });

  it("only guards inside a subagent Sidebar started", async () => {
    process.env.PI_SIDEBAR_GUARD = "1";
    try {
      const pi = new FakePi();
      piSidebar(pi as never);
      expect([...pi.commands.keys()]).toEqual([]);
      expect([...pi.shortcuts.keys()]).toEqual([]);
      const { ctx } = fakeCtx();
      expect(await pi.emit("tool_call", { toolName: "edit", input: {} }, ctx)).toEqual({ block: true, reason: expect.stringMatching(/read-only/) });
      expect(await pi.emit("tool_call", { toolName: "read", input: { path: "a" } }, ctx)).toBeUndefined();
      const request = { version: 1, env: {} as Record<string, string> };
      pi.events.emit("pi-plugins.subagent-env.v1", request);
      expect(request.env).toEqual({ PI_SIDEBAR_GUARD: "1" });
    } finally {
      delete process.env.PI_SIDEBAR_GUARD;
    }
  });

});

describe("Sidebar's model", () => {
  const MODELS = [
    { provider: "anthropic", id: "claude-x", api: "anthropic-messages", name: "Claude X" },
    { provider: "anthropic", id: "claude-opus-5-5", api: "anthropic-messages", name: "Claude Opus 5.5" },
    { provider: "openai-codex", id: "gpt-6-sol", api: "openai-codex-responses", name: "GPT-6 Sol" },
    { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses", name: "GPT-6.1 Sol" },
  ];
  const savedModels = process.env.PI_SIDEBAR_MODELS;
  afterEach(() => {
    if (savedModels === undefined) delete process.env.PI_SIDEBAR_MODELS;
    else process.env.PI_SIDEBAR_MODELS = savedModels;
  });

  function modelSetup() {
    process.env.PI_SIDEBAR_MODELS = "anthropic/claude-opus-*,openai-codex/gpt-*-sol,anthropic/claude-x,nope/x";
    const pi = new FakePi();
    piSidebar(pi as never);
    const { ctx, notes } = fakeCtx({ models: MODELS });
    return { pi, ctx, notes };
  }

  it("switches to a favorite by name, stores it in main's session, and back to same", async () => {
    const { pi, ctx, notes } = modelSetup();
    await pi.commands.get("sidebar")!.handler("model sol", ctx);
    expect(notes.at(-1)!.message).toMatch(/^Sidebar runs on GPT-6\.1 Sol \(openai-codex\/gpt-6\.1-sol\)/);
    expect(pi.entries.at(-1)).toMatchObject({ customType: "sidebar:model", data: { version: 1, model: "openai-codex/gpt-*-sol" } });
    await pi.commands.get("sidebar")!.handler("model same", ctx);
    expect(notes.at(-1)!.message).toBe("Sidebar uses main's model and shares main's prompt cache.");
    await pi.commands.get("sidebar")!.handler("model nothing-like-it", ctx);
    expect(notes.at(-1)).toMatchObject({ level: "warning" });
  });

  it("treats main's own model as same", async () => {
    const { pi, ctx, notes } = modelSetup();
    await pi.commands.get("sidebar")!.handler("model claude-x", ctx);
    expect(notes.at(-1)!.message).toMatch(/main's own model/);
  });

  it("picks from same and the favorites with a login", async () => {
    const { pi, ctx, notes } = modelSetup();
    let offered: string[] = [];
    (ctx.ui as any).select = async (_title: string, options: string[]) => { offered = options; return options[2]; };
    await pi.commands.get("sidebar")!.handler("model", ctx);
    expect(offered).toEqual([
      "Same as main (current) · shares main's prompt cache",
      "Claude Opus 5.5 · anthropic/claude-opus-5-5",
      "GPT-6.1 Sol · openai-codex/gpt-6.1-sol",
      "Claude X · anthropic/claude-x",
    ]);
    expect(notes.at(-1)!.message).toMatch(/runs on GPT-6\.1 Sol/);
  });

  it("shows the picker in Sidebar itself while Sidebar is open, and focuses it", async () => {
    process.env.PI_SIDEBAR_MODELS = "anthropic/claude-opus-*,openai-codex/gpt-*-sol";
    const { controller, ctx, tui, mainEditor } = setup();
    (ctx.modelRegistry as any).getAvailable = () => MODELS;
    let mainDialog = false;
    (ctx.ui as any).select = async () => { mainDialog = true; return undefined; };
    expect(controller.open(ctx as never)).toBe(true);
    controller.focusMain();
    tui.setFocus(mainEditor);
    await controller.modelCommand("", ctx as never);
    const panel = panelOf(controller);
    expect(mainDialog).toBe(false);
    expect(panel.picker).toBeDefined();
    expect(tui.focused).toBe(panel.input);
    const lines = panel.input.render(80).join("\n");
    expect(lines).toContain("Sidebar's model");
    expect(lines).toContain("GPT-6.1 Sol");
    panel.input.handleInput("\x1b[B");
    panel.input.handleInput("\x1b[B");
    panel.input.handleInput("\r");
    expect(panel.picker).toBeUndefined();
    expect(controller.sidebarModel()).toMatchObject({ kind: "other", label: "GPT-6.1 Sol" });
    await controller.modelCommand("", ctx as never);
    panel.input.handleInput("\x1b");
    expect(panel.picker).toBeUndefined();
    expect(controller.sidebarModel()).toMatchObject({ label: "GPT-6.1 Sol" });
  });

  it("cycles with main's model keys in Sidebar and shows the model in its header", () => {
    process.env.PI_SIDEBAR_MODELS = "anthropic/claude-opus-*,openai-codex/gpt-*-sol";
    const { controller, ctx } = setup();
    (ctx.modelRegistry as any).getAvailable = () => MODELS;
    expect(controller.open(ctx as never)).toBe(true);
    controller.focusSidebar();
    const panel = panelOf(controller);
    panel.input.handleInput("\x10"); // Ctrl+P
    expect(controller.sidebarModel()).toMatchObject({ kind: "other", label: "Claude Opus 5.5" });
    expect(panel.titleLine(120)).toContain("Claude Opus 5.5");
    panel.input.handleInput("\x10");
    expect(controller.sidebarModel()).toMatchObject({ kind: "other", label: "GPT-6.1 Sol" });
    panel.input.handleInput("\x10");
    expect(controller.sidebarModel()).toEqual({ kind: "same" });
  });

  it("restores the choice from main's branch", async () => {
    process.env.PI_SIDEBAR_MODELS = "openai-codex/gpt-*-sol";
    const branch = [{ type: "custom", customType: "sidebar:model", data: { version: 1, model: "openai-codex/gpt-*-sol", at: 1 } }];
    const { pi, controller, ctx } = setup(branch);
    (ctx.modelRegistry as any).getAvailable = () => MODELS;
    await pi.emit("session_start", { reason: "startup" }, ctx);
    expect(controller.sidebarModel()).toMatchObject({ kind: "other", label: "GPT-6.1 Sol" });
  });
});

describe("the composer", () => {
  it("starts the prompt where main's does (main's editorPaddingX)", () => {
    const column = (padding?: number) => {
      const { pi, controller, ctx } = setup();
      if (padding !== undefined) pi.settings = { editorPaddingX: padding };
      controller.open(ctx as never);
      const panel = panelOf(controller);
      panel.input.setText("hello");
      const line = (panel.input.render(40) as string[]).find((l) => l.includes("hello"))!;
      return line.indexOf("hello");
    };
    expect(column(1)).toBe(column() + 1);
  });
});

describe("opening and focus", () => {
  it("needs the interactive UI and fullscreen mode", () => {
    const { controller, ctx, notes } = setup();
    expect(controller.open({ ...ctx, mode: "print" } as never)).toBe(false);
    expect(notes.pop()!.message).toMatch(/interactive/);
    const regular = { ...ctx, ui: { ...ctx.ui, setWidget: (_k: string, f?: (t: unknown, th: unknown) => unknown) => f?.({ mode: "regular", requestRender() {} }, ctx.ui.theme) } };
    expect(controller.open(regular as never)).toBe(false);
    expect(notes.pop()!.message).toMatch(/fullscreen/);
  });

  it("opens focused with the key, and the same key in Sidebar closes it", () => {
    const { controller, tui, mainEditor, ctx } = setup();
    controller.toggle(ctx as never);
    expect(tui.layoutRoot).toBeInstanceOf(SplitRoot);
    const panel = panelOf(controller);
    expect(tui.focused).toBe(panel.input);
    panel.input.handleInput("\x14"); // ctrl+t, the test's toggle key
    expect(controller.isOpen).toBe(false);
    expect(tui.focused).toBe(mainEditor);
  });

  it("moves between main and Sidebar with Herdr's prefix+h/l, and hands other moves to Herdr", async () => {
    const { pi, controller, tui, mainEditor, ctx } = setup();
    let input: ((data: string) => unknown) | undefined;
    (ctx.ui as { onTerminalInput?: unknown }).onTerminalInput = (handler: (data: string) => unknown) => { input = handler; return () => {}; };
    await pi.emit("session_start", { reason: "startup" }, ctx);
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    expect(input!("\x1b[104;8u")).toEqual({ consume: true }); // left, from Sidebar: main
    expect(tui.focused).toBe(mainEditor);
    expect(input!("\x1b[108;8u")).toEqual({ consume: true }); // right, from main: Sidebar
    expect(tui.focused).toBe(panel.input);
    expect(input!("x")).toBeUndefined();
  });

  it("sends a prompt another program types into the pane to main, even while Sidebar has focus", async () => {
    const { pi, controller, ctx } = setup();
    let input: ((data: string) => unknown) | undefined;
    (ctx.ui as { onTerminalInput?: unknown }).onTerminalInput = (handler: (data: string) => unknown) => { input = handler; return () => {}; };
    const sent: Array<{ text: unknown; options: unknown }> = [];
    (pi as any).sendUserMessage = (text: unknown, options?: unknown) => sent.push({ text, options });
    let idle = false;
    (ctx as any).isIdle = () => idle;
    await pi.emit("session_start", { reason: "startup" }, ctx);
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    // Herdr's agent prompt: a bracketed paste, then Enter. Main is working, so it steers.
    const paste = "\x1b[200~fold in #1371\nthen rebase\x1b[201~";
    expect(input!(paste)).toBeUndefined();
    panel.input.handleInput(paste);
    expect(input!("\r")).toEqual({ consume: true });
    expect(sent).toEqual([{ text: "fold in #1371\nthen rebase", options: { deliverAs: "steer" } }]);
    expect(panel.input.getText()).toBe("");
    // A paste you then edit, or one into a draft, stays Sidebar's.
    input!("\x1b[200~mine\x1b[201~");
    expect(input!("x")).toBeUndefined();
    expect(input!("\r")).toBeUndefined();
    panel.input.setText("draft ");
    input!("\x1b[200~more\x1b[201~");
    expect(input!("\r")).toBeUndefined();
    // Idle main: a new turn.
    panel.input.setText("");
    idle = true;
    input!("\x1b[200~next\x1b[201~");
    expect(input!("\r")).toEqual({ consume: true });
    expect(sent.at(-1)).toEqual({ text: "next", options: undefined });
  });

  it("makes Sidebar's view Pi's primary scroll view only while it has focus and shows", async () => {
    const { pi, controller, tui, ctx } = setup();
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    expect(panel.view.primary).toBe(true);
    controller.focusMain();
    expect(panel.view.primary).toBe(false);
    controller.focusSidebar();
    pi.events.emit("herdr:blocked", { active: true, label: "question" });
    expect(panel.view.primary).toBe(false);
    pi.events.emit("herdr:blocked", { active: false });
    expect(panel.view.primary).toBe(true);
    // Pi's search opens as an overlay and takes focus: Sidebar stays the half it searches.
    (tui as unknown as { hasOverlay(): boolean }).hasOverlay = () => true;
    panel.input.focused = false;
    expect(panel.view.primary).toBe(true);
    controller.focusMain();
    expect(panel.view.primary).toBe(false);
    controller.toggle(ctx as never);
    expect(panel.view.primary).toBe(false);
  });

  it("draws a filled title bar while focused, and never dims the panel", () => {
    const { controller, ctx } = setup();
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    const title = () => (panel as any).titleLine(80) as string;
    expect(title()).toMatch(/^\[bg\] ◧ Sidebar/);
    controller.focusMain();
    expect(title()).toMatch(/^ ◧ Sidebar/);
    expect(title()).toContain("ctrl+t to close");
    panel.unread = true;
    expect(title()).toContain("● new answer");
  });

  it("shows Pi's working row while Sidebar answers, with pi-status-footer's stats", () => {
    const { pi, controller, ctx } = setup();
    let chars = 0;
    pi.events.on("pi-plugins.working-stats.v1", (data: any) => {
      data.service = {
        refreshMs: 1000,
        create: () => ({
          reset: () => { chars = 0; },
          apply: (event: any) => { chars += event.delta?.length ?? 0; },
          message: () => (chars ? `Working (↓ ${chars / 4} tokens)` : undefined),
        }),
      };
    });
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    expect(panel.working.render(60)).toEqual([]);
    panel.apply({ type: "agent_start" });
    expect(panel.working.render(60).join("")).toContain("Working");
    panel.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400), partial: { content: [] } } });
    expect(panel.working.render(60).join("")).toContain("↓ 100 tokens");
    panel.apply({ type: "auto_retry_start" });
    expect(panel.working.render(60).join("")).toContain("Retrying");
    panel.apply({ type: "agent_end" });
    expect(panel.working.render(60)).toEqual([]);
  });

  it("says plain Working without pi-status-footer", () => {
    const { controller, ctx } = setup();
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    panel.apply({ type: "agent_start" });
    panel.apply({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x".repeat(400), partial: { content: [] } } });
    expect(panel.working.render(60).join("")).not.toContain("tokens");
    panel.apply({ type: "agent_end" });
  });

  it("keeps a blank row between the working row and the composer, as main does", async () => {
    (await import("@earendil-works/pi-coding-agent")).initTheme();
    const { controller, ctx } = setup();
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    panel.apply({ type: "agent_start" });
    const lines = panel.root.render(60, 20);
    const working = lines.findIndex((line: string) => line.includes("Working"));
    expect(working).toBeGreaterThan(0);
    expect(lines[working - 1]!.trim()).toBe("");
    expect(lines[working + 1]!.trim()).toBe("");
    expect(lines[working + 2]).toMatch(/─/);
    panel.apply({ type: "agent_end" });
  });

  it("follows main's thinking setting, and Pi's own keys act on Sidebar", () => {
    const { pi, controller, ctx } = setup();
    let hidden = true;
    (pi as unknown as { getSettings(): unknown }).getSettings = () => ({ hideThinkingBlock: hidden });
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    panel.view.render(80);
    expect(panel.chat.thinkingHidden).toBe(true);
    panel.input.handleInput("\x0f"); // ctrl+o: app.tools.expand
    expect(panel.chat.isExpanded).toBe(true);
    panel.toggleThinking();
    expect(panel.chat.thinkingHidden).toBe(false);
    panel.view.render(80);
    expect(panel.chat.thinkingHidden).toBe(false); // Sidebar's own toggle lasts...
    hidden = false;
    panel.view.render(80);
    hidden = true;
    panel.view.render(80);
    expect(panel.chat.thinkingHidden).toBe(true); // ...until main's setting changes
    panel.input.handleInput("\x04"); // ctrl+d on an empty composer: never quits Pi
    expect(controller.isOpen).toBe(true);
  });

  it("hands Ctrl+S and submits to pi-stash's stash service, and keeps one stash across rebuilds", () => {
    const { pi, controller, ctx } = setup();
    const calls: string[] = [];
    let created = 0;
    let editor: { getText(): string; setText(text: string): void } | undefined;
    pi.events.on("pi-plugins.prompt-stash.v1", (data: any) => {
      data.provider = "pi-stash";
      data.create = (options: any) => {
        created++;
        editor = options.editor();
        return {
          stashed: false,
          handleKey: (key: string) => key === "\x13" && (calls.push("key"), true),
          submitted: (text: string) => calls.push(`submitted ${text}`),
        };
      };
    });
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    panel.input.setText("draft");
    panel.input.handleInput("\x13");
    expect(panel.input.getText()).toBe("draft"); // the service owns what Ctrl+S does
    expect(editor?.getText()).toBe("draft");
    panel.input.setText("/headsup");
    panel.input.handleInput("\r");
    expect(calls).toEqual(["key", "submitted /headsup"]);
    expect(created).toBe(1);
  });

  it("leaves Ctrl+S to the editor without pi-stash", () => {
    const { controller, ctx } = setup();
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    panel.input.setText("draft");
    panel.input.handleInput("\x13");
    expect(panel.input.getText()).toBe("draft");
  });

  it("hides with /sidebar (or /close) and keeps the thread", () => {
    const { controller, tui, mainEditor, ctx } = setup();
    controller.toggle(ctx as never);
    expect(controller.isOpen).toBe(true);
    panelOf(controller).submit("/close");
    expect(controller.isOpen).toBe(false);
    expect(tui.layoutRoot).not.toBeInstanceOf(SplitRoot);
    expect(tui.focused).toBe(mainEditor);
    controller.toggle(ctx as never);
    expect(controller.isOpen).toBe(true);
    controller.toggle(ctx as never);
    expect(controller.isOpen).toBe(false);
  });

  it("gives the right-hand side to another panel and leaves Herdr's keys to it", async () => {
    const { pi, controller, ctx } = setup();
    let input: ((data: string) => unknown) | undefined;
    (ctx.ui as { onTerminalInput?: unknown }).onTerminalInput = (handler: (data: string) => unknown) => { input = handler; return () => {}; };
    const seen: unknown[] = [];
    pi.events.on("pi-plugins.side-panel.v1", (d: unknown) => seen.push(d));
    await pi.emit("session_start", { reason: "startup" }, ctx);
    controller.toggle(ctx as never);
    expect(controller.isOpen).toBe(true);
    expect(seen).toContainEqual({ id: "pi-sidebar", open: true });
    pi.events.emit("pi-plugins.side-panel.v1", { id: "pi-marimo", open: true });
    expect(controller.isOpen).toBe(false);
    expect(seen).toContainEqual({ id: "pi-sidebar", open: false });
    expect(input!("\x1b[108;8u")).toBeUndefined();
    pi.events.emit("pi-plugins.side-panel.v1", { id: "pi-marimo", open: false });
    expect(input!("\x1b[108;8u")).toEqual({ consume: true });
  });

  it("collapses while a dialog holds herdr:blocked", () => {
    const { pi, controller, tui, ctx } = setup();
    controller.openOrFocus(ctx as never);
    const root = tui.layoutRoot as SplitRoot;
    const sidebarEntry = (root as unknown as { entries: Array<{ visible(v: unknown): boolean }> }).entries[2]!;
    expect(sidebarEntry.visible({ width: 165, height: 50 })).toBe(true);
    pi.events.emit("herdr:blocked", { active: true, label: "question" });
    expect(sidebarEntry.visible({ width: 165, height: 50 })).toBe(false);
    pi.events.emit("herdr:blocked", { active: false });
    expect(sidebarEntry.visible({ width: 165, height: 50 })).toBe(true);
  });

  it("collapses while main shows a UI prompt, held or not", async () => {
    const { pi, controller, tui, ctx } = setup();
    controller.openOrFocus(ctx as never);
    const panel = panelOf(controller);
    const root = tui.layoutRoot as SplitRoot;
    const sidebarEntry = (root as unknown as { entries: Array<{ visible(v: unknown): boolean }> }).entries[2]!;
    await pi.emit("ui_prompt_start", { type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Pick" }, ctx);
    expect(sidebarEntry.visible({ width: 165, height: 50 })).toBe(false);
    expect(panel.view.primary).toBe(false);
    // A held dialog inside the prompt: Sidebar stays collapsed until both end.
    pi.events.emit("herdr:blocked", { active: true, label: "question" });
    await pi.emit("ui_prompt_end", { type: "ui_prompt_end", reason: "ui_prompt", kind: "select" }, ctx);
    expect(sidebarEntry.visible({ width: 165, height: 50 })).toBe(false);
    pi.events.emit("herdr:blocked", { active: false });
    expect(sidebarEntry.visible({ width: 165, height: 50 })).toBe(true);
    expect(panel.view.primary).toBe(true);
  });
});

describe("asking", () => {
  it("asks inline before a send that cannot use main's cache, and sends on Enter", () => {
    const { controller, ctx } = setup(OLD_ANSWER);
    controller.openOrFocus(ctx as never);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const panel = panelOf(controller);
    panel.submit("what now?");
    expect(ask).not.toHaveBeenCalled();
    expect(panel.pendingConfirm()).toMatchObject({ text: "what now?" });
    panel.input.handleInput("\r");
    expect(ask).toHaveBeenCalledWith("what now?", true, expect.objectContaining({ snapshot: expect.objectContaining({ sessionId: "main-session" }) }));
    expect(panel.pendingConfirm()).toBeUndefined();
  });

  it("keeps the question in the composer when the confirmation is declined", () => {
    const { controller, ctx } = setup(OLD_ANSWER);
    controller.openOrFocus(ctx as never);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const panel = panelOf(controller);
    panel.submit("what now?");
    panel.input.handleInput("\x1b");
    expect(ask).not.toHaveBeenCalled();
    expect(panel.input.getText()).toBe("what now?");
  });

  it("sends right away while main's cache is warm, and Esc or Ctrl+C stops a running answer", () => {
    const { controller, ctx } = setup();
    controller.main.bind(ctx as never);
    controller.main.request = { api: "anthropic-messages", provider: "anthropic", model: "claude-x", leafId: null, sentAt: Date.now(), payload: {} };
    controller.openOrFocus(ctx as never);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const abort = vi.spyOn(controller.agent, "abort").mockResolvedValue();
    const panel = panelOf(controller);
    panel.submit("what now?");
    expect(ask).toHaveBeenCalledWith("what now?", false, expect.objectContaining({ snapshot: expect.objectContaining({ sessionId: "main-session" }) }));
    vi.spyOn(controller.agent, "busy", "get").mockReturnValue(true);
    panel.input.handleInput("\x1b");
    expect(abort).toHaveBeenCalledTimes(1);
    panel.input.handleInput("\x03"); // Ctrl+C stops it too, as in Claude Code
    expect(abort).toHaveBeenCalledTimes(2);
  });

  it("runs skills and prompt templates in Sidebar, and refuses other commands", () => {
    const { pi, controller, ctx } = setup();
    (pi as unknown as { getCommands(): unknown[] }).getCommands = () => [
      { name: "skill:herdr", source: "skill" },
      { name: "review", source: "prompt" },
      { name: "tasks", source: "extension" },
    ];
    controller.main.bind(ctx as never);
    controller.main.request = { api: "anthropic-messages", provider: "anthropic", model: "claude-x", leafId: null, sentAt: Date.now(), payload: {} };
    controller.toggle(ctx as never);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const panel = panelOf(controller);
    panel.submit("/skill:herdr list panes");
    panel.submit("/review src");
    panel.submit("/tasks");
    expect(ask.mock.calls.map((call) => call[0])).toEqual(["/skill:herdr list panes", "/review src"]);
    expect(panel.hasNotice()).toBe(true);
  });

  it("/new marks a fresh thread in main's session", async () => {
    const { pi, controller, ctx } = setup();
    controller.openOrFocus(ctx as never);
    panelOf(controller).submit("/new");
    await new Promise((r) => setTimeout(r, 0));
    expect(pi.entries.map((e) => e.customType)).toEqual([RESET_ENTRY]);
    expect(controller.isOpen).toBe(true);
  });

  it("restores the thread from main's branch on session start", async () => {
    const exchange = { type: "custom", customType: EXCHANGE_ENTRY, data: { version: 1, messages: [{ role: "user", content: [{ type: "text", text: "earlier" }], timestamp: 0 }], timestamp: 0 } };
    const { pi, controller, ctx } = setup([exchange]);
    await pi.emit("session_start", { reason: "resume" }, ctx);
    expect(controller.agent.messages.map((m: any) => m.content[0].text)).toEqual(["earlier"]);
  });
});

describe("family controller integration", () => {
  it("keeps a hosted primary view through exactly-once raw toggles and native dialogs", async () => {
    const { pi, controller, ctx, tui, mainEditor } = setup();
    const original = tui.layoutRoot;
    let input!: (text: string) => unknown;
    (ctx.ui as any).onTerminalInput = (handler: typeof input) => { input = handler; return () => {}; };
    await pi.emit("session_start", {}, ctx);
    let done!: () => void;
    const primary = leaf();
    const shown = controller.family.service.view({ factory: (_t, _th, _kb, close) => { done = close; return primary; } });
    await Promise.resolve();
    expect(tui.focused).toBe(primary);
    expect(input("\x14")).toEqual({ consume: true });
    expect(controller.isOpen).toBe(true);
    const panel = panelOf(controller);
    panel.input.setText("preserved draft");
    controller.focusMain();
    expect(tui.focused).toBe(primary);
    expect(input("\x14")).toEqual({ consume: true });
    expect(controller.isOpen).toBe(false);
    expect(tui.focused).toBe(primary);
    input("\x14");
    const dialog = leaf();
    tui.setFocus(dialog); // Pi may install the dialog before prompt-start is dispatched.
    await pi.emit("ui_prompt_start", { kind: "select" }, ctx);
    expect(tui.layoutRoot).toBe(original);
    expect(tui.focused).toBe(dialog);
    tui.setFocus(mainEditor); // Pi closes the dialog before emitting prompt-end.
    await pi.emit("ui_prompt_end", { kind: "select" }, ctx);
    expect(tui.layoutRoot).toBeInstanceOf(SplitRoot);
    expect(panel.input.getText()).toBe("preserved draft");
    done();
    await shown;
    expect(controller.isOpen).toBe(true);
    controller.close();
    expect(tui.layoutRoot).toBe(original);
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  it.each([false, true])("returns to the live main editor after a hosted view closes (dialog: %s)", async (dialogOpen) => {
    const { pi, controller, ctx, tui, mainEditor } = setup();
    await pi.emit("session_start", {}, ctx);
    let done!: () => void;
    let disposed = false;
    const primary = { ...leaf(), dispose: () => { disposed = true; } };
    const shown = controller.family.service.view({ factory: (_t, _th, _kb, close) => { done = close; return primary; } });
    await Promise.resolve();
    controller.openOrFocus(ctx as never);
    const panel = panelOf(controller);
    panel.input.setText("keep Sidebar draft");
    expect(tui.focused).toBe(panel.input);
    if (dialogOpen) {
      pi.events.emit("herdr:blocked", { active: true });
      await pi.emit("ui_prompt_start", { kind: "select" }, ctx);
      tui.setFocus(leaf()); // Pi installs and focuses the native dialog.
    }
    done();
    await shown;
    expect(disposed).toBe(true);
    if (dialogOpen) {
      tui.setFocus(mainEditor); // Pi restores its editor when the dialog closes.
      await pi.emit("ui_prompt_end", { kind: "select" }, ctx);
      pi.events.emit("herdr:blocked", { active: false });
    }
    expect(tui.focused).toBe(panel.input);
    controller.focusMain();
    expect(tui.focused).toBe(mainEditor);
    expect(tui.focused).not.toBe(primary);
    expect(panel.input.getText()).toBe("keep Sidebar draft");
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  });

  it("captures the question subject before a confirmation and attaches context only to Sidebar", async () => {
    const { pi, controller, ctx } = setup(OLD_ANSWER);
    await pi.emit("session_start", {}, ctx);
    controller.openOrFocus(ctx as never);
    const prepared = await controller.family.service.prepare({ kind: "subagent", label: "child" });
    const rootId = controller.family.membership!.agentId;
    controller.family.service.focus(prepared.agentId);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const panel = panelOf(controller);
    panel.submit("what is it doing?");
    controller.family.service.focus(rootId);
    panel.input.handleInput("\r");
    expect(ask.mock.calls[0]![2]!.status).toContain(`captured subject=\"${prepared.agentId}\"`);
    expect(ask.mock.calls[0]![2]!.status).toContain(`anchor=\"${rootId}\"`);
    panel.submit("/context");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(controller.agent.nextContext).toContain(rootId);
    expect(pi.entries.some(e => e.customType === "custom_message")).toBe(false);
    prepared.finish("done"); prepared.dispose();
    await pi.emit("session_shutdown", { reason: "quit" }, ctx);
  });
});

describe("quiz mode", () => {
  const warm = (controller: SidebarController, ctx: unknown) => {
    controller.main.bind(ctx as never);
    controller.main.request = { api: "anthropic-messages", provider: "anthropic", model: "claude-x", leafId: null, sentAt: Date.now(), payload: {} };
  };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

  it("/quiz turns it on, stores that in main's session and asks the first question; /quiz again turns it off", async () => {
    const { pi, controller, ctx } = setup();
    warm(controller, ctx);
    controller.openOrFocus(ctx as never);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const panel = panelOf(controller);
    panel.submit("/quiz");
    await flush();
    expect(controller.quiz.on).toBe(true);
    expect(pi.entries.at(-1)).toMatchObject({ customType: QUIZ_ENTRY, data: { version: 1, on: true } });
    expect(ask).toHaveBeenCalledWith(QUIZ_START, false, expect.any(Object));
    expect(controller.agent.quiz?.role()).toBe(QUIZ_ROLE);
    panel.submit("/quiz next");
    await flush();
    expect(ask).toHaveBeenLastCalledWith(QUIZ_NEXT, false, expect.any(Object));
    panel.submit("/quiz");
    await flush();
    expect(controller.quiz.on).toBe(false);
    expect(pi.entries.at(-1)).toMatchObject({ customType: QUIZ_ENTRY, data: { on: false } });
    expect(controller.agent.quiz?.role()).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("/quiz progress shows the profile without asking the model", async () => {
    const { controller, ctx } = setup();
    warm(controller, ctx);
    controller.openOrFocus(ctx as never);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const note = vi.spyOn(panelOf(controller).chat, "note");
    panelOf(controller).submit("/quiz progress");
    await flush();
    expect(ask).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(expect.stringMatching(/No quiz answers|concepts:/));
  });

  it("never shows a rubric or a grade, seeded or streamed", () => {
    const { controller, ctx } = setup();
    controller.openOrFocus(ctx as never);
    const panel = panelOf(controller);
    const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 });
    panel.chat.seed([reply("What happens on retry?\n<quiz-key>SECRET-KEY</quiz-key>")], (text: string) => ({ text }));
    panel.apply({ type: "message_start", message: reply("Right.") });
    panel.apply({ type: "message_update", message: reply('Right.\n<quiz-update>{"concept":"x","result":"correct"}</quiz-update>\nNext?\n<quiz-key>OTHER-SE') });
    const shown = panel.chat.render(100).join("\n");
    expect(shown).toContain("What happens on retry?");
    expect(shown).toContain("Next?");
    expect(shown).not.toMatch(/SECRET|OTHER-SE|quiz-/);
  });

  it("comes back on with main's branch after a restart", async () => {
    const entry = { type: "custom", customType: QUIZ_ENTRY, data: { version: 1, on: true, base: "abc", at: 1 } };
    const { pi, controller, ctx } = setup([entry]);
    await pi.emit("session_start", { reason: "resume" }, ctx);
    expect(controller.quiz.on).toBe(true);
    expect(controller.quiz.base).toBe("abc");
  });

  it("/sidebar quiz opens Sidebar in quiz mode", async () => {
    delete process.env.PI_SIDEBAR_KEYS;
    const pi = new FakePi();
    piSidebar(pi as never);
    const { tui } = fakeTui();
    const { ctx } = fakeCtx();
    (ctx.ui as { setWidget: unknown }).setWidget = (_key: string, factory?: (t: unknown, theme: unknown) => unknown) => factory?.(tui, ctx.ui.theme);
    await pi.commands.get("sidebar")!.handler("quiz progress", ctx);
    expect(tui.layoutRoot).toBeInstanceOf(SplitRoot);
  });
});

describe("heads-up notes and Sidebar", () => {
  const NOTE = { topic: "t", kind: "risk" as const, text: "Careful.", detail: "Because." };
  const deliver = (controller: SidebarController) =>
    (controller as unknown as { deliverNote(note: unknown): void }).deliverNote(NOTE);

  it("keep a note showing above main's editor when Sidebar opens, and add it to the thread once", () => {
    const { controller, ctx } = setup();
    controller.main.bind(ctx as never);
    (controller.headsUp as any).show(NOTE, ctx);
    expect(controller.headsUp.note.showing).toBe(true);
    controller.toggle(ctx as never);
    expect(controller.headsUp.note.showing).toBe(true);
    expect(controller.agent.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(JSON.stringify(controller.agent.messages.at(-1))).toContain("Careful.");
    const count = controller.agent.messages.length;
    controller.toggle(ctx as never);
    controller.toggle(ctx as never);
    expect(controller.agent.messages).toHaveLength(count);
  });

  it("never start Sidebar's thread for a note", () => {
    const { controller, ctx } = setup();
    controller.main.bind(ctx as never);
    deliver(controller);
    expect(controller.agent.messages).toHaveLength(0);
    expect((controller as any).panel).toBeUndefined();
  });

  it("add a note to the thread once Sidebar has been started, even while it is closed", () => {
    const { controller, ctx } = setup();
    controller.main.bind(ctx as never);
    controller.toggle(ctx as never);
    controller.toggle(ctx as never);
    expect(controller.isOpen).toBe(false);
    deliver(controller);
    expect(JSON.stringify(controller.agent.messages)).toContain("Careful.");
    controller.toggle(ctx as never);
    expect(panelOf(controller).chat.empty).toBe(false);
  });
});

describe("pinned prompt", () => {
  it("pins nothing without pi-sticky-last-prompt", async () => {
    (await import("@earendil-works/pi-coding-agent")).initTheme();
    const { controller, ctx } = setup();
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    panel.chat.user("what is it doing");
    panel.chat.note(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const lines = panel.chat.render(60);
    panel.view.updateLayout(lines.length, 10, () => {});
    panel.view.scrollTo(10, { disableFollow: true });
    expect((panel as any).pin(lines, 60)).toEqual(lines);
  });

  it("draws pi-sticky-last-prompt's bar on Sidebar's top row once the prompt scrolls away, and clicking it jumps back", async () => {
    (await import("@earendil-works/pi-coding-agent")).initTheme();
    const { pi, controller, ctx } = setup();
    let promptRow = 0;
    pi.events.on("pi-plugins.prompt-pin.v1", (data: any) => {
      data.service = {
        anchor: (_children: unknown[], _width: number, top: number) => (top > promptRow ? { start: promptRow, end: promptRow + 1, text: "what is it doing" } : undefined),
        bar: (_theme: unknown, text: string) => `PIN ${text}`,
      };
    });
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    panel.chat.user("what is it doing");
    panel.chat.note(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
    const lines = panel.chat.render(60);
    panel.view.updateLayout(lines.length, 10, () => {});
    const start = lines.findIndex((line: string) => line.includes("what is it doing"));
    promptRow = start;
    panel.view.scrollTo(start, { disableFollow: true });
    expect((panel as any).pin(lines, 60)).toEqual(lines);
    panel.view.scrollTo(start + 5, { disableFollow: true });
    const pinned = (panel as any).pin(lines, 60) as string[];
    expect(pinned[start + 5]).toBe("PIN what is it doing");
    expect(pinned.filter((line, i) => line !== lines[i])).toHaveLength(1);
    (panel as any).view.child.handleMouse({ type: "click", button: "left", x: 3, y: start + 5, width: 60, height: lines.length, screenX: 3, screenY: 0 });
    expect(panel.view.scrollTop).toBe(Math.max(0, start - 1));
  });
});

describe("status line", () => {
  it("drops optional parts before cutting the line", () => {
    const parts = [{ text: "◧ Sidebar" }, { text: "read-only", optional: 1 }, { text: "main idle 5s" }, { text: "97% cached · 1k new", optional: 2 }];
    expect(fitStatus(parts, 120, " · ")).toBe("◧ Sidebar · read-only · main idle 5s · 97% cached · 1k new");
    expect(fitStatus(parts, 40, " · ")).toBe("◧ Sidebar · read-only · main idle 5s");
    expect(fitStatus(parts, 30, " · ")).toBe("◧ Sidebar · main idle 5s");
  });
});

describe("share commands in Sidebar", () => {
  const NOTE = { topic: "cache-splice", kind: "share" as const, format: "both" as const, text: "Splice the cache.", detail: "Why.", post: "TIL: splice the cache." };

  async function shareSetup(confirmed: boolean) {
    const { pi, controller, ctx } = setup();
    await pi.emit("session_start", { reason: "startup" }, ctx);
    const headsUp = controller.headsUp as any;
    headsUp.share = { bluesky: { handle: "me.bsky.social", password: "pw", service: "https://bsky.social" } };
    headsUp.lastNote = NOTE;
    const posts: string[] = [];
    headsUp.publish = async (text: string) => { posts.push(text); return { uri: "at://x/app.bsky.feed.post/rk", url: "https://bsky.app/profile/me.bsky.social/post/rk" }; };
    const confirms: Array<[string, string]> = [];
    (ctx.ui as any).confirm = async (title: string, message: string) => { confirms.push([title, message]); return confirmed; };
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    const submit = async (text: string) => { panel.input.setText(text); panel.input.handleInput("\r"); await new Promise((r) => setTimeout(r, 0)); };
    return { panel, submit, posts, confirms };
  }

  it("/post edit puts the draft in Sidebar's composer, and /post <text> publishes that after a confirm", async () => {
    const { panel, submit, posts, confirms } = await shareSetup(true);
    await submit("/post edit");
    expect(panel.input.getText()).toBe("/post TIL: splice the cache.");
    await submit("/post My version.\nTwo lines.");
    expect(confirms).toEqual([["Post to Bluesky as @me.bsky.social?", "My version.\nTwo lines."]]);
    expect(posts).toEqual(["My version.\nTwo lines."]);
    await submit("/post");
    expect(posts.at(-1)).toBe("TIL: splice the cache.");
  });

  it("does not post when the confirm is declined", async () => {
    const { submit, posts, confirms } = await shareSetup(false);
    await submit("/post");
    expect(confirms).toHaveLength(1);
    expect(posts).toEqual([]);
  });

  it("/draft needs a drafts destination", async () => {
    const { panel, submit } = await shareSetup(true);
    await submit("/draft");
    expect(panel.hasNotice()).toBe(true);
  });
});

describe("blog drafts through Sidebar's agent", () => {
  const NOTE = { topic: "cache-splice", kind: "share" as const, format: "both" as const, text: "Splice the cache.", detail: "Why." };
  const text = (value: string) => [{ type: "text", text: value }];
  const assistant = (value: string, stopReason = "stop", extra: object = {}) => ({ role: "assistant", content: text(value), stopReason, ...extra });

  /** A controller whose Sidebar agent is stubbed: `ask` plays the turn `play` describes. */
  async function draftSetup(options: { open?: boolean; play?: (prompt: string, agent: any) => Promise<void> | void } = {}) {
    const { pi, controller, ctx } = setup();
    await pi.emit("session_start", { reason: "startup" }, ctx);
    if (options.open !== false) controller.toggle(ctx as never);
    const agent = controller.agent as any;
    const asked: Array<{ text: string; confirmed: boolean }> = [];
    agent.ask = async (value: string, confirmed = false) => {
      asked.push({ text: value, confirmed });
      await options.play?.(value, agent);
    };
    /** The events and turn listeners of an answer, as the agent sends them. */
    const answer = (prompt: string, added: unknown[]) => {
      agent.emit({ type: "agent_start" });
      agent.emit({ type: "message_start", message: { role: "user", content: text(prompt) } });
      for (const listener of [...agent.turnListeners]) listener(added);
      agent.emit({ type: "agent_end" });
    };
    const shown = () => (panelOf(controller)?.chat.render(400) as string[]).join("\n");
    return { pi, controller, ctx, agent, asked, answer, shown };
  }

  it("resolves with the turn's final assistant text, hiding the instructions in the thread", async () => {
    const { controller, agent, asked, shown } = await draftSetup();
    const listeners = { turn: agent.turnListeners.size, event: agent.listeners.size };
    const result = controller.writeWithSidebar("LONG WRITER INSTRUCTIONS", "Writing a blog draft: Splice the cache.");
    // The turn: the prompt as an event, a lookup, then the draft.
    agent.emit({ type: "message_start", message: { role: "user", content: text(asked[0]!.text) } });
    for (const listener of [...agent.turnListeners]) {
      listener([
        { role: "user", content: text(asked[0]!.text) },
        { ...assistant("Let me look for examples.", "toolUse"), content: [...text("Let me look for examples."), { type: "toolCall", id: "t1", name: "codemode", arguments: {} }] },
        { role: "toolResult", toolCallId: "t1", content: text("[]") },
        assistant("# Splice Your Cache\n\nBody."),
      ]);
    }
    expect(await result).toBe("# Splice Your Cache\n\nBody.");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.confirmed).toBe(true); // asked for explicitly: no cost confirm
    expect(asked[0]!.text.startsWith(NOTE_MARKER)).toBe(true);
    expect(asked[0]!.text).toContain("LONG WRITER INSTRUCTIONS");
    const chat = shown();
    expect(chat).toContain("Writing a blog draft: Splice the cache.");
    expect(chat).not.toContain("LONG WRITER INSTRUCTIONS");
    expect(agent.turnListeners.size).toBe(listeners.turn); // unsubscribed
    expect(agent.listeners.size).toBe(listeners.event);
  });

  it("works while Sidebar is closed", async () => {
    const { controller, agent, answer, asked } = await draftSetup({ open: false });
    agent.ask = async (value: string) => { asked.push({ text: value, confirmed: true }); answer(value, [{ role: "user", content: text(value) }, assistant("# Done")]); };
    expect(panelOf(controller)).toBeUndefined();
    expect(await controller.writeWithSidebar("p", "label")).toBe("# Done");
    expect(asked[0]!.text.startsWith(NOTE_MARKER)).toBe(true);
  });

  it("refuses while Sidebar is answering", async () => {
    const { controller, agent, asked } = await draftSetup();
    Object.defineProperty(agent, "idle", { get: () => false });
    await expect(controller.writeWithSidebar("p", "label")).rejects.toThrow("Sidebar is answering; try the draft again when it is done");
    expect(asked).toEqual([]);
  });

  it("rejects when the turn errors, is aborted, or never answers", async () => {
    const { controller, agent, answer, asked } = await draftSetup();
    const outcome = async (added: (prompt: string) => unknown[]) => {
      agent.ask = async (value: string) => { asked.push({ text: value, confirmed: true }); answer(value, added(value)); };
      return controller.writeWithSidebar("p", "label");
    };
    await expect(outcome(() => [assistant("", "error", { errorMessage: "overloaded" })])).rejects.toThrow("overloaded");
    await expect(outcome(() => [assistant("half", "aborted")])).rejects.toThrow("Sidebar's answer was stopped");
    await expect(outcome((prompt) => [{ role: "user", content: text(prompt) }])).rejects.toThrow("Sidebar did not answer");
    // A question that ended without any turn.
    agent.ask = async () => {};
    await expect(controller.writeWithSidebar("p", "label")).rejects.toThrow("Sidebar did not answer");
    // Sidebar's own refusal to send, then a failure to ask at all.
    agent.ask = async () => agent.emit({ type: "sidebar_error", message: "Sidebar did not send: there is no copy of main's last request. Nothing was spent." });
    await expect(controller.writeWithSidebar("p", "label")).rejects.toThrow(/there is no copy of main's last request/);
    agent.ask = async () => { throw new Error("main's session is not ready yet"); };
    await expect(controller.writeWithSidebar("p", "label")).rejects.toThrow("main's session is not ready yet");
    expect(agent.turnListeners.size).toBe(1); // the quiz recorder's alone
  });

  it("gives up after ten minutes and stops the answer", async () => {
    const { controller, agent } = await draftSetup({ play: () => new Promise(() => {}) });
    agent.abort = vi.fn(async () => {});
    vi.useFakeTimers();
    try {
      const result = controller.writeWithSidebar("p", "label");
      const rejected = expect(result).rejects.toThrow("Sidebar did not finish the draft within 10 minutes");
      await vi.advanceTimersByTimeAsync(DRAFT_TIMEOUT_MS - 1);
      expect(agent.abort).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(agent.abort).toHaveBeenCalledTimes(1);
      expect(agent.turnListeners.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("files a draft written through Sidebar and notes where it went, leaving the thread as it is", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "sidebar-draft-")), "drafts");
    const { pi, controller, agent, answer, shown } = await draftSetup({});
    const headsUp = controller.headsUp as any;
    headsUp.share = { drafts: { dir }, examplesTool: "mcp__server__similar" };
    headsUp.lastNote = NOTE;
    agent.ask = async (value: string) => {
      answer(value, [
        { role: "user", content: text(value) },
        assistant("# Splice Your Cache\n\nBody.\n\n<draft-examples>\n- How caching bit us | https://example.com/a\n</draft-examples>"),
      ]);
    };
    const { location } = await controller.headsUp.draft(NOTE, "full");
    expect(readdirSync(dir)).toEqual([expect.stringMatching(/^\d{4}-\d\d-\d\d-splice-your-cache\.md$/)]);
    expect(readFileSync(location, "utf8")).toContain('examples:\n  - "How caching bit us | https://example.com/a"');
    const chat = shown();
    expect(chat).toContain("Writing a blog draft: Splice the cache.");
    expect(chat).toContain(`Saved to ${location}`);
    expect(pi.entries.filter((entry) => entry.customType === EXCHANGE_ENTRY)).toEqual([]); // no second copy of the exchange
  });

  it("/draft through Sidebar says how it ended in the chat when the idea was already made", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "sidebar-draft-")), "drafts");
    const { controller, agent, answer, shown } = await draftSetup({});
    const headsUp = controller.headsUp as any;
    headsUp.share = { drafts: { dir }, examplesTool: "mcp__server__similar" };
    headsUp.lastNote = NOTE;
    agent.ask = async (value: string) => answer(value, [{ role: "user", content: text(value) }, assistant('<draft-not-ready>already made by "Old Post" (https://example.com/old)</draft-not-ready>')]);
    const panel = panelOf(controller);
    panel.input.setText("/draft");
    panel.input.handleInput("\r");
    await new Promise((r) => setTimeout(r, 10));
    expect(shown()).toContain('already made by "Old Post" (https://example.com/old)');
    expect(panel.hasNotice()).toBe(true); // the failure also shows as a notice
    expect(readdirSync(path.dirname(dir))).toEqual([]); // nothing saved
  });
});

describe("hidden prompts in Sidebar's thread", () => {
  const user = (value: string) => ({ role: "user", content: [{ type: "text", text: value }] });

  it("does not show a marked user message as the turn begins, only an ordinary one", async () => {
    const { pi, controller, ctx } = setup();
    await pi.emit("session_start", { reason: "startup" }, ctx);
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    const shown = () => (panel.chat.render(200) as string[]).join("\n");
    panel.apply({ type: "message_start", message: user(`${NOTE_MARKER}\nSECRET WRITER INSTRUCTIONS\n</sidebar-headsup-note>`) });
    panel.apply({ type: "message_end", message: user(`${NOTE_MARKER}\nSECRET WRITER INSTRUCTIONS`) });
    expect(panel.chat.empty).toBe(true);
    expect(shown()).not.toContain("SECRET WRITER INSTRUCTIONS");
    panel.apply({ type: "message_start", message: user("what is it doing") });
    expect(shown()).toContain("what is it doing");
  });

  it("still starts the working row for a hidden prompt", async () => {
    const { pi, controller, ctx } = setup();
    await pi.emit("session_start", { reason: "startup" }, ctx);
    controller.toggle(ctx as never);
    const panel = panelOf(controller);
    panel.apply({ type: "agent_start" });
    panel.apply({ type: "message_start", message: user(`${NOTE_MARKER}\nx`) });
    expect(panel.working.active).toBe(true);
    panel.apply({ type: "agent_end" });
    expect(panel.working.active).toBe(false);
  });
});
