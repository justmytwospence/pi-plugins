// A notebook, full screen (frame.ts), where you read and steer it. A one-line header (kernel state,
// the agent's changes, the last run), then two panes: the outline on the left (outline.ts: the
// headings and a short line per cell) and the selected cell on the right (detail.ts: prose, output,
// error with its traceback, folded code, dataflow). Narrower than SPLIT_MIN columns the outline
// fills the view and Enter drills into the detail (Esc comes back). It follows the running cell
// until you move. Keys (also `?`):
//   j/k move between cells, ctrl+j/ctrl+k (or ] [) between sections, n/p between a cell's parts,
//   z/Z fold; Enter acts on the part (or opens the code; markdown: edits it); t drives a table; e/E
//   errors, c/C the agent's changes, d its diff; < > upstream/downstream; ^D/^U/PgDn/PgUp/Space
//   scroll the detail; O stacks the whole section in the detail; / filters; v lists the variables;
//   r/R/A run cells, x twice interrupts; w drives the cell's widgets; : runs Python in the kernel;
//   a asks the agent about the cell; m marks it for the agent (Lens), M twice removes a mark; i
//   drives a live chart; o opens the browser; S twice stops the server; Tab/Shift+Tab switch
//   notebooks; Esc, q, ← or h goes back. The mouse wheel scrolls the pane under it, a click
//   selects, a double click opens the code.
// The prompts (ask, Python, a Lens note, a widget's value) dock at the bottom (dock.ts).
import { type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "../core/io.js";
import { type ChartRenderer, VegaRenderer as VegaRendererImpl, type VegaRenderer } from "../core/vega.js";
import { sharedPlotly } from "../core/plotly.js";
import { LiveCharts } from "./live-charts.js";
import { Painter } from "./painter.js";
import { type Cell, truncate } from "../core/notebook.js";
import { editableMarkdown, markdownCellCode } from "../core/markdown.js";
import { summarizeOutput, type TableData, type Widget } from "../core/output.js";
import { elapsed, shortWhere } from "../core/render.js";
import type { Followed } from "../core/watcher.js";
import { kernelStateParts, lensParts } from "../bg.js";
import { INPUT_CONTEXT } from "../activity.js";
import { interruptKey, notebookKey, notebookPath } from "./identity.js";
import { banner, bottom, row as frameRow, rule as frameRule, type FrameTheme } from "../frame.ts";
import type { EditorFactoryFn } from "../editor-contract.ts";
import { Dock, type DockSpec } from "./dock.js";
import { type Part, detailRows } from "./detail.js";
import { helpLines } from "./help.js";
import { type PaneTheme, outlineRows } from "./outline.js";
import { MAX_WIDGETS, type Row, firstLine, foldedCells, selectableCells } from "./rows.js";
import { cellTitle } from "./titles.js";
import type { ScratchEvent, ScratchResult } from "./scratch.js";
import { columnCard, rowCard, tableLines } from "./table.js";
import { type TableRpc, type TableSession, parseFilter, tableSession } from "./table-session.js";
import { variableList, variableRows } from "./variables.js";
import { type WidgetAction, nextValue, typeable, typedValue, widgetHit, widgetValue } from "./widgets.js";

export { notebookLines, outlineRows } from "./outline.js";
export { detailRows } from "./detail.js";
export { selectableCells, type Row, type RowOptions } from "./rows.js";

/** Banner, header, rule, rule above the hints, the hints, bottom border. */
const CHROME = 6;
const TICK_MS = 1_000;
/** The row the panes start at: banner, header, rule. */
const ROWS_TOP = 3;
/** From this many columns the outline and the detail sit side by side; narrower, one at a time. */
const SPLIT_MIN = 100;
/** The outline's width in the split: a third of the view, within limits. */
const outlineWidth = (width: number): number => Math.max(28, Math.min(44, Math.floor((width - 4) * 0.32)));
/** Rows the stacked outline takes above the detail: about a third of the page, odd (as many rows above the cursor as below it), 1 to 9. */
const stackedOutlineRows = (page: number): number => {
  const rows = Math.max(1, Math.min(9, Math.round(page * 0.3), page - 4));
  return rows % 2 ? rows : rows - 1;
};
/** Columns before a widget's line in the detail: the part's bar, a space, the widget's glyph and a space. */
const WIDGET_TEXT = 4;
/** Between the panes. */
const SEPARATOR_WIDTH = 3;
/** Lines of a scratch run shown above its prompt, at most. */
const SCRATCH_ROWS = 12;

/** One cell or its whole section in the detail: the choice holds for the rest of the Pi process. */
let sectionMode: boolean | undefined;

/** What the docked view needs from the split that hosts it. */
export interface DockedHost { focused(): boolean; focusMain(): void }

/** The view's own state, carried over when it moves between full screen and docked. */
export interface ViewState {
  cursor?: string;
  follow: boolean;
  scroll: number;
  detailScroll: number;
  codeOpen: string[];
  folded: string[];
  diffs: string[];
  section: boolean;
  filter: string;
  mode: "cells" | "variables";
  varCursor?: string;
  varFilter: string;
}

export interface ViewActions {
  /** Set when the view is docked beside the chat. */
  docked?: DockedHost;
  /** Start from this state (a view that moved between full screen and docked). */
  initial?: ViewState;
  /** `|` in the full-screen view: dock it beside the chat. */
  dock?(key: string, state: ViewState): void;
  /** `|` in the docked view: back to full screen. */
  undock?(key: string, state: ViewState): void;
  /** The notebooks followed now. */
  followed(): Followed[];
  interrupt(f: Followed): Promise<void>;
  openInBrowser(f: Followed): void;
  /** Runs these cells (id and current code) in the notebook's kernel. */
  run?(f: Followed, cells: Array<{ id: string; code: string }>): Promise<void>;
  /** The servers standing for this notebook (pi-bg's, and one Pi started). */
  servers?(f: Followed): string[];
  /** Stops the servers standing for this notebook; how many. */
  stopServers?(f: Followed): number;
  /** How the notebook's last run went: `ran 2m 3s · 1 error · 5m ago`. */
  lastRun?(f: Followed): string | undefined;
  /** Whether the main agent is working now. */
  agentBusy?(): boolean;
  /** Sends the main agent a message about the notebook (and the cell). */
  ask?(f: Followed, cell: Cell | undefined, text: string): void;
  /** Runs Python in the notebook's kernel, streaming what it prints. */
  scratch?(f: Followed, code: string, onEvent: (e: ScratchEvent) => void, signal: AbortSignal): Promise<ScratchResult>;
  /** Sets one of a cell's widgets. */
  setWidget?(f: Followed, cell: Cell, widget: Widget, value: unknown): void;
  /** Marks a cell for the agent as a Lens selection; resolves with its label. */
  mark?(f: Followed, cell: Cell, note: string): Promise<string>;
  /** Removes a Lens selection. */
  unmark?(f: Followed, selectionId: string): Promise<void>;
  /** Run Plotly figures live (default); false draws them as pictures. */
  liveCharts?: boolean;
  /** Start with the whole section in the detail pane (O toggles it). */
  outputs?: boolean;
  /** A marimo table's kernel functions (search, summaries...), for driving tables. */
  table?: TableRpc;
  /** Writes a table's selection to the kernel as the browser does. */
  setTableSelection?(f: Followed, cell: Cell, objectId: string, value: unknown[]): void;
  /** Saves the whole table as CSV in Pi's working directory; resolves with the file name. */
  saveTable?(f: Followed, cell: Cell, objectId: string): Promise<string>;
  /** Replaces a cell's code through marimo's code mode and reruns it. */
  editCell?(f: Followed, cell: Cell, code: string): Promise<void>;
  /** Pi's keybindings and the suite's editor, for the docked prompts. */
  keybindings?: unknown;
  editorFactory?: EditorFactoryFn;
}

interface ScratchState {
  code: string;
  lines: ScratchEvent[];
  result?: ScratchResult;
  error?: string;
  running: boolean;
  started: number;
  abort: AbortController;
}

/** `╭─ Notebook nb.py · ctrl+] focus ──╮` for the docked view: no "back" arrow, it sits beside the chat. */
function dockedBanner(file: string, width: number, th: FrameTheme, focused: boolean): string {
  const label = ` Notebook ${file} · ${focused ? "ctrl+] chat" : "ctrl+] focus"} `;
  const text = truncateToWidth(label, Math.max(4, width - 3));
  return th.fg("accent", `╭─${th.bold(text)}${"─".repeat(Math.max(0, width - 3 - visibleWidth(text)))}╮`);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class NotebookView implements Component {
  private scroll = 0;
  private follow = true;
  private cursor: string | undefined;
  /** Cells whose code shows in the detail. */
  private codeOpen = new Set<string>();
  /** The detail's scroll, in its own rows. */
  private detailScroll = 0;
  /** Which cell (and view) the detail last drew, so a new one starts at its top. */
  private detailKey = "";
  private lastOutline: Row[] = [];
  private lastDetail: Row[] = [];
  /** Where the panes are: the outline's width, the detail's left column, which panes show. */
  /**
   * Where the panes are: side by side (`both`), or `stacked` when narrow: a few outline rows around the
   * cursor above a rule, the detail under it, as a mail app's list above its reading pane.
   */
  private panes: { lw: number; detailLeft: number; detailTop: number; outlineHeight: number; shows: "both" | "stacked" } = { lw: 28, detailLeft: 0, detailTop: 0, outlineHeight: 0, shows: "both" };
  private filter = "";
  /** Typing a filter: keys go to it. */
  private typing = false;
  /** Where the cursor was when `/` started, for Esc. */
  private findFrom: string | undefined;
  /** Scroll the cursor's cell into view on the next render (after a move, not after scrolling). */
  private reveal = false;
  private armedTarget: string | undefined;
  /** A run of several cells waits for a second press: which, and in which kernel session. */
  private armedRun: { what: "stale" | "all"; target: string } | undefined;
  /** `S` waits for a second press, like `x`. */
  private armedStop: string | undefined;
  /** `M` waits for a second press: the selection it removes. */
  private armedUnmark: { id: string; label: string } | undefined;
  private note: string | undefined;
  private closed = false;
  private mode: "cells" | "variables" = "cells";
  /** The detail shows the cell's whole section. */
  private section: boolean;
  private folded = new Set<string>();
  private diffs = new Set<string>();
  private varCursor: string | undefined;
  private varFilter = "";
  /** The focused part of the cursor's cell (n/p), an index into `lastParts`. */
  private part: number | undefined;
  private partCell: string | undefined;
  private scrollToPart = false;
  private lastParts: Part[] = [];
  /** The table the keys drive (table mode). */
  private table: { cell: string; objectId: string } | undefined;
  /** The widget the keys drive. */
  private widget: { cell: string; index: number; sub: number } | undefined;
  /** A slider being dragged with the mouse. */
  private dragging: { cell: string; index: number } | undefined;
  private help = false;
  private dock: Dock | undefined;
  private scratch: ScratchState | undefined;
  private lastRows: Row[] = [];
  private lastPage = 0;
  private lastDock = 0;
  private readonly vega: VegaRenderer;
  private readonly plotly: ChartRenderer;
  private readonly live: LiveCharts;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: Pick<TUI, "requestRender"> & { terminal: { rows: number } },
    private readonly theme: FrameTheme,
    private key: string,
    private readonly actions: ViewActions,
    private readonly done: () => void,
    vega: VegaRenderer = new VegaRendererImpl(),
    plotly: ChartRenderer = sharedPlotly(),
    live?: LiveCharts,
  ) {
    this.vega = vega;
    this.plotly = plotly;
    this.section = sectionMode ?? actions.outputs ?? false;
    if (actions.initial) this.restore(actions.initial);
    this.live = live ?? new LiveCharts(() => { if (!this.closed) this.tui.requestRender(); }, undefined, undefined, undefined, () => Painter.for(this.tui), actions.docked ? "base" : "overlay");
    if (!actions.docked) Painter.for(this.tui)?.setExclusive(true);
    this.tui.requestRender();
    this.timer = setInterval(() => {
      if (!this.closed) {
        this.syncConfirmation();
        this.tui.requestRender();
      }
    }, TICK_MS);
    this.timer.unref?.();
  }

  get notebook(): string {
    return this.key;
  }

  snapshot(): ViewState {
    return {
      ...(this.cursor !== undefined ? { cursor: this.cursor } : {}),
      follow: this.follow,
      scroll: this.scroll,
      detailScroll: this.detailScroll,
      codeOpen: [...this.codeOpen],
      folded: [...this.folded],
      diffs: [...this.diffs],
      section: this.section,
      filter: this.filter,
      mode: this.mode,
      ...(this.varCursor !== undefined ? { varCursor: this.varCursor } : {}),
      varFilter: this.varFilter,
    };
  }

  private restore(s: ViewState): void {
    this.cursor = s.cursor;
    this.follow = s.follow;
    this.scroll = s.scroll;
    this.detailScroll = s.detailScroll;
    this.codeOpen = new Set(s.codeOpen);
    this.folded = new Set(s.folded);
    this.diffs = new Set(s.diffs);
    this.section = s.section;
    this.filter = s.filter;
    this.mode = s.mode;
    this.varCursor = s.varCursor;
    this.varFilter = s.varFilter;
    // So the detail's scroll survives the first render.
    this.detailKey = `${s.cursor ?? ""}\0${s.section}`;
  }

  /** Esc: docked, back to the chat; full screen, out of the view. */
  private leave(): void {
    if (this.actions.docked) this.actions.docked.focusMain();
    else this.close();
  }

  private toggleDock(): void {
    if (this.actions.docked) {
      if (this.actions.undock) this.actions.undock(this.key, this.snapshot());
      else this.note = "Not available here.";
    } else if (this.actions.dock) {
      this.actions.dock(this.key, this.snapshot());
      this.close();
    } else this.note = "Docking is not available here.";
  }

  /** A new cursor cell starts without a focused part. */
  private syncPart(): void {
    if (this.partCell !== this.cursor) {
      this.part = undefined;
      this.partCell = this.cursor;
    }
  }

  private current(): Followed | undefined {
    return this.actions.followed().find((f) => notebookKey(f) === this.key);
  }

  private syncConfirmation(): void {
    const f = this.current();
    if (!f || f.connection !== "connected" || (!f.notebook.running() && f.notebook.queued() === 0) || interruptKey(f) !== this.armedTarget) this.armedTarget = undefined;
    if (!f || interruptKey(f) !== this.armedStop) this.armedStop = undefined;
    if (!f || f.connection !== "connected" || (this.armedRun && this.armedRun.target !== interruptKey(f))) this.armedRun = undefined;
    if (!f || (this.armedUnmark && !f.notebook.lens.selections().some((s) => s.id === this.armedUnmark!.id))) this.armedUnmark = undefined;
  }

  private viewport(): number {
    return Math.max(3, this.tui.terminal.rows - CHROME - this.lastDock);
  }

  /** Read-only scrolling content: global listeners leave its keys alone (a filter or a docked prompt takes them). */
  [INPUT_CONTEXT](): "viewer" | "filter" | "editor" {
    return this.dock ? "editor" : this.typing ? "filter" : "viewer";
  }

  private cells(f: Followed): Cell[] {
    return selectableCells(f.notebook, this.filter, { folded: this.folded });
  }

  /** Move the cursor to the next/previous selectable cell that passes `want` (wrapping). */
  private step(f: Followed, by: 1 | -1, want: (c: Cell) => boolean = () => true, none = "No such cell."): void {
    const cells = this.cells(f);
    if (!cells.length) return;
    const at = Math.max(0, cells.findIndex((c) => c.id === (this.cursor ?? cells[0]!.id)));
    for (let i = 1; i <= cells.length; i++) {
      const c = cells[((at + by * i) % cells.length + cells.length) % cells.length]!;
      if (want(c)) {
        this.cursor = c.id;
        this.follow = false;
        this.reveal = true;
        return;
      }
    }
    this.note = none;
  }

  private cursorCell(f: Followed): Cell | undefined {
    const cells = this.cells(f);
    return cells.find((c) => c.id === this.cursor) ?? cells[0];
  }

  /** Put the cursor on a cell, opening the fold that hides it. */
  private goTo(f: Followed, id: string): void {
    const head = foldedCells(f.notebook, this.folded).get(id);
    if (head) this.folded.delete(head);
    // A fold inside the opened one may still hide it.
    const inner = foldedCells(f.notebook, this.folded).get(id);
    if (inner) this.folded.delete(inner);
    this.filter = "";
    this.mode = "cells";
    this.table = undefined;
    this.cursor = id;
    this.follow = false;
    this.reveal = true;
  }

  private startRun(f: Followed, cells: Cell[], what: string): void {
    if (!this.actions.run) {
      this.note = "Running cells is not available here.";
      return;
    }
    if (f.connection !== "connected") {
      this.note = "The notebook is not connected.";
      return;
    }
    if (!cells.length) {
      this.note = "Nothing to run.";
      return;
    }
    this.note = `Running ${what}…`;
    this.actions.run(f, cells.map((c) => ({ id: c.id, code: c.code }))).then(
      () => { if (!this.closed) { this.note = `Started ${what}.`; this.follow = true; this.tui.requestRender(); } },
      (e: unknown) => { if (!this.closed) { this.note = `Could not run: ${message(e)}`; this.tui.requestRender(); } },
    );
  }

  private typeFilter(data: string): void {
    const vars = this.mode === "variables";
    // ctrl+j/ctrl+k (and the arrows) move through the matches while typing.
    const by = matchesKey(data, "ctrl+j") || matchesKey(data, "down") ? 1 : matchesKey(data, "ctrl+k") || matchesKey(data, "up") ? -1 : 0;
    if (by) {
      const f = this.current();
      if (vars) {
        const list = f ? variableList(f.notebook, this.varFilter) : [];
        const at = list.findIndex((v) => v.name === this.varCursor);
        this.varCursor = list[Math.max(0, Math.min(list.length - 1, at + by))]?.name ?? this.varCursor;
        this.reveal = true;
      } else if (f) this.step(f, by as 1 | -1);
      this.tui.requestRender();
      return;
    }
    let text = vars ? this.varFilter : this.filter;
    // `/` finds: Enter goes to the match under the cursor and shows everything again; Esc goes back.
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
      const found = matchesKey(data, "enter");
      this.typing = false;
      if (vars) {
        this.varFilter = "";
        if (!found) this.varCursor = this.findFrom;
      } else {
        this.filter = "";
        const target = found ? this.cursor : this.findFrom;
        const f = this.current();
        if (f && target) this.goTo(f, target);
        else this.cursor = target;
      }
      this.findFrom = undefined;
      this.follow = false;
      this.reveal = true;
      this.tui.requestRender();
      return;
    }
    else if (matchesKey(data, "backspace")) text = text.slice(0, -1);
    else if (!data.startsWith("\x1b") && data >= " ") text += data;
    if (vars) {
      this.varFilter = text;
      this.varCursor = undefined;
    } else {
      this.filter = text;
      this.cursor = undefined;
    }
    this.scroll = 0;
    this.follow = false;
    this.reveal = true;
    this.tui.requestRender();
  }

  /** Moves to the next (or previous) followed notebook, starting it afresh. */
  private switchNotebook(by: 1 | -1): void {
    const all = this.actions.followed();
    const i = all.findIndex((o) => notebookKey(o) === this.key);
    const next = all[((i + by) % Math.max(1, all.length) + all.length) % Math.max(1, all.length)];
    if (!next || notebookKey(next) === this.key) return;
    this.key = notebookKey(next);
    this.scroll = 0;
    this.follow = true;
    this.cursor = undefined;
    this.filter = "";
    this.varFilter = "";
    this.varCursor = undefined;
    this.folded.clear();
    this.diffs.clear();
    this.codeOpen.clear();
    this.detailScroll = 0;
    this.widget = undefined;
    this.table = undefined;
    this.part = undefined;
  }

  // --- docked prompts -------------------------------------------------------------------------

  private openDock(spec: DockSpec): void {
    this.dock?.dispose();
    this.dock = new Dock(this.tui, this.theme, spec, this.actions.editorFactory, this.actions.keybindings);
    this.note = undefined;
  }

  private closeDock(): void {
    this.dock?.dispose();
    this.dock = undefined;
    if (!this.scratch?.running) this.scratch = undefined;
  }

  private openAsk(f: Followed): void {
    const ask = this.actions.ask;
    if (!ask) { this.note = "Not available here."; return; }
    const cell = this.cursorCell(f);
    const file = basename(f.attachment.path);
    const busy = this.actions.agentBusy?.() === true;
    this.openDock({
      kind: "ask",
      title: cell ? `Ask the agent about ${cellTitle(f.notebook, cell)} in ${file}` : `Ask the agent about ${file}`,
      hint: `enter send · esc cancel${busy ? " · the agent is working: this goes in as a follow-up" : ""}`,
      submit: (text) => {
        if (!text.trim()) return;
        this.closeDock();
        ask(f, cell, text);
        this.note = "Sent to the agent.";
        this.tui.requestRender();
      },
      cancel: () => { this.closeDock(); this.tui.requestRender(); },
    });
  }

  private openScratch(f: Followed): void {
    const run = this.actions.scratch;
    if (!run) { this.note = "Not available here."; return; }
    if (f.connection !== "connected") { this.note = "The notebook is not connected."; return; }
    const idle = "enter run · esc close";
    this.openDock({
      kind: "scratch",
      title: `Python in ${basename(f.attachment.path)}'s kernel · a scratch cell, nothing is saved`,
      hint: idle,
      submit: (code) => {
        if (!code.trim() || this.scratch?.running) return;
        const dock = this.dock;
        dock?.addToHistory(code);
        dock?.setText("");
        dock?.setHint("running… · esc cancels (marimo interrupts the kernel)");
        const state: ScratchState = { code, lines: [], running: true, started: Date.now(), abort: new AbortController() };
        this.scratch = state;
        run(f, code, (e) => {
          state.lines.push(e);
          if (state.lines.length > 200) state.lines.splice(0, state.lines.length - 200);
          if (!this.closed) this.tui.requestRender();
        }, state.abort.signal).then(
          (r) => { state.result = r; },
          (e: unknown) => { state.error = state.abort.signal.aborted || (e instanceof Error && e.name === "AbortError") ? "cancelled" : message(e); },
        ).finally(() => {
          state.running = false;
          if (this.dock === dock) dock?.setHint(idle);
          if (!this.closed) this.tui.requestRender();
        });
        this.tui.requestRender();
      },
      cancel: () => {
        if (this.scratch?.running) {
          this.scratch.abort.abort();
          this.note = "Cancelled: marimo interrupts the kernel when a scratch run is cancelled.";
        } else this.closeDock();
        this.tui.requestRender();
      },
    });
  }

  private openMark(f: Followed): void {
    const mark = this.actions.mark;
    if (!mark) { this.note = "Not available here."; return; }
    if (!f.notebook.lens.present) { this.note = "No Lens in this notebook (marimo-lens mounts one when it is installed). a asks the agent about this cell instead."; return; }
    if (f.connection !== "connected") { this.note = "The notebook is not connected."; return; }
    const cell = this.cursorCell(f);
    if (!cell) { this.note = "No cell selected."; return; }
    const next = f.notebook.lens.instances()[0]?.nextLabel ?? "S1";
    this.openDock({
      kind: "mark",
      title: `Note for the agent on ${cellTitle(f.notebook, cell)} (Lens ${next})`,
      hint: "enter mark · esc cancel · the note may be empty",
      submit: (note) => {
        this.closeDock();
        this.note = "Marking…";
        mark(f, cell, note.trim()).then(
          (label) => { if (!this.closed) { this.note = `Marked ${label}. a asks the agent to address it.`; this.tui.requestRender(); } },
          (e: unknown) => { if (!this.closed) { this.note = `Lens did not take the mark: ${message(e)}`; this.tui.requestRender(); } },
        );
        this.tui.requestRender();
      },
      cancel: () => { this.closeDock(); this.tui.requestRender(); },
    });
  }

  private openValue(f: Followed, cell: Cell, w: Widget): void {
    const value = widgetValue(f.notebook, w);
    this.openDock({
      kind: "value",
      title: `${w.label || w.kind}: new value`,
      hint: "enter set · esc cancel",
      initial: value === undefined || value === null ? "" : String(value),
      submit: (text) => {
        const typed = typedValue(w, text);
        if ("error" in typed) { this.note = typed.error; this.tui.requestRender(); return; }
        this.closeDock();
        this.actions.setWidget?.(f, cell, w, typed.value);
        this.tui.requestRender();
      },
      cancel: () => { this.closeDock(); this.tui.requestRender(); },
    });
  }

  private openEditMarkdown(f: Followed, cell: Cell): void {
    const text = editableMarkdown(cell.code);
    if (text === undefined) {
      this.note = "This markdown is built in Python (an f-string); ask the agent (a), or open it in the browser (o).";
      this.codeOpen.add(cell.id);
      return;
    }
    this.openDock({
      kind: "markdown",
      title: `Edit markdown · ${cellTitle(f.notebook, cell)}`,
      hint: "enter saves · shift+enter new line · esc cancels (pi-vim: :w saves)",
      initial: text,
      submit: (edited) => {
        this.closeDock();
        if (edited.replace(/\s+$/u, "") === text.replace(/\s+$/u, "")) { this.note = "No change."; this.tui.requestRender(); return; }
        const edit = this.actions.editCell;
        if (!edit) { this.note = "Not available here."; this.tui.requestRender(); return; }
        this.note = "Saving…";
        edit(f, cell, markdownCellCode(edited)).then(
          () => { if (!this.closed) { this.note = "Saved; marimo re-renders it."; this.tui.requestRender(); } },
          (e: unknown) => { if (!this.closed) { this.note = `Could not save: ${message(e)}`; this.tui.requestRender(); } },
        );
        this.tui.requestRender();
      },
      cancel: () => { this.closeDock(); this.tui.requestRender(); },
    });
  }

  /** The session and current data of a cell's marimo table, when the view can drive it. */
  private tableFor(f: Followed, cell: Cell): { session: TableSession; data: TableData } | undefined {
    const t = cell.output?.table;
    if (!t?.objectId || !this.actions.table || f.connection !== "connected") return undefined;
    const session = tableSession(`${this.key}\0${t.objectId}`, cell, t);
    session.onChange = () => { if (!this.closed) this.tui.requestRender(); };
    return { session, data: session.data() };
  }

  private copy(text: string): void {
    const terminal = (this.tui as unknown as { terminal?: { write?(d: string): void } }).terminal;
    if (terminal?.write) {
      terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
      this.note = "Copied.";
    } else this.note = "Copying needs a terminal.";
  }

  private tableKey(f: Followed | undefined, data: string): void {
    const cell = f && this.table ? f.notebook.cells.get(this.table.cell) : undefined;
    const t = f && cell ? this.tableFor(f, cell) : undefined;
    const rpc = this.actions.table;
    if (!f || !cell || !t || !rpc || !this.table) { this.table = undefined; return; }
    const s = t.session;
    const objectId = this.table.objectId;
    this.note = undefined;
    if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
      if (s.card) s.closeCard();
      else this.table = undefined;
      return;
    }
    if (data === "?") { this.help = true; return; }
    if (data === "j" || matchesKey(data, "down")) s.move(f, rpc, 1, 0);
    else if (data === "k" || matchesKey(data, "up")) s.move(f, rpc, -1, 0);
    else if (data === "h" || matchesKey(data, "left")) s.move(f, rpc, 0, -1);
    else if (data === "l" || matchesKey(data, "right")) s.move(f, rpc, 0, 1);
    else if (data === "]" || matchesKey(data, "pageDown")) s.setPage(f, rpc, s.page + 1);
    else if (data === "[" || matchesKey(data, "pageUp")) s.setPage(f, rpc, s.page - 1);
    else if (data === "g") s.setPage(f, rpc, 0);
    else if (data === "G") {
      const n = s.pageCount();
      if (n === undefined) this.note = "marimo did not count the rows: ] pages forward.";
      else s.setPage(f, rpc, n - 1);
    } else if (data === "+") s.setPageSize(f, rpc, 1);
    else if (data === "-") s.setPageSize(f, rpc, -1);
    else if (data === "s" || data === "S") s.toggleSort(f, rpc, s.columnName(), data === "S");
    else if (data === "/") {
      this.openDock({
        kind: "table",
        title: `Search ${cellTitle(f.notebook, cell)}`,
        hint: "enter search · empty clears · esc cancel",
        initial: s.query,
        submit: (text) => { this.closeDock(); s.setQuery(f, rpc, text); this.tui.requestRender(); },
        cancel: () => { this.closeDock(); this.tui.requestRender(); },
      });
    } else if (data === "f") {
      const column = s.columnName();
      const kind = t.data.fieldTypes?.[column]?.kind ?? "string";
      this.openDock({
        kind: "table",
        title: `Filter ${column} (${kind}): > 5 · 1..10 · in a, b · null · !null · ~regex · text`,
        hint: "enter filter · esc cancel",
        submit: (text) => {
          const parsed = parseFilter(column, kind, text);
          if ("error" in parsed) { this.note = parsed.error; this.tui.requestRender(); return; }
          this.closeDock();
          s.addFilter(f, rpc, parsed);
          this.tui.requestRender();
        },
        cancel: () => { this.closeDock(); this.tui.requestRender(); },
      });
    } else if (data === "F") s.clearFilters(f, rpc);
    else if (data === " " || data === "x") {
      const value = this.actions.setTableSelection ? s.toggleSelect(f.notebook) : undefined;
      if (!value) this.note = "This table has no selection.";
      else this.actions.setTableSelection!(f, cell, objectId, value);
    } else if (matchesKey(data, "enter")) s.openRow();
    else if (data === "i") s.openColumn(f, rpc);
    else if (data === "c") s.toggleSummaries(f, rpc);
    else if (data === "y") this.copy(s.cellValue());
    else if (data === "Y") this.copy(s.toTsv());
    else if (data === "D") {
      const save = this.actions.saveTable;
      if (!save) this.note = "Not available here.";
      else {
        this.note = "Saving…";
        save(f, cell, objectId).then(
          (name) => { if (!this.closed) { this.note = `Saved ${name}.`; this.tui.requestRender(); } },
          (e: unknown) => { if (!this.closed) { this.note = `Could not save: ${message(e)}`; this.tui.requestRender(); } },
        );
      }
    } else if (data === "r") void s.refresh(f, rpc);
  }

  /** `t`: drive the table of the cursor's cell (or the focused part). */
  private enterTable(f: Followed, cell: Cell | undefined): void {
    const focused = this.part !== undefined ? this.lastParts[this.part] : undefined;
    const target = focused?.kind === "table" ? f.notebook.cells.get(focused.cell) : cell;
    const hasTable = !!target?.output?.table?.objectId;
    if (!target || !hasTable) { this.note = "This cell shows no table marimo can page."; return; }
    if (!this.actions.table || f.connection !== "connected") { this.note = "This cell shows no table marimo can page: the table needs a connected notebook."; return; }
    this.table = { cell: target.id, objectId: target.output!.table!.objectId! };
    this.cursor = target.id;
    this.follow = false;
    this.reveal = true;
  }

  // --- keys -----------------------------------------------------------------------------------

  /** The widgets of the driven cell, or undefined (and widget mode ends) when they are gone. */
  private drivenWidgets(f: Followed | undefined): { cell: Cell; widgets: Widget[] } | undefined {
    const w = this.widget;
    const cell = w && f ? f.notebook.cells.get(w.cell) : undefined;
    const widgets = cell?.output?.widgets?.slice(0, MAX_WIDGETS) ?? [];
    if (!f || !cell || !widgets.length || f.connection !== "connected") {
      this.widget = undefined;
      return undefined;
    }
    if (w!.index >= widgets.length) w!.index = widgets.length - 1;
    return { cell, widgets };
  }

  private widgetKey(f: Followed | undefined, data: string): void {
    const driven = this.drivenWidgets(f);
    if (!driven || !f) { this.note = "The widgets are gone."; return; }
    const focus = this.widget!;
    const w = driven.widgets[focus.index]!;
    if (matchesKey(data, "escape") || data === "w" || data === "q") { this.widget = undefined; return; }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "up") || data === "k") {
      focus.index = (focus.index - 1 + driven.widgets.length) % driven.widgets.length;
      focus.sub = 0;
      this.reveal = true;
      return;
    }
    if (matchesKey(data, "tab") || matchesKey(data, "down") || data === "j") {
      focus.index = (focus.index + 1) % driven.widgets.length;
      focus.sub = 0;
      this.reveal = true;
      return;
    }
    const act = (action: WidgetAction) => {
      if (w.disabled) { this.note = "This widget is disabled."; return; }
      const next = nextValue(w, widgetValue(f.notebook, w), action, focus.sub);
      if (!next) { this.note = typeable(w) ? "enter types a value" : undefined; return; }
      focus.sub = next.sub;
      this.note = undefined;
      if (next.send) this.actions.setWidget?.(f, driven.cell, w, next.value);
    };
    if (matchesKey(data, "left") || data === "h") act("dec");
    else if (matchesKey(data, "right") || data === "l") act("inc");
    else if (data === "H") act("dec10");
    else if (data === "L") act("inc10");
    else if (data === " ") act("toggle");
    else if (matchesKey(data, "enter")) {
      if (typeable(w) && !w.disabled) this.openValue(f, driven.cell, w);
      else act("toggle");
    }
  }

  private variablesKey(f: Followed | undefined, data: string): void {
    const page = this.viewport();
    const list = f ? variableList(f.notebook, this.varFilter) : [];
    const at = Math.max(0, list.findIndex((v) => v.name === this.varCursor));
    const moveTo = (i: number) => { this.varCursor = list[Math.max(0, Math.min(list.length - 1, i))]?.name; this.reveal = true; };
    if (matchesKey(data, "ctrl+c")) { this.leave(); return; }
    if (matchesKey(data, "escape") && this.varFilter) { this.varFilter = ""; this.varCursor = undefined; return; }
    if (matchesKey(data, "escape") || data === "v" || data === "q" || data === "h" || matchesKey(data, "left")) {
      this.mode = "cells";
      this.scroll = 0;
      this.reveal = true;
      return;
    }
    if (data === "{") { this.switchNotebook(-1); this.mode = "variables"; return; }
    if (data === "}") { this.switchNotebook(1); this.mode = "variables"; return; }
    if (data === "/") { this.typing = true; this.findFrom = this.varCursor; this.varFilter = ""; return; }
    if (matchesKey(data, "down") || data === "j") return moveTo(at + 1);
    if (matchesKey(data, "up") || data === "k") return moveTo(at - 1);
    if (matchesKey(data, "home") || data === "g") { this.scroll = 0; return moveTo(0); }
    if (matchesKey(data, "end") || data === "G") return moveTo(list.length - 1);
    if (matchesKey(data, "ctrl+u")) return this.move(-Math.max(1, Math.floor(page / 2)));
    if (matchesKey(data, "ctrl+d")) return this.move(Math.max(1, Math.floor(page / 2)));
    if (matchesKey(data, "pageUp")) return this.move(-page);
    if (matchesKey(data, "pageDown") || matchesKey(data, "space")) return this.move(page);
    const v = list[at];
    if (!f || !v) return;
    if (matchesKey(data, "enter") || data === "l" || matchesKey(data, "right")) {
      if (v.definedBy && f.notebook.cells.has(v.definedBy)) this.goTo(f, v.definedBy);
      else this.note = `No cell defines ${v.name}.`;
    } else if (data === ">") {
      const user = f.notebook.order.find((id) => v.usedBy.includes(id));
      if (user) this.goTo(f, user);
      else this.note = `No cell uses ${v.name}.`;
    }
  }

  /** Enter (or a double click): open or fold the cell's code, or go to the variable's cell. */
  private activate(f: Followed): void {
    if (this.mode === "variables") return this.variablesKey(f, "\r");
    const c = this.cursorCell(f);
    if (!c) return;
    this.cursor = c.id;
    this.syncPart();
    this.reveal = true;
    const p = this.part !== undefined ? this.lastParts[this.part] : undefined;
    const target = p ? f.notebook.cells.get(p.cell) : undefined;
    if (p && target) {
      switch (p.kind) {
        case "table": this.enterTable(f, target); break;
        case "chart":
          if (!this.live.inspect(target.output)) this.note = "Not a live chart.";
          break;
        case "widgets":
          if (!this.actions.setWidget) this.note = "Widgets cannot be driven here.";
          else if (f.connection !== "connected") this.note = "The notebook is not connected.";
          else this.widget = { cell: target.id, index: 0, sub: 0 };
          break;
        case "code": this.toggleCode(target.id); break;
        case "markdown": this.openEditMarkdown(f, target); break;
        default: this.note = "e jumps to the next failed cell.";
      }
      return;
    }
    if (f.notebook.isMarkdown(c)) this.openEditMarkdown(f, c);
    else this.toggleCode(c.id);
  }

  private toggleCode(id: string): void {
    if (!this.codeOpen.delete(id)) this.codeOpen.add(id);
  }

  /** The pane under a column and a page row (from the first row under the header); the rule between stacked panes is neither. */
  private paneAt(x: number, line: number): "outline" | "detail" | undefined {
    const { shows, detailLeft, outlineHeight } = this.panes;
    if (shows === "both") return x >= detailLeft ? "detail" : "outline";
    return line < outlineHeight ? "outline" : line > outlineHeight ? "detail" : undefined;
  }

  /** ^D, PgDn and the like: the detail scrolls (the outline follows the cursor). */
  private scrollBy(by: number): void {
    if (this.mode === "cells") this.detailScroll = Math.max(0, this.detailScroll + by);
    else this.move(by);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    this.syncConfirmation();
    if (this.help) {
      this.help = false;
      this.tui.requestRender();
      return;
    }
    if (this.dock) {
      this.dock.handleInput(data);
      this.tui.requestRender();
      return;
    }
    if (this.live.inspecting && this.live.key(data)) { this.tui.requestRender(); return; }
    if (this.typing) return this.typeFilter(data);
    const f = this.current();
    if (this.widget) {
      this.widgetKey(f, data);
      this.tui.requestRender();
      return;
    }
    if (this.table && this.mode === "cells") {
      this.tableKey(f, data);
      this.tui.requestRender();
      return;
    }
    if (data === "|") {
      this.toggleDock();
      this.tui.requestRender();
      return;
    }
    if (data === "?") {
      this.help = true;
      this.note = undefined;
      this.tui.requestRender();
      return;
    }
    if (this.mode === "variables") {
      this.variablesKey(f, data);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape") && this.filter) {
      this.filter = "";
      this.cursor = undefined;
      this.tui.requestRender();
      return;
    }
    if (this.actions.docked && data === "q") {
      this.close();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q") || matchesKey(data, "h") || matchesKey(data, "left")) {
      this.leave();
      return;
    }
    const page = this.viewport();
    if (matchesKey(data, "x")) {
      const busy = f && f.connection === "connected" && (f.notebook.running() || f.notebook.queued() > 0);
      this.armedRun = undefined;
      if (!f || !busy) {
        this.armedTarget = undefined;
        this.note = "Nothing is running.";
      } else if (this.armedTarget !== interruptKey(f)) {
        this.armedTarget = interruptKey(f);
      } else {
        this.armedTarget = undefined;
        this.note = "Interrupting…";
        this.actions.interrupt(f).then(
          () => { if (!this.closed) { this.note = "Interrupted."; this.tui.requestRender(); } },
          (e: unknown) => { if (!this.closed) { this.note = `Could not interrupt: ${message(e)}`; this.tui.requestRender(); } },
        );
      }
      this.tui.requestRender();
      return;
    }
    if (f && (data === "R" || data === "A")) {
      const what = data === "R" ? "stale" : "all";
      this.armedTarget = undefined;
      if (this.armedRun?.what !== what || this.armedRun.target !== interruptKey(f)) this.armedRun = { what, target: interruptKey(f) };
      else {
        this.armedRun = undefined;
        const all = f.notebook.ordered().filter((c) => !f.notebook.isMarkdown(c) && !c.disabled);
        const cells = what === "all" ? all : all.filter((c) => c.stale || f.notebook.edited(c));
        this.startRun(f, cells, what === "all" ? `all ${cells.length} cells` : `${cells.length} stale cell${cells.length === 1 ? "" : "s"}`);
      }
      this.tui.requestRender();
      return;
    }
    if (f && data === "S" && this.actions.stopServers && (this.actions.servers?.(f).length ?? 0) > 0) {
      this.armedTarget = undefined;
      this.armedRun = undefined;
      if (this.armedStop !== interruptKey(f)) this.armedStop = interruptKey(f);
      else {
        this.armedStop = undefined;
        const n = this.actions.stopServers(f);
        this.note = n ? `Stopping the marimo server${n === 1 ? "" : "s"}…` : "No server to stop.";
      }
      this.tui.requestRender();
      return;
    }
    if (f && data === "M") {
      this.armedTarget = undefined;
      this.armedRun = undefined;
      this.armedStop = undefined;
      const unmark = this.actions.unmark;
      const c = this.cursorCell(f);
      const selection = c ? f.notebook.lens.selections().filter((s) => s.cells.includes(c.id)).at(-1) : undefined;
      if (!unmark) this.note = "Not available here.";
      else if (!selection) { this.armedUnmark = undefined; this.note = "No Lens selection on this cell."; }
      else if (this.armedUnmark?.id !== selection.id) {
        this.armedUnmark = { id: selection.id, label: selection.label };
        this.note = `M again removes ${selection.label}`;
      } else {
        this.armedUnmark = undefined;
        const label = selection.label;
        this.note = `Removing ${label}…`;
        unmark(f, selection.id).then(
          () => { if (!this.closed) { this.note = `Removed ${label}.`; this.tui.requestRender(); } },
          (e: unknown) => { if (!this.closed) { this.note = `Could not remove ${label}: ${message(e)}`; this.tui.requestRender(); } },
        );
      }
      this.tui.requestRender();
      return;
    }
    this.armedTarget = undefined;
    this.armedRun = undefined;
    this.armedStop = undefined;
    this.armedUnmark = undefined;
    this.note = undefined;
    const nb = f?.notebook;
    this.syncPart();
    if (data === "{") this.switchNotebook(-1);
    else if (data === "}") this.switchNotebook(1);
    else if (matchesKey(data, "o") && f) {
      this.actions.openInBrowser(f);
      this.note = "Opened in the browser.";
    } else if (data === "/") {
      this.typing = true;
      this.findFrom = this.cursor;
      this.filter = "";
    } else if (data === "O") {
      this.section = !this.section;
      sectionMode = this.section;
      this.note = this.section ? "Section view: the whole section." : "Cell view.";
      this.reveal = true;
    } else if (f && nb && (data === "z" || matchesKey(data, "tab"))) {
      const c = this.cursorCell(f);
      const cells = nb.ordered();
      const at = c ? cells.findIndex((x) => x.id === c.id) : -1;
      const head = c && nb.headings(c).length ? c : cells.slice(0, Math.max(0, at)).reverse().find((x) => nb.headings(x).length > 0);
      if (!head) this.note = "No section here.";
      else {
        if (!this.folded.delete(head.id)) this.folded.add(head.id);
        this.cursor = head.id;
        this.follow = false;
        this.reveal = true;
      }
    } else if (f && nb && (data === "Z" || matchesKey(data, "shift+tab"))) {
      if (this.folded.size) this.folded.clear();
      else for (const c of nb.ordered()) if (nb.headings(c).length) this.folded.add(c.id);
      const c = this.cursorCell(f);
      if (c) this.cursor = c.id;
      this.reveal = true;
    } else if (f && nb && this.filter && (matchesKey(data, "ctrl+k") || matchesKey(data, "ctrl+j"))) this.step(f, matchesKey(data, "ctrl+j") ? 1 : -1);
    else if (f && nb && (data === "[" || matchesKey(data, "ctrl+k"))) this.step(f, -1, (c) => nb.headings(c).length > 0, "No section here.");
    else if (f && nb && (data === "]" || matchesKey(data, "ctrl+j"))) this.step(f, 1, (c) => nb.headings(c).length > 0, "No section here.");
    else if (data === "n" || data === "p") {
      if (!this.lastParts.length) this.note = "This cell has one part.";
      else {
        const last = this.lastParts.length - 1;
        if (data === "n") this.part = this.part === undefined ? 0 : Math.min(last, this.part + 1);
        else this.part = this.part === undefined ? last : Math.max(0, this.part - 1);
        this.scrollToPart = true;
      }
    } else if (f && data === "t") this.enterTable(f, this.cursorCell(f));
    else if (f && nb && (data === "c" || data === "C")) {
      if (![...nb.agentChanges.keys()].some((id) => nb.cells.has(id))) this.note = "The agent has not changed a cell since your last message.";
      else this.step(f, data === "c" ? 1 : -1, (c) => nb.agentChanges.has(c.id), "The agent has not changed a cell since your last message.");
    } else if (f && nb && data === "d") {
      const c = this.cursorCell(f);
      if (!c || !nb.agentChanges.has(c.id)) this.note = "The agent has not changed this cell since your last message.";
      else {
        if (!this.diffs.delete(c.id)) { this.diffs.add(c.id); this.codeOpen.add(c.id); }
        this.cursor = c.id;
        this.reveal = true;
      }
    } else if (f && data === "v") {
      this.mode = "variables";
      this.scroll = 0;
      this.reveal = true;
    } else if (f && nb && (data === "<" || data === ">")) {
      const c = this.cursorCell(f);
      const order = nb.order;
      const here = c ? order.indexOf(c.id) : -1;
      const candidates = c ? (data === "<" ? nb.parents(c.id) : nb.children(c.id)) : [];
      const pick = data === "<"
        ? [...candidates].reverse().find((id) => order.indexOf(id) < here) ?? candidates[0]
        : candidates.find((id) => order.indexOf(id) > here) ?? candidates[0];
      if (!pick) this.note = data === "<" ? "No upstream cell." : "No downstream cell.";
      else this.goTo(f, pick);
    } else if (f && data === "w") {
      const c = this.cursorCell(f);
      const widgets = c?.output?.widgets?.slice(0, MAX_WIDGETS) ?? [];
      if (!c || !widgets.length) this.note = "This cell shows no widgets.";
      else if (!this.actions.setWidget) this.note = "Widgets cannot be driven here.";
      else if (f.connection !== "connected") this.note = "The notebook is not connected.";
      else {
        this.widget = { cell: c.id, index: 0, sub: 0 };
        this.cursor = c.id;
        this.follow = false;
        this.reveal = true;
      }
    } else if (f && data === "a") this.openAsk(f);
    else if (f && data === ":") this.openScratch(f);
    else if (f && data === "m") this.openMark(f);
    else if (f && data === "i") {
      const c = this.cursorCell(f);
      if (c && this.live.inspect(c.output)) this.note = "";
      else this.note = "Select a cell with a live chart first, then i.";
    } else if (f && (matchesKey(data, "enter") || matchesKey(data, "l"))) this.activate(f);
    else if (f && data === "r") {
      const c = this.cursorCell(f);
      if (c) this.startRun(f, [c], cellTitle(f.notebook, c));
      else this.note = "No cell selected.";
    } else if (f && data === "e") this.step(f, 1, (c) => !!c.error);
    else if (f && data === "E") this.step(f, -1, (c) => !!c.error);
    else if (data === "f") {
      this.follow = true;
      this.reveal = true;
    } else if (f && (matchesKey(data, "down") || matchesKey(data, "j"))) this.step(f, 1);
    else if (f && (matchesKey(data, "up") || matchesKey(data, "k"))) this.step(f, -1);
    else if (matchesKey(data, "ctrl+u")) this.scrollBy(-Math.max(1, Math.floor(page / 2)));
    else if (matchesKey(data, "ctrl+d")) this.scrollBy(Math.max(1, Math.floor(page / 2)));
    else if (matchesKey(data, "pageUp")) this.scrollBy(-page);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.scrollBy(page);
    else if (matchesKey(data, "home") || data === "g") {
      this.move(-Infinity);
      this.cursor = f ? this.cells(f)[0]?.id : undefined;
    } else if (matchesKey(data, "end") || data === "G") {
      this.follow = false;
      this.scroll = Number.MAX_SAFE_INTEGER;
      this.cursor = f ? this.cells(f).at(-1)?.id : undefined;
      this.reveal = true;
    }
    this.tui.requestRender();
  }

  private move(by: number): void {
    this.follow = false;
    this.scroll = Math.max(0, by === -Infinity ? 0 : this.scroll + by);
  }

  // --- drawing --------------------------------------------------------------------------------

  /** `✗ fit.py  running Model fit · agent: 1 changed`, and flush right when last it ran and where the server is. */
  private header(f: Followed, file: string, inner: number): string {
    const th = this.theme;
    const nb = f.notebook;
    const busy = nb.running() || nb.queued() > 0;
    const errors = nb.errors().length;
    const state = [...kernelStateParts(f), ...lensParts(f)].join(" · ");
    const dot = th.fg("dim", " · ");
    const working = this.actions.agentBusy?.() === true ? `${dot}${th.fg("accent", "agent working")}` : "";
    const servers = this.actions.servers?.(f) ?? [];
    const changes = [...nb.agentChanges.values()];
    const edited = changes.filter((c) => c.kind === "edited" || c.kind === "moved" || c.kind === "renamed").length;
    const created = changes.filter((c) => c.kind === "created").length;
    const removed = changes.filter((c) => c.kind === "deleted").length;
    const agent = changes.length ? `${dot}${th.fg("accent", `agent: ${[edited ? `${edited} changed` : "", created ? `${created} new` : "", removed ? `${removed} removed` : ""].filter(Boolean).join(" · ")}`)}` : "";
    const left = `${busy ? `${th.fg("accent", "●")} ` : errors ? `${th.fg("error", "✗")} ` : ""}${th.bold(file)}  ${state}${working}${agent}`;
    const right = th.fg("dim", [this.actions.lastRun?.(f) ?? "", shortWhere(f.attachment.url) ?? "", servers.length ? `server ${servers.join(", ")}` : ""].filter(Boolean).join(" · "));
    const gap = inner - visibleWidth(left) - visibleWidth(right);
    return visibleWidth(right) && gap >= 2 ? `${left}${" ".repeat(gap)}${right}` : left;
  }

  /** A scratch run's result, as lines. */
  private resultLines(output: { mimetype: string; data: string }, inner: number): string[] {
    const th = this.theme;
    if (output.mimetype.startsWith("image/")) return [th.fg("dim", "[image]")];
    if (output.mimetype === "text/html") {
      const summary = summarizeOutput({ channel: "output", mimetype: output.mimetype, data: output.data });
      if (summary?.table) return tableLines(summary.table, inner, th, 8);
      return summary?.text ? summary.text.split("\n") : [];
    }
    return output.data ? output.data.split("\n") : [];
  }

  /** What the scratch run printed and returned, newest last. */
  private scratchLines(inner: number): string[] {
    const s = this.scratch;
    if (!s) return [];
    const th = this.theme;
    const lines = [th.fg("accent", `>>> ${truncate(firstLine(s.code), 200)}`)];
    for (const e of s.lines) lines.push(e.stream === "stderr" ? th.fg("warning", e.text) : e.text);
    if (s.running) lines.push(th.fg("dim", `running ${elapsed(Date.now() - s.started)}`));
    else if (s.error) lines.push(s.error === "cancelled" ? th.fg("dim", "cancelled") : th.fg("error", `✗ ${s.error}`));
    else if (s.result && !s.result.success) lines.push(th.fg("error", "✗ failed (the traceback is above)"));
    else if (s.result?.output) lines.push(...this.resultLines(s.result.output, inner));
    return lines.slice(-SCRATCH_ROWS);
  }

  /** The docked prompt, with a scratch run above it: full frame rows. */
  private dockRows(width: number): string[] {
    const dock = this.dock;
    if (!dock) {
      this.lastDock = 0;
      return [];
    }
    const th = this.theme;
    const out = [frameRule(width, th)];
    if (dock.kind === "scratch" && this.scratch) out.push(...this.scratchLines(width - 4).map((l) => frameRow(l, width, th)));
    const half = dock.kind === "markdown" ? Math.max(6, Math.floor(this.tui.terminal.rows * 0.6)) : Math.max(4, Math.floor(this.tui.terminal.rows / 2));
    const room = Math.max(3, half - out.length);
    out.push(...dock.render(width - 4, room).map((l) => frameRow(l, width, th)));
    this.lastDock = out.length;
    return out;
  }

  /** Scroll so row `at` shows when asked to, within the rows there are. */
  private place(length: number, at: number | undefined, page: number): void {
    const max = Math.max(0, length - page);
    if (this.reveal && at !== undefined) {
      if (this.scroll === Number.MAX_SAFE_INTEGER) this.scroll = max;
      if (at < this.scroll) this.scroll = at;
      else if (at >= this.scroll + page) this.scroll = at - page + 1;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, max));
    this.reveal = false;
  }

  /** What the `?` page lists first: where the notebook is. */
  private whereText(f: Followed): string {
    const servers = this.actions.servers?.(f) ?? [];
    return [f.attachment.path, f.attachment.url, servers.length ? `server ${servers.join(", ")}` : ""].filter(Boolean).join(" · ");
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const th = this.theme;
    const inner = width - 4;
    const row = (s: string) => frameRow(s, width, th);
    const rule = frameRule(width, th);
    const fit = (text: string, w: number) => truncateToWidth(text, Math.max(1, w), "…", true);
    this.syncConfirmation();
    const f = this.current();
    const file = basename(f?.attachment.path ?? notebookPath(this.key));
    const out = [this.actions.docked ? dockedBanner(file, width, th, this.actions.docked.focused()) : banner(`Notebook ${file}`, width, th)];
    if (!f && this.dock) this.closeDock();
    if (!f) this.widget = undefined;
    else if (this.widget) this.drivenWidgets(f);
    const dock = this.dockRows(width);
    const page = this.viewport();
    this.lastPage = page;
    if (!f) {
      out.push(row(`${th.bold(file)}  ${th.fg("dim", "No longer followed.")}`), rule);
      for (let i = 0; i < page; i++) out.push(row(""));
      this.lastRows = [];
      this.lastOutline = [];
      this.lastDetail = [];
    } else if (this.help) {
      out.push(row(this.header(f, file, inner)), rule);
      const rows = helpLines(th, this.whereText(f)).map((text): Row => ({ text }));
      this.lastRows = rows;
      for (let i = 0; i < page; i++) out.push(row(rows[i]?.text ?? ""));
    } else if (this.mode === "variables") {
      out.push(row(this.header(f, file, inner)), rule);
      const nb = f.notebook;
      const list = variableList(nb, this.varFilter);
      if (!this.varCursor || !list.some((v) => v.name === this.varCursor)) this.varCursor = list[0]?.name;
      let built = variableRows(list, nb, th, this.varCursor, width - 4, this.varFilter);
      const at = this.varCursor !== undefined ? built.index.get(this.varCursor) : undefined;
      this.place(built.rows.length, at, page);
      // Scrolled away from the cursor: it moves to the nearest variable on screen.
      if (at !== undefined && (at < this.scroll || at >= this.scroll + page)) {
        const pick = list[at < this.scroll ? this.scroll : Math.min(list.length - 1, this.scroll + page - 1)];
        if (pick) {
          this.varCursor = pick.name;
          built = variableRows(list, nb, th, this.varCursor, width - 4, this.varFilter);
        }
      }
      this.lastRows = built.rows;
      for (let i = 0; i < page; i++) out.push(row(built.rows[this.scroll + i]?.text ?? ""));
    } else {
      out.push(row(this.header(f, file, inner)), rule);
      const nb = f.notebook;
      const cells = this.cells(f);
      const running = nb.running();
      // Following: the cursor stays on the running cell, or on the fold that hides it.
      if (this.follow && running) {
        const head = this.filter ? undefined : foldedCells(nb, this.folded).get(running.cell.id);
        const target = head ?? running.cell.id;
        if (cells.some((c) => c.id === target)) this.cursor = target;
      }
      if (!this.cursor || !cells.some((c) => c.id === this.cursor)) this.cursor = cells[0]?.id;
      // The outline and the detail side by side; narrower, a few outline rows around the cursor above the detail.
      const split = width >= SPLIT_MIN;
      const lw = split ? outlineWidth(width) : inner;
      const dw = split ? inner - lw - SEPARATOR_WIDTH : inner;
      const shows = split ? "both" : "stacked";
      const oh = split ? page : stackedOutlineRows(page);
      const dh = split ? page : page - oh - 1;
      const detailTop = split ? 0 : oh + 1;
      this.panes = { lw, detailLeft: split ? 2 + lw + SEPARATOR_WIDTH : 2, detailTop, outlineHeight: oh, shows };
      const outline = (): ReturnType<typeof outlineRows> => outlineRows(nb, th as PaneTheme, Date.now(), { cursor: this.cursor, folded: this.folded, filter: this.filter, width: lw });
      let built = outline();
      const at = this.cursor !== undefined ? built.cellRows.get(this.cursor) : undefined;
      if (!split) {
        // Stacked: the cursor's neighbours, the cursor in the middle.
        const centre = this.follow && running && built.running !== undefined ? built.running : at;
        if (centre !== undefined) this.scroll = Math.max(0, Math.min(centre - Math.floor((oh - 1) / 2), built.rows.length - oh));
        this.reveal = false;
      } else if (this.follow && running && built.running !== undefined) {
        this.scroll = Math.min(Math.max(0, built.rows.length - page), Math.max(0, built.running - Math.floor(page / 3)));
        this.reveal = false;
      } else this.place(built.rows.length, at, page);
      // Scrolled away from the cursor: it moves to the nearest cell on screen.
      if (split && at !== undefined && !this.follow && !this.widget && (at < this.scroll || at >= this.scroll + page)) {
        const visible = cells.filter((c) => { const r = built.cellRows.get(c.id); return r !== undefined && r >= this.scroll && r < this.scroll + page; });
        const pick = at < this.scroll ? visible[0] : visible.at(-1);
        if (pick) {
          this.cursor = pick.id;
          built = outline();
        }
      }
      this.lastOutline = built.rows;
      // The detail: the cursor's cell (or its section), at its own scroll.
      this.live.beginFrame();
      const cell = cells.find((c) => c.id === this.cursor);
      let detail: Row[] = [];
      if (cell) {
        this.syncPart();
        // A table the view drives: its page, cursor and selection; a cell that needs its rows asks for them once.
        const tableSource = (c: Cell) => {
          const t = this.tableFor(f, c);
          if (!t) return undefined;
          const s = t.session;
          if (c.id === cell.id && s.needsFetch() && this.actions.table) void s.refresh(f, this.actions.table);
          const focused = this.table?.cell === c.id;
          if (focused) s.ensureVisible(dw - 6);
          const picked = s.selection(nb);
          const cells = new Set<string>();
          const rows = new Set<string>();
          for (const v of picked) {
            if (typeof v === "object" && v !== null) cells.add(`${String((v as { rowId?: unknown }).rowId)}\0${String((v as { columnName?: unknown }).columnName)}`);
            else rows.add(String(v));
          }
          const status = [s.query ? `search "${s.query}"` : "", s.filters.length ? `${s.filters.length} filter${s.filters.length === 1 ? "" : "s"}` : "", picked.length ? `${picked.length} selected` : "", s.loading ? "loading…" : "", s.error ?? ""].filter(Boolean).join(" · ");
          const sorted = s.sort.map((x) => `sorted ${x.by}`).join(", ");
          const note = [sorted, s.filters.length || s.query ? "filtered" : ""].filter(Boolean).join(" · ");
          return {
            data: t.data,
            ...(note ? { note } : {}),
            render: {
              focused, cursorRow: s.row, cursorCol: s.col, colOffset: s.colOffset, selected: rows, selectedCells: cells, sort: s.sort,
              ...(s.summariesOn && s.summaries ? { summaries: s.summaries } : {}),
              ...(status ? { status } : {}),
              rowIdOf: (i: number) => s.rowId(i), firstRow: s.page * s.pageSize,
              ...(t.data.totalRows !== undefined ? { totalRows: t.data.totalRows } : {}),
            },
          };
        };
        const tableCard = (c: Cell): string[] | undefined => {
          const t = this.tableFor(f, c);
          const card = t?.session.card;
          if (!t || !card || this.table?.cell !== c.id) return undefined;
          const lines = card.kind === "row"
            ? rowCard(t.data, card.index, dw - 2, th as PaneTheme, t.session.page * t.session.pageSize + card.index)
            : columnCard(t.data, card.column, t.session.summaries, card.top, dw - 2, th as PaneTheme);
          return lines;
        };
        const d = detailRows(nb, th, Date.now(), {
          cell, width: dw, codeOpen: this.codeOpen.has(cell.id), diff: this.diffs.has(cell.id), section: this.section,
          table: tableSource, tableCard, partFocus: this.part,
          ...(this.widget ? { widgetFocus: this.widget } : {}),
          imageRows: dh - 1, vega: this.vega, plotly: this.plotly,
          ...(this.actions.liveCharts === false ? {} : { live: this.live }),
          onVega: () => { if (!this.closed) this.tui.requestRender(); },
        });
        detail = d.rows;
        this.lastParts = d.parts;
        if (this.part !== undefined && this.part >= d.parts.length) this.part = d.parts.length ? d.parts.length - 1 : undefined;
        const key = `${cell.id}\0${this.section}`;
        if (key !== this.detailKey) {
          this.detailKey = key;
          this.detailScroll = this.section && d.focusRow !== undefined ? Math.max(0, d.focusRow - 2) : 0;
        }
        if (this.scrollToPart) {
          const at = this.part !== undefined ? d.parts[this.part] : undefined;
          if (at) this.detailScroll = Math.max(0, at.row - 1);
          this.scrollToPart = false;
        }
        const focused = this.widget ? d.widgetRows.get(`${this.widget.cell}\0${this.widget.index}`) : undefined;
        if (focused !== undefined) {
          if (focused < this.detailScroll) this.detailScroll = focused;
          else if (focused >= this.detailScroll + dh) this.detailScroll = focused - dh + 1;
        }
        this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, detail.length - dh)));
      }
      this.lastDetail = detail;
      // An image draws only when its whole block is on screen; otherwise a note stands in for it.
      const visible = (i: number): boolean => {
        const r = detail[i];
        if (!r?.image) return true;
        const start = i - r.image.index;
        return start >= this.detailScroll && start + r.image.height <= this.detailScroll + dh;
      };
      const detailText = (i: number): string => {
        const r = detail[i];
        if (!r?.image || visible(i)) return r?.text ?? "";
        return r.image.index === 0 ? r.image.alt : r.text;
      };
      for (let i = 0; i < page; i++) {
        const left = i < oh ? built.rows[this.scroll + i]?.text ?? (this.filter && !cells.length && i === 0 ? th.fg("dim", `No cell matches "${this.filter}".`) : "") : "";
        if (!split && i === oh) { out.push(row(th.fg("dim", "─".repeat(inner)))); continue; }
        if (!split && i < oh) { out.push(row(left)); continue; }
        const di = this.detailScroll + i - detailTop;
        const r = detail[di];
        if (r?.image?.live && r.image.index === 0 && visible(di)) this.live.rects.push({ top: out.length, left: this.panes.detailLeft + 2, geometry: r.image.live.geometry, output: r.image.live.output });
        out.push(row(split ? `${fit(left, lw)}${th.fg("dim", " │ ")}${fit(detailText(di), dw)}` : detailText(di)));
      }
      this.live.endFrame();
    }
    out.push(...dock);
    out.push(rule);
    out.push(row(this.footer(f, width - 4)));
    out.push(bottom(width, th));
    // The images this frame draws stay when the painter wipes the transcript's from under the view.
    const ids = new Set<number>();
    for (const line of out) if (line.includes("\x1b_G")) for (const m of line.matchAll(/\x1b_G([^;\x1b]*)/gu)) {
      const id = /(?:^|,)i=(\d+)(?:,|$)/u.exec(m[1]!)?.[1];
      if (id !== undefined) ids.add(Number(id));
    }
    if (!this.actions.docked) Painter.for(this.tui)?.setViewImages(ids);
    return out;
  }

  private footer(f: Followed | undefined, inner: number): string {
    const th = this.theme;
    const nav = th.fg("dim", this.actions.docked ? "? keys · esc chat · q close" : "? keys · esc back");
    const withNav = (left: string) => {
      const gap = inner - visibleWidth(left) - visibleWidth(nav);
      return gap >= 1 ? `${left}${" ".repeat(gap)}${nav}` : left;
    };
    const noted = (hint: string) => (this.note ? `${th.fg("warning", this.note)}  ${th.fg("dim", hint)}` : th.fg("dim", hint));
    if (this.help) return th.fg("dim", "any key closes");
    if (this.dock) return this.note ? th.fg("warning", this.note) : th.fg("dim", "esc closes the prompt");
    if (this.live.inspecting) return `${th.fg("accent", "chart")} ${th.fg("dim", "arrows or hjkl move (shift: farther) · space starts/ends a drag · +/- zoom · 0 reset · esc done")}`;
    if (this.typing) {
      const text = this.mode === "variables" ? this.varFilter : this.filter;
      return `${th.fg("accent", "/")} ${text}${th.fg("dim", "▏")}  ${th.fg("dim", "enter keep · esc clear")}`;
    }
    if (this.table) return withNav(noted("table: hjkl move · [ ] page · s sort · / search · f filter · space select · enter row · i column · c summary · y copy · D csv · esc done"));
    if (this.widget) return withNav(noted("widget: h/l change · space toggle · enter type · j/k next · esc done"));
    if (this.mode === "variables") return withNav(noted(`enter its cell · > first use · ${this.varFilter ? `/ ${this.varFilter}` : "/ filter"} · v back`));
    const connected = !!f && f.connection === "connected";
    const busy = connected && (f.notebook.running() || f.notebook.queued() > 0);
    // Armed keys and notes stand in for the hints.
    if (this.armedRun?.what === "stale") return withNav(th.fg("error", "R again to run stale cells"));
    if (this.armedRun?.what === "all") return withNav(th.fg("error", "A again to run all cells"));
    if (this.armedTarget) return withNav(th.fg("error", "x again to interrupt"));
    if (this.armedStop) return withNav(th.fg("error", "S again to stop the server"));
    if (this.note) return withNav(th.fg("warning", this.note));
    const cell = f ? this.cursorCell(f) : undefined;
    const hints: string[] = [];
    const focused = this.part !== undefined ? this.lastParts[this.part] : undefined;
    if (f) {
      hints.push("↑↓ cells");
      if (focused) hints.push(`enter ${focused.kind === "markdown" ? "edit" : focused.kind === "table" || focused.kind === "chart" || focused.kind === "widgets" || focused.kind === "code" ? (focused.kind === "widgets" ? "widgets" : focused.kind) : ""}`.trim());
      else hints.push(cell && f.notebook.isMarkdown(cell) ? "enter edit" : "enter code");
    }
    const more: string[] = [];
    if (this.lastParts.length > 1) more.push("n/p parts");
    if (this.lastParts.some((p) => p.kind === "table") && this.actions.table) more.push("t table");
    if (cell?.output?.widgets?.length && this.actions.setWidget) more.push("w widgets");
    if (f && cell && f.notebook.agentChanges.has(cell.id)) more.push("d diff");
    if (f && (cell?.error || f.notebook.errors().length)) more.push("e next error");
    if (f && this.live.rects.length) more.push("i inspect chart");
    if (busy) more.push("x interrupt");
    if (f && this.actions.ask) more.push("a ask");
    if (connected && this.actions.scratch) more.push(": python");
    hints.push(...more.slice(0, 6 - hints.length));
    if (f && this.filter) hints.unshift(th.fg("accent", `/ ${this.filter}`));
    return withNav(th.fg("dim", hints.slice(0, 6).join(" · ")));
  }

  /** A theme change or resize: the terminal may have dropped image data with the redraw, so live charts upload their frames again. */
  invalidate(): void {
    this.live.refresh();
  }

  private close(): void {
    if (this.closed) return;
    this.dispose();
    this.done();
  }

  /** A live chart takes the mouse over it; elsewhere the wheel scrolls the pane under it, a click selects, a double click opens the code. */
  /** The widget under the pointer in the detail, and the column inside its line (after the bar and its glyph). */
  private widgetAt(event: TuiMouseEvent): { f: Followed; cell: Cell; w: Widget; index: number; col: number } | undefined {
    const f = this.current();
    const line = event.y - ROWS_TOP;
    if (!f || this.mode !== "cells" || this.paneAt(event.x, line) !== "detail") return undefined;
    const r = this.lastDetail[this.detailScroll + line - this.panes.detailTop];
    if (!r?.widget) return undefined;
    const cell = f.notebook.cells.get(r.widget.cell);
    const w = cell?.output?.widgets?.[r.widget.index];
    return cell && w ? { f, cell, w, index: r.widget.index, col: event.x - this.panes.detailLeft - WIDGET_TEXT } : undefined;
  }

  /** A click (or a drag) on a widget: focuses it, and does what the click means at that place on its control. */
  private clickWidget(at: { f: Followed; cell: Cell; w: Widget; index: number; col: number }, dragging = false): boolean {
    const { f, cell, w, index } = at;
    if (!this.actions.setWidget || f.connection !== "connected") return false;
    const sub = this.widget?.cell === cell.id && this.widget.index === index ? this.widget.sub : 0;
    this.widget = { cell: cell.id, index, sub };
    if (!this.section) this.cursor = cell.id;
    this.follow = false;
    const hit = widgetHit(w, widgetValue(f.notebook, w), at.col);
    if (!hit) return false;
    if (w.disabled) { this.note = "This widget is disabled."; return false; }
    if ("type" in hit) { if (!dragging) this.openValue(f, cell, w); return false; }
    if ("value" in hit) {
      if (hit.sub !== undefined) this.widget.sub = hit.sub;
      this.actions.setWidget(f, cell, w, hit.value);
      return hit.drag === true;
    }
    if (dragging) return false;
    const next = nextValue(w, widgetValue(f.notebook, w), hit.action, this.widget.sub);
    if (next) {
      this.widget.sub = next.sub;
      if (next.send) this.actions.setWidget(f, cell, w, next.value);
    }
    return false;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const live = this.live.mouse(event);
    if (live) return live;
    if (this.closed) return undefined;
    // A slider dragged with the mouse follows it until the button goes up.
    if (this.dragging && (event.type === "drag" || event.type === "release")) {
      const at = this.widgetAt({ ...event, y: Math.max(ROWS_TOP, event.y) });
      const f = this.current();
      const cell = f?.notebook.cells.get(this.dragging.cell);
      const w = cell?.output?.widgets?.[this.dragging.index];
      if (f && cell && w) this.clickWidget({ f, cell, w, index: this.dragging.index, col: at?.cell.id === cell.id && at.index === this.dragging.index ? at.col : event.x - this.panes.detailLeft - WIDGET_TEXT }, true);
      if (event.type === "release") this.dragging = undefined;
      this.tui.requestRender();
      return { handled: true };
    }
    if (event.type === "wheel") {
      if (this.help || this.dock) return { handled: true };
      const by = event.wheelDelta ?? 0;
      const pane = this.mode === "cells" ? this.paneAt(event.x, event.y - ROWS_TOP) : undefined;
      const f = this.current();
      // Over the focused widget the wheel changes it (up: more); elsewhere it scrolls.
      const over = this.widgetAt(event);
      if (over && by && this.widget?.cell === over.cell.id && this.widget.index === over.index && this.actions.setWidget && !over.w.disabled) {
        const next = nextValue(over.w, widgetValue(over.f.notebook, over.w), by < 0 ? "inc" : "dec", this.widget.sub);
        if (next?.send) this.actions.setWidget(over.f, over.cell, over.w, next.value);
        this.tui.requestRender();
        return { handled: true };
      }
      if (pane === "detail") this.detailScroll = Math.max(0, this.detailScroll + by);
      // The stacked outline is centred on the cursor: the wheel moves the cursor.
      else if (pane === "outline" && this.panes.shows === "stacked") { if (f && by) this.step(f, by > 0 ? 1 : -1); }
      else this.move(by);
      this.tui.requestRender();
      return { handled: true };
    }
    if (event.button !== "left" || event.y < ROWS_TOP || event.y >= ROWS_TOP + this.lastPage) return undefined;
    if (event.type === "press") {
      // A press on a slider's bar sets it there and drags it from then on.
      const at = this.dock || this.help ? undefined : this.widgetAt(event);
      if (at && at.w.kind.endsWith("slider") && this.clickWidget(at)) {
        this.dragging = { cell: at.cell.id, index: at.index };
        this.tui.requestRender();
        return { handled: true, capture: true };
      }
      // Pi turns a press and release into a click only for the component that took the press.
      return { handled: true, render: false };
    }
    if (event.type !== "click") return undefined;
    if (this.help) {
      this.help = false;
      this.tui.requestRender();
      return { handled: true };
    }
    const f = this.current();
    if (!f || this.dock) return { handled: true };
    const line = event.y - ROWS_TOP;
    const twice = (event.clickCount ?? 1) >= 2;
    if (this.mode === "variables") {
      const r = this.lastRows[this.scroll + line];
      if (r?.variable) {
        const again = this.varCursor === r.variable;
        this.varCursor = r.variable;
        if (again || twice) this.activate(f);
      }
    } else if (this.paneAt(event.x, line) === "detail") {
      const r = this.lastDetail[this.detailScroll + line - this.panes.detailTop];
      if (this.table && r?.tableRow !== undefined) {
        const t = f.notebook.cells.get(this.table.cell);
        const tf = t ? this.tableFor(f, t) : undefined;
        if (tf) { tf.session.row = r.tableRow; tf.session.card = undefined; }
      } else if (r?.part !== undefined && !r.widget && !r.code) {
        this.part = r.part;
        if (twice) this.activate(f);
      } else if (r?.widget && this.actions.setWidget && f.connection === "connected") {
        const at = this.widgetAt(event);
        // A slider was set by its press already.
        if (at && !(at.w.kind.endsWith("slider") && widgetHit(at.w, widgetValue(f.notebook, at.w), at.col))) this.clickWidget(at);
        else if (at) this.widget = { cell: at.cell.id, index: at.index, sub: this.widget?.sub ?? 0 };
      } else if (r?.code) {
        const c = this.cursorCell(f);
        if (r.part !== undefined) this.part = r.part;
        if (c) this.toggleCode(this.lastParts[r.part ?? -1]?.cell ?? c.id);
      }
    } else if (this.paneAt(event.x, line) === "outline") {
      const r = this.lastOutline[this.scroll + line];
      if (r?.cell) {
        const again = this.cursor === r.cell;
        this.cursor = r.cell;
        this.follow = false;
        this.widget = undefined;
        this.table = undefined;
        if (again || twice) this.activate(f);
      }
    }
    this.tui.requestRender();
    return { handled: true };
  }

  dispose(): void {
    if (!this.closed && !this.actions.docked) Painter.for(this.tui)?.setExclusive(false);
    this.closed = true;
    clearInterval(this.timer);
    this.scratch?.abort.abort();
    this.dock?.dispose();
    this.dock = undefined;
    this.live.dispose();
  }
}
