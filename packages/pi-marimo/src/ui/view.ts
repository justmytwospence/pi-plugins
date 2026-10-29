// A notebook, full screen (frame.ts), where you read and steer it. A one-line header (kernel state,
// the agent's changes, the last run), then two panes: the outline on the left (outline.ts: the
// headings and a short line per cell) and the selected cell on the right (detail.ts: prose, output,
// error with its traceback, folded code, dataflow). Narrower than SPLIT_MIN columns the outline
// fills the view and Enter drills into the detail (Esc comes back). It follows the running cell
// until you move. Keys (also `?`):
//   j/k move between cells, [ ] between sections, z/Z fold; Enter/l opens the cell's code; n/N
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
import { summarizeOutput, type Widget } from "../core/output.js";
import { elapsed, shortWhere } from "../core/render.js";
import type { Followed } from "../core/watcher.js";
import { kernelStateParts, lensParts } from "../bg.js";
import { INPUT_CONTEXT } from "../activity.js";
import { interruptKey, notebookKey, notebookPath } from "./identity.js";
import { banner, bottom, row as frameRow, rule as frameRule, type FrameTheme } from "../frame.ts";
import type { EditorFactoryFn } from "../editor-contract.ts";
import { Dock, type DockSpec } from "./dock.js";
import { detailRows } from "./detail.js";
import { helpLines } from "./help.js";
import { type PaneTheme, outlineRows } from "./outline.js";
import { MAX_WIDGETS, type Row, firstLine, foldedCells, selectableCells } from "./rows.js";
import { cellTitle } from "./titles.js";
import type { ScratchEvent, ScratchResult } from "./scratch.js";
import { tableLines } from "./table.js";
import { variableList, variableRows } from "./variables.js";
import { type WidgetAction, nextValue, typeable, typedValue, widgetValue } from "./widgets.js";

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
/** Between the panes. */
const SEPARATOR_WIDTH = 3;
/** Lines of a scratch run shown above its prompt, at most. */
const SCRATCH_ROWS = 12;

/** One cell or its whole section in the detail: the choice holds for the rest of the Pi process. */
let sectionMode: boolean | undefined;

export interface ViewActions {
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

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class NotebookView implements Component {
  private scroll = 0;
  private follow = true;
  private cursor: string | undefined;
  /** Cells whose code shows in the detail. */
  private codeOpen = new Set<string>();
  /** The detail's scroll, in its own rows. */
  private detailScroll = 0;
  /** Narrow view: the detail fills the view instead of the outline. */
  private narrowDetail = false;
  /** Which cell (and view) the detail last drew, so a new one starts at its top. */
  private detailKey = "";
  private lastOutline: Row[] = [];
  private lastDetail: Row[] = [];
  /** Where the panes are: the outline's width, the detail's left column, which panes show. */
  private panes: { lw: number; detailLeft: number; shows: "both" | "outline" | "detail" } = { lw: 28, detailLeft: 0, shows: "both" };
  private filter = "";
  /** Typing a filter: keys go to it. */
  private typing = false;
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
  /** The widget the keys drive. */
  private widget: { cell: string; index: number; sub: number } | undefined;
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
    this.live = live ?? new LiveCharts(() => { if (!this.closed) this.tui.requestRender(); }, undefined, undefined, undefined, () => Painter.for(this.tui), "overlay");
    Painter.for(this.tui)?.setExclusive(true);
    this.tui.requestRender();
    this.timer = setInterval(() => {
      if (!this.closed) {
        this.syncConfirmation();
        this.tui.requestRender();
      }
    }, TICK_MS);
    this.timer.unref?.();
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
    let text = vars ? this.varFilter : this.filter;
    if (matchesKey(data, "escape")) {
      text = "";
      this.typing = false;
    } else if (matchesKey(data, "enter")) this.typing = false;
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
    this.narrowDetail = false;
    this.widget = undefined;
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
    if (matchesKey(data, "ctrl+c")) { this.close(); return; }
    if (matchesKey(data, "escape") && this.varFilter) { this.varFilter = ""; this.varCursor = undefined; return; }
    if (matchesKey(data, "escape") || data === "v" || data === "q" || data === "h" || matchesKey(data, "left")) {
      this.mode = "cells";
      this.scroll = 0;
      this.reveal = true;
      return;
    }
    if (matchesKey(data, "shift+tab")) { this.switchNotebook(-1); this.mode = "variables"; return; }
    if (matchesKey(data, "tab")) { this.switchNotebook(1); this.mode = "variables"; return; }
    if (data === "/") { this.typing = true; this.varFilter = ""; return; }
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

  /** Enter (or a double click): open or fold the cell's code, drill into the detail when only the outline shows, or go to the variable's cell. */
  private activate(f: Followed): void {
    if (this.mode === "variables") return this.variablesKey(f, "\r");
    const c = this.cursorCell(f);
    if (!c) return;
    this.cursor = c.id;
    this.reveal = true;
    if (this.panes.shows === "outline") this.narrowDetail = true;
    else this.toggleCode(c.id);
  }

  private toggleCode(id: string): void {
    if (!this.codeOpen.delete(id)) this.codeOpen.add(id);
  }

  /** The pane an x column is over. */
  private paneAt(x: number): "outline" | "detail" {
    const { shows, detailLeft } = this.panes;
    return shows === "detail" || (shows === "both" && x >= detailLeft) ? "detail" : "outline";
  }

  /** ^D, PgDn and the like: the detail scrolls (the outline follows the cursor); with only the outline showing, it scrolls. */
  private scrollBy(by: number): void {
    if (this.mode === "cells" && this.panes.shows !== "outline") this.detailScroll = Math.max(0, this.detailScroll + by);
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
    if (this.narrowDetail && this.panes.shows === "detail" && (matchesKey(data, "escape") || data === "h" || matchesKey(data, "left"))) {
      this.narrowDetail = false;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape") && this.filter) {
      this.filter = "";
      this.cursor = undefined;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q") || matchesKey(data, "h") || matchesKey(data, "left")) {
      this.close();
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
    if (matchesKey(data, "shift+tab")) this.switchNotebook(-1);
    else if (matchesKey(data, "tab")) this.switchNotebook(1);
    else if (matchesKey(data, "o") && f) {
      this.actions.openInBrowser(f);
      this.note = "Opened in the browser.";
    } else if (data === "/") {
      this.typing = true;
      this.filter = "";
    } else if (data === "O") {
      this.section = !this.section;
      sectionMode = this.section;
      this.note = this.section ? "Section view: the whole section." : "Cell view.";
      if (this.panes.shows === "outline") this.narrowDetail = true;
      this.reveal = true;
    } else if (f && nb && data === "z") {
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
    } else if (f && nb && data === "Z") {
      if (this.folded.size) this.folded.clear();
      else for (const c of nb.ordered()) if (nb.headings(c).length) this.folded.add(c.id);
      const c = this.cursorCell(f);
      if (c) this.cursor = c.id;
      this.reveal = true;
    } else if (f && nb && data === "[") this.step(f, -1, (c) => nb.headings(c).length > 0, "No section here.");
    else if (f && nb && data === "]") this.step(f, 1, (c) => nb.headings(c).length > 0, "No section here.");
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
        if (this.panes.shows === "outline") this.narrowDetail = true;
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
        if (this.panes.shows === "outline") this.narrowDetail = true;
      }
    } else if (f && data === "a") this.openAsk(f);
    else if (f && data === ":") this.openScratch(f);
    else if (f && data === "m") this.openMark(f);
    else if (f && data === "i") {
      const c = this.cursorCell(f);
      if (c && this.panes.shows !== "outline" && this.live.inspect(c.output)) this.note = "";
      else this.note = "Select a cell with a live chart first (in a narrow view, open its detail), then i.";
    } else if (f && (matchesKey(data, "enter") || matchesKey(data, "l"))) this.activate(f);
    else if (f && data === "r") {
      const c = this.cursorCell(f);
      if (c) this.startRun(f, [c], cellTitle(f.notebook, c));
      else this.note = "No cell selected.";
    } else if (f && data === "n") this.step(f, 1, (c) => !!c.error);
    else if (f && data === "N") this.step(f, -1, (c) => !!c.error);
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
    const left = `${busy ? th.fg("accent", "●") : errors ? th.fg("error", "✗") : th.fg("dim", "○")} ${th.bold(file)}  ${state}${working}${agent}`;
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
    const room = Math.max(3, Math.max(4, Math.floor(this.tui.terminal.rows / 2)) - out.length);
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
    const out = [banner(`Notebook ${file}`, width, th)];
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
      // The outline and the detail side by side, or one of them filling the view.
      const split = width >= SPLIT_MIN;
      const lw = split ? outlineWidth(width) : inner;
      const dw = split ? inner - lw - SEPARATOR_WIDTH : inner;
      const shows = split ? "both" : this.narrowDetail ? "detail" : "outline";
      if (split) this.narrowDetail = false;
      this.panes = { lw, detailLeft: split ? 2 + lw + SEPARATOR_WIDTH : 2, shows };
      const outline = (): ReturnType<typeof outlineRows> => outlineRows(nb, th as PaneTheme, Date.now(), { cursor: this.cursor, folded: this.folded, filter: this.filter, width: lw });
      let built = outline();
      const at = this.cursor !== undefined ? built.cellRows.get(this.cursor) : undefined;
      if (this.follow && running && built.running !== undefined) {
        this.scroll = Math.min(Math.max(0, built.rows.length - page), Math.max(0, built.running - Math.floor(page / 3)));
        this.reveal = false;
      } else this.place(built.rows.length, at, page);
      // Scrolled away from the cursor: it moves to the nearest cell on screen.
      if (at !== undefined && !this.follow && !this.widget && shows !== "detail" && (at < this.scroll || at >= this.scroll + page)) {
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
      const cell = shows === "outline" ? undefined : cells.find((c) => c.id === this.cursor);
      let detail: Row[] = [];
      if (cell) {
        const d = detailRows(nb, th, Date.now(), {
          cell, width: dw, codeOpen: this.codeOpen.has(cell.id), diff: this.diffs.has(cell.id), section: this.section,
          ...(this.widget ? { widgetFocus: this.widget } : {}),
          imageRows: page - 1, vega: this.vega, plotly: this.plotly,
          ...(this.actions.liveCharts === false ? {} : { live: this.live }),
          onVega: () => { if (!this.closed) this.tui.requestRender(); },
        });
        detail = d.rows;
        const key = `${cell.id}\0${this.section}`;
        if (key !== this.detailKey) {
          this.detailKey = key;
          this.detailScroll = this.section && d.focusRow !== undefined ? Math.max(0, d.focusRow - 2) : 0;
        }
        const focused = this.widget ? d.widgetRows.get(`${this.widget.cell}\0${this.widget.index}`) : undefined;
        if (focused !== undefined) {
          if (focused < this.detailScroll) this.detailScroll = focused;
          else if (focused >= this.detailScroll + page) this.detailScroll = focused - page + 1;
        }
        this.detailScroll = Math.max(0, Math.min(this.detailScroll, Math.max(0, detail.length - page)));
      }
      this.lastDetail = detail;
      // An image draws only when its whole block is on screen; otherwise a note stands in for it.
      const visible = (i: number): boolean => {
        const r = detail[i];
        if (!r?.image) return true;
        const start = i - r.image.index;
        return start >= this.detailScroll && start + r.image.height <= this.detailScroll + page;
      };
      const detailText = (i: number): string => {
        const r = detail[i];
        if (!r?.image || visible(i)) return r?.text ?? "";
        return r.image.index === 0 ? r.image.alt : r.text;
      };
      for (let i = 0; i < page; i++) {
        const di = this.detailScroll + i;
        const r = detail[di];
        if (r?.image?.live && r.image.index === 0 && visible(di)) this.live.rects.push({ top: out.length, left: this.panes.detailLeft + 2, geometry: r.image.live.geometry, output: r.image.live.output });
        const left = built.rows[this.scroll + i]?.text ?? (this.filter && !cells.length && i === 0 ? th.fg("dim", `No cell matches "${this.filter}".`) : "");
        if (shows === "both") out.push(row(`${fit(left, lw)}${th.fg("dim", " │ ")}${fit(detailText(di), dw)}`));
        else out.push(row(shows === "detail" ? detailText(di) : left));
      }
      this.live.endFrame();
    }
    out.push(...dock);
    out.push(rule);
    out.push(row(this.footer(f, width - 4)));
    out.push(bottom(width, th));
    return out;
  }

  private footer(f: Followed | undefined, inner: number): string {
    const th = this.theme;
    const nav = th.fg("dim", "? keys · esc back");
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
    if (f) hints.push("↑↓ cells", this.panes.shows === "outline" ? "enter open" : "enter code");
    const more: string[] = [];
    if (f && this.live.rects.length) more.push("i inspect chart");
    if (cell?.output?.widgets?.length && this.actions.setWidget) more.push("w widgets");
    if (f && cell && f.notebook.agentChanges.has(cell.id)) more.push("d diff");
    if (f && (cell?.error || f.notebook.errors().length)) more.push("n next error");
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
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const live = this.live.mouse(event);
    if (live) return live;
    if (this.closed) return undefined;
    if (event.type === "wheel") {
      if (this.help || this.dock) return { handled: true };
      const by = event.wheelDelta ?? 0;
      if (this.mode === "cells" && this.paneAt(event.x) === "detail") this.detailScroll = Math.max(0, this.detailScroll + by);
      else this.move(by);
      this.tui.requestRender();
      return { handled: true };
    }
    if (event.button !== "left" || event.y < ROWS_TOP || event.y >= ROWS_TOP + this.lastPage) return undefined;
    // Pi turns a press and release into a click only for the component that took the press.
    if (event.type === "press") return { handled: true, render: false };
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
    } else if (this.paneAt(event.x) === "detail") {
      const r = this.lastDetail[this.detailScroll + line];
      if (r?.widget && this.actions.setWidget && f.connection === "connected") {
        this.widget = { cell: r.widget.cell, index: r.widget.index, sub: 0 };
        if (!this.section) this.cursor = r.widget.cell;
        this.follow = false;
      } else if (r?.code) {
        const c = this.cursorCell(f);
        if (c) this.toggleCode(c.id);
      }
    } else {
      const r = this.lastOutline[this.scroll + line];
      if (r?.cell) {
        const again = this.cursor === r.cell;
        this.cursor = r.cell;
        this.follow = false;
        this.widget = undefined;
        if (again || twice) this.activate(f);
      }
    }
    this.tui.requestRender();
    return { handled: true };
  }

  dispose(): void {
    if (!this.closed) Painter.for(this.tui)?.setExclusive(false);
    this.closed = true;
    clearInterval(this.timer);
    this.scratch?.abort.abort();
    this.dock?.dispose();
    this.dock = undefined;
    this.live.dispose();
  }
}
