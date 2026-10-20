// Puts Sidebar next to main inside Pi's fullscreen layout. Pi draws one layout root (its transcript
// and the editor dock); Sidebar re-roots it into a stack of [main, divider, Sidebar], so main reflows
// into its half instead of being covered. The stack is beside main when both halves keep enough
// columns, and below otherwise, re-decided on every frame from the viewport. While another
// extension holds `herdr:blocked` (a dialog waits on the user), Sidebar collapses so the dialog
// renders full width as herdr-web-ui's phone parser expects.
//
// Pi does not publish its layout root; the suite reads it the same way in pi-clear-screen, pi-copy,
// pi-sticky-last-prompt and plan mode. Anything unexpected leaves Pi's layout untouched.
import { HStack, type Component } from "@earendil-works/pi-tui";
import { orientationFor, splitSizes, type Orientation } from "./config.ts";

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
  ratio: number;
  minColumns: number;
  /** Sidebar hidden but the split kept (a dialog holds `herdr:blocked`). */
  collapsed(): boolean;
  /** Whether Sidebar has focus, for the divider's color. */
  focused(): boolean;
  divider(orientation: Orientation, focused: boolean, width: number): string[];
}

type MutableEntry = { component: Component; basis?: number | "auto"; grow?: number; shrink?: number; minSize?: number; visible?: (v: { width: number; height: number }) => boolean };

/** The divider: a full-height rule beside main, or a full-width rule below it. */
class Divider implements Component {
  orientation: Orientation = "right";
  constructor(private readonly settings: SplitSettings) {}
  render(width: number): string[] {
    return this.settings.divider(this.orientation, this.settings.focused(), width);
  }
  invalidate(): void {}
}

/**
 * The re-rooted layout. Stack entries are sized on every frame from the viewport the layout passes to
 * `visible`; a change of orientation applies from the next frame.
 */
export class SplitRoot extends HStack {
  orientation: Orientation = "right";
  private readonly divider: Divider;

  constructor(readonly main: Component, readonly panel: Component, private readonly settings: SplitSettings, private readonly requestRender: () => void) {
    const divider = new Divider(settings);
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
      return;
    }
    const sizes = splitSizes(total, this.settings.ratio);
    Object.assign(entries[0]!, { basis: sizes.main, grow: 0, shrink: 0, minSize: 1 });
    Object.assign(entries[1]!, { basis: sizes.divider, grow: 0, shrink: 0, minSize: 1 });
    Object.assign(entries[2]!, { basis: sizes.side, grow: 0, shrink: 0, minSize: 1 });
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
