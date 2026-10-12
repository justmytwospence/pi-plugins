// The pill under the prompt, Claude Code's background-tasks indicator: `2 shells`, plus
// `1 failed` in the error color while a failure is unseen. `↓` at the bottom of the prompt (or `j`
// in pi-vim's normal mode) selects it, even with a draft in the prompt; Enter, `l` or a click opens
// the background-tasks view; Esc, `↑`, `k` or `h` goes back to the prompt.
// With pi-subagents installed it draws nothing: pi-subagents' list under the prompt ends with the
// same pill (activity.ts).
import { type TUI, type TuiMouseEvent, type TuiMouseEventResult, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type ActivityPill, focusedComponent, leavesPromptDown, mainEditorFocused, readEditorMode } from "./activity.ts";

const KEY = "pi-bg-pill";

export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  inverse?(text: string): string;
}

/** The pill's line(s): the label (inverse when selected), and a key hint while selected. */
export function renderPill(pill: ActivityPill | undefined, selected: boolean, width: number, theme: Theme): string[] {
  if (!pill) return [];
  const inverse = (s: string) => (theme.inverse ? theme.inverse(s) : `\x1b[7m${s}\x1b[27m`);
  const label = selected ? inverse(` ${pill.label} `) : theme.fg("muted", ` ${pill.label} `);
  const alert = pill.alert ? `${theme.fg("dim", "·")} ${theme.fg("error", pill.alert)}` : "";
  const hint = selected ? theme.fg("dim", "  enter view · esc back") : "";
  return [truncateToWidth(`${label}${alert ? ` ${alert}` : ""}${hint}`, width)];
}

export interface PillUI {
  setWidget(
    key: string,
    content: ((tui: TUI, theme: any) => { render(width: number): string[]; invalidate(): void; handleMouse?(e: TuiMouseEvent): TuiMouseEventResult | undefined }) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  readonly theme?: Theme;
}

export interface PillSource {
  pill(now: number): ActivityPill | undefined;
  /** Enter or a click: open the dialog. */
  open(): void;
}

type KeyResult = { consume?: boolean; data?: string } | undefined;

export class PillView {
  private ui: PillUI | undefined;
  private tui: TUI | undefined;
  private registered = false;
  private selected = false;
  private unsubscribe: (() => void) | undefined;
  private generation = 0;

  constructor(private readonly source: PillSource) {}

  /** Bind to a session's UI, or to none (outside the TUI, or while another extension hosts the pill). */
  setUI(ui: PillUI | undefined): void {
    if (ui === this.ui) return;
    this.dispose();
    const generation = this.generation;
    this.ui = ui;
    if (ui) this.unsubscribe = ui.onTerminalInput((data) => generation === this.generation ? this.handleKey(data) : undefined);
  }

  update(): void {
    const ui = this.ui;
    if (!ui) return;
    const generation = this.generation;
    if (!this.source.pill(Date.now())) {
      this.hide();
      return;
    }
    if (this.registered) {
      this.tui?.requestRender();
      return;
    }
    ui.setWidget(
      KEY,
      (tui, factoryTheme: Theme) => {
        if (generation === this.generation) this.tui = tui;
        return {
          render: (width: number) => generation === this.generation ? renderPill(this.source.pill(Date.now()), this.selected, width, ui.theme ?? factoryTheme) : [],
          handleMouse: (e: TuiMouseEvent): TuiMouseEventResult | undefined => {
            if (generation !== this.generation || e.button !== "left") return undefined;
            // pi turns a press and release into a click only for the component that took the press.
            if (e.type === "press") return { handled: true, render: false };
            if (e.type !== "click") return undefined;
            this.selected = false;
            this.source.open();
            return { handled: true };
          },
          invalidate: () => undefined,
        };
      },
      { placement: "belowEditor" },
    );
    this.registered = true;
  }

  /** `{ consume: true }` for the keys the pill takes; undefined lets a key through. */
  handleKey(data: string): KeyResult {
    if (!this.ui || !this.registered || isKeyRelease(data)) return undefined;
    if (!this.editorFocused()) {
      this.deselect();
      return undefined;
    }
    if (!this.selected) {
      const focused = this.focused();
      // Without a view of the editor, only an empty prompt is safe to leave.
      const down = focused ? leavesPromptDown(focused, data, matchesKey(data, "down"), data === "j") : matchesKey(data, "down") && this.ui.getEditorText() === "";
      if (down) {
        this.selected = true;
        this.tui?.requestRender();
        return { consume: true };
      }
      return undefined;
    }
    const modal = readEditorMode(this.focused());
    const navigation = ["enter", "escape", "up", "down", "left", "right"].some((key) => matchesKey(data, key as never));
    if ((modal && (modal.autocomplete || (modal.state !== "normal" && modal.state !== "insert"))) || (modal?.state !== "normal" && !navigation)) {
      this.deselect();
      return undefined;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "l") || matchesKey(data, "right")) {
      this.deselect();
      this.source.open();
      return { consume: true };
    }
    if (matchesKey(data, "escape") || matchesKey(data, "up") || matchesKey(data, "k") || matchesKey(data, "h") || matchesKey(data, "left")) {
      this.deselect();
      return { consume: true };
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) return { consume: true };
    // Anything else goes back to the editor.
    this.deselect();
    return undefined;
  }

  get isSelected(): boolean {
    return this.selected;
  }

  private deselect(): void {
    if (!this.selected) return;
    this.selected = false;
    this.tui?.requestRender();
  }

  private focused(): unknown {
    return focusedComponent(this.tui);
  }

  /** Whether the main prompt has the keyboard (activity.ts: the component's reported context, else pi's editor shape). */
  private editorFocused(): boolean {
    return mainEditorFocused(this.focused());
  }

  private hide(): void {
    const registered = this.registered;
    this.selected = false;
    this.registered = false;
    this.tui = undefined;
    if (registered) this.ui?.setWidget(KEY, undefined);
  }

  dispose(): void {
    const ui = this.ui;
    const registered = this.registered;
    const unsubscribe = this.unsubscribe;
    // Forget all session-bound state before touching a possibly invalidated UI.
    this.generation++;
    this.ui = undefined;
    this.unsubscribe = undefined;
    this.selected = false;
    this.registered = false;
    this.tui = undefined;
    try {
      if (registered) ui?.setWidget(KEY, undefined);
    } finally {
      unsubscribe?.();
    }
  }
}
