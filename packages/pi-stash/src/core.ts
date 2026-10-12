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

/** A slash command: the editor is free again as soon as the command starts. */
export function isTemporaryAction(input: string): boolean {
  return input.trimStart().startsWith("/");
}

/** A `!` or `!!` shell command: Pi awaits it inside the submit callback. */
export function isShellAction(input: string): boolean {
  return input.trimStart().startsWith("!");
}
