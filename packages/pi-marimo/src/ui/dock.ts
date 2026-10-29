// The prompt docked at the bottom of the notebook view: a message for the agent (`a`), Python for the
// kernel's scratchpad (`:`), a note for a Lens mark (`m`), or a widget's typed value. It is the
// suite's editor (pi-vim when loaded, through editor-contract.ts) or Pi's own, as in pi-compact-plan's
// text prompts, so it edits like the main prompt.
import { Editor, type EditorTheme, type TUI, matchesKey } from "@earendil-works/pi-tui";
import { type EditorFactoryFn, type SuiteEditor, markEmbedded } from "../editor-contract.ts";
import type { FrameTheme } from "../frame.ts";

export type DockKind = "ask" | "scratch" | "mark" | "value" | "markdown" | "table";

export interface DockSpec {
  kind: DockKind;
  title: string;
  hint: string;
  initial?: string;
  submit(text: string): void;
  cancel(): void;
}

/** The editor's theme, as pi-compact-plan's text prompt builds it (text-input.ts). */
export function editorTheme(theme: FrameTheme): EditorTheme {
  return {
    borderColor: (text) => theme.fg("borderAccent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("dim", text),
    },
  };
}

type AnyEditor = (SuiteEditor | Editor) & { focused: boolean };

export class Dock {
  readonly kind: DockKind;
  private hint: string;
  private readonly editor: AnyEditor;
  private readonly native: boolean;

  constructor(tui: unknown, private readonly theme: FrameTheme, private readonly spec: DockSpec, factory?: EditorFactoryFn, keybindings?: unknown) {
    this.kind = spec.kind;
    this.hint = spec.hint;
    let editor: AnyEditor | undefined;
    if (factory && keybindings) {
      try {
        editor = factory({
          surface: "embedded",
          tui: tui as TUI,
          theme: editorTheme(theme),
          keybindings: keybindings as never,
          onSubmit: (text) => spec.submit(text),
          onCancel: () => spec.cancel(),
          notify: () => undefined,
          paddingX: 0,
          initialMode: "insert",
          ...(spec.initial ? { initialText: spec.initial } : {}),
        });
      } catch {
        // A provider's bug must not take the prompt away: Pi's own editor follows.
        editor = undefined;
      }
    }
    this.native = !editor;
    if (!editor) {
      const native = markEmbedded(new Editor(tui as TUI, editorTheme(theme)));
      native.onSubmit = (text) => spec.submit(text);
      if (spec.initial) native.setText(spec.initial);
      editor = native;
    }
    editor.focused = true;
    this.editor = editor;
  }

  handleInput(data: string): void {
    // Pi's own editor has no cancel of its own: Escape (outside its autocomplete) closes the prompt.
    if (this.native && matchesKey(data, "escape") && !this.editor.isShowingAutocomplete()) {
      this.spec.cancel();
      return;
    }
    this.editor.handleInput(data);
  }

  /** The title, the editor (its last lines when it is taller than `maxLines` allows) and the hint. */
  render(width: number, maxLines: number): string[] {
    const lines = this.editor.render(Math.max(10, width));
    const room = Math.max(1, maxLines - 2);
    return [this.theme.fg("accent", this.spec.title), ...lines.slice(-room), this.theme.fg("dim", this.hint)];
  }

  getText(): string {
    return this.editor.getText();
  }

  setText(text: string): void {
    this.editor.setText(text);
  }

  addToHistory(text: string): void {
    this.editor.addToHistory(text);
  }

  setHint(hint: string): void {
    this.hint = hint;
  }

  dispose(): void {
    if (!this.native) (this.editor as SuiteEditor).dispose();
  }
}
