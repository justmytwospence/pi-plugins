// Ctrl+C stops a running turn, as in Claude Code. Pi binds Ctrl+C to app.clear (clear the editor,
// exit on a second press) even while the agent works, so a habitual Ctrl+C Ctrl+C quits Pi instead
// of stopping it. Extensions cannot bind app.clear's key (Pi reserves it), so this listens to raw
// terminal input: while main's prompt editor has focus and the agent is busy, Ctrl+C does what
// app.interrupt (Esc) does there and is consumed. Idle, or anywhere else (dialogs, Sidebar), the
// key is left alone.
import { getKeybindings, isKeyRelease } from "@earendil-works/pi-tui";

type Handler = () => void;
export type EditorLike = { actionHandlers?: Map<string, Handler>; onEscape?: Handler };

/** Main's app.clear handler: Pi copies the same function onto every prompt editor it installs. */
export function clearHandlerOf(component: unknown): Handler | undefined {
  const handlers = (component as EditorLike | null)?.actionHandlers;
  return handlers instanceof Map ? handlers.get("app.clear") : undefined;
}

/** Interrupt through main's prompt editor when it has focus and the agent is busy. */
export function routeCtrlC(data: string, focused: unknown, mainClear: Handler | undefined, busy: boolean): { consume: true } | undefined {
  if (!busy || !mainClear || isKeyRelease(data)) return undefined;
  if (!getKeybindings().matches(data, "app.clear")) return undefined;
  const editor = focused as EditorLike | null;
  if (clearHandlerOf(editor) !== mainClear) return undefined;
  const interrupt = editor?.onEscape ?? editor?.actionHandlers?.get("app.interrupt");
  if (typeof interrupt !== "function") return undefined;
  interrupt();
  return { consume: true };
}
