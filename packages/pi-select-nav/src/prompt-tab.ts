import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";

const SURFACE = Symbol.for("pi-plugins.editor-surface.v1");
const MODE = Symbol.for("pi-plugins.editor-mode.v1");
export const ACCEPT_NEXT = "prompt:accept-next";
export const TASK_TAB = "activity:prompt-tab";
export interface TabRequest { handled: boolean; phase?: "active" | "enter" }

type Editor = {
  getText?(): string;
  getCursor?(): { line: number; col: number };
  isShowingAutocomplete?(): boolean;
  [SURFACE]?: string;
  [MODE]?: () => { state: string; autocomplete?: boolean };
};

/** Completion is opt-in: a slash command, or an @ mention at the cursor. */
export function explicitCompletion(editor: Editor): boolean {
  const text = editor.getText?.() ?? "";
  const cursor = editor.getCursor?.();
  if (!cursor) return false;
  const lines = text.split("\n");
  const before = [...lines.slice(0, cursor.line), (lines[cursor.line] ?? "").slice(0, cursor.col)].join("\n");
  return /^\/[\w:.-]*(?:[ \t][^\n]*)?$/.test(before) || /(?:^|\s)@(?:"[^"\n]*"?|[^\s"]*)$/.test(before);
}

/** Tab never reaches implicit file completion in the main prompt. Dialogs own their keys. */
export function routePromptTab(data: string, focused: unknown, main: unknown, emit: (channel: string, request: TabRequest) => void): { consume: true } | undefined {
  if (isKeyRelease(data) || !matchesKey(data, "tab") || !focused || typeof focused !== "object") return undefined;
  const editor = focused as Editor;
  if (editor[SURFACE] === "embedded" || (focused !== main && editor[SURFACE] !== "main") || typeof editor.getText !== "function") return undefined;
  const mode = editor[MODE]?.();
  if (mode && mode.state !== "normal" && mode.state !== "insert") return undefined;
  const autocomplete = mode?.autocomplete || editor.isShowingAutocomplete?.();
  if (autocomplete) return explicitCompletion(editor) ? undefined : { consume: true };
  const request = (channel: string, phase?: TabRequest["phase"]) => {
    const event: TabRequest = { handled: false, phase };
    emit(channel, event);
    return event.handled;
  };
  // Once selected, the task panel owns navigation even though focus stays in the editor.
  if (request(TASK_TAB, "active")) return { consume: true };
  if (editor.getText() === "" && request(ACCEPT_NEXT)) return { consume: true };
  request(TASK_TAB, "enter");
  return { consume: true };
}
