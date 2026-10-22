// The Sidebar panel: a title bar with what main is doing, Sidebar's conversation in Pi's own look,
// Pi's working row while Sidebar answers, a one-line notice or confirmation, the composer, and a hint
// row. It lives in Pi's fullscreen layout next to main (see layout.ts). Keys follow Pi's own
// keybindings (`getKeybindings()`), so whatever you bound for main works here too.
import { getSelectListTheme, keyHint, rawKeyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  getKeybindings,
  Loader,
  matchesKey,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  VStack,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { EDITOR_MODE, EDITOR_SURFACE, INPUT_CONTEXT, requestEditorFactory, type EditorModeContext, type SuiteEditor } from "./contract.ts";
import { PiChat } from "./pi-chat.ts";
import { displayMessage } from "./quiz/protocol.ts";
import { WorkingStats, workingMessage } from "./working.ts";

export interface StatusPart {
  text: string;
  /** Dropped when the line does not fit; higher numbers go first. */
  optional?: number;
}

/** One line that fits `width`: optional parts drop out first, then the line is cut. */
export function fitStatus(parts: StatusPart[], width: number, separator: string): string {
  let kept = parts;
  const line = () => kept.map((p) => p.text).join(separator);
  const droppable = parts.filter((p) => p.optional).sort((a, b) => b.optional! - a.optional!);
  for (const part of droppable) {
    if (visibleWidth(line()) <= width) break;
    kept = kept.filter((p) => p !== part);
  }
  return truncateToWidth(line(), Math.max(1, width));
}

const FAINT = "\x1b[2m";
const SGR = /\x1b\[([0-9;]*)m/g;

/**
 * A line drawn faint, colors kept. A reset (0, or 22 which ends bold and faint together) turns faint
 * off again, so faint is re-applied after each one.
 */
export function dimLine(line: string): string {
  if (!line) return line;
  const body = line.replace(SGR, (sequence, params: string) => {
    const codes = params === "" ? ["0"] : params.split(";");
    return codes.includes("0") || codes.includes("22") ? `${sequence}${FAINT}` : sequence;
  });
  return `${FAINT}${body}\x1b[22m`;
}

export interface PanelHost {
  /** Title-bar parts: what main is doing, cache figures. */
  status(theme: Theme): StatusPart[];
  /** A question (or a `/` command) from the composer. */
  submit(text: string): void;
  /** Confirmed send of a held question. */
  confirm(text: string): void;
  abort(): void;
  focusMain(): void;
  focusSidebar(): void;
  close(): void;
  isBusy(): boolean;
  /** Ctrl+' by default: open or close Sidebar. */
  matchesToggle(data: string): boolean;
  /** How the open/close key is written in hints, e.g. ctrl+'. */
  toggleLabel: string;
  /** Optional direct focus-switch keys (`PI_SIDEBAR_FOCUS_KEYS`). */
  matchesFocusSwitch(data: string): boolean;
  /** Whether main hides thinking blocks (its `hideThinkingBlock` setting). */
  mainHidesThinking(): boolean;
  cwd: string;
  events?: { emit(channel: string, data: unknown): void };
}

type Notice = { kind: "info" | "warning" | "error"; text: string } | { kind: "confirm"; title: string; message: string; text: string };

/** A row drawn from state on every render; clicking it focuses Sidebar. */
class Row implements Component {
  constructor(private readonly draw: (width: number) => string[], private readonly onClick: () => void) {}
  render(width: number): string[] {
    return this.draw(width);
  }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click") return undefined;
    this.onClick();
    return { handled: true };
  }
  invalidate(): void {}
}

/** Pi's working row (its spinner, colors and pi-status-footer's message) while Sidebar answers. */
class WorkingRow implements Component {
  private readonly loader: Loader;
  private readonly stats = new WorkingStats();
  private startedAt = 0;
  private running = false;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private retry: string | undefined;

  constructor(private readonly tui: TUI, theme: () => Theme) {
    this.loader = new Loader(tui, (text) => theme().fg("accent", text), (text) => theme().fg("muted", text), "Working");
    this.loader.stop();
  }

  get active(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.retry = undefined;
    this.startedAt = Date.now();
    this.stats.reset();
    this.refresh();
    this.loader.start();
    this.ticker = setInterval(() => this.refresh(), 1000);
    this.ticker.unref?.();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.loader.stop();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.tui.requestRender();
  }

  apply(event: Record<string, unknown>): void {
    if (event.type === "agent_start") this.start();
    else if (event.type === "agent_end") this.stop();
    else if (event.type === "message_update" && event.assistantMessageEvent) {
      this.stats.apply(event.assistantMessageEvent as never);
      this.retry = undefined;
      this.refresh();
    } else if (event.type === "auto_retry_start") {
      this.retry = "Retrying…";
      this.refresh();
    }
  }

  private refresh(): void {
    if (!this.running) return;
    this.loader.setMessage(this.retry ?? workingMessage(this.stats.tokens(), Date.now() - this.startedAt) ?? "Working");
  }

  render(width: number): string[] {
    return this.running ? this.loader.render(width) : [];
  }

  invalidate(): void {
    this.loader.invalidate();
  }

  dispose(): void {
    this.stop();
  }
}

/** Pi's editor, or pi-vim's embedded editor when it answers the suite contract. */
function overlayShown(tui: TUI): boolean {
  try {
    return (tui as { hasOverlay?(): boolean }).hasOverlay?.() === true;
  } catch {
    return false;
  }
}

class Composer implements Component, Focusable {
  private readonly editor: (Component & Focusable & { getText(): string; setText(text: string): void; handleInput(data: string): void }) | SuiteEditor;
  private readonly suite: boolean;
  private _focused = false;

  /** Whether the composer is pi-vim's editor (its Normal mode scrolls with Ctrl+U/D). */
  get vim(): boolean {
    return this.suite;
  }

  constructor(private readonly tui: TUI, theme: () => Theme, private readonly panel: SidebarPanel, private readonly host: PanelHost) {
    const editorTheme: EditorTheme = {
      borderColor: (text) => (panel.focused ? theme().fg("borderAccent", text) : dimLine(theme().fg("borderMuted", text))),
      selectList: getSelectListTheme(),
    };
    const provided = requestEditorFactory(host.events);
    let suiteEditor: SuiteEditor | undefined;
    if (provided?.factory) {
      try {
        suiteEditor = provided.factory({
          surface: "embedded",
          tui,
          theme: editorTheme,
          keybindings: getKeybindings() as never,
          onSubmit: (text) => this.submit(text),
          onCancel: () => {},
          scrollViewport: (direction) => panel.scroll(direction * 0.5),
          notify: (message, type) => panel.notice({ kind: type, text: message }),
          paddingX: 0,
          initialText: "",
          initialMode: "insert",
        });
      } catch {
        suiteEditor = undefined;
      }
    }
    if (suiteEditor) {
      this.editor = suiteEditor;
      this.suite = true;
    } else {
      const editor = new Editor(tui, editorTheme, { paddingX: 0 });
      editor.onSubmit = (text) => this.submit(text);
      this.editor = editor;
      this.suite = false;
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value;
    // An overlay that takes focus from Sidebar (Pi's transcript search, a selector) acts for Sidebar,
    // so Sidebar stays the active half (and Pi's primary scroll view) until focus moves elsewhere.
    if (value || !overlayShown(this.tui)) this.panel.focused = value;
  }

  [INPUT_CONTEXT](): "editor" {
    return "editor";
  }

  [EDITOR_MODE](): EditorModeContext {
    return this.suite
      ? (this.editor as SuiteEditor)[EDITOR_MODE]()
      : { state: "insert", mode: "insert", pending: "", ex: null, autocomplete: false };
  }

  readonly [EDITOR_SURFACE] = "embedded" as const;

  getText(): string {
    return this.editor.getText();
  }

  setText(text: string): void {
    this.editor.setText(text);
  }

  private submit(text: string): void {
    const value = text.trim();
    if (!value) return;
    (this.editor as { addToHistory?(text: string): void }).addToHistory?.(value);
    this.editor.setText("");
    this.panel.submit(value);
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (this.host.matchesToggle(data)) return this.host.close();
    if (this.host.matchesFocusSwitch(data)) return this.host.focusMain();
    const pending = this.panel.pendingConfirm();
    if (pending) {
      if (matchesKey(data, "enter")) {
        this.panel.clearNotice();
        this.host.confirm(pending.text);
        return;
      }
      if (keys.matches(data, "app.interrupt")) {
        this.panel.clearNotice();
        if (!this.getText().trim()) this.setText(pending.text);
        return;
      }
    }
    // Main's own action keys, as you bound them, act on Sidebar.
    // Ctrl+C (app.clear) stops a running answer too, as in Claude Code; idle, it clears the composer.
    if ((keys.matches(data, "app.interrupt") || keys.matches(data, "app.clear")) && this.host.isBusy()) return this.host.abort();
    if (keys.matches(data, "app.tools.expand")) return this.panel.toggleExpanded();
    if (keys.matches(data, "app.thinking.toggle")) return this.panel.toggleThinking();
    if (!this.suite) {
      if (keys.matches(data, "app.interrupt") && this.panel.hasNotice()) return this.panel.clearNotice();
      if (keys.matches(data, "app.clear")) return this.editor.setText("");
      // Ctrl+D quits Pi from main's empty editor; Sidebar never quits Pi.
      if (keys.matches(data, "app.exit") && !this.getText()) return;
    }
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    return this.editor.render(width);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click") return undefined;
    this.host.focusSidebar();
    return { handled: true };
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  dispose(): void {
    if (this.suite) {
      try { (this.editor as SuiteEditor).dispose(); } catch { /* already gone */ }
    }
  }
}

export class SidebarPanel {
  readonly root: VStack;
  readonly input: Composer;
  readonly chat: PiChat;
  readonly view: ScrollView;
  readonly working: WorkingRow;
  private note: Notice | undefined;
  /** Main's thinking setting last applied to the chat; Sidebar's own toggle lasts until it changes. */
  private mainThinking: boolean | undefined;
  focused = false;
  unread = false;

  constructor(private readonly tui: TUI, private readonly theme: () => Theme, private readonly host: PanelHost) {
    this.chat = new PiChat(() => theme(), { cwd: host.cwd, userMessagesFromEvents: true, requestRender: () => tui.requestRender(), displayAssistant: displayMessage });
    this.syncThinking();
    const body: Component = {
      render: (width) => {
        this.syncThinking();
        const lines = this.chat.empty ? this.emptyState(width) : this.chat.render(width);
        return this.focused ? lines : lines.map(dimLine);
      },
      invalidate: () => {},
    };
    this.view = new ScrollView(body, { follow: "end", primary: false, overscroll: "contain", scrollbar: "auto" });
    this.working = new WorkingRow(tui, theme);
    this.input = new Composer(tui, theme, this, host);
    const focus = () => host.focusSidebar();
    const title = new Row((width) => [this.titleLine(width)], focus);
    const notice = new Row((width) => this.noticeLines(width), focus);
    const hint = new Row((width) => [this.hintLine(width)], focus);
    // Main's editor dock always has one blank row above the editor (Pi's empty widgets-above
    // container is a Spacer(1)), below the working row; notices sit after it, as widgets do.
    const spacer = new Row(() => [""], focus);
    this.root = new VStack([
      { component: title, basis: "auto" },
      { component: this.view, basis: 0, grow: 1, minSize: 1 },
      { component: this.working, basis: "auto" },
      { component: spacer, basis: "auto" },
      { component: notice, basis: "auto" },
      { component: this.input, basis: "auto" },
      { component: hint, basis: "auto" },
    ]);
  }

  submit(text: string): void {
    this.host.submit(text);
  }

  /** A Sidebar session event: the chat and the working row follow it. */
  apply(event: Record<string, unknown>): void {
    this.chat.apply(event);
    this.working.apply(event);
  }

  notice(note: Notice): void {
    this.note = note;
    this.tui.requestRender();
  }

  clearNotice(): void {
    this.note = undefined;
    this.tui.requestRender();
  }

  hasNotice(): boolean {
    return !!this.note;
  }

  pendingConfirm(): Extract<Notice, { kind: "confirm" }> | undefined {
    return this.note?.kind === "confirm" ? this.note : undefined;
  }

  /** Scroll Sidebar's conversation: lines, or pages when |amount| <= 1. */
  scroll(amount: number): void {
    const lines = Math.abs(amount) <= 1 ? Math.round(amount * Math.max(1, this.view.viewportHeight - 2)) : amount;
    this.view.scrollBy(lines);
    this.tui.requestRender();
  }

  scrollLines(lines: number): void {
    this.view.scrollBy(lines);
    this.tui.requestRender();
  }

  scrollToStart(): void {
    this.view.scrollToStart();
    this.tui.requestRender();
  }

  scrollToEnd(): void {
    this.view.scrollToEnd();
    this.tui.requestRender();
  }

  toggleExpanded(): void {
    this.chat.setExpanded(!this.chat.isExpanded);
  }

  /** Flip how Sidebar shows reasoning, until main's own setting changes. */
  toggleThinking(): void {
    this.chat.setThinkingHidden(!this.chat.thinkingHidden);
  }

  /** Follow main's `hideThinkingBlock` whenever it changes. */
  private syncThinking(): void {
    const hidden = this.host.mainHidesThinking();
    if (hidden === this.mainThinking) return;
    this.mainThinking = hidden;
    if (this.chat.thinkingHidden !== hidden) this.chat.setThinkingHidden(hidden);
  }

  dispose(): void {
    this.working.dispose();
    this.input.dispose();
  }

  private emptyState(width: number): string[] {
    const t = this.theme();
    const lines = [
      "",
      t.fg("muted", "Ask about what main is doing, why, or how the code works."),
      t.fg("dim", "Sidebar reads main's live conversation, never changes anything, and answers from main's prompt cache."),
      t.fg("dim", "/quiz quizzes you on main's changes and keeps track of what you know."),
    ];
    return lines.flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width - 1)).map((row) => ` ${row}`) : [""]));
  }

  private titleLine(width: number): string {
    const t = this.theme();
    const separator = t.fg("dim", " · ");
    if (this.focused) {
      const parts: StatusPart[] = [{ text: t.fg("accent", t.bold("◧ Sidebar")) }, ...this.host.status(t)];
      const line = fitStatus(parts, Math.max(1, width - 2), separator);
      return t.bg("selectedBg", ` ${line}${" ".repeat(Math.max(0, width - 2 - visibleWidth(line)))} `);
    }
    const parts: StatusPart[] = [{ text: "◧ Sidebar" }];
    if (this.unread) parts.push({ text: t.fg("accent", "● new answer") });
    parts.push({ text: `${this.host.toggleLabel} to close` }, ...this.host.status(t).map((p) => ({ ...p, optional: (p.optional ?? 0) + 1 })));
    const line = ` ${fitStatus(parts, Math.max(1, width - 1), separator)}`;
    // An unread answer stays bright; everything else on an unfocused Sidebar is faint.
    return this.unread ? line : dimLine(line);
  }

  private noticeLines(width: number): string[] {
    const note = this.note;
    if (!note) return [];
    const t = this.theme();
    if (note.kind === "confirm") {
      return [
        truncateToWidth(t.fg("warning", ` ${note.title}`), width),
        truncateToWidth(t.fg("muted", ` ${note.message}`), width),
      ];
    }
    const color = note.kind === "error" ? "error" : note.kind === "warning" ? "warning" : "muted";
    return [truncateToWidth(t.fg(color, ` ${note.text}`), width)];
  }

  private hintLine(width: number): string {
    const sep = "  ";
    let text: string;
    if (this.note?.kind === "confirm") text = [rawKeyHint("enter", "send anyway"), keyHint("app.interrupt", "keep the question")].join(sep);
    else if (!this.focused) return dimLine(truncateToWidth(` ${rawKeyHint(this.host.toggleLabel, "close")}`, width));
    else {
      // Your own scroll keys, as in main: pi-vim's Ctrl+U/D in Normal mode, and the transcript's end key.
      const scroll = [...(this.input.vim ? [rawKeyHint("ctrl+u/d", "scroll")] : []), keyHint("tui.altScreen.bottom", "end")];
      text = this.host.isBusy()
        ? [keyHint("app.interrupt", "stop"), ...scroll, rawKeyHint(this.host.toggleLabel, "close")].join(sep)
        : [rawKeyHint("enter", "ask"), ...scroll, keyHint("app.tools.expand", "expand"), keyHint("app.thinking.toggle", "thinking"), rawKeyHint("/new", "fresh thread"), rawKeyHint(this.host.toggleLabel, "close")].join(sep);
    }
    return truncateToWidth(` ${text}`, width);
  }
}
