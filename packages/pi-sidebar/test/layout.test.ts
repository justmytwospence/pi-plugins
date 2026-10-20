import { describe, expect, it } from "vitest";
import type { Component } from "@earendil-works/pi-tui";
import { orientationFor, splitSizes } from "../src/config.ts";
import { canSplit, dividerLines, SplitLayout, SplitRoot } from "../src/layout.ts";

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

function settings(overrides: Partial<{ collapsed: boolean; minColumns: number; ratio: number }> = {}) {
  return {
    ratio: overrides.ratio ?? 0.5,
    minColumns: overrides.minColumns ?? 80,
    collapsed: () => overrides.collapsed ?? false,
    focused: () => false,
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
});

describe("SplitRoot", () => {
  it("sizes main, divider and Sidebar from the viewport", () => {
    const root = new SplitRoot(leaf(), leaf(), settings(), () => {});
    entries(root)[0]!.visible!({ width: 165, height: 50 });
    expect(entries(root).map((e) => e.basis)).toEqual([82, 1, 82]);
    expect(layoutType(root)).toBe("hstack");
  });

  it("switches to a vertical split for a narrow viewport, from the next frame", async () => {
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
