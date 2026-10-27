// A text prompt in the suite's editor, so pi-vim's modal editing works there as in the main prompt:
// Enter or :w submits, Escape in Normal mode or :q cancels. It follows pi-plan-mode's
// feedback-input.ts (title, editor, dim key hint), and adds a prefilled text for editing a draft.
// Without an editor provider (or outside the TUI) it is Pi's own input, or Pi's editor for a draft.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, Focusable } from "@earendil-works/pi-tui";
import { Spacer, Text } from "@earendil-works/pi-tui";
import { requestEditorFactory, type SuiteEditor } from "./editor-contract.ts";

const FALLBACK = Symbol("text-input-fallback");

function editorTheme(theme: Theme): EditorTheme {
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

class TextPrompt implements Component, Focusable {
  private readonly parts: Component[];
  private focusedValue = false;

  constructor(title: string, hint: string, private readonly editor: SuiteEditor, theme: Theme) {
    this.parts = [new Text(theme.fg("accent", title), 1, 0), new Spacer(1), editor, new Text(theme.fg("dim", hint), 1, 0)];
  }

  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.editor.focused = value;
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  render(width: number): string[] {
    return this.parts.flatMap((part) => part.render(width));
  }

  invalidate(): void {
    for (const part of this.parts) part.invalidate();
  }

  dispose(): void {
    this.editor.dispose();
  }
}

export interface TextInputOptions {
  /** Text to start from (a draft to edit); the editor opens in Normal mode on it. */
  initial?: string;
  /** The dim key hint under the editor. */
  hint?: string;
  /** Placeholder for Pi's own one-line input, when no editor provider is loaded. */
  placeholder?: string;
}

/** Ask for text; undefined when cancelled. */
export async function askText(pi: ExtensionAPI, ctx: ExtensionContext, title: string, options: TextInputOptions = {}): Promise<string | undefined> {
  const initial = options.initial;
  const native = () => (initial !== undefined ? ctx.ui.editor(title, initial) : ctx.ui.input(title, options.placeholder));
  const suite = ctx.mode === "tui" ? requestEditorFactory(pi.events) : undefined;
  if (!suite || typeof ctx.ui.custom !== "function") return native();
  const hint = options.hint ?? "enter submit · esc then esc (or :q) cancel";
  const answer = await ctx.ui.custom<string | undefined | typeof FALLBACK>((tui, theme, keybindings, done) => {
    let settled = false;
    const finish = (value: string | undefined | typeof FALLBACK) => {
      if (settled) return;
      settled = true;
      done(value);
    };
    let editor: SuiteEditor;
    try {
      editor = suite.factory({
        surface: "embedded",
        tui,
        theme: editorTheme(theme),
        keybindings,
        onSubmit: (text) => finish(text),
        onCancel: () => finish(undefined),
        notify: (message, type) => ctx.ui.notify(message, type),
        initialMode: initial !== undefined ? "normal" : "insert",
        ...(initial !== undefined ? { initialText: initial } : {}),
        paddingX: 1,
      });
    } catch {
      // A provider's bug must not take the prompt away: Pi's own input follows.
      queueMicrotask(() => finish(FALLBACK));
      return { render: () => [], invalidate: () => {} };
    }
    return new TextPrompt(title, hint, editor, theme);
  });
  return answer === FALLBACK ? native() : answer;
}
