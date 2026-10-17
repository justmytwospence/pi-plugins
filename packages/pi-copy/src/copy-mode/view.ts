// Copy mode: a full-screen, vim-style view of a frozen transcript snapshot (snapshot.ts), like
// herdr's or tmux's copy mode but over Pi's whole fullscreen history. Motions, incremental search
// with every match highlighted, visual selection and yank, copycat-style presets, thumbs-style
// hints, jumps between prompts, tool calls and errors, and Enter to scroll Pi to the spot.
import { decodeKittyPrintable, isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Block, Snapshot } from "./snapshot.ts";
import {
  type Hint, type Match, type Pattern, type Pos, type PresetName,
  PRESETS, compile, extract, findAll, findHints, firstNonBlank, nextMatch, quote, wordAt, wordBackward, wordEnd, wordForward,
} from "./text.ts";

export interface CopyModeTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface CopyModeActions {
  copy(text: string): Promise<void>;
  /** Put text into Pi's editor. */
  insert(text: string): void;
  /** Close copy mode; `row` scrolls Pi's transcript so that line is at the top. */
  done(result?: { row: number }): void;
  requestRender(): void;
}

type Mode = "normal" | "visual" | "vline" | "search" | "hint";

const SGR = {
  match: (s: string) => `\x1b[7m${s}\x1b[27m`,
  current: (s: string) => `\x1b[30;43m${s}\x1b[39;49m`,
  select: (s: string) => `\x1b[30;46m${s}\x1b[39;49m`,
  cursor: (s: string) => `\x1b[7m${s}\x1b[27m`,
  hint: (s: string) => `\x1b[1;30;43m${s}\x1b[22;39;49m`,
};

/** Searches of this Pi process, newest last, shared by every copy mode opened. */
const history: string[] = [];
const remember = (q: string) => {
  const i = history.indexOf(q);
  if (i >= 0) history.splice(i, 1);
  history.push(q);
  if (history.length > 100) history.shift();
};

export class CopyModeView {
  private readonly plain: string[];
  cursor: Pos;
  top: number;
  mode: Mode = "normal";
  private anchor: Pos = { row: 0, col: 0 };
  private pending = "";
  private count = "";
  private wantCol = 0;
  private search: { pattern: Pattern; matches: Match[]; forward: boolean; label: string; current?: number } | undefined;
  private input = { text: "", forward: true, historyIndex: -1, from: { row: 0, col: 0 }, top: 0 };
  private hints: Hint[] = [];
  private hintTyped = "";
  message = "";

  constructor(
    private readonly snap: Snapshot,
    private readonly theme: CopyModeTheme,
    private readonly rows: () => number,
    private readonly actions: CopyModeActions,
    options: { search?: "forward" | "backward" } = {},
  ) {
    this.plain = snap.plain.length ? snap.plain : [""];
    const height = this.height();
    // Open where Pi was looking: the cursor on the last line of that screen.
    this.top = Math.max(0, Math.min(snap.scrollTop, this.plain.length - height));
    const visibleEnd = snap.viewportHeight > 0 ? snap.scrollTop + snap.viewportHeight - 1 : this.plain.length - 1;
    this.cursor = { row: Math.max(0, Math.min(this.plain.length - 1, visibleEnd, this.top + height - 1)), col: 0 };
    this.cursor.col = firstNonBlank(this.plain[this.cursor.row]!);
    this.reveal();
    if (options.search) this.startSearch(options.search === "forward");
  }

  [Symbol.for("pi-plugins.input-context.v1")]() {
    return this.mode === "search" ? "filter" : "viewer";
  }

  private height(): number {
    return Math.max(3, this.rows() - 2);
  }

  // --- movement -----------------------------------------------------------------------------

  private clampCol(row: number, col: number): number {
    return Math.max(0, Math.min(col, Math.max(0, (this.plain[row]?.length ?? 1) - 1)));
  }

  private moveTo(pos: Pos, keepCol = false): void {
    const row = Math.max(0, Math.min(this.plain.length - 1, pos.row));
    this.cursor = { row, col: this.clampCol(row, keepCol ? this.wantCol : pos.col) };
    if (!keepCol) this.wantCol = this.cursor.col;
    this.reveal();
  }

  /** Keep the cursor on screen, scrolling as little as possible. */
  private reveal(): void {
    const h = this.height();
    if (this.cursor.row < this.top) this.top = this.cursor.row;
    if (this.cursor.row >= this.top + h) this.top = this.cursor.row - h + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.plain.length - h)));
  }

  private scroll(by: number, moveCursor: boolean): void {
    const h = this.height();
    const max = Math.max(0, this.plain.length - h);
    const before = this.top;
    this.top = Math.max(0, Math.min(max, this.top + by));
    if (moveCursor) this.moveTo({ row: this.cursor.row + (this.top - before || by), col: 0 }, true);
    else if (this.cursor.row < this.top || this.cursor.row >= this.top + h) {
      this.moveTo({ row: Math.max(this.top, Math.min(this.top + h - 1, this.cursor.row)), col: 0 }, true);
    }
  }

  private jumpBlock(test: (b: Block) => boolean, forward: boolean, n: number): void {
    const blocks = this.snap.blocks.filter(test);
    let row = this.cursor.row;
    for (let i = 0; i < n; i++) {
      const next = forward ? blocks.find((b) => b.start > row) : [...blocks].reverse().find((b) => b.start < row);
      if (!next) { if (i === 0) this.message = forward ? "No next one" : "No previous one"; break; }
      row = next.start;
    }
    if (row !== this.cursor.row) {
      this.moveTo({ row, col: firstNonBlank(this.plain[row]!) });
      // Show the block from its first line.
      this.top = Math.max(0, Math.min(row, Math.max(0, this.plain.length - this.height())));
    }
  }

  private paragraph(forward: boolean, n: number): void {
    let row = this.cursor.row;
    for (let i = 0; i < n; i++) {
      row += forward ? 1 : -1;
      while (row > 0 && row < this.plain.length - 1 && !(this.plain[row]!.trim() === "" && this.plain[row - (forward ? 1 : -1)]!.trim() !== "")) row += forward ? 1 : -1;
    }
    this.moveTo({ row, col: 0 });
  }

  // --- search -------------------------------------------------------------------------------

  private setSearch(pattern: Pattern, forward: boolean, label: string, filter?: (s: string) => boolean): void {
    this.search = { pattern, matches: findAll(this.plain, pattern, filter), forward, label };
  }

  private goMatch(forward: boolean, n = 1, from: Pos = this.cursor): boolean {
    const s = this.search;
    if (!s) { this.message = "No previous search"; return false; }
    if (!s.matches.length) { this.message = `Pattern not found: ${s.label}`; s.current = undefined; return false; }
    let pos = from;
    let wrapped = false;
    let index = -1;
    for (let i = 0; i < n; i++) {
      const next = nextMatch(s.matches, pos, forward)!;
      wrapped ||= next.wrapped;
      index = next.index;
      const m = s.matches[index]!;
      pos = { row: m.row, col: m.start };
    }
    s.current = index;
    this.moveTo(pos);
    this.message = wrapped ? (forward ? "search hit BOTTOM, continuing at TOP" : "search hit TOP, continuing at BOTTOM") : "";
    return true;
  }

  private startSearch(forward: boolean): void {
    this.mode = "search";
    this.input = { text: "", forward, historyIndex: history.length, from: { ...this.cursor }, top: this.top };
    this.message = "";
  }

  /** Incremental: each keystroke searches from where `/` was pressed. */
  private updateIncremental(): void {
    this.cursor = { ...this.input.from };
    this.top = this.input.top;
    const pattern = compile(this.input.text);
    if (!pattern) { this.search = undefined; return; }
    this.setSearch(pattern, this.input.forward, this.input.text);
    if (this.search!.matches.length) this.goMatch(this.input.forward, 1, this.input.from);
    this.message = "";
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.cursor = { ...this.input.from };
      this.top = this.input.top;
      this.mode = "normal";
      return;
    }
    if (matchesKey(data, "enter")) {
      this.mode = "normal";
      if (!this.input.text) {
        // An empty search repeats the last one, as in vim.
        const last = history[history.length - 1];
        if (last) { this.input.text = last; this.updateIncremental(); }
      }
      if (this.input.text) remember(this.input.text);
      if (this.search && !this.search.matches.length) this.message = `Pattern not found: ${this.input.text}`;
      return;
    }
    if (matchesKey(data, "backspace")) {
      if (!this.input.text) { this.mode = "normal"; return; }
      this.input.text = this.input.text.slice(0, -1);
    } else if (matchesKey(data, "ctrl+u")) {
      this.input.text = "";
    } else if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const i = Math.max(0, Math.min(history.length, this.input.historyIndex + (matchesKey(data, "up") ? -1 : 1)));
      this.input.historyIndex = i;
      this.input.text = history[i] ?? "";
    } else {
      const ch = printable(data);
      if (ch === undefined) return;
      this.input.text += ch;
    }
    this.updateIncremental();
  }

  // --- hints --------------------------------------------------------------------------------

  private startHints(): void {
    this.hints = findHints(this.plain, this.top, this.top + this.height());
    if (!this.hints.length) { this.message = "Nothing to pick on screen"; return; }
    this.mode = "hint";
    this.hintTyped = "";
  }

  private handleHint(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.mode = "normal"; return; }
    const ch = printable(data);
    if (!ch || !/[a-z]/i.test(ch)) return;
    const insert = ch !== ch.toLowerCase() || /[A-Z]/.test(this.hintTyped);
    this.hintTyped += ch.toLowerCase();
    const exact = this.hints.find((h) => h.label === this.hintTyped);
    if (exact) {
      this.mode = "normal";
      if (insert) { this.actions.insert(exact.text); this.actions.done(); return; }
      this.yank(exact.text);
      return;
    }
    if (!this.hints.some((h) => h.label.startsWith(this.hintTyped))) { this.mode = "normal"; this.message = "No such hint"; }
    else if (insert) this.hintTyped = this.hintTyped.toUpperCase();
  }

  // --- yank ---------------------------------------------------------------------------------

  private yank(text: string, after?: () => void): void {
    if (!text) { this.message = "Nothing to copy"; return; }
    const lines = text.split("\n").length;
    this.message = "Copying…";
    this.actions.copy(text).then(
      () => { this.message = `Copied ${lines} line${lines === 1 ? "" : "s"}, ${text.length} chars`; after?.(); this.actions.requestRender(); },
      (e: unknown) => { this.message = `Copy failed: ${e instanceof Error ? e.message : String(e)}`; this.actions.requestRender(); },
    );
  }

  private selection(): string {
    return extract(this.plain, this.anchor, this.cursor, this.mode === "vline");
  }

  // --- input --------------------------------------------------------------------------------

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (this.mode === "search") this.handleSearchInput(data);
    else if (this.mode === "hint") this.handleHint(data);
    else this.handleNormal(data);
    this.actions.requestRender();
  }

  private handleNormal(data: string): void {
    const visual = this.mode === "visual" || this.mode === "vline";
    const ch = printable(data);
    const n = Math.max(1, Number(this.count) || 1);
    const hadCount = this.count !== "";
    if (ch && /[0-9]/.test(ch) && !this.pending && (ch !== "0" || this.count)) { this.count += ch; return; }
    this.message = "";
    const pending = this.pending;
    this.pending = "";
    this.count = "";

    if (pending === "g") {
      if (ch === "g") this.moveTo({ row: hadCount ? n - 1 : 0, col: 0 });
      else if (ch === "u" || ch === "f" || ch === "h" || ch === "e") this.preset(({ u: "url", f: "path", h: "hash", e: "error" } as const)[ch]);
      return;
    }
    if (pending === "[" || pending === "]") {
      const forward = pending === "]";
      if (ch === pending) this.jumpBlock((b) => b.kind === "user", forward, n);
      else if (ch === "t") this.jumpBlock((b) => b.kind === "tool" || b.kind === "bash", forward, n);
      else if (ch === "e") this.jumpBlock((b) => b.error, forward, n);
      else if (ch === "m") this.jumpBlock((b) => b.kind === "assistant", forward, n);
      return;
    }
    if (pending === "y") {
      if (ch === "y") this.yank(extract(this.plain, this.cursor, { row: this.cursor.row + n - 1, col: 0 }, true));
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      if (visual) { this.mode = "normal"; return; }
      if (matchesKey(data, "ctrl+c") || !this.search) { this.actions.done(); return; }
      this.search = undefined; // first Esc clears the highlights, as :noh
      return;
    }
    if (ch === "q") { this.actions.done(); return; }
    if (matchesKey(data, "enter")) {
      // Pi's viewport is shorter than this view: put the cursor's line a third of the way down it.
      const viewport = this.snap.viewportHeight || this.height();
      this.actions.done({ row: Math.max(0, this.cursor.row - Math.floor(viewport / 3)) });
      return;
    }

    const h = this.height();
    const row = this.cursor.row;
    const line = this.plain[row] ?? "";
    if (ch === "j" || matchesKey(data, "down")) this.moveTo({ row: row + n, col: 0 }, true);
    else if (ch === "k" || matchesKey(data, "up")) this.moveTo({ row: row - n, col: 0 }, true);
    else if (ch === "h" || matchesKey(data, "left")) this.moveTo({ row, col: this.cursor.col - n });
    else if (ch === "l" || matchesKey(data, "right")) this.moveTo({ row, col: this.cursor.col + n });
    else if (ch === "0" || matchesKey(data, "home")) this.moveTo({ row, col: 0 });
    else if (ch === "^") this.moveTo({ row, col: firstNonBlank(line) });
    else if (ch === "$" || matchesKey(data, "end")) this.moveTo({ row, col: Infinity });
    else if (ch === "w" || ch === "W") { let p = this.cursor; for (let i = 0; i < n; i++) p = wordForward(this.plain, p, ch === "W"); this.moveTo(p); }
    else if (ch === "b" || ch === "B") { let p = this.cursor; for (let i = 0; i < n; i++) p = wordBackward(this.plain, p, ch === "B"); this.moveTo(p); }
    else if (ch === "e" || ch === "E") { let p = this.cursor; for (let i = 0; i < n; i++) p = wordEnd(this.plain, p, ch === "E"); this.moveTo(p); }
    else if (ch === "G") this.moveTo({ row: hadCount ? n - 1 : this.plain.length - 1, col: 0 });
    else if (ch === "H") this.moveTo({ row: this.top + (hadCount ? n - 1 : 0), col: 0 });
    else if (ch === "M") this.moveTo({ row: this.top + Math.floor(Math.min(h, this.plain.length - this.top) / 2), col: 0 });
    else if (ch === "L") this.moveTo({ row: Math.min(this.plain.length, this.top + h) - (hadCount ? n : 1), col: 0 });
    else if (ch === "{" || ch === "}") this.paragraph(ch === "}", n);
    else if (matchesKey(data, "ctrl+d")) this.scroll(Math.floor(h / 2) * n, true);
    else if (matchesKey(data, "ctrl+u")) this.scroll(-Math.floor(h / 2) * n, true);
    else if (matchesKey(data, "ctrl+f") || matchesKey(data, "pageDown") || ch === " ") this.scroll((h - 2) * n, true);
    else if (matchesKey(data, "ctrl+b") || matchesKey(data, "pageUp")) this.scroll(-(h - 2) * n, true);
    else if (matchesKey(data, "ctrl+e")) this.scroll(n, false);
    else if (matchesKey(data, "ctrl+y")) this.scroll(-n, false);
    else if (ch === "/" || ch === "?") this.startSearch(ch === "/");
    else if (ch === "n" || ch === "N") {
      if (this.search) this.goMatch(ch === "n" ? this.search.forward : !this.search.forward, n);
      else this.message = "No previous search";
    } else if (ch === "*" || ch === "#") {
      const word = wordAt(line, this.cursor.col);
      if (!word) { this.message = "No word under cursor"; return; }
      const pattern = compile(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b\\C`)!;
      remember(`\\b${word}\\b`);
      this.setSearch(pattern, ch === "*", word);
      this.goMatch(ch === "*", n);
    } else if (ch === "f") this.startHints();
    else if (ch === "g" || ch === "[" || ch === "]") { this.pending = ch; this.count = hadCount ? String(n) : ""; }
    else if (ch === "v" || ch === "V") {
      const target: Mode = ch === "v" ? "visual" : "vline";
      if (this.mode === target) this.mode = "normal";
      else { if (!visual) this.anchor = { ...this.cursor }; this.mode = target; }
    } else if (ch === "o" && visual) {
      const a = this.anchor; this.anchor = { ...this.cursor }; this.moveTo(a);
    } else if (ch === "y" && visual) { const text = this.selection(); this.mode = "normal"; this.yank(text); }
    else if (ch === "y") { this.pending = "y"; this.count = hadCount ? String(n) : ""; }
    else if (ch === "Y") this.yank(visual ? this.selection() : extract(this.plain, this.cursor, { row: row + n - 1, col: 0 }, true));
    else if (ch === "I" || ch === ">") {
      const text = visual ? this.selection() : extract(this.plain, this.cursor, this.cursor, true);
      if (!text) { this.message = "Nothing selected"; return; }
      this.actions.insert(ch === ">" ? quote(text) : text);
      this.actions.done();
    }
  }

  private preset(name: PresetName): void {
    const p = PRESETS[name];
    this.setSearch(p.pattern, true, p.label, p.filter);
    if (this.goMatch(true)) this.message = `${p.label}: n/N to move, v to select, f for hints`;
  }

  // --- rendering ----------------------------------------------------------------------------

  render(width: number): string[] {
    const th = this.theme;
    const h = this.height();
    const out: string[] = [];
    const title = ` COPY MODE${this.snap.fallback ? " (session text)" : ""} `;
    const keys = "/ ? n N search · v V y yank · f hints · gu gf gh ge · [[ ]] [t ]t [e ]e · ⏎ jump · q quit";
    out.push(truncateToWidth(`${th.bold(th.fg("accent", title))} ${th.fg("dim", keys)}`, width));
    const visual = this.mode === "visual" || this.mode === "vline";
    const sel = visual ? ([this.anchor, this.cursor].sort((a, b) => a.row - b.row || a.col - b.col) as [Pos, Pos]) : undefined;
    for (let i = 0; i < h; i++) {
      const row = this.top + i;
      if (row >= this.plain.length) { out.push(th.fg("dim", "~")); continue; }
      out.push(this.renderRow(row, width, sel));
    }
    out.push(this.statusLine(width));
    return out;
  }

  private renderRow(row: number, width: number, sel: [Pos, Pos] | undefined): string {
    const text = this.plain[row]!;
    type Span = { start: number; end: number; style: (s: string) => string; label?: string };
    const spans: Span[] = [];
    if (this.search && this.mode !== "hint") {
      this.search.matches.forEach((m, i) => {
        if (m.row === row) spans.push({ start: m.start, end: m.end, style: i === this.search!.current ? SGR.current : SGR.match });
      });
    }
    if (sel && row >= sel[0].row && row <= sel[1].row) {
      const linewise = this.mode === "vline";
      const start = linewise || row > sel[0].row ? 0 : sel[0].col;
      const end = linewise || row < sel[1].row ? Math.max(text.length, 1) : sel[1].col + 1;
      spans.push({ start, end, style: SGR.select });
    }
    if (this.mode === "hint") {
      for (const hint of this.hints) if (hint.row === row) spans.push({ start: hint.start, end: hint.end, style: (s) => this.theme.fg("dim", s), label: hint.label });
    }
    const isCursorRow = row === this.cursor.row && this.mode !== "hint";
    if (!spans.length && !isCursorRow) return truncateToWidth(this.snap.lines[row] ?? text, width);
    // Restyle the plain text: highlights win over the original colors on this row.
    const padded = isCursorRow && this.cursor.col >= text.length ? text.padEnd(this.cursor.col + 1) : text;
    let out = "";
    for (let col = 0; col < padded.length;) {
      const span = spans.filter((s) => col >= s.start && col < s.end).pop();
      if (isCursorRow && col === this.cursor.col) { out += SGR.cursor(padded[col]!); col++; continue; }
      if (span?.label && col === span.start) {
        const label = span.label.slice(0, Math.max(1, span.end - span.start));
        out += SGR.hint(label);
        col += label.length;
        continue;
      }
      let end = col + 1;
      while (end < padded.length && !(isCursorRow && end === this.cursor.col) && spans.filter((s) => end >= s.start && end < s.end).pop() === span && !(span?.label && end === span.start)) end++;
      const chunk = padded.slice(col, end);
      out += span ? span.style(chunk) : chunk;
      col = end;
    }
    return truncateToWidth(out, width);
  }

  private statusLine(width: number): string {
    const th = this.theme;
    let left: string;
    if (this.mode === "search") left = `${this.input.forward ? "/" : "?"}${this.input.text}\x1b[7m \x1b[27m`;
    else if (this.mode === "hint") left = th.fg("warning", `pick: label copies, Shift+label inserts${this.hintTyped ? ` · ${this.hintTyped}` : ""}`);
    else if (this.message) left = /failed|not found|No /.test(this.message) ? th.fg("error", this.message) : th.fg("warning", this.message);
    else if (this.mode === "visual" || this.mode === "vline") left = th.bold(this.mode === "visual" ? "-- VISUAL --" : "-- VISUAL LINE --") + th.fg("dim", "  y copy · I insert · > quote · o other end");
    else left = this.pending || this.count ? `${this.count}${this.pending}` : "";
    const s = this.search;
    const counter = s && s.matches.length ? `[${s.current === undefined ? "?" : s.current + 1}/${s.matches.length}] ` : "";
    const pct = this.plain.length <= this.height() ? "All" : this.top === 0 ? "Top" : this.top + this.height() >= this.plain.length ? "Bot" : `${Math.round((this.top / (this.plain.length - this.height())) * 100)}%`;
    const right = th.fg("dim", `${counter}${this.cursor.row + 1},${this.cursor.col + 1}  ${pct}`);
    const gap = width - visibleWidth(left) - visibleWidth(right);
    return gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, width);
  }

  invalidate(): void {}
}

/** The printable character a key produced, if any. */
function printable(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  if (data.length === 1 && data >= " " && data !== "\x7f") return data;
  if ([...data].length === 1 && data.charCodeAt(0) > 127) return data;
  return undefined;
}
