// The notebook view docked beside the chat. Pi's fullscreen layout root is re-rooted into
// [chat, divider, notebook] (split-layout.ts, copied from pi-sidebar), so the chat reflows into its
// half and keyboard focus moves between the halves. One right-hand slot is shared with pi-sidebar
// through the event `pi-plugins.side-panel.v1`: opening one closes the other.
import { execFile } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult, matchesKey } from "@earendil-works/pi-tui";
import type { FrameTheme } from "../frame.ts";
import { type LayoutTui, SplitLayout, canSplit, dividerLines, muteEditorBorders } from "./split-layout.ts";
import type { DockedHost, NotebookView, ViewState } from "./view.js";

export const SIDE_PANEL_CHANNEL = "pi-plugins.side-panel.v1";
export const SIDE_PANEL_ID = "pi-marimo";
export const FOCUS_KEY = "ctrl+]";
export const DEFAULT_SPLIT_RATIO = 0.55;
const HERDR_BLOCKED = "herdr:blocked";
const PROBE = "pi-marimo-split-probe";
/** The reserved keys pi-sidebar's Herdr plugin sends for prefix+h/j/k/l (pi-sidebar/src/nav.ts). */
const NAV_KEYS = { left: "ctrl+alt+shift+h", down: "ctrl+alt+shift+j", up: "ctrl+alt+shift+k", right: "ctrl+alt+shift+l" } as const;
type Direction = keyof typeof NAV_KEYS;

export type { DockedHost };
export type SplitTui = TUI & LayoutTui & { getFocusedComponent?(): Component | null };
export type MakeDockedView = (tui: SplitTui, theme: FrameTheme, key: string, host: DockedHost, close: () => void, state?: ViewState) => NotebookView;

/** A normal Herdr pane move from this pane (copied from pi-sidebar/src/nav.ts). */
function herdrFocus(direction: Direction, env: NodeJS.ProcessEnv = process.env): void {
  const pane = env.HERDR_PANE_ID;
  if (env.HERDR_ENV !== "1" || !pane) return;
  execFile(env.HERDR_BIN_PATH || "herdr", ["pane", "focus", "--direction", direction, "--pane", pane], { timeout: 5000 }, () => {});
}

/** The split's panel entry: swapping notebooks swaps `view` without remounting. */
class PanelHost implements Component {
  view: NotebookView | undefined;
  render(width: number): string[] {
    return this.view?.render(width) ?? [];
  }
  invalidate(): void {
    this.view?.invalidate?.();
  }
  handleInput(data: string): void {
    this.view?.handleInput(data);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.view?.handleMouse(event);
  }
}

export class NotebookSplit {
  private tui: SplitTui | undefined;
  private theme: FrameTheme | undefined;
  private layout: SplitLayout | undefined;
  private view: NotebookView | undefined;
  private readonly host = new PanelHost();
  private mainFocus: Component | null = null;
  private ratio = DEFAULT_SPLIT_RATIO;
  private blocked = 0;
  private prompts = 0;
  private otherPanel: string | undefined;
  /** The user closed the split since their last message: auto-docking stays away. */
  private suppressed = false;
  private release: (() => void) | undefined;

  constructor(private readonly pi: ExtensionAPI, private readonly make: MakeDockedView) {
    pi.on("ui_prompt_start" as never, (() => { this.prompts += 1; this.render(); }) as never);
    pi.on("ui_prompt_end" as never, (() => { this.prompts = Math.max(0, this.prompts - 1); this.render(); }) as never);
    pi.events?.on?.(HERDR_BLOCKED, (data: unknown) => {
      const active = (data as { active?: unknown } | undefined)?.active === true;
      this.blocked = Math.max(0, this.blocked + (active ? 1 : -1));
      this.render();
    });
    pi.events?.on?.(SIDE_PANEL_CHANNEL, (data: unknown) => {
      const d = data as { id?: unknown; open?: unknown } | undefined;
      if (typeof d?.id !== "string" || d.id === SIDE_PANEL_ID) return;
      if (d.open === true) {
        this.otherPanel = d.id;
        if (this.isOpen) this.close();
      } else if (this.otherPanel === d.id) this.otherPanel = undefined;
    });
    pi.on("input", ((e: { source?: string }) => { if (e.source === "interactive") this.suppressed = false; }) as never);
  }

  get isOpen(): boolean {
    return !!this.layout?.mounted;
  }
  get key(): string | undefined {
    return this.view?.notebook;
  }
  get collapsed(): boolean {
    return this.blocked > 0 || this.prompts > 0;
  }
  get focused(): boolean {
    return !!this.view && this.tui?.getFocusedComponent?.() === this.view;
  }
  get otherPanelOpen(): boolean {
    return !!this.otherPanel;
  }

  private render(): void {
    if (this.isOpen) this.tui?.requestRender();
  }

  private probe(ctx: ExtensionContext): SplitTui | undefined {
    let tui: SplitTui | undefined;
    try {
      ctx.ui.setWidget(PROBE, ((t: unknown, theme: FrameTheme) => {
        tui = t as SplitTui;
        this.theme = theme;
        return { render: () => [], invalidate() {} };
      }) as never);
      ctx.ui.setWidget(PROBE, undefined);
    } catch {
      return undefined;
    }
    return tui;
  }

  /** Docks `key` beside the chat (or swaps the notebook when already docked); false when it cannot. */
  open(ctx: ExtensionContext, key: string, o: { focus: boolean; state?: ViewState; quiet?: boolean }): boolean {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      if (!o.quiet) ctx.ui.notify("marimo: docking needs Pi's interactive terminal UI.", "warning");
      return false;
    }
    const tui = this.probe(ctx);
    const theme = this.theme;
    if (!tui || !theme || !canSplit(tui)) {
      if (!o.quiet) ctx.ui.notify('marimo: docking beside the chat needs Pi\'s fullscreen mode (set "tuiMode": "fullscreen" in settings).', "warning");
      return false;
    }
    if (tui !== this.tui) {
      this.close();
      this.tui = tui;
      this.layout = new SplitLayout(tui, this.host, {
        ratio: () => this.ratio,
        setRatio: (_orientation, ratio) => { this.ratio = ratio ?? DEFAULT_SPLIT_RATIO; },
        minColumns: 0,
        collapsed: () => this.collapsed,
        focused: () => this.focused,
        focusHalf: (half) => (half === "sidebar" ? this.focusView() : this.focusMain()),
        divider: (orientation, focused, width, length) => dividerLines(orientation, width, (text) => theme.fg("borderAccent", text), {
          sidebar: focused, length, pointer: (text) => theme.bold(theme.fg("accent", text)),
        }),
      });
    }
    const wasOpen = this.isOpen;
    const hadFocus = this.focused;
    const old = this.view;
    if (!wasOpen) {
      this.mainFocus = tui.getFocusedComponent?.() ?? null;
      // Before mounting, so Sidebar unmounts first.
      this.pi.events?.emit?.(SIDE_PANEL_CHANNEL, { id: SIDE_PANEL_ID, open: true });
    }
    const host: DockedHost = { focused: () => this.focused, focusMain: () => this.focusMain() };
    this.view = this.make(tui, theme, key, host, () => this.closeByUser(), o.state);
    this.host.view = this.view;
    old?.dispose();
    if (!this.layout!.mount()) {
      this.view.dispose();
      this.host.view = undefined;
      this.view = undefined;
      if (!wasOpen) this.pi.events?.emit?.(SIDE_PANEL_CHANNEL, { id: SIDE_PANEL_ID, open: false });
      return false;
    }
    if (o.focus || hadFocus) this.focusView();
    else tui.requestRender();
    return true;
  }

  /** Docks without taking focus, when nothing else holds the slot and the user has not just closed it. */
  autoOpen(ctx: ExtensionContext, key: string): void {
    if (this.isOpen || this.suppressed || this.otherPanel) return;
    this.open(ctx, key, { focus: false, quiet: true });
  }

  focusView(): void {
    const tui = this.tui;
    const view = this.view;
    if (!tui || !view || !this.isOpen) return;
    const current = tui.getFocusedComponent?.() ?? null;
    if (current && current !== view) this.mainFocus = current;
    tui.setFocus(view as never);
    // The chat's editor borders turn muted while the notebook has focus.
    muteEditorBorders(this.mainFocus, () => {
      const theme = this.theme;
      return theme && this.isOpen && this.focused && !this.collapsed ? (text) => theme.fg("borderMuted", text) : undefined;
    });
    tui.requestRender();
  }

  focusMain(): void {
    const tui = this.tui;
    if (!tui) return;
    if (this.focused && this.mainFocus) tui.setFocus(this.mainFocus as never);
    tui.requestRender();
  }

  close(): void {
    if (!this.layout || !this.layout.mounted) {
      this.view?.dispose();
      this.host.view = undefined;
      this.view = undefined;
      return;
    }
    const had = this.focused;
    this.layout.unmount();
    this.view?.dispose();
    this.host.view = undefined;
    this.view = undefined;
    if (had && this.mainFocus) this.tui?.setFocus(this.mainFocus as never);
    this.tui?.requestRender();
    this.pi.events?.emit?.(SIDE_PANEL_CHANNEL, { id: SIDE_PANEL_ID, open: false });
  }

  closeByUser(): void {
    this.suppressed = true;
    this.close();
  }

  /** The terminal-input listener: ctrl+] and Herdr's reserved prefix+h/j/k/l keys. */
  handleKey(data: string): { consume: true } | undefined {
    if (!this.isOpen || this.collapsed || !this.tui) return undefined;
    if (matchesKey(data, FOCUS_KEY as never)) {
      if (this.focused) {
        this.focusMain();
        return { consume: true };
      }
      if (this.tui.getFocusedComponent?.() === this.mainFocus) {
        this.focusView();
        return { consume: true };
      }
      return undefined;
    }
    const direction = (Object.keys(NAV_KEYS) as Direction[]).find((d) => matchesKey(data, NAV_KEYS[d] as never));
    if (!direction) return undefined;
    if (this.focused) {
      if (direction === "left") this.focusMain();
      else herdrFocus(direction);
    } else if (direction === "right") this.focusView();
    else herdrFocus(direction);
    return { consume: true };
  }

  listen(ctx: ExtensionContext): void {
    this.release?.();
    this.release = undefined;
    if (ctx.mode === "tui" && typeof ctx.ui.onTerminalInput === "function") {
      this.release = ctx.ui.onTerminalInput((data) => this.handleKey(data));
    }
  }

  shutdown(): void {
    this.close();
    this.release?.();
    this.release = undefined;
    this.blocked = 0;
    this.prompts = 0;
    this.otherPanel = undefined;
    this.suppressed = false;
    this.tui = undefined;
    this.layout = undefined;
  }
}
