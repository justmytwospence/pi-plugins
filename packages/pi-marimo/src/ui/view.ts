// A notebook, full screen (frame.ts): a header (kernel state, cell counts, last run, the server),
// then the outline (headings) with one line per code cell, its status, what it defines, and its
// error, live. It follows the running cell until you move.
//   j/k or ↑↓ move the cursor between cells; ^U/^D, PgUp/PgDn scroll; g/G first/last cell;
//   Enter or l expands the cell under the cursor (its code, console and output); n/N jump to the
//   next/previous failed cell; f follows the running cell again; / filters cells by name, variable
//   or code (Esc clears); r runs the cell, R every stale cell, A every cell (the last two need
//   pressing twice); x twice interrupts the kernel; o opens the notebook in the browser;
//   Tab goes to the next followed notebook; Esc, q, ← or h goes back.
import { type Component, type TUI, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "../core/io.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import { elapsed } from "../core/render.js";
import { truncate } from "../core/notebook.js";
import type { Followed } from "../core/watcher.js";
import { kernelStateParts, lensParts } from "../bg.js";
import { INPUT_CONTEXT } from "../activity.js";
import { interruptKey, notebookKey, notebookPath } from "./identity.js";
import { banner, bottom, row as frameRow, rule as frameRule, type FrameTheme } from "../frame.ts";

/** Banner, three header lines, two rules, hints, bottom border. */
const CHROME = 8;
/** How much of an expanded cell shows: its code, its output. */
const MAX_CODE_LINES = 40;
const MAX_OUTPUT_LINES = 30;
const TICK_MS = 1_000;

export interface ViewActions {
  /** The notebooks followed now. */
  followed(): Followed[];
  interrupt(f: Followed): Promise<void>;
  openInBrowser(f: Followed): void;
  /** Runs these cells (id and current code) in the notebook's kernel. */
  run?(f: Followed, cells: Array<{ id: string; code: string }>): Promise<void>;
  /** The pi-bg servers standing for this notebook. */
  servers?(f: Followed): string[];
  /** Asks pi-bg to stop the servers standing for this notebook; how many. */
  stopServers?(f: Followed): number;
  /** How the notebook's last run went: `ran 2m 3s · 1 error · 5m ago`. */
  lastRun?(f: Followed): string | undefined;
}

const firstLine = (code: string) => code.split("\n").find((l) => l.trim())?.trim() ?? "";

/** One display line; a cell's own line carries its id. */
export interface Row {
  text: string;
  cell?: string;
}

export interface RowOptions {
  cursor?: string | undefined;
  expanded?: ReadonlySet<string>;
  filter?: string;
}

/** The code cells the cursor can stand on: every one, or those matching the filter (name, variables, code). */
export function selectableCells(nb: NotebookState, filter = ""): Cell[] {
  const q = filter.trim().toLowerCase();
  return nb.ordered().filter((c) => {
    if (nb.isMarkdown(c)) return false;
    if (!q) return true;
    return [c.name, c.id, ...(nb.defs.get(c.id) ?? []), c.code, c.error ?? ""].some((t) => t.toLowerCase().includes(q));
  });
}

const clean = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\t/gu, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");

/** The expanded part of a cell: its code, what it printed, what it output. */
function expandedRows(cell: Cell, theme: FrameTheme): string[] {
  const out: string[] = [];
  const pad = "      ";
  const code = cell.code.replace(/\s+$/u, "").split("\n");
  for (const line of code.slice(0, MAX_CODE_LINES)) out.push(`${pad}${theme.fg("dim", "│")} ${clean(line)}`);
  if (code.length > MAX_CODE_LINES) out.push(`${pad}${theme.fg("dim", `│ … ${code.length - MAX_CODE_LINES} more lines`)}`);
  const printed = cell.console ?? [];
  for (const l of printed) out.push(`${pad}${theme.fg("dim", "▍")} ${l.stream === "stderr" ? theme.fg("warning", clean(l.text)) : clean(l.text)}`);
  const output = cell.output;
  if (output) {
    const text = output.kind === "text" || output.kind === "other" ? output.text : theme.fg("dim", output.text);
    const lines = text.split("\n");
    for (const line of lines.slice(0, MAX_OUTPUT_LINES)) out.push(`${pad}${theme.fg("accent", "▍")} ${clean(line)}`);
    if (lines.length > MAX_OUTPUT_LINES) out.push(`${pad}${theme.fg("dim", `▍ … ${lines.length - MAX_OUTPUT_LINES} more lines`)}`);
  } else if (!printed.length && !cell.error) {
    out.push(`${pad}${theme.fg("dim", cell.status === "idle" && !cell.lastRunCode ? "▍ (not run)" : "▍ (no output)")}`);
  }
  return out;
}

/** The notebook as rows: headings, then a line per code cell (its error under it, its code and output when expanded). */
export function notebookRows(nb: NotebookState, theme: FrameTheme, now: number, opts: RowOptions = {}): { rows: Row[]; running?: number; cellRows: Map<string, number> } {
  const filtering = !!opts.filter?.trim();
  const rows: Row[] = (filtering ? [] : lensSection(nb, theme)).map((text) => ({ text }));
  const shown = new Set(selectableCells(nb, opts.filter).map((c) => c.id));
  const cellRows = new Map<string, number>();
  let running: number | undefined;
  // Each cell's open Lens selections, tagged on its row.
  const marks = new Map<string, string[]>();
  for (const s of nb.lens.selections()) for (const id of s.cells) marks.set(id, [...marks.get(id) ?? [], s.label]);
  const icon = (c: Cell) =>
    c.status === "running"
      ? theme.fg("accent", "●")
      : c.error || c.blocked
        ? theme.fg("error", "✗")
        : c.status === "queued"
          ? theme.fg("muted", "◌")
          : c.stale || nb.edited(c)
            ? theme.fg("warning", "○")
            : theme.fg("dim", "○");
  for (const cell of nb.ordered()) {
    const headings = nb.headings(cell);
    if (!filtering) for (const h of headings) rows.push({ text: `${"  ".repeat(Math.max(0, h.level - 1))}${h.level === 1 ? theme.bold(theme.fg("accent", h.text)) : theme.bold(h.text)}` });
    if (nb.isMarkdown(cell) || !shown.has(cell.id)) continue;
    const notes: string[] = [];
    if (cell.status === "running") notes.push(theme.fg("accent", `running${cell.runningSince ? ` ${elapsed(now - cell.runningSince)}` : ""}`));
    else if (cell.status === "queued") notes.push(theme.fg("muted", "queued"));
    if (cell.blocked) notes.push(theme.fg("error", "not run: an ancestor failed"));
    if (cell.disabled) notes.push(theme.fg("dim", "disabled"));
    if (cell.stale) notes.push(theme.fg("warning", "stale"));
    if (nb.edited(cell)) notes.push(theme.fg("warning", "edited, not rerun"));
    const defs = nb.defs.get(cell.id) ?? [];
    const label = cell.name !== "_" ? cell.name : cell.id;
    const what = defs.length ? `→ ${truncate(defs.join(", "), 80)}` : theme.fg("dim", truncate(firstLine(cell.code) || "(empty)", 80));
    if (cell.status === "running") running = rows.length;
    const marked = marks.get(cell.id);
    const here = opts.cursor === cell.id;
    const open = opts.expanded?.has(cell.id);
    cellRows.set(cell.id, rows.length);
    rows.push({
      cell: cell.id,
      text: `${here ? theme.fg("accent", open ? "▾" : "▸") : " "} ${icon(cell)} ${here ? theme.bold(label) : theme.fg("muted", label)}${marked ? ` ${theme.fg("warning", marked.join(" "))}` : ""}  ${what}${notes.length ? `  ${notes.join(theme.fg("dim", " · "))}` : ""}`,
    });
    if (cell.error) rows.push({ text: `      ${theme.fg("error", truncate(cell.error, 200))}` });
    if (open) for (const text of expandedRows(cell, theme)) rows.push({ text });
  }
  return { rows, ...(running !== undefined ? { running } : {}), cellRows };
}

/** The notebook as display lines (see notebookRows). */
export function notebookLines(nb: NotebookState, theme: FrameTheme, now: number, opts: RowOptions = {}): { lines: string[]; running?: number } {
  const { rows, running } = notebookRows(nb, theme, now, opts);
  return { lines: rows.map((r) => r.text), ...(running !== undefined ? { running } : {}) };
}

/** Open marimo-lens selections (label, note, where, image) and the latest addressed ones, above the outline. */
export function lensSection(nb: NotebookState, theme: FrameTheme): string[] {
  const open = nb.lens.selections();
  const history = nb.lens.history().slice(-3);
  if (!open.length && !history.length) return [];
  const current = nb.lens.current()?.id;
  const where = (cells: string[]) => cells.map((id) => {
    const c = nb.cells.get(id);
    return c && c.name !== "_" ? c.name : id;
  }).join(", ");
  const lines = [theme.bold(theme.fg("accent", "Lens"))];
  for (const s of open) {
    const meta = [where(s.cells), s.image && s.image !== "available" ? `image ${s.image}` : "", s.previous !== undefined ? "reopened" : ""].filter(Boolean).join(" \u00b7 ");
    lines.push(`  ${theme.fg("warning", s.label)}${s.id === current ? theme.fg("dim", "*") : " "} ${s.note ? truncate(s.note.replace(/\s+/g, " "), 120) : theme.fg("dim", s.what ?? "(no note)")}${meta ? `  ${theme.fg("dim", meta)}` : ""}`);
  }
  for (const h of history) {
    lines.push(`  ${theme.fg("success", "\u2713")} ${theme.fg("dim", h.label)} ${theme.fg("dim", truncate(h.summary ?? h.note ?? "", 120))}`);
  }
  lines.push("");
  return lines;
}

export class NotebookView implements Component {
  private scroll = 0;
  private follow = true;
  private cursor: string | undefined;
  private expanded = new Set<string>();
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
  private note: string | undefined;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: Pick<TUI, "requestRender"> & { terminal: { rows: number } },
    private readonly theme: FrameTheme,
    private key: string,
    private readonly actions: ViewActions,
    private readonly done: () => void,
  ) {
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
  }

  private viewport(): number {
    return Math.max(3, this.tui.terminal.rows - CHROME);
  }

  /** Read-only scrolling content: global listeners leave its keys alone (typing a filter takes them). */
  [INPUT_CONTEXT](): "viewer" | "filter" {
    return this.typing ? "filter" : "viewer";
  }

  private cells(f: Followed): Cell[] {
    return selectableCells(f.notebook, this.filter);
  }

  /** Move the cursor to the next/previous selectable cell that passes `want` (wrapping). */
  private step(f: Followed, by: 1 | -1, want: (c: Cell) => boolean = () => true): void {
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
    this.note = "No such cell.";
  }

  private cursorCell(f: Followed): Cell | undefined {
    const cells = this.cells(f);
    return cells.find((c) => c.id === this.cursor) ?? cells[0];
  }

  private label(c: Cell): string {
    return c.name !== "_" ? c.name : c.id;
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
      (e: unknown) => { if (!this.closed) { this.note = `Could not run: ${e instanceof Error ? e.message : String(e)}`; this.tui.requestRender(); } },
    );
  }

  private typeFilter(data: string): void {
    if (matchesKey(data, "escape")) {
      this.filter = "";
      this.typing = false;
    } else if (matchesKey(data, "enter")) this.typing = false;
    else if (matchesKey(data, "backspace")) this.filter = this.filter.slice(0, -1);
    else if (!data.startsWith("\x1b") && data >= " ") this.filter += data;
    this.cursor = undefined;
    this.scroll = 0;
    this.follow = false;
    this.reveal = true;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    this.syncConfirmation();
    if (this.typing) return this.typeFilter(data);
    const f = this.current();
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
          (e: unknown) => { if (!this.closed) { this.note = `Could not interrupt: ${e instanceof Error ? e.message : String(e)}`; this.tui.requestRender(); } },
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
    this.armedTarget = undefined;
    this.armedRun = undefined;
    this.armedStop = undefined;
    this.note = undefined;
    if (matchesKey(data, "tab")) {
      const all = this.actions.followed();
      const i = all.findIndex((o) => notebookKey(o) === this.key);
      const next = all[(i + 1) % Math.max(1, all.length)];
      if (next) {
        this.key = notebookKey(next);
        this.scroll = 0;
        this.follow = true;
        this.cursor = undefined;
        this.filter = "";
      }
    } else if (matchesKey(data, "o") && f) {
      this.actions.openInBrowser(f);
      this.note = "Opened in the browser.";
    } else if (data === "/") {
      this.typing = true;
      this.filter = "";
    } else if (f && (matchesKey(data, "enter") || matchesKey(data, "l"))) {
      const c = this.cursorCell(f);
      if (c) {
        this.cursor = c.id;
        if (!this.expanded.delete(c.id)) this.expanded.add(c.id);
        this.reveal = true;
      }
    } else if (f && data === "r") {
      const c = this.cursorCell(f);
      if (c) this.startRun(f, [c], this.label(c));
      else this.note = "No cell selected.";
    } else if (f && data === "n") this.step(f, 1, (c) => !!c.error);
    else if (f && data === "N") this.step(f, -1, (c) => !!c.error);
    else if (data === "f") {
      this.follow = true;
      this.reveal = true;
    } else if (f && (matchesKey(data, "down") || matchesKey(data, "j"))) this.step(f, 1);
    else if (f && (matchesKey(data, "up") || matchesKey(data, "k"))) this.step(f, -1);
    else if (matchesKey(data, "ctrl+u")) this.move(-Math.max(1, Math.floor(page / 2)));
    else if (matchesKey(data, "ctrl+d")) this.move(Math.max(1, Math.floor(page / 2)));
    else if (matchesKey(data, "pageUp")) this.move(-page);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.move(page);
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

  /** `✗ fit.py  running Model fit`, then what the notebook holds and when it last ran. */
  private header(f: Followed, file: string): string[] {
    const th = this.theme;
    const nb = f.notebook;
    const busy = nb.running() || nb.queued() > 0;
    const code = nb.ordered().filter((c) => !nb.isMarkdown(c));
    const stale = code.filter((c) => c.stale || nb.edited(c)).length;
    const errors = nb.errors().length;
    const state = [...kernelStateParts(f), ...lensParts(f)].join(" · ");
    const servers = this.actions.servers?.(f) ?? [];
    const counts = [
      `${code.length} cell${code.length === 1 ? "" : "s"}`,
      stale ? th.fg("warning", `${stale} stale`) : "",
      errors ? th.fg("error", `${errors} error${errors === 1 ? "" : "s"}`) : "",
      this.actions.lastRun?.(f) ?? "",
      servers.length ? `server ${servers.join(", ")}` : "",
    ].filter(Boolean).join(th.fg("dim", " · "));
    return [
      `${busy ? th.fg("accent", "●") : errors ? th.fg("error", "✗") : th.fg("dim", "○")} ${th.bold(file)}  ${state}`,
      counts,
      th.fg("dim", `${f.attachment.path} · ${f.attachment.url} · session ${f.attachment.sessionId}`),
    ];
  }

  render(width: number): string[] {
    if (width < 8) return [];
    const th = this.theme;
    const row = (s: string) => frameRow(s, width, th);
    const rule = frameRule(width, th);
    this.syncConfirmation();
    const f = this.current();
    const file = basename(f?.attachment.path ?? notebookPath(this.key));
    const out = [banner(`Notebook ${file}`, width, th)];
    const page = this.viewport();
    if (!f) {
      out.push(row(th.bold(file)), row(th.fg("dim", "No longer followed.")), row(""), rule);
      for (let i = 0; i < page; i++) out.push(row(""));
    } else {
      for (const line of this.header(f, file)) out.push(row(line));
      out.push(rule);
      const nb = f.notebook;
      const cells = this.cells(f);
      const running = nb.running();
      // Following: the cursor stays on the running cell.
      if (this.follow && running && cells.some((c) => c.id === running.cell.id)) this.cursor = running.cell.id;
      if (!this.cursor || !cells.some((c) => c.id === this.cursor)) this.cursor = cells[0]?.id;
      const built = notebookRows(nb, th, Date.now(), { cursor: this.cursor, expanded: this.expanded, filter: this.filter });
      const rows = built.rows;
      const max = Math.max(0, rows.length - page);
      const at = this.cursor !== undefined ? built.cellRows.get(this.cursor) : undefined;
      if (this.follow && running && built.running !== undefined) this.scroll = Math.min(max, Math.max(0, built.running - Math.floor(page / 3)));
      else if (this.reveal && at !== undefined) {
        if (this.scroll === Number.MAX_SAFE_INTEGER) this.scroll = max;
        if (at < this.scroll) this.scroll = at;
        else if (at >= this.scroll + page) this.scroll = at - page + 1;
      } else if (this.follow) this.scroll = Math.min(this.scroll, max);
      this.scroll = Math.max(0, Math.min(this.scroll, max));
      this.reveal = false;
      // Scrolled away from the cursor: it moves to the nearest cell on screen.
      if (at !== undefined && !this.follow && (at < this.scroll || at >= this.scroll + page)) {
        const visible = cells.filter((c) => { const r = built.cellRows.get(c.id); return r !== undefined && r >= this.scroll && r < this.scroll + page; });
        const pick = at < this.scroll ? visible[0] : visible.at(-1);
        if (pick) {
          this.cursor = pick.id;
          const again = notebookRows(nb, th, Date.now(), { cursor: this.cursor, expanded: this.expanded, filter: this.filter });
          rows.splice(0, rows.length, ...again.rows);
        }
      }
      for (let i = 0; i < page; i++) out.push(row(rows[this.scroll + i]?.text ?? (this.filter && !cells.length && i === 0 ? th.fg("dim", `No cell matches "${this.filter}".`) : "")));
    }
    out.push(rule);
    out.push(row(this.footer(f, width - 4)));
    out.push(bottom(width, th));
    return out;
  }

  private footer(f: Followed | undefined, inner: number): string {
    const th = this.theme;
    if (this.typing) return `${th.fg("accent", "/")} ${this.filter}${th.fg("dim", "▏")}  ${th.fg("dim", "enter keep · esc clear")}`;
    const connected = !!f && f.connection === "connected";
    const busy = connected && (f.notebook.running() || f.notebook.queued() > 0);
    const hints: string[] = [];
    if (f) hints.push("enter expand");
    if (connected && this.actions.run) hints.push("r run");
    if (this.armedRun?.what === "stale") hints.push(th.fg("error", "R again to run stale cells"));
    else if (this.armedRun?.what === "all") hints.push(th.fg("error", "A again to run all cells"));
    else if (connected && this.actions.run) hints.push("R stale", "A all");
    if (busy) hints.push(this.armedTarget ? th.fg("error", "x again to interrupt") : "x interrupt");
    if (f && this.actions.stopServers && (this.actions.servers?.(f).length ?? 0) > 0) hints.push(this.armedStop ? th.fg("error", "S again to stop the server") : "S stop server");
    if (f?.notebook.errors().length) hints.push("n errors");
    if (f) hints.push(this.filter ? th.fg("accent", `/ ${this.filter}`) : "/ filter");
    if (f) hints.push("o browser");
    if (this.actions.followed().length > 1) hints.push("tab next");
    const left = this.note ? `${th.fg("warning", this.note)}  ${th.fg("dim", hints.join(" · "))}` : th.fg("dim", hints.join(" · "));
    const nav = th.fg("dim", "j/k f g/G · esc back");
    const gap = inner - visibleWidth(left) - visibleWidth(nav);
    return gap >= 1 ? `${left}${" ".repeat(gap)}${nav}` : left;
  }

  invalidate(): void {}

  private close(): void {
    if (this.closed) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
}
