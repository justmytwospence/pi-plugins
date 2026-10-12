/**
 * The comment editor: Pi's native `Editor`, or one from a suite editor provider
 * (pi-vim) when one is loaded. The provider is found with a synchronous request
 * on Pi's event bus; nothing is imported from a sibling package. The symbols and
 * shapes below are a structural copy of pi-vim's `contract.ts`, version 1.
 */

import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/** Event bus channel of the editor factory request. */
export const EDITOR_FACTORY_CHANNEL = "pi-plugins.editor-factory.v1";
/** Method on a focusable component: the input it currently owns. */
export const INPUT_CONTEXT = Symbol.for("pi-plugins.input-context.v1");
/** Method on a modal editor: the current modal input state. */
export const EDITOR_MODE = Symbol.for("pi-plugins.editor-mode.v1");

export type EditorModeState = "insert" | "normal" | "visual" | "ex" | "pending";

export interface EditorModeContext {
	state: EditorModeState;
	/** The native autocomplete popup is open and owns Up/Down/Tab/Enter/Escape. */
	autocomplete: boolean;
}

/** What the viewer needs from either editor. */
export type CommentEditor = Pick<Editor, "focused" | "getText" | "setText" | "onSubmit" | "render" | "handleInput" | "invalidate" | "isShowingAutocomplete"> & {
	dispose?(): void;
	[EDITOR_MODE]?: () => EditorModeContext;
};

/** The options this consumer passes to a provider's factory (a subset of the contract's). */
export interface EditorFactoryOptions {
	surface: "embedded";
	tui: TUI;
	theme: EditorTheme;
	keybindings: KeybindingsManager;
	onSubmit: (text: string) => void;
	onCancel: () => void;
	/** Ctrl+U (-1) and Ctrl+D (+1) in idle Normal mode scroll the diff behind the editor. */
	scrollViewport?: (direction: -1 | 1) => void;
	/** EX commands other than the submit/cancel set; true when handled. */
	onExCommand?: (name: string, args: string, raw: string) => boolean;
	notify?: (message: string, type: "info" | "warning" | "error") => void;
	paddingX?: number;
	initialText?: string;
	initialMode?: "insert" | "normal";
}

export interface EditorFactoryRequest {
	version: 1;
	factory?: (options: EditorFactoryOptions) => CommentEditor;
	provider?: string;
}

export interface EditorRequest {
	tui: TUI;
	theme: EditorTheme;
	keybindings: KeybindingsManager;
	onSubmit: (text: string) => void;
	onCancel: () => void;
	scrollViewport?: (direction: -1 | 1) => void;
	notify?: (message: string, type: "info" | "warning" | "error") => void;
	initialText: string;
	initialMode: "insert" | "normal";
	paddingX: number;
}

export type EditorCreator = (request: EditorRequest) => CommentEditor;

/** Pi's native editor, set up like the provider would set up its own. */
export function nativeEditor(request: EditorRequest): CommentEditor {
	const editor = new Editor(request.tui, request.theme, { paddingX: request.paddingX }) as CommentEditor;
	editor.setText(request.initialText);
	editor.onSubmit = request.onSubmit;
	return editor;
}

/**
 * An editor creator that asks the bus for a provider each time a comment editor
 * opens (providers answer only after their own session_start), and falls back
 * to Pi's native editor when nobody answers or the provider throws.
 */
export function embeddedEditorFactory(pi: Pick<ExtensionAPI, "events">): EditorCreator {
	return (request) => {
		const ask: EditorFactoryRequest = { version: 1 };
		try {
			pi.events.emit(EDITOR_FACTORY_CHANNEL, ask);
		} catch {
			// An optional provider must not disable commenting.
		}
		if (typeof ask.factory === "function") {
			let editor: CommentEditor | undefined;
			try {
				editor = ask.factory({
					surface: "embedded",
					tui: request.tui,
					theme: request.theme,
					keybindings: request.keybindings,
					onSubmit: request.onSubmit,
					onCancel: request.onCancel,
					scrollViewport: request.scrollViewport,
					onExCommand: () => false,
					notify: request.notify,
					paddingX: request.paddingX,
					initialText: request.initialText,
					initialMode: request.initialMode,
				});
				const methods = ["render", "handleInput", "getText", "setText", "invalidate", "isShowingAutocomplete"] as const;
				if (editor && methods.every((name) => typeof editor?.[name] === "function")) {
					if (editor.getText() !== request.initialText) editor.setText(request.initialText);
					return editor;
				}
			} catch {
				// A broken provider falls back to the native editor.
			}
			try {
				editor?.dispose?.();
			} catch {
				// Even broken cleanup must not disable the native fallback.
			}
		}
		return nativeEditor(request);
	};
}

/** Whether the editor handles Escape itself (a modal editor leaves Insert mode, or closes its popup). */
export function editorOwnsEscape(editor: CommentEditor): boolean {
	if (editor.isShowingAutocomplete()) return true;
	return typeof editor[EDITOR_MODE] === "function";
}

/** A one-line key hint for the editor in use. */
export function editorHint(editor: CommentEditor): string {
	return typeof editor[EDITOR_MODE] === "function"
		? " :w or enter save · :q or esc (normal mode) cancel · ctrl+d/u scroll the diff"
		: " enter save · shift+enter newline · esc cancel";
}
