// Ctrl+C stops a running turn, as in Claude Code. Pi binds Ctrl+C to app.clear (clear the editor,
// exit on a second press) even while the agent works, so a habitual Ctrl+C Ctrl+C quits Pi instead
// of stopping it. Extensions cannot bind app.clear's key (Pi reserves it), so this listens to raw
// terminal input: while main's prompt editor has focus and the agent is busy, Ctrl+C does what
// app.interrupt (Esc) does there and is consumed. Idle, or anywhere else (dialogs, Sidebar), the
// key is left alone.
//
// Esc (and that Ctrl+C) while prompts are queued first takes them back: Pi's own Esc restores the
// queue to the editor and stops the turn in one go. Here the first press only restores the queue
// (Pi's app.message.dequeue, Alt+Up) and the turn keeps running; the next press, with nothing
// queued, stops it as before.
import { getKeybindings, isKeyRelease } from "@earendil-works/pi-tui";

type Handler = () => void;
export type EditorLike = { actionHandlers?: Map<string, Handler>; onEscape?: Handler; isShowingAutocomplete?(): boolean };

/** pi-vim's modal state (its contract.ts), when the editor is pi-vim's. */
const EDITOR_MODE = Symbol.for("pi-plugins.editor-mode.v1");
type ModeContext = { state?: string; autocomplete?: boolean };

/** Main's editor and the agent's state, as read for one key. */
export interface InterruptState {
  focused: unknown;
  mainClear: Handler | undefined;
  busy: boolean;
  /** Prompts queued for the running turn (steering or follow-up). */
  queued: boolean;
}

/** The focused component is main's prompt editor (Pi copies main's app.clear onto any it installs). */
function mainEditor(state: InterruptState): EditorLike | undefined {
  if (!state.mainClear || clearHandlerOf(state.focused) !== state.mainClear) return undefined;
  return state.focused as EditorLike;
}

/** Restore the queue to the editor without stopping the turn; false when there is nothing to do it with. */
function dequeue(editor: EditorLike): boolean {
  const restore = editor.actionHandlers?.get("app.message.dequeue");
  if (typeof restore !== "function") return false;
  restore();
  return true;
}

/** Main's app.clear handler: Pi copies the same function onto every prompt editor it installs. */
export function clearHandlerOf(component: unknown): Handler | undefined {
  const handlers = (component as EditorLike | null)?.actionHandlers;
  return handlers instanceof Map ? handlers.get("app.clear") : undefined;
}

/**
 * Interrupt through main's prompt editor when it has focus and the agent is busy: restore queued
 * prompts first, stop the turn once none are queued.
 */
export function routeCtrlC(data: string, state: InterruptState): { consume: true } | undefined {
  if (!state.busy || isKeyRelease(data)) return undefined;
  if (!getKeybindings().matches(data, "app.clear")) return undefined;
  const editor = mainEditor(state);
  if (!editor) return undefined;
  if (state.queued && dequeue(editor)) return { consume: true };
  const interrupt = editor.onEscape ?? editor.actionHandlers?.get("app.interrupt");
  if (typeof interrupt !== "function") return undefined;
  interrupt();
  return { consume: true };
}

/**
 * Esc in main's prompt editor while the agent is busy and prompts are queued: restore them and
 * keep the turn running. Otherwise Esc goes where it always goes (Pi stops the turn). An open
 * autocomplete popup, and a pi-vim Visual selection, pending command or EX line, keep their Esc.
 */
export function routeEscape(data: string, state: InterruptState): { consume: true } | undefined {
  if (!state.busy || !state.queued || isKeyRelease(data)) return undefined;
  if (!getKeybindings().matches(data, "app.interrupt")) return undefined;
  const editor = mainEditor(state);
  if (!editor || editor.isShowingAutocomplete?.() === true) return undefined;
  const mode = (editor as { [EDITOR_MODE]?: () => ModeContext })[EDITOR_MODE]?.();
  if (mode && (mode.autocomplete === true || (mode.state !== "insert" && mode.state !== "normal"))) return undefined;
  return dequeue(editor) ? { consume: true } : undefined;
}
