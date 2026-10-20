// Puts Sidebar next to main inside Pi's fullscreen layout. Pi draws one layout root (its transcript
// and the editor dock); Sidebar re-roots it into a stack of [main, divider, Sidebar], so main reflows
// into its half instead of being covered. The stack is beside main when both halves keep enough
// columns, and below otherwise, re-decided on every frame from the viewport. While another
// extension holds `herdr:blocked` (a dialog waits on the user), Sidebar collapses so the dialog
// renders full width as herdr-web-ui's phone parser expects.
//
// Pi does not publish its layout root; the suite reads it the same way in pi-clear-screen, pi-copy,
// pi-sticky-last-prompt and plan mode. Anything unexpected leaves Pi's layout untouched.
import { HStack, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

type TuiMouseDispatchResult = NonNullable<ReturnType<HStack["handleMouse"]>> & { target: unknown };
import { orientationFor, ratioAt, splitSizes, type Orientation } from "./config.ts";

/** What Sidebar needs from Pi's fullscreen renderer. */
export interface LayoutTui {
  readonly mode?: string;
  layoutRoot?: Component;
  setLayoutRoot?(component: Component | undefined): void;
  requestRender(force?: boolean): void;
}

export function canSplit(tui: unknown): tui is LayoutTui & Required<Pick<LayoutTui, "setLayoutRoot">> {
  const t = tui as LayoutTui | undefined;
  return !!t && typeof t.setLayoutRoot === "function" && !!t.layoutRoot;
}

export interface SplitSettings {
  /** Sidebar's share for an orientation. */
  ratio(orientation: Orientation): number;
  /** Divider drags: a new share while dragging (`final` on release), undefined to reset it. */
  setRatio?(orientation: Orientation, ratio: number | undefined, final: boolean): void;
  minColumns: number;
  /** Scroll Sidebar's transcript by lines (the mouse wheel over Sidebar). */
  scrollSidebar?(lines: number): void;
  /** Whether Sidebar's view is Pi's primary scroll view now (it has focus). */
  sidebarPrimary?(): boolean;
  /** Sidebar hidden but the split kept (a dialog holds `herdr:blocked`). */
  collapsed(): boolean;
  /** Whether Sidebar has focus, for the divider's color. */
  focused(): boolean;
  divider(orientation: Orientation, focused: boolean, width: number): string[];
}

type MutableEntry = { component: Component; basis?: number | "auto"; grow?: number; shrink?: number; minSize?: number; visible?: (v: { width: number; height: number }) => boolean };

/**
 * The divider: a full-height rule beside main, or a full-width rule below it. Drag it to resize
 * (it captures the mouse from press to release); double-click it to go back to the default share.
 */
class Divider implements Component {
  orientation: Orientation = "right";
  dragging = false;
  constructor(private readonly settings: SplitSettings, private readonly drag: (event: TuiMouseEvent, phase: "move" | "end" | "reset") => void) {}
  render(width: number): string[] {
    return this.settings.divider(this.orientation, this.dragging || this.settings.focused(), width);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "click" && (event.clickCount ?? 1) >= 2) {
      this.drag(event, "reset");
      return { handled: true };
    }
    if (event.type === "press" && event.button === "left") {
      this.dragging = true;
      return { capture: true, render: true };
    }
    if (!this.dragging) return undefined;
    if (event.type === "drag") {
      this.drag(event, "move");
      return { handled: true };
    }
    if (event.type === "release") {
      this.dragging = false;
      this.drag(event, "end");
      return { handled: true, render: true };
    }
    return undefined;
  }
  invalidate(): void {}
}

type WheelView = { scrollBy(lines: number): unknown; child?: { children?: unknown } };

/** Main's transcript scroll view: the scroll view over a document with children, primary first. */
export function findTranscriptView(root: unknown): WheelView | undefined {
  const seen = new Set<unknown>();
  let fallback: WheelView | undefined;
  const walk = (node: unknown, depth: number): WheelView | undefined => {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 8) return undefined;
    seen.add(node);
    const view = node as Partial<WheelView> & { primary?: unknown };
    if (typeof view.scrollBy === "function" && Array.isArray(view.child?.children)) {
      if (view.primary === true) return view as WheelView;
      fallback ??= view as WheelView;
    }
    const parent = node as { children?: unknown; entries?: unknown };
    const kids = [
      ...(Array.isArray(parent.entries) ? parent.entries.map((entry) => (entry as { component?: unknown } | undefined)?.component) : []),
      ...(Array.isArray(parent.children) ? parent.children : []),
    ];
    for (const kid of kids) {
      const found = walk(kid, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(root, 0) ?? fallback;
}

/**
 * The re-rooted layout. Stack entries are sized on every frame from the viewport the layout passes to
 * `visible`; a change of orientation applies from the next frame.
 */
export class SplitRoot extends HStack {
  orientation: Orientation = "right";
  private readonly divider: Divider;
  /** Main's size along the split axis and the axis's total, from the last frame. */
  private split = { main: 0, total: 0 };
  private mainView: WheelView | undefined;

  constructor(readonly main: Component, readonly panel: Component, private readonly settings: SplitSettings, private readonly requestRender: () => void) {
    const divider = new Divider(settings, (event, phase) => this.dragDivider(event, phase));
    super([
      { component: main, basis: 0 },
      { component: divider, basis: 0 },
      { component: panel, basis: 0 },
    ]);
    this.divider = divider;
    const entries = this.stackEntries();
    entries[0]!.visible = (viewport) => {
      this.resize(viewport);
      return true;
    };
    entries[1]!.visible = () => !this.settings.collapsed();
    entries[2]!.visible = () => !this.settings.collapsed();
  }

  private stackEntries(): MutableEntry[] {
    return (this as unknown as { entries: MutableEntry[] }).entries;
  }

  /** Size the three entries for this viewport; switch orientation for the next frame if needed. */
  resize(viewport: { width: number; height: number }): void {
    const wanted = orientationFor(viewport.width, this.settings.minColumns);
    if (wanted !== this.orientation) {
      this.orientation = wanted;
      this.divider.orientation = wanted;
      (this as unknown as { layoutType: string }).layoutType = wanted === "right" ? "hstack" : "vstack";
      queueMicrotask(() => this.requestRender());
    }
    const entries = this.stackEntries();
    const total = this.orientation === "right" ? viewport.width : viewport.height;
    if (this.settings.collapsed()) {
      Object.assign(entries[0]!, { basis: total, grow: 1, shrink: 1, minSize: 1 });
      this.split = { main: total, total };
      return;
    }
    const sizes = splitSizes(total, this.settings.ratio(this.orientation));
    this.split = { main: sizes.main, total };
    Object.assign(entries[0]!, { basis: sizes.main, grow: 0, shrink: 0, minSize: 1 });
    Object.assign(entries[1]!, { basis: sizes.divider, grow: 0, shrink: 0, minSize: 1 });
    Object.assign(entries[2]!, { basis: sizes.side, grow: 0, shrink: 0, minSize: 1 });
  }

  private dragDivider(event: TuiMouseEvent, phase: "move" | "end" | "reset"): void {
    if (!this.settings.setRatio || this.split.total < 3) return;
    if (phase === "reset") this.settings.setRatio(this.orientation, undefined, true);
    else {
      // The split fills the screen from its top-left corner, so screen coordinates are its own.
      const position = this.orientation === "right" ? event.screenX : event.screenY;
      this.settings.setRatio(this.orientation, ratioAt(position, this.split.total), phase === "end");
    }
    this.requestRender();
  }

  /**
   * The wheel scrolls only the half under the pointer. Pi gives a scroll view's leftover wheel
   * lines to the primary view, which would move the other half at a transcript's top or end
   * (pi-stereo-view consumes the wheel per panel the same way).
   */
  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    if (event.type !== "wheel" || this.settings.collapsed()) return undefined;
    const handled: TuiMouseDispatchResult = {
      handled: true,
      target: { component: this, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height },
    };
    const lines = event.wheelDelta ?? 0;
    const position = this.orientation === "right" ? event.x : event.y;
    if (position > this.split.main) {
      if (!this.settings.scrollSidebar) return undefined;
      this.settings.scrollSidebar(lines);
      return handled;
    }
    if (position === this.split.main || !this.settings.sidebarPrimary?.()) return undefined;
    // Sidebar is primary, so main's leftover lines would scroll it: scroll main's transcript here.
    this.mainView ??= findTranscriptView(this.main);
    if (!this.mainView) return undefined;
    this.mainView.scrollBy(lines);
    return handled;
  }
}

/** Mounts and unmounts the split on one renderer, and puts it back if Pi replaces the root. */
export class SplitLayout {
  private original: Component | undefined;
  private root: SplitRoot | undefined;

  constructor(readonly tui: LayoutTui, private readonly panel: Component, private readonly settings: SplitSettings) {}

  get mounted(): boolean {
    return !!this.root && this.tui.layoutRoot === this.root;
  }

  /** Re-root Pi's layout; false when this renderer has no layout to split (regular mode). */
  mount(): boolean {
    if (this.mounted) return true;
    if (!canSplit(this.tui)) return false;
    const current = this.tui.layoutRoot!;
    // Pi replaced our root (or never had it): split whatever it shows now.
    this.original = current instanceof SplitRoot ? current.main : current;
    this.root = new SplitRoot(this.original, this.panel, this.settings, () => this.tui.requestRender());
    this.tui.setLayoutRoot!(this.root);
    this.tui.requestRender(true);
    return true;
  }

  unmount(): void {
    if (this.root && this.tui.layoutRoot === this.root && this.original) {
      this.tui.setLayoutRoot?.(this.original);
      this.tui.requestRender(true);
    }
    this.root = undefined;
    this.original = undefined;
  }

  get orientation(): Orientation {
    return this.root?.orientation ?? "right";
  }
}

const DIVIDER_ROWS = 400;

/** The divider's lines: Pi clips a leaf's lines to its box, so a tall column covers any height. */
export function dividerLines(orientation: Orientation, width: number, style: (text: string) => string): string[] {
  if (orientation === "down") return [style("─".repeat(Math.max(1, width)))];
  const cell = style("│");
  return Array.from({ length: DIVIDER_ROWS }, () => cell);
}
