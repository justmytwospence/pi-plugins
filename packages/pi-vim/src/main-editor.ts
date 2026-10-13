/**
 * The main prompt editor: the upstream pi-vim editor (EX bridge to Pi
 * commands and the shell, `:q` quits Pi, Escape in idle Normal mode reaches
 * Pi's `app.interrupt`) plus the suite protocol and half-page transcript
 * scrolling on Ctrl+U / Ctrl+D in idle Normal mode.
 */
import type { ModalEditorOptions } from "./engine/modal-editor.js";
import { matchesKey } from "@earendil-works/pi-tui";
import { SuiteModalEditor } from "./suite-editor.js";

/** Like Vim's 'timeoutlen': how long `Ctrl-X` waits for its second key. */
export const CTRL_X_TIMEOUT_MS = 1000;

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

  private filePickerFn: (() => Promise<string | undefined>) | undefined;
  private ctrlXTimer: ReturnType<typeof setTimeout> | undefined;

  /** Enables Insert-mode `Ctrl-X Ctrl-F`; resolves to the text to insert. */
  setFilePickerFn(fn: (() => Promise<string | undefined>) | undefined): void {
    this.filePickerFn = fn;
  }

  /**
   * Insert mode: `Ctrl-X` waits up to CTRL_X_TIMEOUT_MS for `Ctrl-F`, which
   * opens the file picker. Any other key, or the timeout, replays `Ctrl-X`
   * so Pi's own binding for it (copy) still works.
   */
  override handleInput(data: string): void {
    if (this.ctrlXTimer !== undefined) {
      clearTimeout(this.ctrlXTimer);
      this.ctrlXTimer = undefined;
      if (matchesKey(data, "ctrl+f")) {
        void this.openFilePicker();
        return;
      }
      super.handleInput("\x18");
    } else if (
      this.filePickerFn &&
      matchesKey(data, "ctrl+x") &&
      this.getModeContext().state === "insert" &&
      !this.isShowingAutocomplete()
    ) {
      this.ctrlXTimer = setTimeout(() => {
        this.ctrlXTimer = undefined;
        if (!this.isDisposed()) super.handleInput("\x18");
      }, CTRL_X_TIMEOUT_MS);
      return;
    }
    super.handleInput(data);
  }

  private async openFilePicker(): Promise<void> {
    const text = await this.filePickerFn?.();
    if (text && !this.isDisposed()) {
      this.insertTextAtCursor(text);
      this.tui.requestRender();
    }
  }

  override dispose(event?: { reason?: string }): void {
    if (this.ctrlXTimer !== undefined) clearTimeout(this.ctrlXTimer);
    this.ctrlXTimer = undefined;
    super.dispose(event);
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
