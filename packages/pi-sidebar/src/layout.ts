// Puts Sidebar next to main inside Pi's fullscreen layout. Pi draws one layout root (its transcript
// and the editor dock); Sidebar re-roots it into a stack of [main, divider, Sidebar], so main reflows
// into its half instead of being covered. The stack is beside main when both halves keep enough
// columns, and below otherwise, re-decided on every frame from the viewport. While another
// extension holds `herdr:blocked` (a dialog waits on the user), Sidebar collapses so the dialog
// renders full width as herdr-web-ui's phone parser expects.
//
// Pi does not publish its layout root; the suite reads it the same way in pi-clear-screen, pi-copy,
// pi-sticky-last-prompt and plan mode. Anything unexpected leaves Pi's layout untouched.
import { HStack, visibleWidth, type Component, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

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
  /** Whether Sidebar has focus: the divider points at the focused half, and the other one is dimmed. */
  focused(): boolean;
  /** The divider's lines; `length` is its run along the split (rows beside main, columns below it). */
  divider(orientation: Orientation, sidebarFocused: boolean, width: number, length: number): string[];
}

type MutableEntry = { component: Component; basis?: number | "auto"; grow?: number; shrink?: number; minSize?: number; visible?: (v: { width: number; height: number }) => boolean };

/**
 * The divider: a full-height rule beside main, or a full-width rule below it. Drag it to resize
 * (it captures the mouse from press to release); double-click it to go back to the default share.
 */
class Divider implements Component {
  orientation: Orientation = "right";
  dragging = false;
  /** Rows beside main, from the last frame's viewport. */
  length = 0;
  constructor(private readonly settings: SplitSettings, private readonly drag: (event: TuiMouseEvent, phase: "move" | "end" | "reset") => void) {}
  render(width: number): string[] {
    return this.settings.divider(this.orientation, this.settings.focused(), width, this.orientation === "right" ? this.length : width);
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
    this.divider.length = viewport.height;
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
   * Dim the half without focus on a composited frame, so the focused half stands out (as tmux dims
   * an inactive pane). The halves' boxes come from Pi's layout frame; nothing else is touched.
   */
  dimUnfocused(screen: string[], frame: unknown): string[] {
    if (this.settings.collapsed()) return screen;
    const box = findBox((frame as { root?: FrameBox } | undefined)?.root, this);
    const target = this.settings.focused() ? this.main : this.panel;
    const half = box?.children.find((child) => child.component === target);
    if (!half) return screen;
    const area = half.clip ?? half.rect;
    if (area.width <= 0 || area.height <= 0) return screen;
    const result = screen.slice();
    for (let row = Math.max(0, area.y); row < Math.min(result.length, area.y + area.height); row++) {
      result[row] = faintColumns(result[row] ?? "", area.x, area.x + area.width);
    }
    return result;
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
  private restoreDim: (() => void) | undefined;

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
    this.installDim();
    this.tui.requestRender(true);
    return true;
  }

  /**
   * Dim the unfocused half on every frame. Pi has no hook for a whole-frame pass, so this wraps the
   * renderer's search-highlight stage, the first one that gets both the composited frame and its layout
   * boxes (after fake cursors, before overlays, so dialogs and search stay undimmed). pi-cc-render
   * wraps a later stage the same way. A Pi without that stage just shows no dimming.
   */
  private installDim(): void {
    if (this.restoreDim) return;
    const tui = this.tui as LayoutTui & { applySearchHighlights?: HighlightStage };
    const stage = tui.applySearchHighlights;
    if (typeof stage !== "function") return;
    const own = Object.prototype.hasOwnProperty.call(tui, "applySearchHighlights");
    const layout = this;
    const wrapped: HighlightStage = function (this: unknown, screen, frame) {
      const root = layout.mounted ? layout.root : undefined;
      return stage.call(this, root ? root.dimUnfocused(screen, frame) : screen, frame);
    };
    tui.applySearchHighlights = wrapped;
    this.restoreDim = () => {
      // Someone wrapped it after us: leave theirs; ours is inert once unmounted.
      if (tui.applySearchHighlights !== wrapped) return;
      if (own) tui.applySearchHighlights = stage;
      else delete tui.applySearchHighlights;
    };
  }

  unmount(): void {
    this.restoreDim?.();
    this.restoreDim = undefined;
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

/**
 * The divider's lines: Pi clips a leaf's lines to its box, so a tall column covers any height. A
 * small arrow in its middle points at the focused half (`pointer` styles it); `length` is the run
 * along the split, 0 when unknown.
 */
export function dividerLines(orientation: Orientation, width: number, style: (text: string) => string, focus?: { sidebar: boolean; length: number; pointer: (text: string) => string }): string[] {
  if (orientation === "down") {
    const columns = Math.max(1, width);
    if (!focus || columns < 3) return [style("─".repeat(columns))];
    const middle = Math.floor((columns - 1) / 2);
    return [style("─".repeat(middle)) + focus.pointer(focus.sidebar ? "▾" : "▴") + style("─".repeat(columns - middle - 1))];
  }
  const cell = style("│");
  const lines = Array.from({ length: DIVIDER_ROWS }, () => cell);
  if (focus && focus.length >= 3) lines[Math.min(DIVIDER_ROWS - 1, Math.floor((focus.length - 1) / 2))] = focus.pointer(focus.sidebar ? "▸" : "◂");
  return lines;
}

type HighlightStage = (screen: string[], frame: unknown) => string[];
type FrameRect = { x: number; y: number; width: number; height: number };
type FrameBox = { component: unknown; rect: FrameRect; clip?: FrameRect; children: FrameBox[] };

function findBox(box: FrameBox | undefined, component: unknown, depth = 0): FrameBox | undefined {
  if (!box || depth > 6) return undefined;
  if (box.component === component) return box;
  for (const child of box.children ?? []) {
    const found = findBox(child, component, depth + 1);
    if (found) return found;
  }
  return undefined;
}

const FAINT = "\x1b[2m";
const NORMAL_INTENSITY = "\x1b[22m";
// CSI, OSC and APC (Pi's cursor marker) sequences, and two-byte escapes: kept as they are.
const ESCAPE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|_[^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/y;
const segmenter = new Intl.Segmenter();

/**
 * Draw columns [from, to) of a terminal line faint, inserting codes only: nothing in the line is
 * dropped, so cursor markers and links survive. Faint is re-applied after every SGR code in the range
 * (a reset would end it), and ended at the range's end. Image lines are left alone.
 */
export function faintColumns(line: string, from: number, to: number): string {
  if (to <= from || line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) return line;
  let out = "", column = 0, index = 0, faint = false;
  const at = (col: number) => {
    const inside = col >= from && col < to;
    if (inside && !faint) out += FAINT;
    else if (!inside && faint) out += NORMAL_INTENSITY;
    faint = inside;
  };
  while (index < line.length) {
    ESCAPE.lastIndex = index;
    const escape = ESCAPE.exec(line);
    if (escape) {
      out += escape[0];
      if (faint && escape[0].startsWith("\x1b[") && escape[0].endsWith("m")) out += FAINT;
      index += escape[0].length;
      continue;
    }
    let end = line.indexOf("\x1b", index + 1);
    if (end < 0) end = line.length;
    for (const { segment } of segmenter.segment(line.slice(index, end))) {
      at(column);
      out += segment;
      column += visibleWidth(segment);
    }
    index = end;
  }
  if (faint) out += NORMAL_INTENSITY;
  return out;
}

type BorderRenderer = (this: unknown, width: number, hidden: number) => string;
interface BorderedEditor {
  renderTopBorder?: BorderRenderer;
  renderBottomBorder?: BorderRenderer;
  [MUTED_BORDERS]?: { muted: () => ((text: string) => string) | undefined };
}
const MUTED_BORDERS = Symbol.for("pi-sidebar/muted-borders");
const SGR = /\x1b\[[0-9;:]*m/g;

/**
 * Redraw a Pi editor's border lines (pi-status-footer's gauge included) in `muted()`'s color while it
 * returns one, so main's editor stops looking active while Sidebar has focus. Wraps the instance's
 * border hooks once; a later call only swaps the predicate. Editors without those hooks are left alone.
 */
export function muteEditorBorders(editor: unknown, muted: () => ((text: string) => string) | undefined): boolean {
  const e = editor as BorderedEditor | null;
  if (!e || typeof e.renderTopBorder !== "function" || typeof e.renderBottomBorder !== "function") return false;
  const installed = e[MUTED_BORDERS];
  if (installed) {
    installed.muted = muted;
    return true;
  }
  const state = { muted };
  const wrap = (render: BorderRenderer): BorderRenderer => function (this: unknown, width, hidden) {
    const line = render.call(this, width, hidden);
    const color = state.muted();
    return color ? color(line.replace(SGR, "")) : line;
  };
  e[MUTED_BORDERS] = state;
  e.renderTopBorder = wrap(e.renderTopBorder);
  e.renderBottomBorder = wrap(e.renderBottomBorder);
  return true;
}
