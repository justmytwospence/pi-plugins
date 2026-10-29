// FleetView: Claude Code's panel below the prompt. `main` and the subagents (running, plus failed
// or stopped ones until the user's next message or `x`), then the pills other extensions offer
// (pi-bg's `2 tasks`). A run that succeeds leaves at once, and a dim `/tasks to see subagents`
// (or `/subagents ...` without pi-bg) shows for 30 s, as in Claude Code.
// ↓ at the bottom of the prompt (even with a draft in it), `j` in pi-vim's normal mode there, or ←
// at an empty prompt moves into it; ↑/↓ or k/j select; Tab and Ctrl+J/Ctrl+K cycle through main too; Enter or l opens the selected run's
// conversation viewer (Esc there comes back here) or the pill's dialog; x twice stops the selected
// run, x on an ended run dismisses it; b moves a foreground run to the background; Esc, h, or ↑/k
// past the first row, returns to the prompt. A run whose viewer is open stays until it closes.
// Keys go through `onTerminalInput` before the editor. Letter shortcuts require positively
// identified idle Normal mode; native and Insert editors keep their text/edit keys. A modal state
// change, autocomplete or another focused surface releases the virtual selection immediately.
// Adapted from tintinweb/pi-subagents (MIT): https://github.com/tintinweb/pi-subagents
import { type TUI, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type ActivityEntry, type ActivityPill, type ActivitySection, focusedComponent, leavesPromptDown, mainEditorFocused, readEditorMode, stoppable as rowStoppable } from "../activity.ts";
import type { Run } from "../run.ts";
import { runLabel } from "../label.ts";
import { displayTokens } from "../run.ts";
import { type Theme, dimAll, elapsedMs, formatCost, formatCount, formatElapsed, jev, modelAndEffort, rightAlign, statusIcon, taskRows } from "./format.ts";
import { type SessionSource, type ViewerActions, type ViewerUI, openViewer } from "./viewer.ts";

const FLEET_KEY = "subagents-fleet";
/** Subagent rows shown at once; the rest scroll. */
const MAX_ROWS = 5;
const TICK_MS = 250;
/** How long the hint after a subagent succeeds stays, as in Claude Code. */
export const SUCCESS_HINT_MS = 30_000;

export type FleetEntry =
  | { kind: "main" }
  | { kind: "run"; run: Run }
  | { kind: "pill"; section: ActivitySection; pill: ActivityPill }
  /** One of a pill's rows (pi-marimo's notebooks), selected and opened like a run. */
  | { kind: "row"; section: ActivitySection; row: ActivityEntry };

/** What a stop on this entry would act on: a run's session, a row's stop token. A change cancels the arming. */
const targetOf = (e: FleetEntry | undefined): unknown => (e?.kind === "run" ? (e.run.child ?? e.run) : e?.kind === "row" ? (e.row.stopToken ?? "") : undefined);

const entryKey = (e: FleetEntry) => (e.kind === "run" ? `run:${e.run.id}` : e.kind === "pill" ? `pill:${e.section.id}` : e.kind === "row" ? `row:${e.section.id}\0${e.row.key}` : "main");

/** A failed or stopped run the user has not seen yet: it ended after their last message and is not dismissed. */
export function held(run: Run, dismissedAt: number, dismissed: ReadonlySet<string>): boolean {
  const s = run.state;
  return s.status !== "running" && s.status !== "done" && s.endedAt !== undefined && s.endedAt > dismissedAt && !dismissed.has(run.id);
}

/**
 * `main` and the runs worth listing (running, being viewed, or failed or stopped and unseen),
 * earliest first, then each section's pill. Without runs there is no `main` row, only the pills.
 */
export function fleetRoster(
  runs: readonly Run[],
  now: number,
  viewing?: string,
  sections: readonly ActivitySection[] = [],
  dismissedAt = Number.POSITIVE_INFINITY,
  dismissed: ReadonlySet<string> = new Set(),
): FleetEntry[] {
  const listed = runs
    .filter((r) => r.state.status === "running" || `run:${r.id}` === viewing || held(r, dismissedAt, dismissed))
    .sort((a, b) => a.state.startedAt - b.state.startedAt);
  const pills = sections.flatMap((section) => {
    let pill: ActivityPill | undefined;
    try {
      pill = section.pill?.(now);
    } catch {
      // Another extension's bug must not break the list.
    }
    if (!pill) return [];
    const rows = (pill.rows ?? []).map((row) => ({ kind: "row" as const, section, row }));
    // A pill with no label of its own (its rows say it all) is only its rows.
    return [...rows, ...(pill.label || pill.alert ? [{ kind: "pill" as const, section, pill }] : [])];
  });
  return [...(listed.length ? [{ kind: "main" as const }] : []), ...listed.map((run) => ({ kind: "run" as const, run })), ...pills];
}

export interface FleetFrame {
  roster: readonly FleetEntry[];
  /** Index into the roster. */
  selected: number;
  /** The session shown now (in a subagent's session view), marked even while the list is inactive. */
  current?: number;
  active: boolean;
  /** The selected run is one `x` away from being stopped. */
  stopArmed?: boolean;
  /** The selected run is in the foreground and can be moved to the background. */
  canBackground?: boolean;
  /** Letter shortcuts belong only to positively identified idle Normal mode. */
  normalKeys?: boolean;
  /** A dim line under the list: `/tasks to see subagents`. */
  note?: string;
  now: number;
  width: number;
  theme: Theme & { inverse?(text: string): string };
}

export function renderFleet({ roster, selected, current, active, stopArmed, canBackground, normalKeys = true, note, now, width, theme }: FleetFrame): string[] {
  if (!roster.length && !note) return [];
  const lines: string[] = [];
  const runs = roster.flatMap((e) => (e.kind === "run" ? [e.run] : []));
  const pills = roster.flatMap((e, i) => (e.kind === "pill" || e.kind === "row" ? [{ e, i }] : []));
  const sel = Math.min(selected, Math.max(0, roster.length - 1));
  const chosen = active ? roster[sel] : undefined;
  const bullet = (i: number) => (active && i === sel ? theme.fg("accent", "●") : i === current ? theme.fg("text", "◉") : theme.fg("dim", "○"));
  if (runs.length) {
    const stoppable = normalKeys && chosen?.kind === "run" && chosen.run.state.status === "running";
    const dismissable = normalKeys && chosen?.kind === "run" && chosen.run.state.status !== "running";
    const hint = !active
      ? undefined
      : stopArmed && stoppable
        ? theme.fg("error", `x again to stop ${runLabel(chosen.run)}`)
        : chosen?.kind === "pill" || chosen?.kind === "row"
          ? theme.fg("dim", `${normalKeys ? "j/k select · l/enter view" : "↑/↓ select · enter view"}${chosen.kind === "row" && rowStoppable(chosen.section, chosen.row) && normalKeys ? " · x stop" : ""} · ${normalKeys ? "h/esc" : "esc"} back`)
          : theme.fg(
              "dim",
              `${normalKeys ? "j/k select · l/enter view" : "↑/↓ select · enter view"}${stoppable ? " · x stop" : ""}${dismissable ? " · x dismiss" : ""}${stoppable && canBackground ? " · b background" : ""} · ${normalKeys ? "h/esc" : "esc"} back`,
            );
    if (hint !== undefined) lines.push(truncateToWidth(` ${hint}`, width));
    // Bold for the selected row and for the session shown now, as for the runs below.
    const mainOn = (active && sel === 0) || current === 0;
    lines.push(truncateToWidth(` ${bullet(0)} ${mainOn ? theme.bold(theme.fg("text", "main")) : theme.fg("muted", "main")}`, width));
    // Runs are roster rows 1..runs.length; scroll so the selected one shows.
    const visible = Math.min(MAX_ROWS, runs.length);
    const selRun = chosen?.kind === "run" ? sel - 1 : current !== undefined && roster[current]?.kind === "run" ? current - 1 : 0;
    const start = selRun < visible ? 0 : selRun - visible + 1;
    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let i = start; i < start + visible; i++) {
      const run = runs[i];
      if (!run) continue;
      const on = (active && i + 1 === sel) || i + 1 === current;
      const prefix = ` ${bullet(i + 1)} `;
      const identity = `${on ? theme.bold(theme.fg("text", runLabel(run))) : theme.fg("muted", runLabel(run))}  ${theme.fg("dim", run.agent)}${jev(run.byJev.agent, theme)}  ${dimAll(modelAndEffort(run, theme), theme)}`;
      const cost = formatCost(run.state.usage.cost.total);
      const stats = `${formatElapsed(elapsedMs(run, now))} · ↓ ${formatCount(displayTokens(run.state.usage))} tokens${cost ? ` · ${cost}` : ""}`;
      const done = run.state.status === "running" ? "" : `${statusIcon(run.state.status, theme)} `;
      lines.push(...taskRows(prefix, identity, done + theme.fg(on ? "text" : "dim", stats), width, true));
    }
    const below = runs.length - (start + visible);
    if (below > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${below} more`), width));
  }
  // With no runs, the hint for a selected row (a notebook) tops the list, where the runs' hint would be.
  if (!runs.length && chosen?.kind === "row") {
    const canStop = normalKeys && rowStoppable(chosen.section, chosen.row);
    lines.push(truncateToWidth(` ${stopArmed && canStop ? theme.fg("error", "x again to stop") : theme.fg("dim", `${normalKeys ? "j/k select · l/enter view" : "↑/↓ select · enter view"}${canStop ? " · x stop" : ""} · ${normalKeys ? "h/esc" : "esc"} back`)}`, width));
  }
  // The pills: Claude Code's background-tasks indicator, inverse while selected.
  const inverse = (s: string) => (theme.inverse ? theme.inverse(s) : `\x1b[7m${s}\x1b[27m`);
  for (const { e, i } of pills) {
    if (e.kind === "row") {
      const on = active && i === sel;
      const armed = on && stopArmed;
      const icon = e.row.status === "running" ? theme.fg("accent", "●") : e.row.status === "failed" ? theme.fg("error", "✗") : e.row.status === "stopped" ? theme.fg("warning", "■") : theme.fg("dim", "○");
      const name = on ? theme.bold(theme.fg("text", e.row.label)) : theme.fg("muted", e.row.label);
      const cursor = `${active && i === sel ? theme.fg("accent", "›") : " "}${icon} `;
      if (e.row.line) lines.push(truncateToWidth(`${cursor}${e.row.line(theme)}${armed ? `  ${theme.fg("error", "x again to stop")}` : ""}`, width));
      else lines.push(...taskRows(cursor, `${name}${e.row.detail ? `  ${theme.fg("dim", e.row.detail)}` : ""}`, theme.fg(on ? "text" : "dim", armed ? "x again to stop" : e.row.stats), width, true));
      continue;
    }
    if (e.kind !== "pill") continue;
    const on = active && i === sel;
    const label = on ? inverse(` ${e.pill.label} `) : theme.fg("muted", ` ${e.pill.label} `);
    const alert = e.pill.alert ? ` ${theme.fg("dim", "·")} ${theme.fg("error", e.pill.alert)}` : "";
    const hint = on && !runs.length && !pills.some((p) => p.e.kind === "row") ? theme.fg("dim", normalKeys ? "  l/enter view · h/esc back" : "  enter view · esc back") : "";
    lines.push(truncateToWidth(`${label}${alert}${hint}`, width));
  }
  if (note) lines.push(truncateToWidth(` ${theme.fg("dim", note)}`, width));
  // Pi puts the footer right under below-editor widgets.
  lines.push("");
  return lines;
}

/** The part of `ctx.ui` FleetView uses. */
export interface FleetUI extends ViewerUI {
  setWidget(key: string, content: ((tui: TUI, theme: any) => { render(width: number): string[]; invalidate(): void }) | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  readonly theme?: Theme;
}

export interface FleetSource extends Omit<SessionSource, "onSwitch"> {
  runs(): readonly Run[];
  enabled(): boolean;
  actions(run: Run): ViewerActions;
  /** Other extensions' sources whose pills end the list (pi-bg). */
  sections?(): readonly ActivitySection[];
  /** When the user last sent a message: failed and stopped runs that ended before it leave the list. */
  dismissedAt?(): number;
  /** Runs dismissed with `x`. */
  dismissed?(): ReadonlySet<string>;
  dismiss?(runId: string): void | Promise<void>;
  /** The dim line under the list, if any (`/tasks to see subagents` after a success). */
  note?(now: number): string | undefined;
}

type KeyResult = { consume?: boolean; data?: string } | undefined;

export class FleetView {
  private ui: FleetUI | undefined;
  private tui: TUI | undefined;
  private unsubscribeInput: (() => void) | undefined;
  private registered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = false;
  private selectedMode: string | undefined;
  private selected = 0;
  /** The selected row by identity, so rows coming and going do not move the selection. */
  private selectedKey: string | undefined;
  /** The row one `x` away from being stopped. */
  private armedKey: string | undefined;
  /** Confirmation belongs to the exact live child, not just its stable row id. */
  private armedTarget: unknown;
  private viewing: string | undefined;
  private stopArmed = false;
  private closeViewer: (() => void) | undefined;

  constructor(private readonly source: FleetSource) {}

  setUI(ui: FleetUI): void {
    if (ui === this.ui) return;
    this.unsubscribeInput?.();
    this.ui = ui;
    this.registered = false;
    this.tui = undefined;
    this.unsubscribeInput = ui.onTerminalInput((data) => this.handleKey(data));
  }

  private roster() {
    return fleetRoster(this.source.runs(), Date.now(), this.viewing, this.source.sections?.() ?? [], this.source.dismissedAt?.(), this.source.dismissed?.());
  }

  /** The first row ↓ selects: the first run, or the first pill when there are no runs. */
  private firstRow(roster: readonly FleetEntry[]): number {
    return roster[0]?.kind === "main" ? 1 : 0;
  }

  /** Follows the selected row to where it is now, or clamps when it left. */
  private reselect(roster: readonly FleetEntry[]): void {
    const at = this.selectedKey ? roster.findIndex((e) => entryKey(e) === this.selectedKey) : -1;
    this.selected = at >= 0 ? at : Math.min(this.selected, Math.max(0, roster.length - 1));
    this.selectedKey = roster[this.selected] ? entryKey(roster[this.selected] as FleetEntry) : undefined;
  }

  private select(roster: readonly FleetEntry[], index: number): void {
    this.selected = index;
    this.selectedKey = roster[index] ? entryKey(roster[index] as FleetEntry) : undefined;
  }

  update(): void {
    if (!this.ui) return;
    const roster = this.roster();
    const note = this.source.note?.(Date.now());
    if (!this.source.enabled() || (!roster.length && !note)) {
      if (this.registered) this.ui.setWidget(FLEET_KEY, undefined);
      this.registered = false;
      this.tui = undefined;
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.active = false;
      this.selected = 0;
      return;
    }
    this.reselect(roster);
    if (!roster.length) this.active = false;
    if (!this.timer) {
      this.timer = setInterval(() => this.update(), TICK_MS);
      this.timer.unref?.();
    }
    if (this.registered) {
      this.tui?.requestRender();
      return;
    }
    const ui = this.ui;
    ui.setWidget(
      FLEET_KEY,
      (tui, factoryTheme: Theme) => {
        this.tui = tui;
        return {
          render: (width: number) => {
            const roster = this.roster();
            this.reselect(roster);
            const entry = roster[this.selected];
            const canBackground = entry?.kind === "run" && Boolean(this.source.actions(entry.run).canBackground?.());
            const now = Date.now();
            const stopArmed = this.stopArmed && (entry?.kind === "run" || entry?.kind === "row") && entryKey(entry) === this.armedKey && targetOf(entry) === this.armedTarget;
            // Below the main prompt, main is the session shown.
            const current = roster[0]?.kind === "main" ? 0 : undefined;
            return renderFleet({ roster, selected: this.selected, current, active: this.active, stopArmed, canBackground, normalKeys: readEditorMode(this.focused())?.state === "normal", note: this.source.note?.(now), now, width, theme: ui.theme ?? factoryTheme });
          },
          invalidate: () => undefined,
        };
      },
      { placement: "belowEditor" },
    );
    this.registered = true;
  }

  /** Optional select-nav routing, without depending on that extension. */
  tab(activeOnly = false): boolean {
    if (activeOnly && !this.active) return false;
    return this.handleKey("\t", true)?.consume === true;
  }

  /** `{ consume: true }` for the keys the list takes; undefined lets a key through. */
  handleKey(data: string, enterWithTab = false): KeyResult {
    if (!this.ui || !this.source.enabled() || isKeyRelease(data)) return undefined;
    // The viewer owns the keyboard while it is open.
    if (this.closeViewer) return undefined;
    // A dialog or another overlay has the keyboard; the editor's text is not what it seems.
    if (!this.editorFocused()) {
      if (this.active) this.deactivate();
      return undefined;
    }
    const focused = this.focused();
    const modal = readEditorMode(focused);
    const mode = modal?.state ?? "insert";
    const autocomplete = modal?.autocomplete || (focused as { isShowingAutocomplete?: () => boolean } | undefined)?.isShowingAutocomplete?.();
    // A virtually selected list must not keep keys after the prompt changes editing state.
    if (this.active && (autocomplete || mode !== this.selectedMode || (mode !== "normal" && mode !== "insert"))) {
      this.deactivate();
      return undefined;
    }
    if (!this.active) {
      if (autocomplete || (mode !== "normal" && mode !== "insert")) return undefined;
      // ↓ (or vim's j) at the bottom of the prompt, ← at an empty one; nothing else needs the list worked out.
      // Without a view of the editor, only an empty prompt is safe to leave.
      const down = focused ? leavesPromptDown(focused, data, matchesKey(data, "down"), data === "j" && modal?.state === "normal") : matchesKey(data, "down") && this.ui.getEditorText() === "";
      const left = matchesKey(data, "left") && this.ui.getEditorText() === "";
      const tab = enterWithTab && matchesKey(data, "tab");
      // Ctrl+J/Ctrl+K stay the editor's until the list is selected (Tab, or ↓ at the prompt's end);
      // only then do they cycle it.
      if (!down && !left && !tab) return undefined;
      const roster = this.roster();
      if (roster.length > 0) {
        this.active = true;
        this.selectedMode = mode;
        this.select(roster, this.firstRow(roster));
        this.update();
        return { consume: true };
      }
      return undefined;
    }
    // Insert and plain nonmodal editors retain text/edit keys while a row is highlighted.
    if (modal?.state !== "normal" && !["up", "down", "enter", "escape", "pageUp", "pageDown", "tab", "ctrl+j", "ctrl+k"].some((key) => matchesKey(data, key as never))) {
      this.deactivate();
      return undefined;
    }
    const roster = this.roster();
    this.reselect(roster);
    const entry = roster[this.selected];
    // Armed only for the row that was selected when x was first pressed.
    const armed = this.stopArmed && (entry?.kind === "run" || entry?.kind === "row") && entryKey(entry) === this.armedKey && targetOf(entry) === this.armedTarget;
    this.stopArmed = false;
    this.armedKey = undefined;
    this.armedTarget = undefined;
    if (matchesKey(data, "x") && entry?.kind === "run" && entry.run.state.status === "running") {
      // Two presses, so a stray x cannot kill a run.
      if (armed) this.invoke(() => this.source.actions(entry.run).stop?.());
      else {
        this.stopArmed = true;
        this.armedKey = entryKey(entry);
        this.armedTarget = entry.run.child ?? entry.run;
      }
    } else if (matchesKey(data, "x") && entry?.kind === "row" && rowStoppable(entry.section, entry.row)) {
      if (armed) this.invoke(() => entry.section.stop?.(entry.row.key));
      else {
        this.stopArmed = true;
        this.armedKey = entryKey(entry);
        this.armedTarget = targetOf(entry);
      }
    } else if (matchesKey(data, "x") && entry?.kind === "run") {
      // An ended run: dismissed now instead of at the user's next message.
      this.invoke(() => this.source.dismiss?.(entry.run.id));
      const left = this.roster();
      if (!left.length) this.active = false;
      this.select(left, Math.min(this.selected, Math.max(0, left.length - 1)));
    } else if (matchesKey(data, "b") && entry?.kind === "run" && this.source.actions(entry.run).canBackground?.()) {
      this.source.actions(entry.run).background?.();
    } else if (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d") || matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      const direction = matchesKey(data, "ctrl+u") || matchesKey(data, "pageUp") ? -1 : 1;
      const page = Math.min(MAX_ROWS, roster.length);
      const step = matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d") ? Math.max(1, Math.floor(page / 2)) : page;
      this.select(roster, Math.max(0, Math.min(roster.length - 1, this.selected + direction * step)));
    } else if (matchesKey(data, "tab") || matchesKey(data, "ctrl+j")) {
      // The cycle wraps through main, too.
      this.select(roster, (this.selected + 1) % roster.length);
    } else if (matchesKey(data, "ctrl+k")) {
      this.select(roster, (this.selected - 1 + roster.length) % roster.length);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.select(roster, Math.min(roster.length - 1, this.selected + 1));
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.selected === 0) this.active = false;
      else this.select(roster, this.selected - 1);
    } else if (matchesKey(data, "escape") || matchesKey(data, "h")) {
      this.active = false;
      this.selected = 0;
    } else if (matchesKey(data, "enter") || matchesKey(data, "l")) {
      this.open(roster[this.selected]);
    } else {
      // Anything else goes back to the editor.
      this.deactivate();
      return undefined;
    }
    this.update();
    return { consume: true };
  }

  /** Input callbacks cannot await another source; contain synchronous and asynchronous failures. */
  private invoke(action: () => void | Promise<void>): void {
    try {
      void Promise.resolve(action()).catch(() => undefined);
    } catch {
      // A source's failure must not take over the keyboard.
    }
  }

  private focused(): unknown {
    return focusedComponent(this.tui);
  }

  /** Whether the main prompt has the keyboard (activity.ts: the component's reported context, else pi's editor shape). */
  private editorFocused(): boolean {
    return mainEditorFocused(this.focused());
  }

  private deactivate() {
    this.active = false;
    this.stopArmed = false;
    this.selected = 0;
    this.update();
  }

  private open(entry: FleetEntry | undefined) {
    if (!entry || entry.kind === "main" || !this.ui) {
      this.active = false;
      this.selected = 0;
      return;
    }
    const key = entryKey(entry);
    this.viewing = key;
    const cleared = () => this.viewerClosed(key);
    if (entry.kind === "row") {
      // The row's own view (a notebook); it owns the keyboard until it closes.
      this.active = false;
      this.closeViewer = () => undefined;
      const ui = this.ui;
      const { section, row } = entry;
      Promise.resolve()
        .then(() => section.open(row.key, ui))
        .then(cleared, cleared);
      return;
    }
    if (entry.kind === "pill") {
      // The section's own dialog; it owns the keyboard until it closes.
      this.active = false;
      if (!entry.section.openDialog) return cleared();
      this.closeViewer = () => undefined;
      const ui = this.ui;
      const section = entry.section;
      // Never throws here: a bug in another extension must not leave the list owning no keys.
      Promise.resolve()
        .then(() => section.openDialog?.(ui))
        .then(cleared, cleared);
      return;
    }
    void this.show(this.ui, entry.run);
  }

  /**
   * Show `run`'s session; Tab and the list there switch between main and the runs listed here.
   * Resolves when you are back in main.
   */
  show(ui: ViewerUI, run: Run): Promise<void> {
    this.viewing = `run:${run.id}`;
    const src = this.source;
    const source: SessionSource = {
      runs: () => src.runs(),
      actions: (r) => src.actions(r),
      enabled: () => src.enabled(),
      sections: () => src.sections?.() ?? [],
      dismissedAt: () => src.dismissedAt?.() ?? Number.POSITIVE_INFINITY,
      dismissed: () => src.dismissed?.() ?? new Set(),
      dismiss: (id) => src.dismiss?.(id),
      contextWindow: (model) => src.contextWindow?.(model),
      settings: () => src.settings?.() ?? {},
      onSwitch: (r) => {
        this.viewing = `run:${r.id}`;
      },
    };
    const cleared = () => this.viewerClosed(this.viewing ?? `run:${run.id}`);
    return openViewer(ui, run, src.actions(run), (close) => {
      this.closeViewer = close;
    }, source).then(cleared, cleared);
  }

  private viewerClosed(key: string) {
    this.closeViewer = undefined;
    this.viewing = undefined;
    // Back on the row just viewed, if it is still listed.
    const roster = this.roster();
    const index = roster.findIndex((e) => entryKey(e) === key);
    if (index >= 0 && this.active) this.select(roster, index);
    this.update();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
    const close = this.closeViewer;
    this.closeViewer = undefined;
    this.viewing = undefined;
    try {
      close?.();
      if (this.registered) this.ui?.setWidget(FLEET_KEY, undefined);
    } finally {
      this.registered = false;
      this.tui = undefined;
      this.active = false;
      this.ui = undefined;
    }
  }
}
