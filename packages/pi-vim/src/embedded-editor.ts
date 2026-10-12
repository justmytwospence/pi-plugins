/**
 * An embedded editor for another component's dialog (contract v1, surface
 * `"embedded"`). It is the same engine as the main prompt with the session
 * boundary removed: nothing it does reaches Pi's agent, command registry,
 * shell or process.
 *
 * - Escape is local first (Insert to Normal, Visual to Normal, drop pending
 *   keys, close the EX line); only in idle Normal mode does it call `onCancel`.
 * - Ctrl+U / Ctrl+D in idle Normal mode call `scrollViewport`; without one
 *   they are consumed. Visual never scrolls a viewport; Escape returns it to
 *   Normal first. Pending counts/operators cancel locally. EX Ctrl+U clears
 *   the input and Ctrl+D no-ops at its end cursor, keeping EX open.
 * - The EX line asks `onExCommand` first, then submits on `:w` / `:wq` / `:x`,
 *   cancels on the `:q` family and reports anything else through `notify`.
 *   `/commands` and `!shell` lines are never dispatched.
 * - `dispose()` releases its shared TUI cursor ownership; a live main editor
 *   keeps its hardware cursor until the session ends.
 */
import type { EditorFactoryOptions } from "./contract.js";
import { ModalEditor, type ModalEditorOptions } from "./engine/modal-editor.js";
import { SuiteModalEditor } from "./suite-editor.js";

const EX_SUBMIT_NAMES: ReadonlySet<string> = new Set(["w", "wq", "x"]);

export class EmbeddedEditor extends SuiteModalEditor {
  private readonly hooks: Pick<
    EditorFactoryOptions,
    "onCancel" | "scrollViewport" | "onExCommand" | "notify"
  >;

  private readonly onDisposed: (() => void) | undefined;

  constructor(
    options: EditorFactoryOptions,
    engineOptions?: ModalEditorOptions,
    onDisposed?: () => void,
  ) {
    super(
      "embedded",
      options.tui,
      options.theme,
      // Keep native editing/history bindings, but never application actions:
      // embedded Insert Ctrl+D on an empty draft must not invoke app.exit.
      Object.assign(Object.create(options.keybindings), {
        matches: (data: string, action: Parameters<typeof options.keybindings.matches>[1]) =>
          !action.startsWith("app.") && options.keybindings.matches(data, action),
      }),
      engineOptions,
    );
    this.onDisposed = onDisposed;
    this.hooks = {
      onCancel: options.onCancel,
      scrollViewport: options.scrollViewport,
      onExCommand: options.onExCommand,
      notify: options.notify,
    };
    if (options.onSubmit) this.onSubmit = options.onSubmit;
    this.setPaddingX(options.paddingX ?? 0);
    if (options.initialText) this.setText(options.initialText);
    if (options.initialMode === "normal") this.handleInput("\x1b");
  }

  protected override handleIdleNormalEscape(): void {
    this.hooks.onCancel?.();
  }

  protected override scrollHalfPage(direction: -1 | 1): boolean {
    this.hooks.scrollViewport?.(direction);
    return true;
  }

  protected override executeExCommand(command: string): void {
    const { name, bareName, args, force } = ModalEditor.parseExCommand(command);
    if (this.hooks.onExCommand?.(name, args, command) === true) return;
    if (EX_SUBMIT_NAMES.has(bareName)) {
      this.submitThroughEditor();
      return;
    }
    if (ModalEditor.isExQuitName(bareName)) {
      if (!force && this.getText().trim().length > 0) {
        this.hooks.notify?.(
          `Editor is not empty; use :${name}! to close anyway`,
          "warning",
        );
        return;
      }
      this.hooks.onCancel?.();
      return;
    }
    this.hooks.notify?.(`Unsupported ex command: :${command}`, "warning");
  }

  override dispose(): void {
    if (this.isDisposed()) return;
    super.dispose();
    this.onDisposed?.();
  }
}
