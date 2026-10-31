import { stripVTControlCharacters } from "node:util";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  type Component, type Focusable, CURSOR_MARKER, Input, fuzzyFilter, isKeyRelease,
  matchesKey, truncateToWidth,
} from "@earendil-works/pi-tui";

export interface PickerTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const VISIBLE = 8;

/** Display-only text: never return this in place of the original prompt. */
function preview(text: string): string {
  return stripVTControlCharacters(text).replace(/\s+/gu, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/gu, "");
}

export class HistoryPicker implements Component, Focusable {
  private readonly input = new Input({ prompt: "search: " });
  private readonly prompts: string[];
  private matches: string[] = [];
  private selected = 0;
  private visible = VISIBLE;
  private finished = false;
  private readonly theme: PickerTheme;
  private readonly keybindings: KeybindingsManager;
  private readonly requestRender: () => void;
  private readonly done: (text: string | undefined) => void;
  private readonly terminalHeight: () => number;

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }
  [Symbol.for("pi-plugins.input-context.v1")](): string { return "filter"; }

  constructor(
    prompts: readonly string[],
    initialQuery: string,
    theme: PickerTheme,
    keybindings: KeybindingsManager,
    requestRender: () => void,
    done: (text: string | undefined) => void,
    terminalHeight: () => number = () => Infinity,
  ) {
    this.theme = theme;
    this.keybindings = keybindings;
    this.requestRender = requestRender;
    this.done = done;
    this.terminalHeight = terminalHeight;
    this.prompts = [...prompts];
    // Bracketed paste inserts literal text with the cursor at the end, independent
    // of configured selection/cursor actions that might match the draft itself.
    this.input.handleInput(`\x1b[200~${preview(initialQuery)}\x1b[201~`);
    this.filter();
  }

  private filter(): void {
    const query = this.input.getValue();
    // fuzzyFilter's stable score sort preserves recency on equal scores.
    this.matches = query ? fuzzyFilter(this.prompts, query, (text) => text) : [...this.prompts];
    this.selected = 0;
  }

  private finish(text: string | undefined): void {
    this.finished = true;
    this.done(text);
  }

  handleInput(data: string): void {
    if (this.finished || isKeyRelease(data)) return;
    const action = (name: Parameters<KeybindingsManager["matches"]>[1]) => this.keybindings.matches(data, name);
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || action("tui.select.cancel")) {
      return this.finish(undefined);
    }
    let delta = 0;
    if (action("tui.select.up") || matchesKey(data, "ctrl+p") || matchesKey(data, "ctrl+k")) delta = -1;
    else if (action("tui.select.down") || matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+j") || matchesKey(data, "ctrl+r")) delta = 1;
    else if (action("tui.select.pageUp")) delta = -this.visible;
    else if (action("tui.select.pageDown")) delta = this.visible;
    if (delta) {
      this.selected = Math.max(0, Math.min(this.matches.length - 1, this.selected + delta));
    } else if (action("tui.select.confirm")) {
      const text = this.matches[this.selected];
      if (text !== undefined) this.finish(text);
      return;
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      // Input owns editing and bracketed paste; sanitize any pasted terminal controls.
      const value = this.input.getValue();
      const safe = preview(value);
      if (safe !== value) this.input.setValue(safe);
      if (this.input.getValue() !== before) this.filter();
    }
    this.requestRender();
  }

  invalidate(): void { this.input.invalidate(); }

  render(width: number, height = Infinity): string[] {
    const w = Math.max(0, width);
    const t = this.theme;
    // Native fullscreen reserves one transcript row and a three-row editor
    // minimum, even on a three-row terminal: the root clips the dock's last
    // row. Collapse to the chosen result first instead of moving its cursor
    // onto an unrelated row to coax the leaf's cursor-follow clipping.
    const h = Math.max(0, Math.floor(this.terminalHeight() <= 3 ? Math.min(height, 1) : height));
    // Drop decoration before results on tiny terminals. Even a one-row viewport
    // can show the selection; normal viewports retain the full frame and hints.
    const lines: string[] = [];
    if (h >= 4) lines.push(t.fg("accent", `╭ ${t.bold("Prompt history")} ${"─".repeat(Math.max(0, w - 18))}╮`));
    // The ordinary custom dock is a native Container leaf; the layout only
    // renders it at intrinsic height and clips around CURSOR_MARKER. Keep that
    // marker on the chosen result so both clipping and host cursor position
    // identify the item Enter restores.
    if (h >= 2) lines.push(...this.input.render(Math.max(1, w)).map(line =>
      this.matches.length ? line.replaceAll(CURSOR_MARKER, "") : line));
    const footer: string[] = [];
    if (h >= 3 || (!this.matches.length && h > 0)) {
      footer.push(t.fg("dim", this.matches.length ? `${this.selected + 1}/${this.matches.length}` : "No matches"));
    }
    if (h >= 6) footer.push(t.fg("dim", "↑↓ move · Enter restore · Esc cancel"));
    if (h >= 5) footer.push(t.fg("accent", `╰${"─".repeat(Math.max(0, w - 2))}╯`));
    this.visible = Math.max(1, Math.min(VISIBLE, h - lines.length - footer.length));
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.visible / 2), this.matches.length - this.visible));
    for (let i = start; h > 0 && i < Math.min(this.matches.length, start + this.visible); i++) {
      const chosen = i === this.selected;
      lines.push(t.fg(chosen ? "accent" : "muted", `${chosen ? "›" : " "} ${preview(this.matches[i])}`));
    }
    const selectedRow = lines.findIndex(line => stripVTControlCharacters(line).startsWith("› "));
    lines.push(...footer);
    if (this.focused && selectedRow >= 0) {
      // Even hosts that expose a hidden hardware cursor must never show a
      // second caret on an unrelated row. Input retains its software caret.
      lines[selectedRow] = CURSOR_MARKER + lines[selectedRow];
    }
    return lines.map((line) => truncateToWidth(line, w));
  }
}
