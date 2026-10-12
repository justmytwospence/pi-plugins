/**
 * The symbol-keyed integration protocol (contract v1) on top of the engine.
 * Both surfaces share protocol, lifecycle and input ownership here without
 * reimplementing the engine's motions or operators.
 */
import {
  EDITOR_INSERT,
  EDITOR_MODE,
  EDITOR_SNAPSHOT,
  EDITOR_SURFACE,
  type EditorModeContext,
  type EditorSnapshot,
  type EditorSnapshotApi,
  type EditorSurface,
  INPUT_CONTEXT,
  type SuiteEditor,
} from "./contract.js";
import { matchesKey } from "@earendil-works/pi-tui";
import { acquireCursor } from "./cursor-owner.js";
import { acquireViewportInput } from "./viewport-input.js";
import { resolveTuiRuntime } from "./tui-runtime.js";
import {
  getCursorShapeRuntime,
  hasPromptCursorMarker,
  stripSoftwareCursorWhenHardwareCursorIsUsed,
  type CursorShapeSequence,
} from "./engine/cursor-shape.js";
import { ModalEditor, type ModalEditorOptions } from "./engine/modal-editor.js";

type EditorConstructorArgs = ConstructorParameters<typeof ModalEditor>;

export abstract class SuiteModalEditor extends ModalEditor implements SuiteEditor {
  readonly [EDITOR_SURFACE]: EditorSurface;
  readonly [EDITOR_SNAPSHOT]: EditorSnapshotApi;
  private cursorLease: ReturnType<typeof acquireCursor>;
  private releaseViewportInput: () => void;
  private runtimeTui: object;

  constructor(
    surface: EditorSurface,
    tui: EditorConstructorArgs[0],
    theme: EditorConstructorArgs[1],
    keybindings: EditorConstructorArgs[2],
    options?: ModalEditorOptions,
  ) {
    super(tui, theme, keybindings, options);
    this.runtimeTui = resolveTuiRuntime(tui);
    this.releaseViewportInput = acquireViewportInput(this.runtimeTui, this);
    this.cursorLease = acquireCursor(this.runtimeTui, this);
    if (surface === "main") this.cursorLease.activate();
    this[EDITOR_SURFACE] = surface;
    this[EDITOR_SNAPSHOT] = {
      capture: (): EditorSnapshot => this.captureEditorSnapshot(),
      restore: (snapshot: EditorSnapshot): boolean =>
        this.restoreEditorSnapshot(snapshot),
    };
  }

  private refreshRuntime(): void {
    const runtime = resolveTuiRuntime(this.tui);
    if (runtime === this.runtimeTui) return;
    const inherited = { previous: this.cursorLease.previous };
    this.cursorLease.release((shape) => this.writeRuntimeShape(shape));
    this.releaseViewportInput();
    this.runtimeTui = runtime;
    this.releaseViewportInput = acquireViewportInput(runtime, this);
    this.cursorLease = acquireCursor(runtime, this, inherited);
    if (this[EDITOR_SURFACE] === "main") this.cursorLease.activate();
  }

  private writeRuntimeShape(shape: CursorShapeSequence): void {
    // The engine's captured runtime predates renderer replacement. Lease shape
    // caching belongs to the resolved renderer, so write to that renderer now.
    getCursorShapeRuntime(this.runtimeTui)?.writeCursorShape(shape);
  }

  protected override syncCursorShapeForRender(lines: string[]): void {
    if (this.isDisposed()) return;
    this.refreshRuntime();
    if (!hasPromptCursorMarker(lines)) return;
    const hardwareCursor = this.cursorLease.render(
      this.getDesiredCursorShapeSequence(),
      (shape) => this.writeRuntimeShape(shape),
    );
    if (hardwareCursor) stripSoftwareCursorWhenHardwareCursorIsUsed(lines);
  }

  override dispose(event?: { reason?: string }): void {
    if (this.isDisposed()) return;
    super.dispose();
    try {
      this.cursorLease.release((shape) => this.writeRuntimeShape(shape), event);
    } finally {
      this.releaseViewportInput();
    }
  }

  override setText(text: string): void {
    // Pi restores saved text after custom dialogs and copies it when swapping
    // editor components. An unchanged draft is not an edit: retain its cursor,
    // Vim undo/redo, register and repeat state through those lifecycle calls.
    if (text === this.getText()) return;
    super.setText(text);
  }

  override handleInput(data: string): void {
    if (this.isDisposed()) return;
    const context = this.getModeContext();
    // Counts fall through to CustomEditor after being discarded upstream.
    // On an empty draft Ctrl+D could exit instead of cancelling the incomplete
    // Vim command. EX owns its text-field controls inside the engine.
    if (
      context.state === "pending" &&
      (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d"))
    ) {
      super.handleInput("\x1b");
      return;
    }
    super.handleInput(data);
  }

  [INPUT_CONTEXT](): "editor" {
    return "editor";
  }

  [EDITOR_MODE](): EditorModeContext {
    return this.getModeContext();
  }

  [EDITOR_INSERT](): void {
    this.enterInsertAtEnd();
  }
}
