import { describe, expect, it, vi } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import { NotebookSplit } from "../src/ui/split.ts";
import { SplitRoot } from "../src/ui/split-layout.ts";

const theme = { fg: (_: string, t: string) => t, bold: (t: string) => t };
const leaf = (): Component => ({ render: () => [], invalidate() {} });

function setup(opts: { fullscreen?: boolean } = {}) {
  const main = leaf();
  const editor = leaf();
  const tui: any = {
    layoutRoot: main as Component | undefined,
    requestRender() {},
    focused: editor as Component | null,
    setFocus(c: Component | null) { this.focused = c; },
    getFocusedComponent() { return this.focused; },
    terminal: { rows: 40, write() {} },
  };
  if (opts.fullscreen !== false) tui.setLayoutRoot = function (c: Component | undefined) { this.layoutRoot = c; };
  const handlers = new Map<string, Array<(...a: any[]) => unknown>>();
  const bus = new Map<string, Array<(d: unknown) => void>>();
  const pi: any = {
    on: (name: string, fn: (...a: any[]) => unknown) => { (handlers.get(name) ?? handlers.set(name, []).get(name)!).push(fn); },
    events: {
      on: (name: string, fn: (d: unknown) => void) => { (bus.get(name) ?? bus.set(name, []).get(name)!).push(fn); },
      emit: (name: string, d: unknown) => { for (const fn of bus.get(name) ?? []) fn(d); },
    },
  };
  const emitted: unknown[] = [];
  pi.events.on("pi-plugins.side-panel.v1", (d: unknown) => emitted.push(d));
  let input: ((d: string) => unknown) | undefined;
  const ctx: any = {
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget: (_k: string, f?: (t: unknown, th: unknown) => unknown) => f?.(tui, theme),
      notify: vi.fn(),
      onTerminalInput: (h: (d: string) => unknown) => { input = h; return () => {}; },
    },
  };
  const views: any[] = [];
  const split = new NotebookSplit(pi, (_t, _th, key) => {
    const v = { render: () => ["NB"], invalidate() {}, handleInput: vi.fn(), handleMouse: () => undefined, dispose: vi.fn(), notebook: key };
    views.push(v);
    return v as never;
  });
  split.listen(ctx);
  const fire = (name: string, ...a: unknown[]) => { for (const fn of handlers.get(name) ?? []) fn(...a); };
  return { split, tui, main, editor, pi, ctx, views, emitted, fire, input: (d: string) => input!(d) };
}

describe("NotebookSplit", () => {
  it("docks the view beside the chat and focuses it; close puts the chat back", () => {
    const s = setup();
    expect(s.split.open(s.ctx, "k", { focus: true })).toBe(true);
    expect(s.tui.layoutRoot).toBeInstanceOf(SplitRoot);
    expect((s.tui.layoutRoot as any).main).toBe(s.main);
    expect(s.tui.focused).toBe(s.views[0]);
    expect(s.split.isOpen).toBe(true);
    s.split.close();
    expect(s.tui.layoutRoot).toBe(s.main);
    expect(s.tui.focused).toBe(s.editor);
    expect(s.views[0].dispose).toHaveBeenCalled();
  });

  it("without Pi's fullscreen layout it says so, unless quiet", () => {
    const s = setup({ fullscreen: false });
    expect(s.split.open(s.ctx, "k", { focus: true })).toBe(false);
    expect(s.ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(s.split.open(s.ctx, "k", { focus: true, quiet: true })).toBe(false);
    expect(s.ctx.ui.notify).toHaveBeenCalledTimes(1);
  });

  it("one right-hand panel: it announces itself, and gives way to Sidebar", () => {
    const s = setup();
    s.split.open(s.ctx, "k", { focus: true });
    expect(s.emitted).toContainEqual({ id: "pi-marimo", open: true });
    s.pi.events.emit("pi-plugins.side-panel.v1", { id: "pi-sidebar", open: true });
    expect(s.split.isOpen).toBe(false);
    s.split.autoOpen(s.ctx, "k");
    expect(s.split.isOpen).toBe(false);
    s.pi.events.emit("pi-plugins.side-panel.v1", { id: "pi-sidebar", open: false });
    s.split.autoOpen(s.ctx, "k");
    expect(s.split.isOpen).toBe(true);
    expect(s.tui.focused).toBe(s.editor);
  });

  it("collapses while a dialog is up", () => {
    const s = setup();
    s.split.open(s.ctx, "k", { focus: true });
    const entry = (s.tui.layoutRoot as any).entries[2];
    const v = { width: 200, height: 40 };
    expect(entry.visible(v)).toBe(true);
    s.fire("ui_prompt_start");
    expect(entry.visible(v)).toBe(false);
    s.fire("ui_prompt_end");
    expect(entry.visible(v)).toBe(true);
    s.pi.events.emit("herdr:blocked", { active: true });
    expect(entry.visible(v)).toBe(false);
    s.pi.events.emit("herdr:blocked", { active: false });
    expect(entry.visible(v)).toBe(true);
  });

  it("ctrl+] and Herdr's prefix+h/l move between the halves", () => {
    const s = setup();
    expect(s.input("\x1d")).toBeUndefined();
    expect(s.input("\x1b[108;8u")).toBeUndefined();
    s.split.open(s.ctx, "k", { focus: false });
    expect(s.tui.focused).toBe(s.editor);
    expect(s.input("\x1d")).toEqual({ consume: true });
    expect(s.tui.focused).toBe(s.views[0]);
    expect(s.input("\x1d")).toEqual({ consume: true });
    expect(s.tui.focused).toBe(s.editor);
    expect(s.input("\x1b[108;8u")).toEqual({ consume: true });
    expect(s.tui.focused).toBe(s.views[0]);
    expect(s.input("\x1b[104;8u")).toEqual({ consume: true });
    expect(s.tui.focused).toBe(s.editor);
    s.split.close();
    expect(s.input("\x1d")).toBeUndefined();
    expect(s.input("\x1b[108;8u")).toBeUndefined();
  });

  it("a split the user closed does not reopen itself until their next message", () => {
    const s = setup();
    s.split.open(s.ctx, "k", { focus: false });
    s.split.closeByUser();
    s.split.autoOpen(s.ctx, "k");
    expect(s.split.isOpen).toBe(false);
    s.fire("input", { source: "interactive" });
    s.split.autoOpen(s.ctx, "k");
    expect(s.split.isOpen).toBe(true);
  });
});
