import { describe, expect, it, vi } from "vitest";
import { CURSOR_MARKER, type Component } from "@earendil-works/pi-tui";
import { renderLayoutFrame as baselineRenderer } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
// The same suite can verify Pi's newer renderer against the baseline component boundary.
const renderLayoutFrame: typeof baselineRenderer = process.env.PI_SIDEBAR_TEST_RENDERER
  ? (await import(/* @vite-ignore */ process.env.PI_SIDEBAR_TEST_RENDERER)).renderLayoutFrame
  : baselineRenderer;
import { FamilyViewHost } from "../src/family/view-host.ts";
import { dividerLines, SplitLayout, SplitRoot, type PrimaryViewTui } from "../src/layout.ts";

const leaf = (label: string): Component => ({ render: () => [label], invalidate() {} });
function fixture(width = 180) {
  const original = leaf("main");
  const editor = leaf("main draft");
  const sidebar = leaf("sidebar draft");
  let focused: Component | null = editor;
  const tui = {
    terminal: { columns: width, rows: 40 },
    layoutRoot: original as Component | undefined,
    setLayoutRoot(root: Component | undefined) { this.layoutRoot = root; },
    getFocusedComponent: () => focused,
    setFocus(component: Component | null) {
      if (focused && "focused" in focused) (focused as Component & { focused: boolean }).focused = false;
      focused = component;
      if (focused && "focused" in focused) (focused as Component & { focused: boolean }).focused = true;
    },
    requestRender() {},
  } satisfies PrimaryViewTui & { terminal: { columns: number; rows: number } };
  const host = new FamilyViewHost(tui, {}, {});
  const layout = new SplitLayout(tui, sidebar, {
    ratio: () => 0.5, minColumns: 80, collapsed: () => false, focused: () => focused === sidebar,
    divider: (orientation, _focused, w) => dividerLines(orientation, w, (text) => text),
  });
  const render = () => {
    const frame = () => renderLayoutFrame(tui.layoutRoot!, tui.terminal.columns, tui.terminal.rows, () => {});
    frame();
    return frame();
  };
  return { tui, host, layout, render, original, editor, sidebar };
}

// Real Pi layout renderer, not hand-created layout boxes: budgets arrive before render().
describe.each([46, 120, 180])("family primary at %i columns", (width) => {
  it("preserves the component, draft, cursor and allocated budget across toggles and resizing", async () => {
    const f = fixture(width);
    f.host.mountSplit(f.layout);
    let done!: () => void;
    let allocated!: () => { width: number; height: number };
    const budgets: Array<{ width: number; height: number }> = [];
    const component = {
      focused: false,
      draft: "planner draft",
      render(w: number) {
        const budget = allocated();
        budgets.push(budget);
        expect(w).toBe(budget.width);
        return [this.draft + (this.focused ? CURSOR_MARKER : ""), ...Array.from({ length: Math.max(0, budget.height - 1) }, () => "primary")];
      },
      invalidate() {},
      dispose: vi.fn(),
    };
    const closed = f.host.view({ factory: (_tui, _theme, _kb, finish, viewport) => { done = finish; allocated = viewport; return component; } });
    await Promise.resolve();
    let frame = f.render();
    expect(f.host.viewport()).toEqual(width === 180 ? { width: 89, height: 40 } : { width, height: 19 });
    expect(f.tui.getFocusedComponent()).toBe(component);
    expect(frame.lines.some((line) => line.includes("planner draft"))).toBe(true);
    expect(frame.lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    f.host.unmountSplit();
    f.render();
    expect(f.host.viewport()).toEqual({ width, height: 40 });
    expect(f.host.currentPrimary).toBe(component);
    f.host.mountSplit(f.layout);
    f.tui.terminal.columns = width === 180 ? 46 : 180;
    frame = f.render();
    expect(f.host.viewport()).toEqual(width === 180 ? { width: 46, height: 19 } : { width: 89, height: 40 });
    expect(f.host.currentPrimary).toBe(component);
    expect(component.draft).toBe("planner draft");
    expect(f.tui.terminal.rows).toBe(40);
    expect(budgets.length).toBeGreaterThan(2);
    done();
    await closed;
    expect(f.tui.layoutRoot).toBeInstanceOf(SplitRoot);
    expect((f.tui.layoutRoot as SplitRoot).main).toBe(f.original);
    expect(f.tui.getFocusedComponent()).toBe(f.editor);
    expect(component.dispose).toHaveBeenCalledOnce();
    expect(f.host.sidebarRequestedOpen).toBe(true);
  });

  it("suspends native vs local dialogs and restores hosted focus without touching overlays", async () => {
    const f = fixture(width);
    const overlays = Object.freeze([Object.freeze({ dialog: "unrelated" })]);
    Object.defineProperty(f.tui, "overlays", { value: overlays, writable: false });
    f.host.mountSplit(f.layout);
    let done!: () => void;
    const primary = leaf("planner");
    const closed = f.host.view({ factory: (_t, _theme, _kb, finish) => { done = finish; return primary; } });
    await Promise.resolve();
    f.render();
    const local = f.host.suspend("local");
    expect(f.render().lines.join("\n")).toContain("planner");
    expect(f.layout.mounted).toBe(false);
    const native = f.host.suspend("native");
    expect(f.tui.layoutRoot).toBe(f.original);
    expect(f.tui.getFocusedComponent()).toBe(primary);
    native();
    expect(f.render().lines.join("\n")).toContain("planner");
    local();
    expect(f.layout.mounted).toBe(true);
    expect(f.tui.getFocusedComponent()).toBe(primary);
    expect(f.host.sidebarRequestedOpen).toBe(true);
    done();
    await closed;
    expect((f.tui as unknown as { overlays: unknown }).overlays).toBe(overlays);
    f.host.dispose();
    expect(f.tui.layoutRoot).toBe(f.original);
  });
});

it("keeps requested-close and main focus when a primary finishes during a native dialog", async () => {
  const f = fixture();
  f.host.mountSplit(f.layout);
  f.tui.setFocus(f.sidebar);
  let done!: () => void;
  const closed = f.host.view({ factory: (_t, _theme, _kb, finish) => { done = finish; return leaf("primary"); } });
  await Promise.resolve();
  const restore = f.host.suspend("native");
  f.host.unmountSplit();
  done();
  await closed;
  restore();
  restore(); // release is idempotent
  expect(f.tui.layoutRoot).toBe(f.original);
  expect(f.tui.getFocusedComponent()).toBe(f.editor);
  expect(f.host.sidebarRequestedOpen).toBe(false);
});

describe.each([false, true])("native focus with Sidebar open=%s", (open) => {
  it("does not capture a late dialog or restore it after Pi closes it", () => {
    const f = fixture();
    if (open) f.host.mountSplit(f.layout);
    const dialog = leaf("native dialog");
    f.tui.setFocus(dialog);
    const release = f.host.suspend("native");
    expect(f.tui.getFocusedComponent()).toBe(dialog);
    expect(f.tui.layoutRoot).toBe(f.original);
    f.tui.setFocus(f.editor); // Pi removes the dialog and restores its editor first.
    release();
    expect(f.tui.getFocusedComponent()).toBe(f.editor);
    expect(f.layout.mounted).toBe(open);
  });

  it("preserves an external dialog when a native hold ends before that dialog", () => {
    const f = fixture();
    if (open) f.host.mountSplit(f.layout);
    const release = f.host.suspend("native");
    const dialog = leaf("still-open dialog");
    f.tui.setFocus(dialog);
    release();
    expect(f.tui.getFocusedComponent()).toBe(dialog);
  });
});

it("restores a hosted view, not a late native dialog, after Pi restores its editor", async () => {
  const f = fixture();
  f.host.mountSplit(f.layout);
  const primary = leaf("primary");
  let done!: () => void;
  const closed = f.host.view({ factory: (_t, _theme, _kb, finish) => { done = finish; return primary; } });
  await Promise.resolve();
  const dialog = leaf("dialog");
  f.tui.setFocus(dialog);
  const release = f.host.suspend("native");
  expect(f.tui.getFocusedComponent()).toBe(dialog);
  f.tui.setFocus(f.editor);
  release();
  expect(f.tui.getFocusedComponent()).toBe(primary);
  done();
  await closed;
});

it.each([false, true])("keeps a local hold's prior Sidebar focus across nested native releases (dialog still open=%s)", async (dialogOpen) => {
  const f = fixture();
  f.host.mountSplit(f.layout);
  let done!: () => void;
  const primary = leaf("primary");
  const closed = f.host.view({ factory: (_t, _theme, _kb, finish) => { done = finish; return primary; } });
  await Promise.resolve();
  f.tui.setFocus(f.sidebar);
  const local = f.host.suspend("local");
  const outerDialog = leaf("outer dialog");
  f.tui.setFocus(outerDialog);
  const outer = f.host.suspend("native");
  const innerDialog = leaf("inner dialog");
  f.tui.setFocus(innerDialog);
  const inner = f.host.suspend("native");
  inner();
  expect(f.tui.getFocusedComponent()).toBe(innerDialog);
  f.tui.setFocus(dialogOpen ? outerDialog : f.editor);
  outer(); // A remaining local hold must not redirect a still-open dialog to primary.
  expect(f.tui.getFocusedComponent()).toBe(dialogOpen ? outerDialog : primary);
  if (dialogOpen) f.tui.setFocus(f.editor);
  local();
  expect(f.tui.getFocusedComponent()).toBe(f.sidebar);
  expect(f.layout.mounted).toBe(true);
  done();
  await closed;
  expect(f.tui.getFocusedComponent()).toBe(f.sidebar);
});

it.each(["sidebar", "external"] as const)("keeps %s focus when an auto-view closes", async (target) => {
  const f = fixture();
  f.host.mountSplit(f.layout);
  let done!: () => void;
  const closed = f.host.view({ factory: (_t, _theme, _kb, finish) => { done = finish; return leaf("primary"); } });
  await Promise.resolve();
  const focus = target === "sidebar" ? f.sidebar : leaf("external");
  f.tui.setFocus(focus);
  done();
  await closed;
  expect(f.host.hasView).toBe(false);
  expect(f.tui.getFocusedComponent()).toBe(focus);
  expect((f.tui.layoutRoot as SplitRoot).main).toBe(f.original);
});

it.each([false, true])("invalidates closing-view focus without stealing a suspended dialog (local=%s)", async (localHold) => {
  const f = fixture();
  f.host.mountSplit(f.layout);
  f.tui.setFocus(f.sidebar);
  let done!: () => void;
  const closed = f.host.view({ factory: (_t, _theme, _kb, finish) => { done = finish; return leaf("primary"); } });
  await Promise.resolve();
  const local = localHold ? f.host.suspend("local") : undefined;
  const dialog = leaf("dialog");
  f.tui.setFocus(dialog);
  const native = f.host.suspend("native");
  done();
  await closed;
  expect(f.tui.getFocusedComponent()).toBe(dialog);
  f.tui.setFocus(f.editor);
  native();
  local?.();
  expect(f.tui.getFocusedComponent()).toBe(f.sidebar);
  expect(f.host.hasView).toBe(false);
  expect(f.layout.mounted).toBe(true);
});

it("preserves an external local return target when a fullscreen primary closes", async () => {
  const f = fixture();
  let done!: () => void;
  const closed = f.host.view({ factory: (_t, _theme, _kb, finish) => { done = finish; return leaf("primary"); } });
  await Promise.resolve();
  const external = leaf("external");
  f.tui.setFocus(external);
  const local = f.host.suspend("local");
  done();
  await closed;
  expect(f.tui.getFocusedComponent()).toBe(external);
  local();
  expect(f.tui.getFocusedComponent()).toBe(external);
});

it("drops a disposed primary even when it still owns focus during a local hold", async () => {
  const f = fixture();
  let done!: () => void;
  const closed = f.host.view({ factory: (_t, _theme, _kb, finish) => { done = finish; return leaf("primary"); } });
  await Promise.resolve();
  const local = f.host.suspend("local");
  done();
  await closed;
  expect(f.tui.getFocusedComponent()).toBe(f.editor);
  local();
  expect(f.tui.getFocusedComponent()).toBe(f.editor);
});

it("handles synchronous done, failed factories, disposal and stale completions", async () => {
  const f = fixture();
  const dispose = vi.fn();
  await f.host.view({ factory: (_t, _theme, _kb, done) => { done(); return { ...leaf("closed"), dispose }; } });
  expect(dispose).toHaveBeenCalledOnce();
  await expect(f.host.view({ factory: () => { throw new Error("factory failed"); } })).rejects.toThrow("factory failed");
  expect(f.host.hasView).toBe(false);
  let resolve!: (component: Component) => void;
  const closed = f.host.view({ factory: () => new Promise((done) => { resolve = done; }) });
  await expect(f.host.view({ factory: () => leaf("second") })).rejects.toThrow("already open");
  f.host.dispose();
  const late = { ...leaf("late"), dispose };
  resolve(late);
  await closed;
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(f.tui.layoutRoot).toBe(f.original);
  await expect(f.host.view({ factory: () => leaf("stale") })).rejects.toThrow("disposed");
});
