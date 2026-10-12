import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

const EDITOR_MODE = Symbol.for("pi-plugins.editor-mode.v1");
/** Optional structural protocol: no runtime import from a sibling package. */
export type ProseEditor = Pick<Editor, "focused" | "getText" | "setText" | "onSubmit" | "render" | "handleInput" | "invalidate" | "isShowingAutocomplete"> & {
  dispose?(): void;
  [EDITOR_MODE]?: () => { state: string };
};
export type EditorCreator = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, onSubmit: (text: string) => void, onCancel: () => void) => ProseEditor;

export function embeddedEditorFactory(pi: ExtensionAPI): EditorCreator {
  return (tui, theme, keybindings, onSubmit, onCancel) => {
    const request: { version: 1; factory?: (options: unknown) => ProseEditor } = { version: 1 };
    try { pi.events.emit("pi-plugins.editor-factory.v1", request); } catch { /* Optional providers cannot disable native composition. */ }
    let editor: ProseEditor | undefined;
    try { editor = request.factory?.({ surface: "embedded", tui, theme, keybindings, onSubmit, onCancel }); } catch { /* Native fallback for an incompatible provider. */ }
    editor ??= new Editor(tui, theme);
    editor.onSubmit = onSubmit;
    return editor;
  };
}

/** A modal editor's first cancellation key belongs to its active input substate. */
export function editorOwnsCancel(editor: ProseEditor): boolean {
  if (editor.isShowingAutocomplete()) return true;
  const readMode = editor[EDITOR_MODE];
  if (typeof readMode !== "function") return false;
  return readMode.call(editor)?.state !== "normal";
}
