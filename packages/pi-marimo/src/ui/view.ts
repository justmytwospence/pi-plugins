// A notebook, full screen (frame.ts): the outline (headings) with one line per code cell, its
// status, what it defines, and its error, live. It follows the running cell. ↑↓ or j/k scroll,
// PgUp/PgDn, g/G; Tab goes to the next followed notebook; `x` twice interrupts the kernel; `o`
// opens the notebook in the browser; Esc, q, ← or h goes back.
import { type Component, type TUI, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "../core/io.js";
import type { Cell, NotebookState } from "../core/notebook.js";
import { elapsed } from "../core/render.js";
import { truncate } from "../core/notebook.js";
import type { Followed } from "../core/watcher.js";
import { kernelStateParts } from "../bg.js";
import { INPUT_CONTEXT } from "../activity.js";
import { interruptKey, notebookKey, notebookPath } from "./identity.js";
import { banner, bottom, row as frameRow, rule as frameRule, type FrameTheme } from "./frame.js";

/** Banner, two header lines, two rules, hints, bottom border. */
const CHROME = 7;
const TICK_MS = 1_000;

export interface ViewActions {
  /** The notebooks followed now. */
  followed(): Followed[];
  interrupt(f: Followed): Promise<void>;
  openInBrowser(f: Followed): void;
}

const firstLine = (code: string) => code.split("\n").find((l) => l.trim())?.trim() ?? "";

/** The notebook as display lines: headings, then a line per code cell (and its error under it). */
export function notebookLines(nb: NotebookState, theme: FrameTheme, now: number): { lines: string[]; running?: number } {
  const lines: string[] = [];
  let running: number | undefined;
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
    for (const h of headings) lines.push(`${"  ".repeat(Math.max(0, h.level - 1))}${h.level === 1 ? theme.bold(theme.fg("accent", h.text)) : theme.bold(h.text)}`);
    if (nb.isMarkdown(cell)) continue;
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
    if (cell.status === "running") running = lines.length;
    lines.push(`  ${icon(cell)} ${theme.fg("muted", label)}  ${what}${notes.length ? `  ${notes.join(theme.fg("dim", " · "))}` : ""}`);
    if (cell.error) lines.push(`      ${theme.fg("error", truncate(cell.error, 200))}`);
  }
  return { lines, ...(running !== undefined ? { running } : {}) };
}

export class NotebookView implements Component {
  private scroll = 0;
  private follow = true;
  private armedTarget: string | undefined;
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
  }

  private viewport(): number {
    return Math.max(3, this.tui.terminal.rows - CHROME);
  }

  /** Read-only scrolling content: global listeners leave its keys alone. */
  [INPUT_CONTEXT](): "viewer" {
    return "viewer";
  }

  handleInput(data: string): void {
    if (this.closed) return;
    this.syncConfirmation();
    const f = this.current();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q") || matchesKey(data, "h") || matchesKey(data, "left")) {
      this.close();
      return;
    }
    const page = this.viewport();
    if (matchesKey(data, "x")) {
      const busy = f && f.connection === "connected" && (f.notebook.running() || f.notebook.queued() > 0);
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
    this.armedTarget = undefined;
    if (matchesKey(data, "tab")) {
      const all = this.actions.followed();
      const i = all.findIndex((o) => notebookKey(o) === this.key);
      const next = all[(i + 1) % Math.max(1, all.length)];
      if (next) {
        this.key = notebookKey(next);
        this.scroll = 0;
        this.follow = true;
        this.note = undefined;
      }
    } else if (matchesKey(data, "o") && f) {
      this.actions.openInBrowser(f);
      this.note = "Opened in the browser.";
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) this.move(-1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.move(1);
    else if (matchesKey(data, "ctrl+u")) this.move(-Math.max(1, Math.floor(page / 2)));
    else if (matchesKey(data, "ctrl+d")) this.move(Math.max(1, Math.floor(page / 2)));
    else if (matchesKey(data, "pageUp")) this.move(-page);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "space")) this.move(page);
    else if (matchesKey(data, "home") || data === "g") this.move(-Infinity);
    else if (matchesKey(data, "end") || data === "G") {
      this.follow = true;
      this.scroll = Number.MAX_SAFE_INTEGER;
    }
    this.tui.requestRender();
  }

  private move(by: number): void {
    this.follow = false;
    this.scroll = Math.max(0, by === -Infinity ? 0 : this.scroll + by);
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
      out.push(row(th.bold(file)), row(th.fg("dim", "No longer followed.")), rule);
      for (let i = 0; i < page; i++) out.push(row(""));
    } else {
      const busy = f.notebook.running() || f.notebook.queued() > 0;
      const state = kernelStateParts(f).join(" · ");
      out.push(row(`${busy ? th.fg("accent", "●") : f.notebook.errors().length ? th.fg("error", "✗") : th.fg("dim", "○")} ${th.bold(file)}  ${state}`));
      out.push(row(th.fg("dim", `${f.attachment.path} · ${f.attachment.url} · session ${f.attachment.sessionId}`)));
      out.push(rule);
      const { lines, running } = notebookLines(f.notebook, th, Date.now());
      const max = Math.max(0, lines.length - page);
      // Following: keep the running cell in view, a third of the way down.
      if (this.follow) this.scroll = running !== undefined ? Math.min(max, Math.max(0, running - Math.floor(page / 3))) : Math.min(this.scroll, max);
      this.scroll = Math.min(this.scroll, max);
      for (let i = 0; i < page; i++) out.push(row(lines[this.scroll + i] ?? ""));
    }
    out.push(rule);
    const hints: string[] = [];
    if (f && f.connection === "connected" && (f.notebook.running() || f.notebook.queued() > 0)) hints.push(this.armedTarget ? th.fg("error", "x again to interrupt") : "x interrupt");
    if (f) hints.push("o open in browser");
    if (this.actions.followed().length > 1) hints.push("tab next notebook");
    const left = this.note ? `${th.fg("warning", this.note)}  ${th.fg("dim", hints.join(" · "))}` : th.fg("dim", hints.join(" · "));
    const nav = th.fg("dim", "j/k ^U/^D g/G · h/esc back");
    const inner = width - 4;
    const gap = inner - visibleWidth(left) - visibleWidth(nav);
    out.push(row(gap >= 1 ? `${left}${" ".repeat(gap)}${nav}` : left));
    out.push(bottom(width, th));
    return out;
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
