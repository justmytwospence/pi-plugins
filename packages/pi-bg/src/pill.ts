// The pill under the prompt, Claude Code's background-tasks indicator: `2 tasks` (pi-bg) or
// `1 notebook` (pi-marimo), plus `1 failed` in the error color while a failure is unseen. A pill may
// carry rows (pi-marimo's notebooks, one each) listed above its label. `↓` at the bottom of the
// prompt (or `j` in pi-vim's normal mode) selects the first row, even with a draft in the prompt;
// `↓`/`↑`, `j`/`k` or Tab move through the rows and the label; Enter, `l` or a click opens the
// selected one (a row's own view, or the source's dialog); `x` twice stops a running row that can
// be stopped; Esc, `h`, or `↑` past the first goes back to the prompt.
// It is drawn only while no host shows the source's pill (activity.ts): pi-subagents' list under the
// prompt, or pi-bg's pill for pi-marimo.
// pi-marimo (its own repository, justmytwospence/pi-marimo) keeps an identical copy as src/pill.ts; change it in both.
import { type TUI, type TuiMouseEvent, type TuiMouseEventResult, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ActivityEntry, type ActivityPill, captureMainEditor, focusedComponent, leavesPromptDown, mainEditorFocused, readEditorMode } from "./activity.ts";

export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  inverse?(text: string): string;
  bg?(color: string, text: string): string;
}

/** Which slot of a pill is selected (rows first, then the label line) and which row `x` has armed. */
export interface PillSelection {
  index: number;
  /** The stop key of the row `x` was pressed on once. */
  armed?: string | undefined;
}

/** A row's identity for `x`: its key and the target it would stop (a changed target cancels the arming). */
export const rowStopKey = (row: ActivityEntry): string => `${row.key}\0${row.stopToken ?? ""}`;

/** The slots a pill offers, in order: its rows, then its label line when it has one. */
export function pillSlots(pill: ActivityPill | undefined): Array<{ kind: "row"; row: ActivityEntry } | { kind: "label" }> {
  if (!pill) return [];
  return [...(pill.rows ?? []).map((row) => ({ kind: "row" as const, row })), ...(pill.label || pill.alert ? [{ kind: "label" as const }] : [])];
}

/** The selection mark of every list under the prompt, the tasks dialog and the subagents list: a filled dot for the selected row, a hollow one for the rest. */
export const bullet = (selected: boolean, theme: Theme): string => (selected ? theme.fg("accent", "●") : theme.fg("dim", "○"));

/** What an ended row says about how it ended, before its stats: `✗` failed, `■` stopped; running and done rows say nothing. */
export function endMark(status: ActivityEntry["status"], theme: Theme): string {
  return status === "failed" ? theme.fg("error", "✗") : status === "stopped" ? theme.fg("warning", "■") : "";
}

/** One row: ` ○ fit.py  :2718 · idle                         ✗ 2:14`, the dot filled and the name bold while selected. */
function renderRow(row: ActivityEntry, selected: boolean, width: number, theme: Theme): string {
  // A source's own styled line (pi-marimo's notebooks) is drawn as it is.
  const body = row.line ? row.line(theme) : `${selected ? theme.bold(theme.fg("text", row.label)) : theme.fg("muted", row.label)}${row.detail ? `  ${theme.fg("dim", row.detail)}` : ""}`;
  const left = ` ${bullet(selected, theme)} ${body}`;
  const stats = row.line || !row.stats ? "" : theme.fg(selected ? "text" : "dim", row.stats);
  const right = [endMark(row.status, theme), stats].filter(Boolean).join(" ");
  if (!right) return truncateToWidth(left, width);
  // The right side (how it ended, its stats) is kept; the name gives way.
  const room = Math.max(8, width - visibleWidth(right) - 1);
  const fitted = truncateToWidth(left, room);
  return truncateToWidth(`${fitted}${" ".repeat(Math.max(1, width - visibleWidth(fitted) - visibleWidth(right)))}${right}`, width);
}

/** The pill's lines: its rows, the label line (a filled dot when selected, with a key hint), and `x again to stop` under the rows while one is armed. */
export function renderPill(pill: ActivityPill | undefined, selected: boolean | PillSelection, width: number, theme: Theme, stoppableRow: (row: ActivityEntry) => boolean = () => false): string[] {
  if (!pill) return [];
  const slots = pillSlots(pill);
  const sel: PillSelection | undefined = selected === true ? { index: Math.max(0, slots.length - 1) } : selected === false ? undefined : selected;
  const lines: string[] = [];
  slots.forEach((slot, i) => {
    if (slot.kind === "row") {
      lines.push(renderRow(slot.row, sel?.index === i, width, theme));
      return;
    }
    const on = sel?.index === i;
    const label = on ? theme.bold(theme.fg("text", pill.label)) : theme.fg("muted", pill.label);
    const alert = pill.alert ? `${theme.fg("dim", "·")} ${theme.fg("error", pill.alert)}` : "";
    const hint = on ? theme.fg("dim", "  enter view · esc back") : "";
    lines.push(truncateToWidth(` ${bullet(on, theme)} ${label}${alert ? ` ${alert}` : ""}${hint}`, width));
  });
  // The only line under the rows is the confirmation `x` asks for.
  const at = sel ? slots[sel.index] : undefined;
  if (at?.kind === "row" && sel!.armed === rowStopKey(at.row)) lines.push(truncateToWidth(theme.fg("error", "   x again to stop"), width));
  return lines;
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
  /** Enter or a click on the label: open the dialog. */
  open(): void | Promise<unknown>;
  /** Enter or a click on a row: open that row's view. The selection returns to the row when the promise settles. */
  openRow?(key: string): void | Promise<unknown>;
  /** `x` twice on a running row. */
  stopRow?(key: string): void | Promise<void>;
  /** Whether `x` applies to this row now; without it, none does. */
  canStopRow?(row: ActivityEntry): boolean;
}

type KeyResult = { consume?: boolean; data?: string } | undefined;

export class PillView {
  private ui: PillUI | undefined;
  private tui: TUI | undefined;
  private main: unknown;
  /** Hosting toggles detach the pill, not the session's main editor. Never replace a UI's owner. */
  private readonly mains = new WeakMap<PillUI, unknown>();
  private registered = false;
  private selected = false;
  /** The selected slot (pillSlots) and the row `x` has armed. */
  private index = 0;
  private armed: string | undefined;
  private unsubscribe: (() => void) | undefined;
  private generation = 0;

  private readonly source: PillSource;
  /** Widget key, e.g. `pi-bg-pill`. */
  private readonly key: string;

  constructor(source: PillSource, key: string) {
    this.source = source;
    this.key = key;
  }

  /** Bind to a session's UI, or to none (outside the TUI, or while another extension hosts the pill). */
  setUI(ui: PillUI | undefined): void {
    if (ui === this.ui) return;
    this.dispose();
    const generation = this.generation;
    this.ui = ui;
    if (!ui) return;
    // Acquire focus independently of the visible pill: it may have no work yet, or have just
    // returned from Fleet hosting. Never learn a new owner from a later widget render.
    const probe = `${this.key}-probe`;
    let probing = true;
    try {
      ui.setWidget(probe, (tui) => {
        if (probing && generation === this.generation) {
          this.tui = tui;
          if (!this.mains.has(ui)) this.mains.set(ui, captureMainEditor(focusedComponent(tui)));
          this.main = this.mains.get(ui);
        }
        return { render: () => [], invalidate: () => undefined };
      });
    } finally {
      probing = false;
      ui.setWidget(probe, undefined);
    }
    this.unsubscribe = ui.onTerminalInput((data) => generation === this.generation ? this.handleKey(data) : undefined);
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
      this.key,
      (_tui, factoryTheme: Theme) => {
        return {
          render: (width: number) => {
            if (generation !== this.generation) return [];
            const pill = this.source.pill(Date.now());
            this.clamp(pill);
            return renderPill(pill, this.selected ? { index: this.index, armed: this.armed } : false, width, ui.theme ?? factoryTheme, (row) => this.source.canStopRow?.(row) === true);
          },
          handleMouse: (e: TuiMouseEvent): TuiMouseEventResult | undefined => {
            if (generation !== this.generation || e.button !== "left") return undefined;
            // pi turns a press and release into a click only for the component that took the press.
            if (e.type === "press") return { handled: true, render: false };
            if (e.type !== "click") return undefined;
            const slot = pillSlots(this.source.pill(Date.now()))[e.y];
            const index = e.y;
            this.deselect();
            this.openSlot(slot, index);
            return { handled: true };
          },
          invalidate: () => undefined,
        };
      },
      { placement: "belowEditor" },
    );
    this.registered = true;
  }

  /** Optional select-nav routing; a selected single pill stays selected on Tab. */
  tab(activeOnly = false): boolean {
    if (activeOnly && !this.selected) return false;
    return this.handleKey("\t", true)?.consume === true;
  }

  /** `{ consume: true }` for the keys the pill takes; undefined lets a key through. */
  handleKey(data: string, enterWithTab = false): KeyResult {
    if (!this.ui || !this.registered || isKeyRelease(data)) return undefined;
    if (!this.editorFocused()) {
      this.deselect();
      return undefined;
    }
    if (!this.selected) {
      const focused = this.focused();
      const down = leavesPromptDown(focused, data, matchesKey(data, "down"), data === "j");
      const mode = readEditorMode(focused);
      const tab = enterWithTab && matchesKey(data, "tab") && !mode?.autocomplete
        && !(focused as { isShowingAutocomplete?: () => boolean } | undefined)?.isShowingAutocomplete?.()
        && (!mode || mode.state === "normal" || mode.state === "insert");
      if (down || tab) {
        this.selected = true;
        this.index = 0;
        this.armed = undefined;
        this.tui?.requestRender();
        return { consume: true };
      }
      return undefined;
    }
    const modal = readEditorMode(this.focused());
    const navigation = ["enter", "escape", "up", "down", "left", "right", "tab"].some((key) => matchesKey(data, key as never));
    if ((modal && (modal.autocomplete || (modal.state !== "normal" && modal.state !== "insert"))) || (modal?.state !== "normal" && !navigation)) {
      this.deselect();
      return undefined;
    }
    const pill = this.source.pill(Date.now());
    const slots = pillSlots(pill);
    this.clamp(pill);
    const at = slots[this.index];
    if (matchesKey(data, "enter") || matchesKey(data, "l") || matchesKey(data, "right")) {
      const index = this.index;
      this.deselect();
      this.openSlot(at, index);
      return { consume: true };
    }
    if (matchesKey(data, "escape") || matchesKey(data, "h") || matchesKey(data, "left")) {
      this.deselect();
      return { consume: true };
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.armed = undefined;
      if (this.index > 0) this.index--;
      else this.deselect();
      this.tui?.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "down") || matchesKey(data, "j") || matchesKey(data, "tab")) {
      this.armed = undefined;
      // Tab wraps; the arrows stop at the last slot.
      this.index = matchesKey(data, "tab") ? (this.index + 1) % Math.max(1, slots.length) : Math.min(this.index + 1, Math.max(0, slots.length - 1));
      this.tui?.requestRender();
      return { consume: true };
    }
    if (data === "x" && at?.kind === "row" && this.source.canStopRow?.(at.row) === true && this.source.stopRow) {
      const key = rowStopKey(at.row);
      if (this.armed !== key) this.armed = key;
      else {
        this.armed = undefined;
        void Promise.resolve(this.source.stopRow(at.row.key)).catch(() => undefined);
      }
      this.tui?.requestRender();
      return { consume: true };
    }
    // Anything else goes back to the editor.
    this.deselect();
    return undefined;
  }

  get isSelected(): boolean {
    return this.selected;
  }

  /** Keep the selection on a slot that exists, and drop an arming whose row is gone or changed. */
  private clamp(pill: ActivityPill | undefined): void {
    const slots = pillSlots(pill);
    this.index = Math.max(0, Math.min(this.index, slots.length - 1));
    const at = slots[this.index];
    if (this.armed !== undefined && !(at?.kind === "row" && rowStopKey(at.row) === this.armed)) this.armed = undefined;
  }

  /** Opens a slot's view; when it closes, the selection comes back to the slot that was open, like going back in a list. */
  private openSlot(slot: ReturnType<typeof pillSlots>[number] | undefined, index: number): void {
    if (!slot) return;
    const generation = this.generation;
    let result: void | Promise<unknown>;
    try {
      result = slot.kind === "row" ? this.source.openRow?.(slot.row.key) : this.source.open();
    } catch {
      return;
    }
    if (!result || typeof (result as Promise<unknown>).then !== "function") return;
    const back = () => {
      if (generation !== this.generation || !this.ui || !this.registered || this.selected || !this.editorFocused()) return;
      this.selected = true;
      this.index = index;
      this.armed = undefined;
      this.clamp(this.source.pill(Date.now()));
      this.tui?.requestRender();
    };
    (result as Promise<unknown>).then(back, back);
  }

  private deselect(): void {
    if (!this.selected) return;
    this.selected = false;
    this.armed = undefined;
    this.tui?.requestRender();
  }

  private focused(): unknown {
    return focusedComponent(this.tui);
  }

  /** Only the explicit main surface or this binding's captured main may yield navigation. */
  private editorFocused(): boolean {
    return mainEditorFocused(this.focused(), this.main);
  }

  private hide(): void {
    const registered = this.registered;
    this.selected = false;
    this.armed = undefined;
    this.registered = false;
    if (registered) this.ui?.setWidget(this.key, undefined);
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
    this.armed = undefined;
    this.registered = false;
    this.tui = undefined;
    this.main = undefined;
    try {
      if (registered) ui?.setWidget(this.key, undefined);
    } finally {
      unsubscribe?.();
    }
  }
}
