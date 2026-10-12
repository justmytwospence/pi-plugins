/**
 * Editor integration contract, version 1.
 *
 * This file is package-local. Other components copy the symbols and shapes
 * below structurally; nothing imports across package directories. Every
 * key is a `Symbol.for(...)` registry symbol, so the same identifier resolves
 * in every module instance, including the jiti-loaded extension copies.
 *
 * Discovery is a synchronous request over `pi.events`:
 *
 *   const request: EditorFactoryRequest = { version: 1 };
 *   pi.events.emit(EDITOR_FACTORY_CHANNEL, request);
 *   const editor = request.factory?.({ surface: "embedded", tui, theme, keybindings, ... })
 *     ?? new Editor(tui, theme);
 *
 * `pi.events.emit` runs each `pi.events.on` handler's synchronous prefix
 * before returning, so `request.factory` is set (or still undefined) by the
 * time `emit` returns. The provider answers only after its own `session_start`
 * ran, so request a factory when a dialog opens, not when a session starts.
 * When no provider is loaded, the request comes back unanswered and the
 * consumer uses Pi's native editor.
 */
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteProvider,
  Component,
  EditorTheme,
  Focusable,
  TUI,
} from "@earendil-works/pi-tui";

/** Event bus channel. Equal to `EDITOR_FACTORY.description`. */
export const EDITOR_FACTORY_CHANNEL = "pi-plugins.editor-factory.v1";
/** Identifier of the factory protocol; its description names the channel. */
export const EDITOR_FACTORY = Symbol.for("pi-plugins.editor-factory.v1");
/** Property on an editor instance: `"main"` or `"embedded"`. */
export const EDITOR_SURFACE = Symbol.for("pi-plugins.editor-surface.v1");
/** Method on any focusable component: which kind of input it owns. */
export const INPUT_CONTEXT = Symbol.for("pi-plugins.input-context.v1");
/** Method on a modal editor: the current modal input state. */
export const EDITOR_MODE = Symbol.for("pi-plugins.editor-mode.v1");
/** Property on an editor: capture/restore plain draft snapshots. */
export const EDITOR_SNAPSHOT = Symbol.for("pi-plugins.editor-snapshot.v1");
/** Method on a modal editor: enter Insert mode at the end of the text. */
export const EDITOR_INSERT = Symbol.for("pi-plugins.editor-insert.v1");

export type EditorSurface = "main" | "embedded";

/**
 * Input context reported through `INPUT_CONTEXT`. Editor surfaces report
 * `"editor"`. Other components in the suite report `"filter"` (a search or
 * filter text field), `"list"` (a selection list) or `"viewer"` (read-only
 * scrolling content). A component without the method has an unknown context
 * and global listeners must leave its input alone.
 */
export type InputContext = "editor" | "filter" | "list" | "viewer";

/** Raw engine mode. */
export type EditorMode = "insert" | "normal" | "visual" | "visual-line";

/**
 * Modal input state. `"normal"` and `"visual"` are idle: the next key starts
 * a fresh command. `"pending"` means a count, operator, motion, `g`/`r`
 * prefix or a discarded Normal-mode paste is in progress and the next key
 * completes or cancels it. `"ex"` means an EX command line is being typed.
 */
export type EditorModeState = "insert" | "normal" | "visual" | "ex" | "pending";

export interface EditorModeContext {
  state: EditorModeState;
  /** Raw engine mode, also while `state` is `"ex"` or `"pending"`. */
  mode: EditorMode;
  /** Pending keys as typed (for example `"2d"`, `"f"`, `"g"`); `""` when idle. */
  pending: string;
  /** EX command line without the leading `:`; `null` outside EX. */
  ex: string | null;
  /** The native autocomplete popup is open and owns Up/Down/Tab/Enter/Escape. */
  autocomplete: boolean;
}

export interface EditorCursor {
  line: number;
  col: number;
}

/** Plain draft snapshot. `history` is opaque and only meaningful in-process. */
export interface EditorSnapshot {
  version: 1;
  text: string;
  cursor: EditorCursor;
  mode: EditorMode;
  /** Visual selection anchor; present only in a visual mode. */
  anchor?: EditorCursor;
  /** Opaque engine edit history (undo, redo, register, repeat). */
  history?: unknown;
}

export interface EditorSnapshotApi {
  capture(): EditorSnapshot;
  /**
   * Restore text, cursor (clamped), mode and anchor; restore `history` when
   * present and valid. Pending state and any EX line are cleared. Returns
   * false and changes nothing when the snapshot version is unsupported.
   */
  restore(snapshot: EditorSnapshot): boolean;
}

export interface EditorFactoryOptions {
  surface: EditorSurface;
  tui: TUI;
  theme: EditorTheme;
  /** Pi's keybindings; `ctx.ui.custom()` and `setEditorComponent` supply one. */
  keybindings: KeybindingsManager;
  /** Embedded: Enter (outside autocomplete), `:w`, `:wq`, `:x`. Ignored for `main`. */
  onSubmit?: (text: string) => void;
  /** Embedded: `:q`, `:q!`, `:qa` and Escape in idle Normal mode. Ignored for `main`. */
  onCancel?: () => void;
  /**
   * Embedded: Ctrl+U (-1) and Ctrl+D (+1) in idle Normal mode only. The
   * consumer scrolls its own viewport by half a page. Without it those keys
   * are consumed and do nothing. Insert, Visual, EX and pending states keep
   * the editor's own handling. `main` scrolls Pi's fullscreen transcript.
   */
  scrollViewport?: (direction: -1 | 1) => void;
  /**
   * Embedded: consulted first for every EX command (name without `:`, trimmed
   * args, the raw line). Return true when handled. Unhandled names other than
   * the submit/cancel set are reported through `notify` as unsupported.
   * Embedded editors never dispatch `/commands` or `!shell` to the session.
   */
  onExCommand?: (name: string, args: string, raw: string) => boolean;
  /** Embedded: local messages (unsupported EX command, non-empty quit). Default: none. */
  notify?: (message: string, type: "info" | "warning" | "error") => void;
  /** Native editor padding; default 0 (Pi's `setPaddingX` remains available). */
  paddingX?: number;
  initialText?: string;
  /** Default `"insert"`. */
  initialMode?: "insert" | "normal";
}

/**
 * The returned editor is a Pi `EditorComponent` plus the native `Editor`
 * surface consumers already use (`getCursor`, `getLines`, `isShowingAutocomplete`,
 * `setAutocompleteProvider`, `borderColor`, `focused`, `handleMouse`). The
 * symbol-keyed members below are the integration protocol. `dispose()` is
 * idempotent; an embedded editor must be disposed when its dialog closes.
 */
export interface SuiteEditor extends Component, Focusable {
  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  addToHistory(text: string): void;
  insertTextAtCursor(text: string): void;
  getExpandedText(): string;
  setAutocompleteProvider(provider: AutocompleteProvider): void;
  borderColor: (str: string) => string;
  setPaddingX(padding: number): void;
  setAutocompleteMaxVisible(maxVisible: number): void;
  getCursor(): EditorCursor;
  getLines(): string[];
  isShowingAutocomplete(): boolean;
  dispose(): void;
  readonly [EDITOR_SURFACE]: EditorSurface;
  [INPUT_CONTEXT](): "editor";
  [EDITOR_MODE](): EditorModeContext;
  readonly [EDITOR_SNAPSHOT]: EditorSnapshotApi;
  [EDITOR_INSERT](): void;
}

export type EditorFactoryFn = (options: EditorFactoryOptions) => SuiteEditor;

/** Minimal native/suite surface used by the steering composer. */
export interface EmbeddedEditor extends Component, Focusable {
  handleInput(data: string): void;
  onSubmit?: (text: string) => void;
  dispose?(): void;
}

/** Request when opening the composer, after providers have started. */
export function requestEditorFactory(events: { emit(channel: string, data: unknown): void } | undefined): EditorFactoryRequest | undefined {
  if (!events) return undefined;
  const request: EditorFactoryRequest = { version: 1 };
  try {
    events.emit(EDITOR_FACTORY_CHANNEL, request);
  } catch {
    return undefined;
  }
  return typeof request.factory === "function" ? request : undefined;
}

/**
 * Request payload. The consumer creates it with `version: 1` and emits it on
 * `EDITOR_FACTORY_CHANNEL`; the first provider sets `factory` and `provider`
 * synchronously. Later providers leave an answered request alone.
 */
export interface EditorFactoryRequest {
  version: 1;
  factory?: EditorFactoryFn;
  /** Name of the answering provider, e.g. `"pi-vim"`. */
  provider?: string;
}

/** Event bus payload of `pi-vim:mode-change`, emitted for both surfaces. */
export interface ModeChangeEvent {
  mode: EditorMode;
  previousMode: EditorMode;
  surface: EditorSurface;
}

/** Read a component's input context, tolerating a plain string value. */
export function readInputContext(component: unknown): InputContext | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  const value = (component as Record<symbol, unknown>)[INPUT_CONTEXT];
  const context = typeof value === "function" ? value.call(component) : value;
  return context === "editor" || context === "filter" || context === "list" || context === "viewer"
    ? context
    : undefined;
}

/** Read a component's editor surface marker. */
export function readEditorSurface(component: unknown): EditorSurface | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  const value = (component as Record<symbol, unknown>)[EDITOR_SURFACE];
  return value === "main" || value === "embedded" ? value : undefined;
}

/** Read a modal editor's mode context; undefined for other components. */
export function readEditorMode(component: unknown): EditorModeContext | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  const value = (component as Record<symbol, unknown>)[EDITOR_MODE];
  return typeof value === "function" ? (value.call(component) as EditorModeContext) : undefined;
}
