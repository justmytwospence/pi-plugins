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
  private transcriptSearchFn: ((direction: "forward" | "backward") => boolean) | undefined;

  /** Idle Normal `/` and `?`: returns true when something (pi-copy's copy mode) opened. */
  setTranscriptSearchFn(fn: ((direction: "forward" | "backward") => boolean) | undefined): void {
    this.transcriptSearchFn = fn;
  }

  protected override openTranscriptSearch(direction: "forward" | "backward"): boolean {
    return this.transcriptSearchFn?.(direction) === true;
  }
  private ctrlXTimer: ReturnType<typeof setTimeout> | undefined;
  private replayingCtrlX = false;

  /** Enables Insert-mode `Ctrl-X Ctrl-F`; resolves to the text to insert. */
  setFilePickerFn(fn: (() => Promise<string | undefined>) | undefined): void {
    this.filePickerFn = fn;
  }

  /**
   * Insert/idle Normal: Ctrl-X Ctrl-E invokes Pi's external editor action.
   * Insert also supports Ctrl-X Ctrl-F for the file picker. Unmatched keys
   * and timeout replay Ctrl-X so Pi's own binding (copy) still works.
   */
  override handleInput(data: string): void {
    if (this.replayingCtrlX) {
      super.handleInput(data);
      return;
    }
    if (matchesKey(data, "ctrl+x") && !["insert", "normal"].includes(this.getModeContext().state)) {
      this.replayCtrlX();
      return;
    }
    if (this.ctrlXTimer !== undefined) {
      clearTimeout(this.ctrlXTimer);
      this.ctrlXTimer = undefined;
      const externalEditor = this.actionHandlers.get("app.editor.external");
      if (matchesKey(data, "ctrl+e") && externalEditor) {
        externalEditor();
        return;
      }
      if (matchesKey(data, "ctrl+f") && this.filePickerFn && this.getModeContext().state === "insert") {
        void this.openFilePicker();
        return;
      }
      this.replayCtrlX();
    } else if (
      (this.actionHandlers.has("app.editor.external") ||
        (this.filePickerFn && this.getModeContext().state === "insert")) &&
      matchesKey(data, "ctrl+x") &&
      ["insert", "normal"].includes(this.getModeContext().state) &&
      !this.isShowingAutocomplete()
    ) {
      this.ctrlXTimer = setTimeout(() => {
        this.ctrlXTimer = undefined;
        if (!this.isDisposed()) this.replayCtrlX();
      }, CTRL_X_TIMEOUT_MS);
      return;
    }
    super.handleInput(data);
  }

  private replayCtrlX(): void {
    // EX can cancel and redispatch a control key through this.handleInput.
    // Never reinterpret that replay as the start of a new chord.
    this.replayingCtrlX = true;
    try {
      super.handleInput("\x18");
    } finally {
      this.replayingCtrlX = false;
    }
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
