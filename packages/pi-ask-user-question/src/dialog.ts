// herdr-web-ui and Collie read this dialog off the screen for phone cards; keep its layout compatible.
// See "herdr-web-ui compatibility" and "Collie compatibility" in the repository's docs/clients.md, and run
// `npm run check:clients`, before changing rendering.
// The question dialog, in the editor area at the bottom of pi's terminal UI like Claude Code's: the
// transcript stays visible above it. Several questions get a tab each plus a Review tab; every
// question ends with a "Type something." row that opens a multiline field under the options, `n` adds a note,
// and options with a Markdown preview show it beside the list (above the question in narrow terminals).
// The layout follows Pi's own select/input dialogs so herdr-web-ui can read it as a chat card.
import { DynamicBorder, getMarkdownTheme, getSelectListTheme, type KeybindingsManager, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
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
import { type EditorCreator, type ProseEditor, beginComposition, editorOwnsCancel, inline } from "./editor.ts";
import { BOX_CHROME, box, columns, contentWidth, type Natural, SIDE_ROWS, sideBySide, split, STACKED_ROWS } from "./preview.ts";
import { type Answer, type Choice, type DialogResult, makeAnswer } from "./result.ts";
import { type Question, TYPE_SOMETHING } from "./schema.ts";

/** Longest header shown in a tab or chip before it is cut with "…". */
export const HEADER_WIDTH = 16;
const NO_PREVIEW = "No preview for this option";
/** The typed-answer row of a multiple choice, named as OmO's form names it (herdr-web-ui reads it). */
const OWN_ANSWER = "Type your own answer";
/** A multiple choice's typed-answer option. */
const OTHER = "Other";

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
  /** Review's highlighted row: 0 submits, 1 cancels. */
  private reviewCursor = 0;
  /** Review's own note, about the answers as a whole. */
  private readonly reviewNotes: ProseEditor;
  private reviewNote = "";
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
    const saveReviewNote = (text: string) => {
      this.reviewNote = text.trim();
      this.reviewNotes.setText(this.reviewNote);
      this.closeEditor();
    };
    this.reviewNotes = createEditor?.(tui, editorTheme, keybindings, saveReviewNote, () => this.closeEditor()) ?? new Editor(tui, editorTheme) as ProseEditor;
    this.reviewNotes.onSubmit = saveReviewNote;
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
      // Ctrl+J/Ctrl+K move between rows from an open field too, in any editor mode: a note is
      // saved, an answer draft is kept on its row. Shift+Enter is the newline key.
      const step = matchesKey(data, "ctrl+j") ? 1 : matchesKey(data, "ctrl+k") ? -1 : 0;
      // Up from an empty field does nothing, as Pi's kill-to-end would: herdr-web-ui clears a text
      // field with ctrl+k ctrl+u before typing an answer into it.
      if (step === -1 && !editor?.getText()) return;
      if (step && !this.onReview()) return this.leaveEditor(step);
      if (editor && kb.matches(data, "tui.select.cancel") && !editorOwnsCancel(editor)) this.closeEditor();
      else editor?.handleInput(data);
      return;
    }
    const many = this.questions.length > 1;
    const reserved = kb.matches(data, "tui.select.confirm") || kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down");
    if (!reserved && many && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
      // A ticked "Other" with nothing typed yet asks for its text before moving on.
      if (!this.onReview() && this.wantsText(this.tab)) return this.openEditor("custom");
      return this.go(1);
    }
    if (!reserved && many && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) return this.go(-1);
    if (this.onReview()) {
      const key = printable(data);
      if (kb.matches(data, "tui.select.confirm")) {
        if (this.reviewCursor === 0) this.submitReview();
        else this.finish(true);
      } else if (kb.matches(data, "tui.select.cancel")) this.finish(true);
      else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") || matchesKey(data, "ctrl+j") || matchesKey(data, "ctrl+k") || key === "j" || key === "k") {
        this.reviewCursor = 1 - this.reviewCursor;
      } else if (key === "n" || matchesKey(data, "ctrl+g")) this.openEditor("notes");
      return;
    }
    const q = this.questions[this.tab]!;
    const slot = this.slots[this.tab]!;
    const rows = q.options.length + 1;
    const key = printable(data);
    // A bare LF is Ctrl+J in a legacy terminal (Enter sends CR), though it also matches "enter".
    if (data === "\n") {
      slot.cursor = (slot.cursor + 1) % rows;
      return;
    }
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
      if (Number(key) > rows) return;
      slot.cursor = Number(key) - 1;
      // A multiple choice's number toggles its option, as OmO's form does; on "Other" it only
      // ticks it, and the text is asked for when the answer is committed.
      if (q.multiSelect && slot.cursor < q.options.length) this.toggle(q, slot);
      else if (q.multiSelect) {
        slot.typedChecked = !slot.typedChecked;
        this.updateMulti(q, slot);
      }
    } else if (key === " " && q.multiSelect) this.toggle(q, slot);
    else if (q.multiSelect && matchesKey(data, Key.backspace)) {
      // Clears the checks (herdr-web-ui starts a multiple-choice answer with it).
      slot.checked.clear();
      slot.typedChecked = false;
      this.updateMulti(q, slot);
    } else if (q.multiSelect && !many && matchesKey(data, Key.tab)) {
      if (this.wantsText(this.tab)) this.openEditor("custom");
      else if (slot.choice) this.advance();
    }
    else if (key === "n") this.openEditor("notes");
  }

  private confirm(q: Question, slot: Slot): void {
    if (slot.cursor === q.options.length) return this.openEditor("custom");
    if (!q.multiSelect) {
      const option = q.options[slot.cursor]!;
      slot.choice = { kind: "option", label: option.label, ...(option.preview ? { preview: option.preview } : {}) };
      return this.advance();
    }
    if (this.wantsText(this.tab)) return this.openEditor("custom");
    // Enter with nothing checked picks the highlighted option alone.
    if (slot.checked.size === 0 && !slot.typedChecked) slot.checked.add(slot.cursor);
    this.updateMulti(q, slot);
    this.advance();
  }

  /** A multiple choice's "Other" is ticked but has no text yet. */
  private wantsText(index: number): boolean {
    const slot = this.slots[index];
    return !!this.questions[index]?.multiSelect && !!slot?.typedChecked && !slot.typed;
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

  private leaveEditor(step: 1 | -1): void {
    const slot = this.slots[this.tab]!;
    if (this.editing === "notes") this.saveNote(this.tab, slot.notes.getText());
    else this.closeEditor();
    const rows = this.questions[this.tab]!.options.length + 1;
    slot.cursor = (slot.cursor + step + rows) % rows;
  }

  private openEditor(kind: Editing): void {
    if (this.onReview()) {
      this.editing = "notes";
      beginComposition(this.reviewNotes);
      this.syncFocus();
      return;
    }
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
    if (this.onReview()) return this.editing ? this.reviewNotes : undefined;
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
    this.reviewNotes.focused = this.hasFocus && this.reviewNotes === open;
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
    if (this.reviewNotes.getText().trim() !== this.reviewNote) return this.openEditor("notes");
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
    this.reviewNotes.dispose?.();
    const answers: Answer[] = [];
    this.slots.forEach((slot, i) => {
      if (cancelled && !slot.choice) return;
      answers.push(makeAnswer(this.questions, i, slot.choice, slot.note));
    });
    this.done({ cancelled, answers, ...(!cancelled && this.reviewNote ? { note: this.reviewNote } : {}) });
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
    // The top border carries the title `Ask user`, the first line of OmO's ask_user_question form
    // (then a tab bar ending in Submit), which herdr-web-ui reads for its multiple-choice cards;
    // it reads any line that starts with those words, so a titled border costs no line of its own.
    const t = this.theme;
    const lone = this.questions.length === 1 ? this.questions[0]! : undefined;
    // A lone multiple choice names its header in the tab bar it needs anyway, not twice.
    const chip = lone?.header && !lone.multiSelect ? ` ${t.fg("dim", "·")} ${t.bg("selectedBg", t.fg("accent", t.bold(` ${clipHeader(lone.header)} `)))}` : "";
    // A multiple choice says so up top: its rows leave unchecked boxes blank (anything drawn there
    // would show in the phone card's option text), so this and the ✓ column are the cue.
    const current = this.onReview() ? undefined : this.questions[this.tab];
    const cue = current?.multiSelect && !lone ? ` ${t.fg("dim", "·")} ${t.fg("accent", "choose any")}` : "";
    // herdr-web-ui wants a `·` after `Ask user` whenever anything follows it on the line.
    const title = ` ${t.fg("muted", "Ask user")}${chip || cue ? `${chip}${cue}` : ` ${t.fg("dim", "·")}`} `;
    const out = [title + t.fg("accent", "─".repeat(Math.max(0, width - visibleWidth(title))))];
    if (!lone) out.push(...wrap(` ${this.tabBar()}`, width));
    // One tab label (single spaces inside it), then Submit: OmO's tab bar, which herdr-web-ui needs.
    else if (lone.multiSelect) out.push(` ${t.bg("selectedBg", t.fg("accent", t.bold(` → ${clipHeader(lone.header || "Q1")} `)))}${t.fg("dim", "·")} ${t.fg("accent", "choose any")}   ${t.fg("dim", "Submit")}`);
    out.push("");
    out.push(...(this.onReview() ? this.review(width) : this.question(width)));
    out.push(...this.border.render(width));
    return out;
  }

  private tabBar(): string {
    const t = this.theme;
    // OmO's shape: `→` on the open tab, `✓` after an answered one, Submit last, two spaces or more apart.
    const tab = (text: string, open: boolean, color: "success" | "muted" | "dim") =>
      open ? t.bg("selectedBg", t.fg("text", `→ ${text}`)) : t.fg(color, text);
    const tabs = this.questions.map((q, i) => {
      const answered = !!this.slots[i]!.choice;
      return tab(`${clipHeader(q.header || `Q${i + 1}`)}${answered ? " ✓" : ""}`, i === this.tab, answered ? "success" : "muted");
    });
    tabs.push(tab("Submit", this.onReview(), this.slots.every((s) => s.choice) ? "success" : "dim"));
    return tabs.join("   ");
  }

  private question(width: number): string[] {
    const t = this.theme;
    const q = this.questions[this.tab]!;
    const slot = this.slots[this.tab]!;
    const out: string[] = [];
    // Laid out as Pi's own select and input dialogs are, top to bottom: the question, a blank,
    // one row per option (anything under a row is a `│` continuation of it), a blank, then Pi's
    // key hint. herdr-web-ui reads a pi dialog off the screen by exactly that, and a phone then
    // gets the options (or a text box) instead of a bare Enter/Esc card.
    const hasPreview = !q.multiSelect && slot.cursor < q.options.length && q.options.some((o) => o.preview);
    // A stacked preview goes over the question, so nothing comes between the rows and the hint.
    if (hasPreview && !sideBySide(width) && width >= 8) out.push(...indent(this.preview(slot, width - 2, STACKED_ROWS), 1), "");
    out.push(...hang(" ", t.bold(t.fg("text", q.question)), width));
    if (slot.note && this.editing !== "notes") out.push(...hang(" ", t.fg("dim", `note: ${oneLine(slot.note)}`), width));
    out.push("");

    if (hasPreview && sideBySide(width)) {
      const { left, right } = split(width, this.natural(q, slot, width));
      out.push(...columns(this.options(q, slot, left), this.preview(slot, right, SIDE_ROWS), left));
    } else out.push(...this.options(q, slot, width));
    out.push("");

    if (this.editing) {
      const title =
        this.editing === "notes"
          ? t.fg("accent", t.bold("Note"))
          : this.emptyAnswer
            ? t.fg("warning", "Write an answer before continuing.")
            : `${t.fg("accent", t.bold("Your answer"))}${t.fg("dim", ` · ${q.question}`)}`;
      const editor = this.editing === "custom" ? slot.custom : slot.notes;
      out.push(...hang(" ", title, width), "", ...inline(` ${t.fg("accent", "›")} `, "", editor, width, t), "");
      out.push(...hintLines(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`, width));
    } else if (q.multiSelect) {
      // OmO's multiple-choice hint, so herdr-web-ui offers checkboxes for this question.
      const many = this.questions.length > 1;
      const keys = [["↑↓", "move"], ["1-9", "select"], ["space", "toggle"], ["enter", "next"], ["tab", many ? "next question" : "done"], ["n", "note"], ["esc", "cancel"]];
      out.push(...hintLines(keys.map(([k, d]) => rawKeyHint(k!, d!)).join("  "), width));
    } else {
      const extra = `${this.questions.length > 1 ? `${rawKeyHint("tab", "next")}  ` : ""}${rawKeyHint("n", "note")}  `;
      out.push(...hintLines(`${extra}${menuHint()}`, width));
    }
    return out;
  }

  /** The option rows and the "Type something." row, `width` columns wide. */
  private options(q: Question, slot: Slot, width: number): string[] {
    const t = this.theme;
    const out: string[] = [];
    const own = q.options.length;
    // `description` follows the label on its line. A single choice is laid out as Pi's select (a
    // wrapped rest goes behind a `│`, which herdr-web-ui joins to the row); a multiple choice as
    // OmO's form (a ✓ after each checked row, an unnumbered typed-answer row, and wrapped lines
    // indented five or more, which it reads as the row's description).
    const row = (i: number, label: string, description: string | undefined, mark: boolean, blank = false) => {
      const focused = slot.cursor === i || (i === own && this.editing === "custom");
      const number = `${t.fg(focused ? "accent" : "muted", `${i + 1}.`)} `;
      // A multiple choice keeps its ticks in one column after the numbers; a single choice ticks after the label.
      const column = q.multiSelect ? (mark ? `${t.fg("success", "✓")} ` : "  ") : "";
      const prefix = ` ${focused ? t.fg("accent", "→") : " "} ${number}${column}`;
      const text =
        (blank ? concealed(label) : t.fg(focused ? "accent" : "text", focused ? t.bold(label) : label)) +
        (mark && !column ? t.fg("success", " ✓") : "") +
        (description ? t.fg("muted", ` · ${description}`) : "");
      const [first = "", ...rest] = hang(prefix, text, width);
      out.push(first, ...(q.multiSelect ? rest.map((line) => ` ${line}`) : gutter(rest, t)));
    };
    q.options.forEach((o, i) => {
      const mark = q.multiSelect ? slot.checked.has(i) : slot.choice?.kind === "option" && slot.choice.label === o.label;
      row(i, o.label, o.description || undefined, mark);
    });
    // A draft stays on its row, after (or in place of) the typed-answer label; the field opens below.
    const draft = oneLine(slot.custom.getText().trim());
    if (!q.multiSelect) {
      // Highlighted and still empty, the row looks like an empty field with a cursor, ready for
      // typing. The label is only concealed, so herdr-web-ui still reads "Type something." there.
      const blank = !draft && slot.cursor === own && !this.editing;
      row(own, draft || TYPE_SOMETHING, undefined, slot.choice?.kind === "custom", blank);
      return out;
    }
    // A multiple choice's typed answer is an option of its own, "Other", so a phone's checkbox card
    // can tick it (the text is asked for next). OmO's form also has an unnumbered typed-answer row,
    // which herdr-web-ui requires; here it is a faint line of help.
    row(own, draft ? `${OTHER}: ${draft}` : OTHER, draft ? undefined : "type your own answer", slot.typedChecked);
    out.push(...hang("   ", t.fg("dim", `${OWN_ANSWER}: check ${own + 1}, then enter.`), width));
    return out;
  }

  /**
   * Unwrapped widths of the option rows and of every option's preview (all of them, so the
   * columns do not shift as the highlight moves).
   */
  private natural(q: Question, slot: Slot, width: number): Natural {
    const rows = [...q.options, { label: TYPE_SOMETHING, description: "" }].map((o, i) => {
      const prefix = 4 + `${i + 1}.`.length;
      const label = prefix + visibleWidth(o.label) + 4;
      return { label, description: o.description ? label + 3 + visibleWidth(o.description) : 0 };
    });
    const labels = Math.max(...rows.map((r) => r.label));
    const inner = Math.max(1, width - 2 - BOX_CHROME);
    const previews = slot.previews.map((md) => (md ? contentWidth(md.render(inner)) : visibleWidth(NO_PREVIEW)));
    return { labels, options: Math.max(labels, ...rows.map((r) => r.description)), preview: Math.max(0, ...previews) };
  }

  private preview(slot: Slot, width: number, rows: number): string[] {
    const t = this.theme;
    const md = slot.previews[slot.cursor];
    const content = md ? md.render(Math.max(1, width - BOX_CHROME)) : [t.fg("muted", t.italic(NO_PREVIEW))];
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
    const draft = this.reviewNotes.getText().trim();
    if (this.reviewNote && this.editing !== "notes") out.push("", ...hang(" ", t.fg("dim", `note: ${oneLine(this.reviewNote)}`), width));
    if (!this.editing && draft !== this.reviewNote) out.push(...hang(" ", t.fg("warning", `unsaved note: ${oneLine(draft) || "(cleared)"}`), width));
    if (this.editing) {
      out.push("", ...hang(" ", t.fg("accent", t.bold("Note")), width), "", ...inline(` ${t.fg("accent", "›")} `, "", this.reviewNotes, width, t), "");
      out.push(...hintLines(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`, width));
      return out;
    }
    out.push("", ` ${t.fg("text", "Submit these answers?")}`, "");
    ["Submit answers", "Cancel"].forEach((label, i) => {
      const focused = this.reviewCursor === i;
      out.push(` ${focused ? t.fg("accent", "→") : " "} ${focused ? t.fg("accent", t.bold(label)) : t.fg("text", label)}`);
    });
    out.push("", ...hintLines(`${rawKeyHint("tab", "back")}  ${rawKeyHint("n", "note")}  ${menuHint()}`, width));
    return out;
  }

}

/**
 * `label` hidden (SGR 8), its first cell drawn as a block cursor. The characters stay in the
 * terminal's cells, so a screen read (herdr's) still has the label; only the display is blank.
 */
function concealed(label: string): string {
  const [first = " ", ...rest] = [...label];
  return `\x1b[7;8m${first}\x1b[27m${rest.join("")}\x1b[28m`;
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

/** Pi's own select hint, which herdr-web-ui looks for at the end of a dialog's last line. */
function menuHint(): string {
  return `${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`;
}

function hintLines(text: string, width: number): string[] {
  // A row wraps at a hint boundary, so the separator's spaces would open the next row: every row of a
  // hint stays one column in, as Pi's own (and as Collie reads a wrapped footer).
  const p = 1;
  if (p >= width - 4) return hang(" ", text, width);
  return wrap(text, width - p).map((line) => ` ${line.replace(/^((?:\x1b\[[0-9;:]*m)*) +/u, "$1")}`);
}

/**
 * Lines under an option row (its wrapped label, its description) behind a dim `│` in column two.
 * Besides lining them up, the bar marks them as the row's own: herdr-web-ui joins a line that
 * starts with exactly one space and no cursor to the row above it, and drops a leading `│`.
 */
function gutter(lines: string[], t: Theme): string[] {
  return lines.map((line) => (line.startsWith("  ") ? ` ${t.fg("dim", "│")}${line.slice(2)}` : line));
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
