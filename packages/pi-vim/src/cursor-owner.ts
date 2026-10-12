/** One hardware-cursor lease per TUI, shared by main and embedded surfaces. */
import {
  getCursorShapeRuntime,
  RESET_CURSOR_SHAPE,
  type CursorShapeSequence,
} from "./engine/cursor-shape.js";

const owners = new WeakMap<object, CursorOwner>();
type CursorOwner = {
  editors: Set<object>;
  previous: boolean | undefined;
  enabled: boolean;
  active?: object;
  shape?: CursorShapeSequence;
};

export function acquireCursor(tui: object, editor: object, inherited?: { previous: boolean | undefined }) {
  let owner = owners.get(tui);
  if (!owner) {
    owner = {
      editors: new Set(),
      previous: inherited ? inherited.previous : getCursorShapeRuntime(tui)?.getShowHardwareCursor?.(),
      enabled: false,
    };
    owners.set(tui, owner);
  }
  owner.editors.add(editor);
  const shared = owner;
  const runtime = getCursorShapeRuntime(tui);
  return {
    previous: shared.previous,
    activate() {
      if (!runtime || shared.enabled) return;
      runtime.setShowHardwareCursor(true);
      shared.enabled = true;
      shared.active = editor;
    },
    render(shape: CursorShapeSequence, write: (shape: CursorShapeSequence) => void) {
      if (!runtime || !shared.editors.has(editor)) return false;
      if (runtime.getShowHardwareCursor?.() === false ||
          (!shared.enabled && shared.previous === undefined)) {
        runtime.setShowHardwareCursor(true);
        shared.enabled = true;
        shared.shape = undefined;
      }
      shared.active = editor;
      if (shared.shape !== shape) {
        write(shape);
        shared.shape = shape;
      }
      return true;
    },
    release(write: (shape: CursorShapeSequence) => void, event?: { reason?: string }) {
      if (!shared.editors.delete(editor)) return;
      // Disposing an unfocused dialog must not reset the active editor's shape.
      if (shared.active === editor) {
        write(RESET_CURSOR_SHAPE);
        shared.shape = RESET_CURSOR_SHAPE;
        shared.active = undefined;
      }
      if (shared.editors.size === 0) {
        if (event?.reason === "quit" && shared.enabled) {
          // Pi may already have stopped the TUI: do not hide the shell cursor.
          runtime?.writeCursorShape("\x1b[?25h");
        } else if (shared.enabled && shared.previous !== undefined) {
          runtime?.setShowHardwareCursor(shared.previous);
        }
        owners.delete(tui);
      }
    },
  };
}
