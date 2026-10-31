import { describe, expect, it } from "vitest";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { orientationFor, splitSizes } from "../src/config.ts";
import { canSplit, dividerLines, faintColumns, findTranscriptView, muteEditorBorders, SplitLayout, SplitRoot } from "../src/layout.ts";

const leaf = (): Component => ({ render: () => [], invalidate() {} });

function fakeTui(root: Component | undefined = leaf()) {
  return {
    mode: "fullscreen",
    layoutRoot: root as Component | undefined,
    renders: 0,
    setLayoutRoot(component: Component | undefined) { this.layoutRoot = component; },
    requestRender() { this.renders++; },
  };
}

function settings(overrides: Partial<{ collapsed: boolean; minColumns: number; ratio: number; focused: () => boolean }> = {}) {
  return {
    ratio: () => overrides.ratio ?? 0.5,
    minColumns: overrides.minColumns ?? 80,
    collapsed: () => overrides.collapsed ?? false,
    focused: overrides.focused ?? (() => false),
    divider: () => ["|"],
  };
}

type Entry = { basis?: number; grow?: number; visible?: (v: { width: number; height: number }) => boolean };
const entries = (root: SplitRoot) => (root as unknown as { entries: Entry[] }).entries;
const layoutType = (root: SplitRoot) => (root as unknown as { layoutType: string }).layoutType;

describe("sizes", () => {
  it("halves beside main when both halves keep the minimum, below otherwise", () => {
    expect(orientationFor(161, 80)).toBe("right");
    expect(orientationFor(160, 80)).toBe("down");
    expect(splitSizes(165, 0.5)).toEqual({ main: 82, divider: 1, side: 82 });
    expect(splitSizes(57, 0.5)).toEqual({ main: 28, divider: 1, side: 28 });
    expect(splitSizes(100, 0.3)).toEqual({ main: 69, divider: 1, side: 30 });
  });

  it("draws a full-height rule beside main and a full-width rule below it", () => {
    expect(dividerLines("right", 1, (t) => t).length).toBeGreaterThan(100);
    expect(dividerLines("down", 5, (t) => t)).toEqual(["─────"]);
  });

  it("points the divider at the focused half from its middle", () => {
    const pointer = (t: string) => `[${t}]`;
    const beside = dividerLines("right", 1, (t) => t, { sidebar: true, length: 9, pointer });
    expect(beside[4]).toBe("[▸]");
    expect(beside.filter((line) => line !== "│")).toEqual(["[▸]"]);
    expect(dividerLines("right", 1, (t) => t, { sidebar: false, length: 9, pointer })[4]).toBe("[◂]");
    expect(dividerLines("down", 7, (t) => t, { sidebar: true, length: 7, pointer })).toEqual(["───[▾]───"]);
    expect(dividerLines("down", 7, (t) => t, { sidebar: false, length: 7, pointer })).toEqual(["───[▴]───"]);
    expect(dividerLines("right", 1, (t) => t, { sidebar: true, length: 0, pointer }).every((line) => line === "│")).toBe(true);
  });

  it("draws a column range faint without dropping anything", () => {
    expect(faintColumns("abcdef", 2, 4)).toBe("ab\x1b[2mcd\x1b[22mef");
    expect(faintColumns("abc", 0, 3)).toBe("\x1b[2mabc\x1b[22m");
    // Resets inside the range keep it faint; cursor markers and links pass through.
    const cursor = "\x1b_pi:c\x07";
    expect(faintColumns(`a\x1b[0mb${cursor}c`, 0, 9)).toBe(`\x1b[2ma\x1b[0m\x1b[2mb${cursor}c\x1b[22m`);
    expect(faintColumns(`ab${cursor}`, 0, 1)).toBe(`\x1b[2ma\x1b[22mb${cursor}`);
    expect(faintColumns("中文x", 2, 4)).toBe("中\x1b[2m文\x1b[22mx");
    expect(faintColumns("\x1b_Gf=100;AAAA\x1b\\", 0, 5)).toBe("\x1b_Gf=100;AAAA\x1b\\");
  });
});

describe("SplitRoot", () => {
  it("sizes main, divider and Sidebar from the viewport", () => {
    const root = new SplitRoot(leaf(), leaf(), settings(), () => {});
    entries(root)[0]!.visible!({ width: 165, height: 50 });
    expect(entries(root).map((e) => e.basis)).toEqual([82, 1, 82]);
    expect(layoutType(root)).toBe("hstack");
  });

  it("switches to a vertical split for a narrow viewport and requests a redraw", async () => {
    let renders = 0;
    const root = new SplitRoot(leaf(), leaf(), settings(), () => renders++);
    entries(root)[0]!.visible!({ width: 120, height: 40 });
    expect(layoutType(root)).toBe("vstack");
    expect(root.orientation).toBe("down");
    expect(entries(root).map((e) => e.basis)).toEqual([19, 1, 20]);
    await Promise.resolve();
    expect(renders).toBe(1);
  });

  it("hides Sidebar and gives main everything while collapsed", () => {
    const root = new SplitRoot(leaf(), leaf(), settings({ collapsed: true }), () => {});
    expect(entries(root)[0]!.visible!({ width: 165, height: 50 })).toBe(true);
    expect(entries(root)[1]!.visible!({ width: 165, height: 50 })).toBe(false);
    expect(entries(root)[2]!.visible!({ width: 165, height: 50 })).toBe(false);
    expect(entries(root)[0]!.basis).toBe(165);
  });
});

describe("focus cues", () => {
  const frameFor = (root: SplitRoot, mainWidth: number) => ({
    root: { component: root, rect: { x: 0, y: 0, width: 9, height: 2 }, children: [
      { component: root.main, rect: { x: 0, y: 0, width: mainWidth, height: 2 }, children: [] },
      { component: {}, rect: { x: mainWidth, y: 0, width: 1, height: 2 }, children: [] },
      { component: root.panel, rect: { x: mainWidth + 1, y: 0, width: 9 - mainWidth - 1, height: 2 }, children: [] },
    ] },
  });

  it("dims the half without focus", () => {
    let sidebar = false;
    const root = new SplitRoot(leaf(), leaf(), settings({ focused: () => sidebar }), () => {});
    const frame = frameFor(root, 4);
    expect(root.dimUnfocused(["mmmm|sss", "mm"], frame)).toEqual(["mmmm|\x1b[2msss\x1b[22m", "mm"]);
    sidebar = true;
    expect(root.dimUnfocused(["mmmm|sss", "mm"], frame)).toEqual(["\x1b[2mmmmm\x1b[22m|sss", "\x1b[2mmm\x1b[22m"]);
    expect(root.dimUnfocused(["x"], { root: { component: {}, rect: frame.root.rect, children: [] } })).toEqual(["x"]);
    const collapsed = new SplitRoot(leaf(), leaf(), settings({ collapsed: true }), () => {});
    expect(collapsed.dimUnfocused(["mmmm|sss"], frameFor(collapsed, 4))).toEqual(["mmmm|sss"]);
  });

  it("wraps the renderer's highlight stage while mounted and restores it", () => {
    const calls: string[][] = [];
    const tui = Object.assign(fakeTui(), { applySearchHighlights(screen: string[], _frame?: unknown) { calls.push(screen); return screen; } });
    const stage = tui.applySearchHighlights;
    const layout = new SplitLayout(tui, leaf(), settings());
    layout.mount();
    expect(tui.applySearchHighlights).not.toBe(stage);
    const root = tui.layoutRoot as SplitRoot;
    tui.applySearchHighlights(["mmmm|sss"], frameFor(root, 4));
    expect(calls.at(-1)).toEqual(["mmmm|\x1b[2msss\x1b[22m"]);
    layout.unmount();
    expect(tui.applySearchHighlights).toBe(stage);
    expect(Object.prototype.hasOwnProperty.call(tui, "applySearchHighlights")).toBe(true);
    // A renderer whose stage lives on its prototype gets it back there.
    class Renderer { mode = "fullscreen"; layoutRoot: Component | undefined = leaf(); setLayoutRoot(c: Component | undefined) { this.layoutRoot = c; } requestRender() {} applySearchHighlights(screen: string[]) { return screen; } }
    const proto = new Renderer();
    const other = new SplitLayout(proto, leaf(), settings());
    other.mount();
    expect(Object.prototype.hasOwnProperty.call(proto, "applySearchHighlights")).toBe(true);
    other.unmount();
    expect(Object.prototype.hasOwnProperty.call(proto, "applySearchHighlights")).toBe(false);
  });

  it("focuses the half a left press lands in, then lets Pi handle the press", () => {
    let sidebar = false;
    const asked: string[] = [];
    const seen: unknown[] = [];
    const tui = Object.assign(fakeTui(), {
      mouseCapture: undefined as unknown,
      activeSearch: undefined as unknown,
      renderedOverlayLayouts: [] as { row: number; col: number; width: number; height: number }[],
      handleMouseEvent(raw: unknown) { seen.push(raw); },
    });
    const handler = tui.handleMouseEvent;
    const layout = new SplitLayout(tui, leaf(), { ...settings({ focused: () => sidebar }), focusHalf: (half: "main" | "sidebar") => { asked.push(half); sidebar = half === "sidebar"; } });
    layout.mount();
    entries(tui.layoutRoot as SplitRoot)[0]!.visible!({ width: 165, height: 50 });
    tui.handleMouseEvent({ x: 120, y: 3, button: 0 });
    expect(asked).toEqual(["sidebar"]);
    expect(seen).toHaveLength(1);
    tui.handleMouseEvent({ x: 120, y: 3, button: 0 }); // already focused
    tui.handleMouseEvent({ x: 10, y: 3, button: 0, release: true }); // release
    tui.handleMouseEvent({ x: 10, y: 3, button: 2 }); // right button
    tui.handleMouseEvent({ x: 10, y: 3, button: 64 }); // wheel
    tui.handleMouseEvent({ x: 82, y: 3, button: 0 }); // divider
    tui.renderedOverlayLayouts = [{ row: 0, col: 0, width: 20, height: 10 }];
    tui.handleMouseEvent({ x: 10, y: 3, button: 0 }); // dialog
    tui.renderedOverlayLayouts = [];
    tui.activeSearch = {};
    tui.handleMouseEvent({ x: 10, y: 3, button: 0 }); // search open
    tui.activeSearch = undefined;
    expect(asked).toEqual(["sidebar"]);
    tui.handleMouseEvent({ x: 10, y: 3, button: 0 });
    expect(asked).toEqual(["sidebar", "main"]);
    expect(seen).toHaveLength(9);
    layout.unmount();
    expect(tui.handleMouseEvent).toBe(handler);
  });

  it("mutes an editor's borders while asked, once per editor", () => {
    const editor = { renderTopBorder: (w: number) => `\x1b[36m${"─".repeat(w)}\x1b[39m`, renderBottomBorder: () => "\x1b[31m━\x1b[36m─\x1b[39m" };
    let mute = true;
    const muted = (t: string) => `<muted>${t}</muted>`;
    expect(muteEditorBorders(editor, () => (mute ? muted : undefined))).toBe(true);
    expect(editor.renderTopBorder(3)).toBe("<muted>───</muted>");
    expect(editor.renderBottomBorder()).toBe("<muted>━─</muted>");
    mute = false;
    expect(editor.renderTopBorder(2)).toBe("\x1b[36m──\x1b[39m");
    const top = editor.renderTopBorder;
    expect(muteEditorBorders(editor, () => muted)).toBe(true);
    expect(editor.renderTopBorder).toBe(top);
    expect(editor.renderTopBorder(1)).toBe("<muted>─</muted>");
    expect(muteEditorBorders({ render: () => [] }, () => muted)).toBe(false);
    expect(muteEditorBorders(null, () => muted)).toBe(false);
  });
});

describe("SplitLayout", () => {
  it("re-roots Pi's layout and restores it", () => {
    const original = leaf();
    const tui = fakeTui(original);
    const layout = new SplitLayout(tui, leaf(), settings());
    expect(layout.mount()).toBe(true);
    expect(tui.layoutRoot).toBeInstanceOf(SplitRoot);
    expect((tui.layoutRoot as SplitRoot).main).toBe(original);
    expect(layout.mounted).toBe(true);
    layout.unmount();
    expect(tui.layoutRoot).toBe(original);
    expect(layout.mounted).toBe(false);
  });

  it("mounts an explicit primary without losing the root it must restore", () => {
    const original = leaf();
    const tui = fakeTui(original);
    const primary = leaf();
    const viewport: Array<{ width: number; height: number }> = [];
    const layout = new SplitLayout(tui, leaf(), settings());
    layout.mount(primary, (budget) => viewport.push(budget));
    const root = tui.layoutRoot as SplitRoot;
    expect(root.main).toBe(primary);
    root.resize({ width: 180, height: 40 });
    root.resize({ width: 46, height: 30 });
    expect(viewport).toEqual([{ width: 89, height: 40 }, { width: 46, height: 14 }]);
    layout.unmount();
    expect(tui.layoutRoot).toBe(original);
  });

  it("splits Pi's new root when Pi replaced it", () => {
    const tui = fakeTui(leaf());
    const layout = new SplitLayout(tui, leaf(), settings());
    layout.mount();
    const replacement = leaf();
    tui.layoutRoot = replacement;
    expect(layout.mounted).toBe(false);
    layout.mount();
    expect((tui.layoutRoot as SplitRoot).main).toBe(replacement);
  });

  it("does nothing on a renderer without a layout root (regular mode)", () => {
    expect(canSplit({ requestRender() {} })).toBe(false);
    const tui = { layoutRoot: undefined, requestRender() {} };
    expect(new SplitLayout(tui, leaf(), settings()).mount()).toBe(false);
  });
});

describe("mouse", () => {
  const event = (over: Partial<TuiMouseEvent>): TuiMouseEvent => ({
    type: "wheel", button: "none" as never, x: 0, y: 0, screenX: 0, screenY: 0, width: 165, height: 50, shift: false, alt: false, ctrl: false, ...over,
  });

  function mouseRoot(options: { primary?: boolean } = {}) {
    const scrolled: string[] = [];
    const ratios: Array<[string, number | undefined, boolean]> = [];
    const transcript = { primary: true, child: { children: [] }, scrollBy: (n: number) => { scrolled.push(`main:${n}`); return 0; }, render: () => [], invalidate() {} };
    const main = { children: [transcript], render: () => [], invalidate() {} } as unknown as Component;
    const root = new SplitRoot(main, leaf(), {
      ...settings(),
      setRatio: (orientation, ratio, final) => ratios.push([orientation, ratio, final]),
      scrollSidebar: (n) => scrolled.push(`side:${n}`),
      sidebarPrimary: () => options.primary ?? false,
    }, () => {});
    entries(root)[0]!.visible!({ width: 165, height: 50 }); // main 82, divider at 82, Sidebar from 83
    return { root, scrolled, ratios, divider: (root as unknown as { entries: Array<{ component: Component }> }).entries[1]!.component };
  }

  it("keeps the wheel in Sidebar when it is under the pointer", () => {
    const { root, scrolled } = mouseRoot();
    expect(root.handleMouse(event({ x: 100, screenX: 100, wheelDelta: -3 }))).toMatchObject({ handled: true });
    expect(scrolled).toEqual(["side:-3"]);
  });

  it("leaves main's wheel to Pi unless Sidebar is primary, then scrolls main's transcript itself", () => {
    expect(mouseRoot().root.handleMouse(event({ x: 10, wheelDelta: -3 }))).toBeUndefined();
    const { root, scrolled } = mouseRoot({ primary: true });
    expect(root.handleMouse(event({ x: 10, wheelDelta: -3 }))).toMatchObject({ handled: true });
    expect(scrolled).toEqual(["main:-3"]);
    expect(root.handleMouse(event({ type: "click", x: 10 }))).toBeUndefined();
  });

  it("drags the divider to a new share, saves it on release, and resets on double-click", () => {
    const { divider, ratios } = mouseRoot();
    expect(divider.handleMouse!(event({ type: "drag", screenX: 60 }))).toBeUndefined(); // not pressed
    expect(divider.handleMouse!(event({ type: "press", button: "left" }))).toMatchObject({ capture: true });
    expect(divider.render(1)[0]).toBe("|");
    divider.handleMouse!(event({ type: "drag", screenX: 60 }));
    divider.handleMouse!(event({ type: "release", screenX: 50 }));
    divider.handleMouse!(event({ type: "click", clickCount: 2 }));
    expect(ratios).toEqual([
      ["right", (164 - 60) / 164, false],
      ["right", (164 - 50) / 164, true],
      ["right", undefined, true],
    ]);
  });

  it("finds a transcript view nested in main", () => {
    const view = { primary: true, child: { children: [] }, scrollBy() {} };
    expect(findTranscriptView({ entries: [{ component: { children: [view] } }] })).toBe(view);
    expect(findTranscriptView({ children: [{ scrollBy() {}, child: {} }] })).toBeUndefined();
  });
});
