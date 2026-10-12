// Test-only reduction of @saadjs/pi-stash 0.0.3 (MIT, Saad Bash).
// Keep its factory-time global, string-only stash API, untagged editor wrapper,
// selection handlers and shutdown retention. Shell/slash handling is not needed
// for these ownership tests. Never load an installed package as a test fixture.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CTRL_S } from "./harness.ts";

const STASH_KEY = Symbol.for("@saadjs/pi-stash/prompt");

class LegacyPromptStash {
  private prompt: string | undefined;
  get value(): string | undefined { return this.prompt; }
  get hasPrompt(): boolean { return this.prompt !== undefined; }
  stash(prompt: string): void { this.prompt = prompt; }
  take(): string | undefined {
    const prompt = this.prompt;
    this.prompt = undefined;
    return prompt;
  }
}

export function legacyPromptStash(pi: ExtensionAPI) {
  const globals = globalThis as Record<symbol, unknown>;
  const stash = (globals[STASH_KEY] ??= new LegacyPromptStash()) as LegacyPromptStash;
  const counts = { toggles: 0, restores: 0 };
  let activeContext: ExtensionContext | undefined;

  const restore = (ctx: ExtensionContext) => {
    const prompt = stash.value;
    if (prompt === undefined || ctx.ui.getEditorText().length > 0) return;
    counts.restores++;
    stash.take();
    ctx.ui.setEditorText(prompt);
  };

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    // The test harness always supplies a base factory; the real extension also
    // falls back to CustomEditor when there is none.
    const previous = ctx.ui.getEditorComponent()!;
    ctx.ui.setEditorComponent((...args) => {
      const editor = previous(...args);
      const handleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data) => {
        if (data !== CTRL_S) {
          handleInput(data);
          return;
        }
        counts.toggles++;
        const current = ctx.ui.getEditorText();
        if (!stash.hasPrompt) {
          if (current.length > 0) {
            stash.stash(current);
            ctx.ui.setEditorText("");
          }
        } else {
          const prompt = stash.take()!;
          if (current.length > 0) stash.stash(current);
          ctx.ui.setEditorText(prompt);
        }
      };
      return editor;
    });
    restore(ctx);
  });
  pi.on("session_shutdown", () => {
    activeContext = undefined;
    // Intentionally neither delete the global nor unwrap the editor, as upstream.
  });
  pi.on("model_select", () => { if (activeContext) restore(activeContext); });
  pi.on("thinking_level_select", () => { if (activeContext) restore(activeContext); });
  return { stash, counts };
}
