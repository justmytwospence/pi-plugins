// A one-off text prompt (the review's "What should change?") in the suite's editor, so pi-vim's
// modal editing works there as in the main prompt: Enter or :w sends, Escape in Normal mode or :q
// cancels. Without an editor provider (or outside the TUI) it is Pi's own one-line input.
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, Focusable } from "@earendil-works/pi-tui";
import { Spacer, Text } from "@earendil-works/pi-tui";
import { requestEditorFactory, type SuiteEditor } from "./editor-contract.js";

const FALLBACK = Symbol("feedback-input-fallback");

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

class FeedbackPrompt implements Component, Focusable {
  private readonly parts: Component[];
  private focusedValue = false;

  constructor(
    title: string,
    private readonly editor: SuiteEditor,
    theme: Theme,
  ) {
    this.parts = [
      new Text(theme.fg("accent", title), 1, 0),
      new Spacer(1),
      editor,
      new Text(theme.fg("dim", "enter send · esc then esc (or :q) cancel"), 1, 0),
    ];
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

/** Ask for a line or more of text; undefined when cancelled. */
export async function askFeedback(pi: ExtensionAPI, ctx: ExtensionContext, title: string): Promise<string | undefined> {
  const suite = ctx.mode === "tui" ? requestEditorFactory(pi.events) : undefined;
  if (!suite || typeof ctx.ui.custom !== "function") return ctx.ui.input(title);
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
        initialMode: "insert",
        paddingX: 1,
      });
    } catch {
      // A provider's bug must not take the prompt away: Pi's own input follows.
      queueMicrotask(() => finish(FALLBACK));
      return { render: () => [], invalidate: () => {} };
    }
    return new FeedbackPrompt(title, editor, theme);
  });
  return answer === FALLBACK ? ctx.ui.input(title) : answer;
}
