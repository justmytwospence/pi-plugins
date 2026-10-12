// The question dialog, in the editor area at the bottom of pi's terminal UI like Claude Code's: the
// transcript stays visible above it. Several questions get a tab each plus a Review tab; every
// question ends with a "Type something." row that opens a multiline editor, `n` adds a note, and
// options with a Markdown preview show it beside the list (below it in narrow terminals).
import { DynamicBorder, getMarkdownTheme, getSelectListTheme, type KeybindingsManager, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  decodeKittyPrintable,
  Editor,
  type EditorTheme,
  type Focusable,
  isKeyRelease,
  Key,
  Markdown,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type EditorCreator, type ProseEditor, beginComposition, compositionState, editorOwnsCancel } from "./editor.ts";
import { box, columns, leftWidth, rightWidth, SIDE_ROWS, sideBySide, STACKED_ROWS } from "./preview.ts";
import { type Answer, type Choice, type DialogResult, makeAnswer } from "./result.ts";
import { type Question, TYPE_SOMETHING } from "./schema.ts";

/** Longest header shown in a tab or chip before it is cut with "…". */
export const HEADER_WIDTH = 16;

interface Slot {
  /** The highlighted row: an option, or the "Type something." row after them. */
  cursor: number;
  /** The committed answer; multi-select answers follow the checked rows as they change. */
  choice?: Choice;
  /** Multi-select: checked options, and whether the typed text is checked. */
  checked: Set<number>;
  typedChecked: boolean;
  /** The saved "Type something." text; the editor holds the draft. */
  typed: string;
  note: string;
  custom: ProseEditor;
  notes: ProseEditor;
  previews: Array<Markdown | undefined>;
}

type Editing = "custom" | "notes";

export function clipHeader(header: string): string {
  return truncateToWidth(header, HEADER_WIDTH, "…");
}

export class QuestionDialog implements Component, Focusable {
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly questions: Question[];
  private readonly done: (result: DialogResult) => void;
  private readonly signal: AbortSignal | undefined;
  private readonly slots: Slot[];
  private readonly border: DynamicBorder;
  /** The open tab: a question, or `questions.length` for Review. */
  private tab = 0;
  private editing: Editing | undefined;
  private emptyAnswer = false;
  private finished = false;
  private hasFocus = false;
  private cache: { width: number; lines: string[] } | undefined;
  private readonly onAbort = () => {
    this.finish(true);
    this.tui.requestRender();
  };

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    questions: Question[],
    done: (result: DialogResult) => void,
    signal?: AbortSignal,
    createEditor?: EditorCreator,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.questions = questions;
    this.done = done;
    this.signal = signal;
    this.border = new DynamicBorder((s) => theme.fg("accent", s));
    const editorTheme: EditorTheme = { borderColor: (s) => theme.fg("accent", s), selectList: getSelectListTheme() };
    this.slots = questions.map((q, i) => {
      const saveCustom = (text: string) => this.saveTyped(i, text);
      const saveNotes = (text: string) => this.saveNote(i, text);
      const custom = createEditor?.(tui, editorTheme, keybindings, saveCustom, () => this.closeEditor()) ?? new Editor(tui, editorTheme) as ProseEditor;
      const notes = createEditor?.(tui, editorTheme, keybindings, saveNotes, () => this.closeEditor()) ?? new Editor(tui, editorTheme) as ProseEditor;
      custom.onSubmit = saveCustom;
      notes.onSubmit = saveNotes;
      return { cursor: 0, checked: new Set(), typedChecked: false, typed: "", note: "", custom, notes, previews: this.previewsFor(q) };
    });
    signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.syncFocus();
  }

  [Symbol.for("pi-plugins.input-context.v1")]() { return this.editing ? "editor" : "list"; }

  // --- input -------------------------------------------------------------------------------

  handleInput(data: string): void {
    if (this.finished || isKeyRelease(data)) return;
    this.input(data);
    this.refresh();
  }

  private input(data: string): void {
    const kb = this.keybindings;
    if (this.editing) {
      this.emptyAnswer = false;
      const editor = this.editor();
      if (editor && kb.matches(data, "tui.select.cancel") && !editorOwnsCancel(editor)) this.closeEditor();
      else editor?.handleInput(data);
      return;
    }
    const many = this.questions.length > 1;
    const reserved = kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down");
    if (!reserved && many && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) return this.go(1);
    if (!reserved && many && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) return this.go(-1);
    if (this.onReview()) {
      if (kb.matches(data, "tui.select.confirm")) this.submitReview();
      else if (kb.matches(data, "tui.select.cancel")) this.finish(true);
      return;
    }
    const q = this.questions[this.tab]!;
    const slot = this.slots[this.tab]!;
    const rows = q.options.length + 1;
    const key = printable(data);
    if (kb.matches(data, "tui.select.confirm")) return this.confirm(q, slot);
    if (kb.matches(data, "tui.select.cancel")) return this.finish(true);
    // A highlighted text row is a composition target: printable input and paste
    // belong to the answer, before n/j/k/digits can become list commands.
    if (!reserved && slot.cursor === q.options.length && (isTextInput(data) || (key === " " && (!q.multiSelect || !slot.typed)))) {
      this.openEditor("custom");
      slot.custom.handleInput(data);
      return;
    }
    if (matchesKey(data, "ctrl+g")) return this.openEditor("notes");
    if (kb.matches(data, "tui.select.up") || matchesKey(data, "ctrl+k") || key === "k") slot.cursor = (slot.cursor - 1 + rows) % rows;
    else if (kb.matches(data, "tui.select.down") || matchesKey(data, "ctrl+j") || key === "j") slot.cursor = (slot.cursor + 1) % rows;
    else if (key && /^[1-9]$/u.test(key)) {
      if (Number(key) <= rows) slot.cursor = Number(key) - 1;
    } else if (key === " " && q.multiSelect) this.toggle(q, slot);
    else if (key === "n") this.openEditor("notes");
  }

  private confirm(q: Question, slot: Slot): void {
    if (slot.cursor === q.options.length) return this.openEditor("custom");
    if (!q.multiSelect) {
      const option = q.options[slot.cursor]!;
      slot.choice = { kind: "option", label: option.label, ...(option.preview ? { preview: option.preview } : {}) };
      return this.advance();
    }
    // Enter with nothing checked picks the highlighted option alone.
    if (slot.checked.size === 0 && !slot.typedChecked) slot.checked.add(slot.cursor);
    this.updateMulti(q, slot);
    this.advance();
  }

  private toggle(q: Question, slot: Slot): void {
    if (slot.cursor === q.options.length) {
      if (!slot.typed) return this.openEditor("custom");
      slot.typedChecked = !slot.typedChecked;
    } else if (slot.checked.has(slot.cursor)) slot.checked.delete(slot.cursor);
    else slot.checked.add(slot.cursor);
    this.updateMulti(q, slot);
  }

  private updateMulti(q: Question, slot: Slot): void {
    const selected = q.options.filter((_, i) => slot.checked.has(i)).map((o) => o.label);
    if (slot.typedChecked && slot.typed) selected.push(slot.typed);
    slot.choice = selected.length ? { kind: "multi", selected } : undefined;
  }

  /** "Type something." saved: answers a single-select question; checks the text in a multi-select one. */
  private saveTyped(index: number, raw: string): void {
    const q = this.questions[index]!;
    const slot = this.slots[index]!;
    const text = raw.trim();
    if (!text) {
      slot.custom.setText(raw);
      slot.typed = "";
      if (q.multiSelect) {
        slot.typedChecked = false;
        this.updateMulti(q, slot);
      } else if (slot.choice?.kind === "custom") slot.choice = undefined;
      this.emptyAnswer = true;
      beginComposition(slot.custom);
      return;
    }
    slot.custom.setText(text); // submitting empties the editor; keep the text as the draft
    slot.typed = text;
    this.closeEditor();
    if (q.multiSelect) {
      slot.typedChecked = true;
      this.updateMulti(q, slot);
    } else slot.choice = { kind: "custom", text };
    this.advance();
  }

  private saveNote(index: number, raw: string): void {
    const slot = this.slots[index]!;
    slot.note = raw.trim();
    slot.notes.setText(slot.note);
    this.closeEditor();
  }

  private openEditor(kind: Editing): void {
    const slot = this.slots[this.tab]!;
    if (kind === "custom") slot.cursor = this.questions[this.tab]!.options.length;
    this.editing = kind;
    this.emptyAnswer = false;
    beginComposition(kind === "custom" ? slot.custom : slot.notes);
    this.syncFocus();
  }

  private closeEditor(): void {
    this.editing = undefined;
    this.emptyAnswer = false;
    this.syncFocus();
  }

  private editor(): ProseEditor | undefined {
    const slot = this.slots[this.tab];
    if (!slot || !this.editing) return undefined;
    return this.editing === "custom" ? slot.custom : slot.notes;
  }

  /** The cursor shows in the open editor only. */
  private syncFocus(): void {
    const open = this.editor();
    for (const slot of this.slots) {
      slot.custom.focused = this.hasFocus && slot.custom === open;
      slot.notes.focused = this.hasFocus && slot.notes === open;
    }
  }

  /** After an answer: submit a lone question, else go to the next unanswered one, then Review. */
  private advance(): void {
    const n = this.questions.length;
    if (n === 1) return this.finish(false);
    for (let step = 1; step < n; step++) {
      const i = (this.tab + step) % n;
      if (!this.slots[i]!.choice) {
        this.tab = i;
        return;
      }
    }
    this.tab = n;
  }

  private go(direction: 1 | -1): void {
    const tabs = this.questions.length + 1;
    this.tab = (this.tab + direction + tabs) % tabs;
  }

  /** Review never silently drops text left behind with Escape. */
  private submitReview(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      const kind = slot.custom.getText().trim() !== slot.typed ? "custom" : slot.notes.getText().trim() !== slot.note ? "notes" : undefined;
      if (kind) {
        this.tab = i;
        this.openEditor(kind);
        return;
      }
    }
    this.finish(false);
  }

  private onReview(): boolean {
    return this.tab === this.questions.length;
  }

  private finish(cancelled: boolean): void {
    if (this.finished) return;
    this.finished = true;
    this.signal?.removeEventListener("abort", this.onAbort);
    for (const slot of this.slots) { slot.custom.dispose?.(); slot.notes.dispose?.(); }
    const answers: Answer[] = [];
    this.slots.forEach((slot, i) => {
      if (cancelled && !slot.choice) return;
      answers.push(makeAnswer(this.questions, i, slot.choice, slot.note));
    });
    this.done({ cancelled, answers });
  }

  private refresh(): void {
    this.cache = undefined;
    this.tui.requestRender();
  }

  // --- rendering ---------------------------------------------------------------------------

  render(width: number): string[] {
    if (!this.editing && this.cache?.width === width) return this.cache.lines;
    const w = Math.max(1, width);
    const lines = this.build(w).map((line) => (visibleWidth(line) > w ? truncateToWidth(line, w) : line));
    if (!this.editing) this.cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = undefined;
    this.border.invalidate();
    this.questions.forEach((q, i) => {
      const slot = this.slots[i]!;
      slot.previews = this.previewsFor(q);
      slot.custom.invalidate();
      slot.notes.invalidate();
    });
  }

  private previewsFor(q: Question): Array<Markdown | undefined> {
    return q.options.map((o) => (o.preview ? new Markdown(o.preview, 0, 0, getMarkdownTheme()) : undefined));
  }

  private build(width: number): string[] {
    const out = [...this.border.render(width)];
    if (this.questions.length > 1) out.push(...wrap(` ${this.tabBar()}`, width), "");
    out.push(...(this.onReview() ? this.review(width) : this.question(width)));
    out.push("", ...wrap(` ${this.hints()}`, width), ...this.border.render(width));
    return out;
  }

  private tabBar(): string {
    const t = this.theme;
    const tabs = this.questions.map((q, i) => {
      const answered = !!this.slots[i]!.choice;
      const text = ` ${answered ? "■" : "□"} ${clipHeader(q.header || `Q${i + 1}`)} `;
      return i === this.tab ? t.bg("selectedBg", t.fg("text", text)) : t.fg(answered ? "success" : "muted", text);
    });
    const ready = this.slots.every((s) => s.choice);
    const review = " Review ";
    tabs.push(this.onReview() ? t.bg("selectedBg", t.fg("text", review)) : t.fg(ready ? "success" : "dim", review));
    return tabs.join(" ");
  }

  private question(width: number): string[] {
    const t = this.theme;
    const q = this.questions[this.tab]!;
    const slot = this.slots[this.tab]!;
    const out: string[] = [];
    const chip = this.questions.length === 1 && q.header ? `${t.bg("selectedBg", t.fg("accent", t.bold(` ${clipHeader(q.header)} `)))} ` : "";
    const hint = q.multiSelect ? t.fg("muted", " (select all that apply)") : "";
    out.push(...hang(" ", `${chip}${t.bold(t.fg("text", q.question))}${hint}`, width), "");

    const hasPreview = !q.multiSelect && slot.cursor < q.options.length && q.options.some((o) => o.preview);
    if (hasPreview && sideBySide(width)) {
      const left = leftWidth(width, this.naturalWidth(q));
      out.push(...columns(this.options(q, slot, left), this.preview(slot, rightWidth(width, left), SIDE_ROWS), left));
    } else out.push(...this.options(q, slot, width));
    if (this.editing === "custom") {
      out.push(` ${t.fg("accent", "Your answer:")}`, ...indent(slot.custom.render(Math.max(1, width - 4)), 4));
      if (this.emptyAnswer) out.push(...hang("   ", t.fg("warning", "Write an answer before continuing."), width));
    }
    if (hasPreview && !sideBySide(width) && width >= 8) out.push("", ...indent(this.preview(slot, width - 2, STACKED_ROWS), 1));

    if (this.editing === "notes") out.push("", ` ${t.fg("accent", "Notes:")}`, ...indent(slot.notes.render(Math.max(1, width - 2)), 1));
    else if (slot.note) out.push("", ...hang("   ", t.fg("dim", `note: ${oneLine(slot.note)}`), width));
    return out;
  }

  /** The option rows and the "Type something." row, `width` columns wide. */
  private options(q: Question, slot: Slot, width: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    const row = (i: number, label: string, checked: boolean, chosen: boolean) => {
      const focused = slot.cursor === i || (i === q.options.length && this.editing === "custom");
      const box = q.multiSelect ? (checked ? "[x] " : "[ ] ") : "";
      const prefix = ` ${focused ? t.fg("accent", "❯") : " "} ${t.fg(focused ? "accent" : "muted", `${i + 1}.`)} ${box ? t.fg(checked ? "success" : "muted", box) : ""}`;
      const text = t.fg(focused ? "accent" : "text", focused ? t.bold(label) : label) + (chosen ? t.fg("success", " ✓") : "");
      out.push(...hang(prefix, text, width));
      return " ".repeat(visibleWidth(prefix));
    };
    q.options.forEach((o, i) => {
      const chosen = slot.choice?.kind === "option" && slot.choice.label === o.label;
      const pad = row(i, o.label, slot.checked.has(i), chosen);
      if (o.description) out.push(...hang(pad, t.fg("muted", o.description), width));
    });
    const pad = row(q.options.length, TYPE_SOMETHING, slot.typedChecked && !!slot.typed, slot.choice?.kind === "custom");
    const draft = slot.custom.getText().trim();
    if (draft && this.editing !== "custom") out.push(...hang(pad, t.fg("dim", oneLine(draft)), width).slice(0, 3));
    return out;
  }

  private naturalWidth(q: Question): number {
    const boxW = q.multiSelect ? 4 : 0;
    const labels = [...q.options.map((o) => o.label), TYPE_SOMETHING];
    return Math.max(...labels.map((label, i) => 5 + `${i + 1}.`.length + boxW + visibleWidth(label) + 2)) + 2;
  }

  private preview(slot: Slot, width: number, rows: number): string[] {
    const t = this.theme;
    const md = slot.previews[slot.cursor];
    const content = md ? md.render(Math.max(1, width - 4)) : [t.fg("muted", t.italic("No preview for this option"))];
    return box(
      content,
      width,
      rows,
      (s) => t.fg("border", s),
      (hidden) => t.fg("muted", `… ${hidden} more line${hidden === 1 ? "" : "s"}`),
    );
  }

  private review(width: number): string[] {
    const t = this.theme;
    const out = [` ${t.bold(t.fg("accent", "Review your answers"))}`, ""];
    this.questions.forEach((q, i) => {
      const slot = this.slots[i]!;
      const a = makeAnswer(this.questions, i, slot.choice, slot.note);
      const value =
        a.kind === "unanswered"
          ? t.fg("warning", "(not answered)")
          : `${a.kind === "custom" ? t.fg("muted", "(wrote) ") : ""}${t.fg("text", oneLine(a.answer ?? ""))}`;
      out.push(...hang(` ${t.fg("accent", clipHeader(q.header || `Q${i + 1}`))}${t.fg("muted", " → ")}`, value, width));
      if (a.notes) out.push(...hang("   ", t.fg("dim", `note: ${oneLine(a.notes)}`), width));
      for (const [draft, saved, label] of [[slot.custom.getText().trim(), slot.typed, "answer"], [slot.notes.getText().trim(), slot.note, "note"]] as const) {
        if (draft !== saved) out.push(...hang("   ", t.fg("warning", `unsaved ${label}: ${oneLine(draft) || "(cleared)"}`), width));
      }
    });
    return out;
  }

  private hints(): string {
    const hint = (action: "tui.select.confirm" | "tui.select.cancel" | "tui.input.submit" | "tui.input.newLine", label: string) => rawKeyHint(this.keybindings.getKeys(action).join("/") || "unbound", label);
    const many = this.questions.length > 1;
    if (this.editing) {
      const state = compositionState(this.editor()!);
      const action = this.editing === "custom" ? "use answer" : "save note";
      return [
        ...(state ? [state.toUpperCase()] : []),
        ...(state === "normal" ? [rawKeyHint("i", "insert")] : []),
        hint("tui.input.submit", action),
        hint("tui.input.newLine", "newline"),
        hint("tui.select.cancel", state && state !== "normal" ? "normal mode" : "back (keep draft)"),
      ].join("  ");
    }
    if (this.onReview()) {
      const drafts = this.slots.some((s) => s.custom.getText().trim() !== s.typed || s.notes.getText().trim() !== s.note);
      return [hint("tui.select.confirm", drafts ? "finish unsaved draft" : "submit"), rawKeyHint("tab", "questions"), hint("tui.select.cancel", "cancel")].join("  ");
    }
    const q = this.questions[this.tab]!;
    const multi = q.multiSelect;
    const custom = this.slots[this.tab]!.cursor === q.options.length;
    return [
      `${this.keybindings.getKeys("tui.select.up").join("/")}/${this.keybindings.getKeys("tui.select.down").join("/")} navigate`,
      ...(custom
        ? ["type or paste your answer", hint("tui.select.confirm", "edit answer"), ...(multi ? [rawKeyHint("space", "toggle/edit answer")] : [])]
        : multi ? [rawKeyHint("space", "toggle"), hint("tui.select.confirm", "done")] : [hint("tui.select.confirm", "select")]),
      rawKeyHint(custom ? "ctrl+g" : "n/ctrl+g", "notes"),
      ...(many ? [rawKeyHint("tab", "next question")] : []),
      hint("tui.select.cancel", "cancel"),
    ].join("  ");
  }
}

/** Text input, not control keys: preserve the original bytes for the editor. */
function isTextInput(data: string): boolean {
  if (data.startsWith("\x1b[200~")) return true;
  const text = printable(data) ?? data;
  return text.length > 0 && !/[\u0000-\u001f\u007f]/u.test(text) && text !== " ";
}

/** A plain character typed, from a legacy or a kitty-protocol terminal. */
function printable(data: string): string | undefined {
  if (data.length === 1) return data;
  return decodeKittyPrintable(data);
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/gu, " ⏎ ");
}

function wrap(text: string, width: number): string[] {
  return wrapTextWithAnsi(text, Math.max(1, width));
}

/** `text` wrapped after `prefix`, continuation lines indented to line up under it. */
function hang(prefix: string, text: string, width: number): string[] {
  const p = visibleWidth(prefix);
  if (p >= width - 4) return wrap(prefix + text, width);
  return wrap(text, width - p).map((line, i) => (i === 0 ? prefix : " ".repeat(p)) + line);
}

function indent(lines: string[], n: number): string[] {
  return lines.map((line) => " ".repeat(n) + line);
}
