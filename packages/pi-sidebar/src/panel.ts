// The Sidebar panel: a header with what main is doing, Sidebar's conversation in Pi's own look, a
// one-line notice or confirmation, the composer, and a hint row. It lives in Pi's fullscreen layout
// next to main (see layout.ts); the composer takes keyboard focus while Sidebar is focused.
import { getSelectListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  getKeybindings,
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

export interface PanelHost {
  /** Header parts: what main is doing, cache figures. */
  status(theme: Theme): StatusPart[];
  /** A question (or a `/` command) from the composer. */
  submit(text: string): void;
  /** Confirmed send of a held question. */
  confirm(text: string): void;
  abort(): void;
  focusMain(): void;
  focusSidebar(): void;
  isBusy(): boolean;
  /** Keys that switch focus back to main (Ctrl+' by default). */
  matchesToggle(data: string): boolean;
  cwd: string;
  events?: { emit(channel: string, data: unknown): void };
}

type Notice = { kind: "info" | "warning" | "error"; text: string } | { kind: "confirm"; title: string; message: string; text: string };

/** A row of text drawn from state on every render; clicking it focuses Sidebar. */
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

/** Pi's editor, or pi-vim's embedded editor when it answers the suite contract. */
class Composer implements Component, Focusable {
  private readonly editor: (Component & Focusable & { getText(): string; setText(text: string): void; handleInput(data: string): void }) | SuiteEditor;
  private readonly suite: boolean;
  private _focused = false;

  constructor(tui: TUI, theme: () => Theme, private readonly panel: SidebarPanel, private readonly host: PanelHost) {
    const editorTheme: EditorTheme = { borderColor: (text) => theme().fg(panel.focused ? "borderAccent" : "borderMuted", text), selectList: getSelectListTheme() };
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
          onCancel: () => host.focusMain(),
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
    this.panel.focused = value;
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
    if (this.host.matchesToggle(data)) {
      this.host.focusMain();
      return;
    }
    const pending = this.panel.pendingConfirm();
    if (pending) {
      if (matchesKey(data, "enter")) {
        this.panel.clearNotice();
        this.host.confirm(pending.text);
        return;
      }
      if (matchesKey(data, "escape")) {
        this.panel.clearNotice();
        if (!this.getText().trim()) this.setText(pending.text);
        return;
      }
    }
    if (matchesKey(data, "escape") && this.host.isBusy()) {
      this.host.abort();
      return;
    }
    if (matchesKey(data, "escape") && !this.suite) {
      if (this.panel.hasNotice()) this.panel.clearNotice();
      else this.host.focusMain();
      return;
    }
    if (matchesKey(data, "shift+up")) return void this.panel.scroll(-3);
    if (matchesKey(data, "shift+down")) return void this.panel.scroll(3);
    if (matchesKey(data, "shift+pageUp")) return void this.panel.scroll(-1);
    if (matchesKey(data, "shift+pageDown")) return void this.panel.scroll(1);
    if (matchesKey(data, "ctrl+o")) return void this.panel.toggleExpanded();
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
  private readonly view: ScrollView;
  private note: Notice | undefined;
  focused = false;
  unread = false;

  constructor(private readonly tui: TUI, private readonly theme: () => Theme, private readonly host: PanelHost) {
    this.chat = new PiChat(() => theme(), { cwd: host.cwd, userMessagesFromEvents: true, requestRender: () => tui.requestRender() });
    const body: Component = {
      render: (width) => (this.chat.empty ? this.emptyState(width) : this.chat.render(width)),
      invalidate: () => {},
    };
    this.view = new ScrollView(body, { follow: "end", primary: false, overscroll: "contain", scrollbar: "auto" });
    this.input = new Composer(tui, theme, this, host);
    const focus = () => host.focusSidebar();
    const header = new Row((width) => [this.headerLine(width)], focus);
    const notice = new Row((width) => this.noticeLines(width), focus);
    const hint = new Row((width) => [this.hintLine(width)], focus);
    this.root = new VStack([
      { component: header, basis: "auto" },
      { component: this.view, basis: 0, grow: 1, minSize: 1 },
      { component: notice, basis: "auto" },
      { component: this.input, basis: "auto" },
      { component: hint, basis: "auto" },
    ]);
  }

  submit(text: string): void {
    this.host.submit(text);
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

  toggleExpanded(): void {
    this.chat.setExpanded(!this.chat.isExpanded);
  }

  followEnd(): void {
    this.view.scrollToEnd();
  }

  dispose(): void {
    this.input.dispose();
  }

  private emptyState(width: number): string[] {
    const t = this.theme();
    const lines = [
      "",
      t.fg("muted", "Ask about what main is doing, why, or how the code works."),
      t.fg("dim", "Sidebar reads main's live conversation, never changes anything, and answers from main's prompt cache."),
    ];
    return lines.flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width - 1)).map((row) => ` ${row}`) : [""]));
  }

  private headerLine(width: number): string {
    const t = this.theme();
    const title = this.focused ? t.fg("accent", t.bold("◧ Sidebar")) : t.fg("muted", "◧ Sidebar");
    const parts: StatusPart[] = [{ text: title }, ...this.host.status(t)];
    if (this.unread && !this.focused) parts.splice(1, 0, { text: t.fg("accent", "● new answer") });
    return fitStatus(parts, width, t.fg("dim", " · "));
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
    const t = this.theme();
    let text: string;
    if (this.note?.kind === "confirm") text = "enter send anyway · esc keep the question";
    else if (!this.focused) text = "ctrl+' to ask";
    else if (this.host.isBusy()) text = "esc stop · ctrl+' main · shift+↑↓ scroll";
    else text = "enter ask · ctrl+' main · shift+↑↓ scroll · ctrl+o tools · /new /close";
    return truncateToWidth(t.fg("dim", ` ${text}`), width);
  }
}
