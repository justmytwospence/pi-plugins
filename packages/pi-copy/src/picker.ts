import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, decodeKittyPrintable, isKeyRelease, fuzzyFilter, matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Segment, preview } from "./segments.ts";

export type Tab = "suggested" | "all";

export interface PickerTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface PickerModel {
  /** Suggested order (recency until Jev's ranking arrives). */
  suggested: Segment[];
  /** Everything, newest first. */
  all: Segment[];
  ranking: "pending" | "done" | "unavailable";
  /** Number of user turns covered, for the age column. */
  lastTurn: number;
}

const BADGE: Record<Segment["kind"], string> = {
  user: "you",
  assistant: "reply",
  section: "sect",
  code: "code",
  command: "cmd",
  snippet: "snip",
  path: "path",
  url: "url",
  table: "table",
  list: "list",
  quote: "quote",
  commit: "commit",
  paragraph: "text",
};

const VISIBLE_ROWS = 12;
const PREVIEW_LINES = 14;

/**
 * The /yank picker: arrows or ctrl+j/ctrl+k move, typing filters, Tab switches Suggested/All,
 * right arrow (or Space with an empty filter) expands the preview, Enter copies, Esc clears the
 * filter or closes.
 */
export class Picker {
  tab: Tab = "suggested";
  query = "";
  cursor = 0;
  expanded = false;
  /** Whether the user has moved or filtered; until then a new ranking puts the cursor at the top. */
  private touched = false;
  private cached: { width: number; lines: string[] } | undefined;
  private paste: string | undefined;
  private hasFocus = false;
  get focused() { return this.hasFocus; }
  set focused(value: boolean) { if (value !== this.hasFocus) this.cached = undefined; this.hasFocus = value; }
  [Symbol.for("pi-plugins.input-context.v1")]() { return "filter"; }

  constructor(
    private model: PickerModel,
    private readonly theme: PickerTheme,
    private readonly requestRender: () => void,
    private readonly done: (segment: Segment | undefined) => void,
    private readonly keybindings?: KeybindingsManager,
  ) {}

  /** The rows on the current tab, filtered. */
  items(): Segment[] {
    const base = this.tab === "suggested" ? this.model.suggested : this.model.all;
    return this.query ? fuzzyFilter(base, this.query, (s) => `${BADGE[s.kind]} ${s.text}`) : base;
  }

  /** New ranking: reorder, keeping the cursor on the piece you moved to (or at the top). */
  update(model: PickerModel) {
    const current = this.touched ? this.items()[this.cursor]?.id : undefined;
    this.model = model;
    const index = current ? this.items().findIndex((s) => s.id === current) : -1;
    this.cursor = index >= 0 ? index : 0;
    this.refresh();
  }

  private refresh() {
    this.cached = undefined;
    this.requestRender();
  }

  private move(delta: number) {
    const n = this.items().length;
    if (!n) return;
    this.cursor = Math.min(n - 1, Math.max(0, this.cursor + delta));
    this.refresh();
  }

  handleInput(data: string) {
    if (isKeyRelease(data)) return;
    this.touched = true;
    if (this.paste !== undefined || data.includes("\x1b[200~")) {
      this.paste = (this.paste ?? "") + data.replace("\x1b[200~", "");
      const end = this.paste.indexOf("\x1b[201~");
      if (end < 0) return;
      this.query += this.paste.slice(0, end).replace(/[\x00-\x1f\x7f]/g, " ");
      this.paste = undefined;
      this.cursor = 0;
      return this.refresh();
    }
    const action = (name: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel", fallback: string) =>
      this.keybindings ? this.keybindings.matches(data, name) : matchesKey(data, fallback as "up");
    if (action("tui.select.confirm", "enter")) return this.done(this.items()[this.cursor]);
    if (action("tui.select.cancel", "escape")) {
      if (!this.query) return this.done(undefined);
      this.query = "";
      this.cursor = 0;
      return this.refresh();
    }
    if (action("tui.select.up", "up") || matchesKey(data, "ctrl+k")) return this.move(-1);
    if (action("tui.select.down", "down") || matchesKey(data, "ctrl+j")) return this.move(1);
    // This surface is always a search field, not a read-only viewport.
    if (matchesKey(data, "ctrl+u")) { this.query = ""; this.cursor = 0; return this.refresh(); }
    if (matchesKey(data, "ctrl+d")) return; // delete-forward at the end of the query
    if (matchesKey(data, Key.pageUp)) return this.move(-VISIBLE_ROWS);
    if (matchesKey(data, Key.pageDown)) return this.move(VISIBLE_ROWS);
    if (matchesKey(data, Key.tab)) {
      this.tab = this.tab === "suggested" ? "all" : "suggested";
      this.cursor = 0;
      return this.refresh();
    }
    if (matchesKey(data, Key.right) || (matchesKey(data, Key.space) && !this.query)) {
      this.expanded = !this.expanded;
      return this.refresh();
    }
    if (matchesKey(data, Key.left)) {
      this.expanded = false;
      return this.refresh();
    }
    if (matchesKey(data, Key.backspace)) {
      const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(this.query)];
      this.query = this.query.slice(0, parts.at(-1)?.index ?? 0);
      this.cursor = 0;
      return this.refresh();
    }
    const printable = decodeKittyPrintable(data) ?? data;
    if (printable && !/[\x00-\x1f\x7f]/u.test(printable)) {
      this.query += printable;
      this.cursor = 0;
      this.refresh();
    }
  }

  invalidate() {
    this.cached = undefined;
  }

  render(width: number): string[] {
    if (this.cached?.width === width) return this.cached.lines;
    const t = this.theme;
    const w = Math.max(1, width);
    const lines: string[] = [];
    const tab = (name: Tab, label: string) => (this.tab === name ? t.fg("accent", t.bold(`[${label}]`)) : t.fg("muted", ` ${label} `));
    const status = this.model.ranking === "pending" ? t.fg("dim", "  ranking…") : this.model.ranking === "unavailable" ? t.fg("dim", "  (recency order)") : "";
    lines.push(t.fg("accent", "─".repeat(w)));
    lines.push(truncateToWidth(` ${t.bold("Yank")}  ${tab("suggested", "Suggested")} ${tab("all", "All")}${status}`, w));
    const filterLabel = truncateToWidth(` ${t.fg("muted", "filter:")} `, Math.max(0, w - 1), "");
    const filterRoom = Math.max(0, w - visibleWidth(filterLabel) - 1);
    const queryTail = sliceByColumn(this.query, Math.max(0, visibleWidth(this.query) - filterRoom), filterRoom);
    lines.push(`${filterLabel}${queryTail}${this.focused ? CURSOR_MARKER : ""}${t.fg("accent", "▏")}`);

    const items = this.items();
    const start = Math.max(0, Math.min(this.cursor - Math.floor(VISIBLE_ROWS / 2), items.length - VISIBLE_ROWS));
    if (!items.length) lines.push(t.fg("dim", "  nothing matches"));
    for (let i = start; i < Math.min(items.length, start + VISIBLE_ROWS); i++) {
      const s = items[i] as Segment;
      const selected = i === this.cursor;
      const age = this.model.lastTurn - s.turn;
      const badge = BADGE[s.kind].padEnd(6);
      const ageText = age === 0 ? "now" : `${age}t ago`;
      const prefix = `${selected ? t.fg("accent", "›") : " "} ${t.fg(selected ? "accent" : "muted", badge)} `;
      const suffix = ` ${t.fg("dim", ageText.padStart(7))}`;
      const room = Math.max(4, w - visibleWidth(prefix) - visibleWidth(suffix));
      const text = truncateToWidth(preview(s), room, "…");
      const pad = " ".repeat(Math.max(0, room - visibleWidth(text)));
      lines.push(`${prefix}${selected ? t.fg("accent", text) : text}${pad}${suffix}`);
    }
    if (items.length > VISIBLE_ROWS) lines.push(t.fg("dim", `  ${this.cursor + 1}/${items.length}`));

    const current = items[this.cursor];
    if (this.expanded && current) {
      lines.push(t.fg("muted", "─".repeat(w)));
      const wrapped = current.text.split("\n").flatMap((l) => wrapTextWithAnsi(l, Math.max(1, w - 2)));
      for (const line of wrapped.slice(0, PREVIEW_LINES)) lines.push(` ${line}`);
      if (wrapped.length > PREVIEW_LINES) lines.push(t.fg("dim", `  … ${wrapped.length - PREVIEW_LINES} more lines`));
    }
    const keys = (action: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel", fallback: string) => this.keybindings?.getKeys(action).join("/") || fallback;
    lines.push(truncateToWidth(t.fg("dim", ` ${keys("tui.select.up", "↑")}/${keys("tui.select.down", "↓")} move · type to filter · Tab suggested/all · → preview · ${keys("tui.select.confirm", "Enter")} copy · ${keys("tui.select.cancel", "Esc")} ${this.query ? "clear filter, then close" : "close"}`), w));
    lines.push(t.fg("accent", "─".repeat(w)));
    this.cached = { width, lines: lines.map((l) => truncateToWidth(l, w)) };
    return this.cached.lines;
  }
}
