/**
 * Structural copy of the parts of the suite editor contract (version 1) that pi-sidebar consumes.
 * The canonical file is packages/pi-vim/src/contract.ts; nothing imports across package
 * directories. Every key is a `Symbol.for(...)` registry symbol, so the same identifier resolves
 * in every module instance, including jiti-loaded extension copies.
 *
 * Discovery is a synchronous request over `pi.events`: the consumer emits
 * `{ version: 1 }` on `EDITOR_FACTORY_CHANNEL`; a loaded provider sets `factory` and
 * `provider` before `emit` returns. Request a factory when the dialog opens, not at
 * session start, and dispose the returned editor when the dialog closes.
 */
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, Focusable, TUI } from "@earendil-works/pi-tui";

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
export interface EditorModeContext {
  state: "insert" | "normal" | "visual" | "ex" | "pending";
  mode: "insert" | "normal" | "visual" | "visual-line";
  pending: string;
  ex: string | null;
  autocomplete: boolean;
}

export type EditorSurface = "main" | "embedded";
export type InputContext = "editor" | "filter" | "list" | "viewer";

export interface EditorFactoryOptions {
  surface: EditorSurface;
  tui: TUI;
  theme: EditorTheme;
  keybindings: KeybindingsManager;
  /** Embedded: Enter (outside autocomplete), `:w`, `:wq`, `:x`. */
  onSubmit?: (text: string) => void;
  /** Embedded: `:q`, `:q!`, `:qa` and Escape in idle Normal mode. */
  onCancel?: () => void;
  /** Embedded: Ctrl+U (-1) and Ctrl+D (+1) in idle Normal mode only; other states keep editor handling. */
  scrollViewport?: (direction: -1 | 1) => void;
  /** Embedded: consulted first for every EX command. Return true when handled. */
  onExCommand?: (name: string, args: string, raw: string) => boolean;
  /** Embedded: local messages (unsupported EX command, non-empty quit). */
  notify?: (message: string, type: "info" | "warning" | "error") => void;
  paddingX?: number;
  initialText?: string;
  initialMode?: "insert" | "normal";
}

/** The subset of a provided editor that the Sidebar composer uses. */
export interface SuiteEditor extends Component, Focusable {
  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  dispose(): void;
  readonly [EDITOR_SURFACE]: EditorSurface;
  [EDITOR_MODE](): EditorModeContext;
}

export type EditorFactoryFn = (options: EditorFactoryOptions) => SuiteEditor;

export interface EditorFactoryRequest {
  version: 1;
  factory?: EditorFactoryFn;
  /** Name of the answering provider, e.g. `"pi-vim"`. */
  provider?: string;
}

/** Ask loaded providers for an embedded editor factory; undefined when none answers. */
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
 * Prompt-stash service (version 1), provided by pi-stash; copied structurally from
 * packages/pi-stash/src/contract.ts. Each controller keeps its own stash, apart from main's.
 */
export const STASH_CHANNEL = "pi-plugins.prompt-stash.v1";

export interface StashControllerOptions {
  editor(): { getText(): string; setText(text: string): void } | undefined;
  notify(message: string, type: "info" | "warning"): void;
  changed?(): void;
}

export interface StashController {
  readonly stashed: boolean;
  /** Handle the stash key (Ctrl+S); true when consumed. */
  handleKey(data: string): boolean;
  /** After a submit: a `/` command brings the stash back into an empty editor. */
  submitted(text: string): void;
}

export interface StashRequest {
  version: 1;
  create?: (options: StashControllerOptions) => StashController;
  provider?: string;
}

/** A stash controller from an active pi-stash; undefined when none answers. */
export function requestStash(events: { emit(channel: string, data: unknown): void } | undefined, options: StashControllerOptions): StashController | undefined {
  if (!events) return undefined;
  const request: StashRequest = { version: 1 };
  try {
    events.emit(STASH_CHANNEL, request);
    return typeof request.create === "function" ? request.create(options) : undefined;
  } catch {
    return undefined;
  }
}
