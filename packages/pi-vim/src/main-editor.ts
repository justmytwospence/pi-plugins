/**
 * The main prompt editor: the upstream pi-vim editor (EX bridge to Pi
 * commands and the shell, `:q` quits Pi, Escape in idle Normal mode reaches
 * Pi's `app.interrupt`) plus the suite protocol and half-page transcript
 * scrolling on Ctrl+U / Ctrl+D in idle Normal mode.
 */
import type { ModalEditorOptions } from "./engine/modal-editor.js";
import { SuiteModalEditor } from "./suite-editor.js";

type EditorConstructorArgs = ConstructorParameters<typeof SuiteModalEditor>;

type ScrollableTui = {
  scrollBy?: (lines: number) => void;
  terminal?: { rows?: number };
  getPrimaryScrollView?: () => { viewportHeight?: number };
};

export class MainEditor extends SuiteModalEditor {
  constructor(
    tui: EditorConstructorArgs[1],
    theme: EditorConstructorArgs[2],
    keybindings: EditorConstructorArgs[3],
    options?: ModalEditorOptions,
  ) {
    super("main", tui, theme, keybindings, options);
  }

  /**
   * Idle Normal mode only: scroll Pi's fullscreen transcript by half a page
   * through the TUI's own `scrollBy`, the same call its half-page bindings
   * make. The regular (scrollback) TUI has no viewport to move, so the key is
   * consumed and does nothing rather than deleting text or exiting Pi.
   */
  protected override scrollHalfPage(direction: -1 | 1): boolean {
    const tui = this.tui as unknown as ScrollableTui;
    if (typeof tui.scrollBy === "function") {
      // SDK 1.1.0's native half-page binding uses the transcript viewport,
      // which excludes the prompt/footer. Fall back for older/custom TUIs.
      const viewportHeight = tui.getPrimaryScrollView?.().viewportHeight;
      const rows = typeof viewportHeight === "number" && viewportHeight > 0
        ? viewportHeight
        : typeof tui.terminal?.rows === "number" ? tui.terminal.rows : 0;
      tui.scrollBy(direction * Math.max(1, Math.floor(rows / 2)));
    }
    return true;
  }
}
