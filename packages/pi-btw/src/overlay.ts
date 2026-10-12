// The focused BTW modal: a framed transcript viewport, a status row and a composer.
//
// Origin: pi-btw 0.6.1 extensions/btw.ts BtwOverlayComponent (MIT, Dan Bachelder). Suite changes:
//   - The composer is an embedded editor from the suite editor contract when a provider
//     (pi-vim) answers the factory request, and Pi's native single-line Input otherwise.
//   - Ctrl+U / Ctrl+D scroll the side transcript by half a page. They only reach this component
//     while the overlay is focused; with the main editor focused they keep Pi's behavior. The
//     native composer scrolls when it is empty; a contract editor decides by its own mode.
//   - The component reports its input context so suite key routers leave its keys alone.
import { getMarkdownTheme, getSelectListTheme, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type MarkdownTheme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { EDITOR_MODE, EDITOR_SURFACE, INPUT_CONTEXT, type EditorFactoryFn, type EditorModeContext, type SuiteEditor } from "./contract.ts";
import { matchesBtwFocusShortcut, matchesBtwWidthToggle } from "./focus-keys.ts";
import type { BtwThreadMode } from "./thread.ts";
import {
  BTW_BLOCK_INDENT,
  BTW_OVERLAY_CHROME_LINES,
  buildOverlayTranscript,
  getCompletedExchangeCount,
  getOverlayTitle,
  hasStreamingTranscriptEntry,
  type BtwTranscript,
} from "./transcript.ts";

export type BtwOverlayWidthMode = "window" | "full";

/** What the overlay needs from its composer, whichever editor backs it. */
export interface Composer {
  readonly kind: "native" | "suite";
  readonly provider?: string;
  focused: boolean;
  getText(): string;
  setText(text: string): void;
  /** Keys the overlay did not own. */
  handleInput(data: string): void;
  /** Rows to frame inside the dialog; at least one. */
  renderLines(width: number): string[];
  /** Whether Up/Down should scroll the transcript instead of reaching the composer. */
  readonly scrollsOnArrows: boolean;
  invalidate(): void;
  getMode?(): EditorModeContext;
  dispose(): void;
}

export interface BtwOverlayOptions {
  tui: TUI;
  theme: ExtensionContext["ui"]["theme"];
  getTheme?: () => ExtensionContext["ui"]["theme"];
  keybindings: KeybindingsManager;
  readTranscriptEntries: () => BtwTranscript;
  getStatus: () => string | null;
  getMode: () => BtwThreadMode;
  getWidthMode: () => BtwOverlayWidthMode;
  /** The focus-shortcut label for the hints row. */
  focusShortcutsLabel: string;
  onSubmit: (value: string) => void;
  onDismiss: () => void;
  onUnfocus: () => void;
  onToggleWidth: () => void;
  /** Suite editor factory for the composer; omitted means Pi's native Input. */
  editorFactory?: EditorFactoryFn;
  editorProvider?: string;
  notify?: (message: string, type: "info" | "warning" | "error") => void;
  initialDraft?: string;
}

function editorTheme(getTheme: () => ExtensionContext["ui"]["theme"]): EditorTheme {
  return { borderColor: (text) => getTheme().fg("borderMuted", text), selectList: getSelectListTheme() };
}

/** Pi's single-line Input; focus/cursor markers stay attached to the composer for IME use. */
export function createNativeComposer(options: {
  tui: TUI;
  keybindings: KeybindingsManager;
  onSubmit: (value: string) => void;
  onDismiss: () => void;
  scrollHalfPage: (direction: -1 | 1) => void;
}): Composer {
  const input = new Input();
  input.onSubmit = (value) => options.onSubmit(value);
  input.onEscape = () => options.onDismiss();
  return {
    kind: "native",
    scrollsOnArrows: true,
    get focused() {
      return input.focused;
    },
    set focused(value: boolean) {
      input.focused = value;
    },
    getText: () => input.getValue(),
    setText: (text) => input.setValue(text),
    handleInput(data) {
      if (options.keybindings.matches(data, "tui.select.cancel")) {
        options.onDismiss();
        return;
      }
      // Half-page scrolling only while nothing is typed; otherwise Ctrl+U/Ctrl+D keep editing.
      if (input.getValue().length === 0 && (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d"))) {
        options.scrollHalfPage(matchesKey(data, "ctrl+u") ? -1 : 1);
        return;
      }
      input.handleInput(data);
    },
    renderLines: (width) => [input.render(width)[0] ?? ""],
    invalidate: () => input.invalidate(),
    dispose() {},
  };
}

/** An embedded editor from the suite contract (pi-vim): multi-line, modal, with its own cursor. */
export function createSuiteComposer(
  factory: EditorFactoryFn,
  options: {
    tui: TUI;
    theme: ExtensionContext["ui"]["theme"];
    getTheme?: () => ExtensionContext["ui"]["theme"];
    keybindings: KeybindingsManager;
    provider?: string;
    onSubmit: (value: string) => void;
    onDismiss: () => void;
    scrollHalfPage: (direction: -1 | 1) => void;
    notify?: (message: string, type: "info" | "warning" | "error") => void;
    initialText?: string;
  },
): Composer {
  const editor: SuiteEditor = factory({
    surface: "embedded",
    tui: options.tui,
    theme: editorTheme(options.getTheme ?? (() => options.theme)),
    keybindings: options.keybindings,
    onSubmit: (text) => options.onSubmit(text),
    onCancel: () => options.onDismiss(),
    scrollViewport: (direction) => options.scrollHalfPage(direction),
    notify: options.notify,
    paddingX: 0,
    initialText: options.initialText ?? "",
    initialMode: "insert",
  });
  let disposed = false;
  return {
    kind: "suite",
    provider: options.provider,
    scrollsOnArrows: false,
    get focused() {
      return editor.focused;
    },
    set focused(value: boolean) {
      editor.focused = value;
    },
    getText: () => editor.getText(),
    setText: (text) => editor.setText(text),
    handleInput: (data) => editor.handleInput(data),
    getMode: () => editor[EDITOR_MODE](),
    invalidate: () => editor.invalidate(),
    renderLines(width) {
      const lines = editor.render(width);
      return lines.length > 0 ? lines : [""];
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        editor.dispose();
      } catch {
        // The provider's editor is already gone.
      }
    },
  };
}

export class BtwOverlayComponent implements Component, Focusable {
  readonly composer: Composer;
  private readonly readTranscriptEntries: () => BtwTranscript;
  private readonly getStatus: () => string | null;
  private readonly getMode: () => BtwThreadMode;
  private readonly getWidthMode: () => BtwOverlayWidthMode;
  private readonly focusShortcutsLabel: string;
  private readonly onSubmitCallback: (value: string) => void;
  private readonly onDismissCallback: () => void;
  private readonly onUnfocusCallback: () => void;
  private readonly onToggleWidthCallback: () => void;
  private readonly keybindings: KeybindingsManager;
  private readonly tui: TUI;
  private theme: ExtensionContext["ui"]["theme"];
  private readonly getTheme?: () => ExtensionContext["ui"]["theme"];
  private markdownTheme: MarkdownTheme;
  private readonly managesMouseReporting: boolean;
  private transcriptLines: string[] = [];
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private contentWidth = 66;
  private followTranscript = true;
  private _focused = false;
  private modeTextValue = "";
  private summaryTextValue = "";
  private statusTextValue = "";
  private hintsTextValue = "";
  private disposed = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.composer.focused = value;
  }

  /** Suite key routers (pi-select-nav) leave editor input alone. */
  [INPUT_CONTEXT](): "editor" {
    return "editor";
  }

  [EDITOR_MODE](): EditorModeContext {
    return this.composer.getMode?.() ?? { state: "insert", mode: "insert", pending: "", ex: null, autocomplete: false };
  }

  /** The composer is an embedded surface; the overlay as a whole is too. */
  readonly [EDITOR_SURFACE] = "embedded" as const;

  constructor(options: BtwOverlayOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.getTheme = options.getTheme;
    this.keybindings = options.keybindings;
    this.markdownTheme = getMarkdownTheme();
    // Fullscreen Pi owns mouse reporting for the entire terminal session. In regular mode BTW
    // manages it while the overlay exists.
    this.managesMouseReporting = options.tui.mode !== "fullscreen";
    this.readTranscriptEntries = options.readTranscriptEntries;
    this.getStatus = options.getStatus;
    this.getMode = options.getMode;
    this.getWidthMode = options.getWidthMode;
    this.focusShortcutsLabel = options.focusShortcutsLabel;
    this.onSubmitCallback = options.onSubmit;
    this.onDismissCallback = options.onDismiss;
    this.onUnfocusCallback = options.onUnfocus;
    this.onToggleWidthCallback = options.onToggleWidth;

    const submit = (value: string) => {
      this.followTranscript = true;
      this.onSubmitCallback(value);
    };
    const scrollHalfPage = (direction: -1 | 1) => {
      this.scrollTranscript(direction * Math.max(1, Math.floor(this.transcriptViewportHeight / 2)));
    };
    const composerOptions = {
      tui: options.tui,
      keybindings: options.keybindings,
      onSubmit: submit,
      onDismiss: () => this.onDismissCallback(),
      scrollHalfPage,
    };
    let composer: Composer | undefined;
    if (options.editorFactory) {
      try {
        composer = createSuiteComposer(options.editorFactory, {
          ...composerOptions, theme: options.theme, getTheme: options.getTheme, provider: options.editorProvider,
          notify: options.notify, initialText: options.initialDraft,
        });
      } catch (error) {
        options.notify?.(`Embedded editor unavailable; using Pi's native Input: ${String(error)}`, "warning");
      }
    }
    this.composer = composer ?? createNativeComposer(composerOptions);
    if (options.initialDraft && this.composer.kind === "native") this.composer.setText(options.initialDraft);

    if (this.managesMouseReporting) {
      this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");
    }

    this.refresh();
  }

  private get borderless(): boolean {
    // Full-width mode drops the vertical bars and corner glyphs so a terminal Shift+drag selection
    // captures only the dialog's own text; with side borders those columns would land in the drag.
    return this.getWidthMode() === "full";
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    if (this.borderless) {
      return `${truncated}${" ".repeat(padding)}`;
    }
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    if (this.borderless) {
      return this.theme.fg("border", "─".repeat(innerWidth));
    }
    return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    if (this.borderless) {
      return this.theme.fg("border", "─".repeat(innerWidth));
    }
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private wrapTranscript(innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of this.transcriptLines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return wrapped;
  }

  private getDialogHeight(): number {
    const terminalRows = this.tui.terminal?.rows ?? process.stdout.rows ?? 30;
    // Match Pi's maxHeight="78%" and our one-row top margin. A fixed minimum
    // here would put the composer below Pi's top-to-bottom overlay clipping.
    return Math.max(1, Math.min(32, Math.floor(terminalRows * 0.78), terminalRows - 1));
  }

  scrollTranscript(delta: number): void {
    if (delta < 0) {
      this.followTranscript = false;
    }
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.composer.dispose();
    if (this.managesMouseReporting) {
      this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
    }
  }

  private getMouseScrollDelta(data: string): number | null {
    const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!match) {
      return null;
    }

    const button = Number(match[1]);
    if ((button & 64) !== 64) {
      return null;
    }

    return (button & 1) === 0 ? -3 : 3;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.scrollTranscript(event.wheelDelta);
    return { handled: true, render: true };
  }

  handleInput(data: string): void {
    if (this.disposed || !this.focused) return;
    if (matchesBtwFocusShortcut(data)) {
      this.onUnfocusCallback();
      return;
    }

    if (matchesBtwWidthToggle(data)) {
      this.onToggleWidthCallback();
      return;
    }

    const mouseScrollDelta = this.getMouseScrollDelta(data);
    if (mouseScrollDelta !== null) {
      this.scrollTranscript(mouseScrollDelta);
      return;
    }

    // Native Input keeps upstream Ctrl+C clear/dismiss. A modal provider owns its
    // Insert/Visual/EX/pending input, including Ctrl+C and autocomplete keys.
    if (this.composer.kind === "native" && this.keybindings.matches(data, "app.clear")) {
      if (this.composer.getText().length > 0) {
        this.composer.setText("");
        this.tui.requestRender();
        return;
      }
      this.onDismissCallback();
      return;
    }

    const pageStep = Math.max(1, this.transcriptViewportHeight - 1);
    if (matchesKey(data, Key.pageUp)) {
      this.scrollTranscript(-pageStep);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.scrollTranscript(pageStep);
      return;
    }
    if (this.composer.scrollsOnArrows) {
      if (matchesKey(data, Key.up)) {
        this.scrollTranscript(-1);
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.scrollTranscript(1);
        return;
      }
    }

    this.composer.handleInput(data);
  }

  private fitRenderedLine(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const dialogWidth = Math.max(1, width);
    const borderColumns = this.borderless || width < 3 ? 0 : 2;
    const innerWidth = Math.max(1, dialogWidth - borderColumns);
    const contentWidth = Math.max(1, innerWidth - BTW_BLOCK_INDENT.length);
    if (contentWidth !== this.contentWidth) {
      this.contentWidth = contentWidth;
      this.rebuildTranscriptLines();
    }
    const transcriptLines = this.wrapTranscript(innerWidth);
    const dialogHeight = this.getDialogHeight();
    const renderedComposer = this.composer.renderLines(innerWidth);
    // A multiline editor must not push its input/cursor below Pi's overlay clip.
    const compact = dialogHeight < BTW_OVERLAY_CHROME_LINES;
    const composerBudget = compact
      ? Math.max(1, dialogHeight - 2)
      : Math.max(1, Math.floor((dialogHeight - BTW_OVERLAY_CHROME_LINES + 1) / 2));
    const cursorRow = renderedComposer.findIndex((line) => line.includes(CURSOR_MARKER));
    const composerStart = Math.max(0, Math.min(cursorRow - composerBudget + 1, renderedComposer.length - composerBudget));
    const composerLines = renderedComposer.slice(composerStart, composerStart + composerBudget);
    if (compact) {
      // On short terminals, sacrifice transcript/chrome rather than the input cursor.
      // Even a one-row viewport retains the composer's current cursor row.
      this.transcriptViewportHeight = 0;
      const lines: string[] = [];
      if (dialogHeight >= 2) lines.push(this.theme.fg("accent", this.modeTextValue.trim()));
      if (dialogHeight >= 3) lines.push(this.theme.fg("warning", this.statusTextValue.trim()));
      lines.push(...composerLines);
      return lines.map((line) => this.fitRenderedLine(this.frameLine(line, innerWidth), width));
    }
    // The fixed chrome counts one composer row; a taller composer takes rows from the transcript.
    const chromeHeight = BTW_OVERLAY_CHROME_LINES - 1 + composerLines.length;
    const transcriptHeight = Math.max(0, dialogHeight - chromeHeight);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) {
        this.followTranscript = true;
      }
    }

    const visibleTranscript = transcriptLines.slice(this.transcriptScrollOffset, this.transcriptScrollOffset + transcriptHeight);
    const transcriptPadCount = Math.max(0, transcriptHeight - visibleTranscript.length);
    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const summary =
      hiddenAbove || hiddenBelow ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}` : this.summaryTextValue.trim();

    const lines = [this.borderLine(innerWidth, "top")];

    lines.push(this.frameLine(this.theme.fg("accent", this.theme.bold(this.modeTextValue.trim())), innerWidth));
    lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    for (const line of visibleTranscript) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < transcriptPadCount; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.theme.fg("warning", this.statusTextValue.trim()), innerWidth));
    for (const line of composerLines) {
      lines.push(this.frameLine(line, innerWidth));
    }
    lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue.trim()), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines.map((line) => this.fitRenderedLine(line, width));
  }

  setDraft(value: string): void {
    this.composer.setText(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.composer.getText();
  }

  getTranscriptEntries(): BtwTranscript {
    return this.readTranscriptEntries().map((entry) => ({ ...entry }));
  }

  private rebuildTranscriptLines(): void {
    this.transcriptLines = buildOverlayTranscript(this.readTranscriptEntries(), this.theme, this.markdownTheme, this.contentWidth);
  }

  invalidate(): void {
    if (this.disposed) return;
    this.theme = this.getTheme?.() ?? this.theme;
    this.markdownTheme = getMarkdownTheme();
    this.composer.invalidate();
    this.rebuildTranscriptLines();
  }

  refresh(): void {
    if (this.disposed) return;
    this.modeTextValue = `${getOverlayTitle(this.getMode())} · hidden thread preserved`;
    const entries = this.readTranscriptEntries();
    const exchanges = getCompletedExchangeCount(entries);
    const active = hasStreamingTranscriptEntry(entries) ? " · streaming" : " · idle";
    this.summaryTextValue = `${exchanges} exchange${exchanges === 1 ? "" : "s"}${active}`;

    this.rebuildTranscriptLines();

    const status = this.getStatus() ?? "Ready. Enter submits; Escape dismisses without clearing.";
    this.statusTextValue = status;
    const scrollHint = this.composer.kind === "suite" ? "Ctrl+U/D" : "↑↓ Ctrl+U/D";
    this.hintsTextValue = `Scroll wheel ${scrollHint} PgUp/PgDn · Enter · ${this.focusShortcutsLabel} focus · Alt+w width · Esc`;
    this.tui.requestRender();
  }
}
