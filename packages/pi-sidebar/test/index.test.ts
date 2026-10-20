import { afterEach, describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import piSidebar from "../src/index.ts";
import { SidebarController } from "../src/controller.ts";
import { SplitRoot } from "../src/layout.ts";
import { fitStatus } from "../src/panel.ts";
import { EXCHANGE_ENTRY, RESET_ENTRY } from "../src/thread.ts";
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

  it("explains why the model cannot be overridden", async () => {
    const pi = new FakePi();
    piSidebar(pi as never);
    const { ctx, notes } = fakeCtx();
    await pi.commands.get("sidebar")!.handler("model anthropic/claude-haiku", ctx);
    expect(notes[0]!.message).toMatch(/always uses main's model/);
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

  it("opens beside main, moves focus there, and back with the key", () => {
    const { controller, tui, mainEditor, ctx } = setup();
    controller.openOrFocus(ctx as never);
    expect(tui.layoutRoot).toBeInstanceOf(SplitRoot);
    const panel = panelOf(controller);
    expect(tui.focused).toBe(panel.input);
    panel.input.handleInput("\x14"); // ctrl+t, the test's toggle key
    expect(tui.focused).toBe(mainEditor);
    controller.openOrFocus(ctx as never);
    expect(tui.focused).toBe(panel.input);
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
});

describe("asking", () => {
  it("asks inline before a send that cannot use main's cache, and sends on Enter", () => {
    const { controller, ctx } = setup();
    controller.openOrFocus(ctx as never);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const panel = panelOf(controller);
    panel.submit("what now?");
    expect(ask).not.toHaveBeenCalled();
    expect(panel.pendingConfirm()).toMatchObject({ text: "what now?" });
    panel.input.handleInput("\r");
    expect(ask).toHaveBeenCalledWith("what now?", true);
    expect(panel.pendingConfirm()).toBeUndefined();
  });

  it("keeps the question in the composer when the confirmation is declined", () => {
    const { controller, ctx } = setup();
    controller.openOrFocus(ctx as never);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const panel = panelOf(controller);
    panel.submit("what now?");
    panel.input.handleInput("\x1b");
    expect(ask).not.toHaveBeenCalled();
    expect(panel.input.getText()).toBe("what now?");
  });

  it("sends right away while main's cache is warm, and Esc stops a running answer", () => {
    const { controller, ctx } = setup();
    controller.main.bind(ctx as never);
    controller.main.request = { api: "anthropic-messages", provider: "anthropic", model: "claude-x", leafId: null, sentAt: Date.now(), payload: {} };
    controller.openOrFocus(ctx as never);
    const ask = vi.spyOn(controller.agent, "ask").mockResolvedValue();
    const abort = vi.spyOn(controller.agent, "abort").mockResolvedValue();
    const panel = panelOf(controller);
    panel.submit("what now?");
    expect(ask).toHaveBeenCalledWith("what now?", false);
    vi.spyOn(controller.agent, "busy", "get").mockReturnValue(true);
    panel.input.handleInput("\x1b");
    expect(abort).toHaveBeenCalled();
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

describe("status line", () => {
  it("drops optional parts before cutting the line", () => {
    const parts = [{ text: "◧ Sidebar" }, { text: "read-only", optional: 1 }, { text: "main idle 5s" }, { text: "97% cached · 1k new", optional: 2 }];
    expect(fitStatus(parts, 120, " · ")).toBe("◧ Sidebar · read-only · main idle 5s · 97% cached · 1k new");
    expect(fitStatus(parts, 40, " · ")).toBe("◧ Sidebar · read-only · main idle 5s");
    expect(fitStatus(parts, 30, " · ")).toBe("◧ Sidebar · main idle 5s");
  });
});
