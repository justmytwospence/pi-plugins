// Plain stash state, kept free of Pi imports so it can be shared across extension
// instances (process-global) and tested without a TUI.
//
// Origin: @saadjs/pi-stash 0.0.3 core.ts (MIT, Saad Bash). The suite version stores
// an optional editor snapshot (cursor, mode) next to the text; `value` keeps the
// upstream shape so readers such as pi-status-footer's stash row keep working.

import type { EditorSnapshot } from "./contract.ts";

/** What is kept while a prompt is stashed. */
export interface StashedPrompt {
  /** The stashed editor text. */
  text: string;
  /** Cursor/mode snapshot from an editor implementing the suite snapshot protocol. */
  snapshot?: EditorSnapshot;
}

export class PromptStash {
  private prompt: StashedPrompt | undefined;

  /** The stashed text (upstream-compatible accessor; pi-status-footer reads it). */
  get value(): string | undefined {
    return this.prompt?.text;
  }

  /** The full stashed entry. */
  get entry(): StashedPrompt | undefined {
    return this.prompt;
  }

  get hasPrompt(): boolean {
    return this.prompt !== undefined;
  }

  stash(prompt: string | StashedPrompt): void {
    this.prompt = typeof prompt === "string" ? { text: prompt } : { ...prompt };
  }

  take(): StashedPrompt | undefined {
    const prompt = this.prompt;
    this.prompt = undefined;
    return prompt;
  }
}

/** Where a stash's drafts come from and go back to: Pi's main editor or another plugin's editor. */
export interface DraftTarget {
  getText(): string;
  /** The text plus, when available, the editor's snapshot. */
  capture(text: string): StashedPrompt;
  /** Put a stashed draft into the editor (snapshot restore when possible, text otherwise). */
  apply(entry: StashedPrompt): void;
  /** Clear the editor after stashing its draft. */
  clear(): void;
  notify(message: string, type: "info" | "warning"): void;
  /** The stash changed (status indicators). */
  changed?(): void;
}

/** Restore the stashed draft. Automatic restoration only fills an empty editor; it never overwrites a newer draft. */
export function restoreDraft(stash: PromptStash, target: DraftTarget, automatic: boolean): boolean {
  const entry = stash.entry;
  if (!entry) return false;
  if (automatic && target.getText().length > 0) return false;
  stash.take();
  target.apply(entry);
  target.changed?.();
  target.notify("Restored stashed prompt", "info");
  return true;
}

/** Ctrl+S: stash the draft, restore into an empty editor, or swap the two. */
export function toggleDraft(stash: PromptStash, target: DraftTarget): void {
  const current = target.getText();
  if (!stash.hasPrompt) {
    if (current.length === 0) {
      target.notify("Nothing to stash", "warning");
      return;
    }
    stash.stash(target.capture(current));
    target.clear();
    target.changed?.();
    target.notify("Prompt stashed", "info");
    return;
  }
  if (current.length === 0) {
    restoreDraft(stash, target, false);
    return;
  }
  const previous = stash.take()!;
  stash.stash(target.capture(current));
  target.apply(previous);
  target.changed?.();
  target.notify("Swapped current and stashed prompts", "info");
}

/** A slash command: the editor is free again as soon as the command starts. */
export function isTemporaryAction(input: string): boolean {
  return input.trimStart().startsWith("/");
}

/** A `!` or `!!` shell command: Pi awaits it inside the submit callback. */
export function isShellAction(input: string): boolean {
  return input.trimStart().startsWith("!");
}
