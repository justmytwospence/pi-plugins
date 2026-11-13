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

/** Most drafts kept; stashing beyond this drops the oldest. */
export const STASH_LIMIT = 20;

/** Where repeated Ctrl+S presses are while browsing the stash. */
export interface StashCycle {
  /** The draft Ctrl+S just put in the editor; another Ctrl+S on this exact text moves on. */
  text: string;
  /** 1-based position of that draft among all drafts being browsed. */
  index: number;
  total: number;
}

/**
 * A stack of stashed drafts, newest on top. Ctrl+S pushes and pops; automatic restoration
 * only ever brings back the draft stashed last, and only until something else is popped.
 */
export class PromptStash {
  /** Oldest first; the top (newest) is last. */
  private prompts: StashedPrompt[] = [];
  /**
   * Whether automatic restoration (after a command, a shell command, a model change) may
   * bring back the top draft. Set when a draft is stashed, cleared when one is taken: drafts
   * left underneath are shelved and come back only through Ctrl+S.
   */
  autoRestore = false;
  /** Browsing state of repeated Ctrl+S presses; in memory only, cleared by any other key. */
  cycle: StashCycle | undefined;
  /**
   * Held through a navigation (/tree, /fork, /clone) that may load a message into the editor:
   * the draft comes back when the editor is empty afterwards, else after the next submit.
   * Lives on the process-global stash so it survives the session replacement of a fork.
   */
  held = false;
  /**
   * Set by /import, which replaces the session and then clears the editor: the next session
   * settles the draft only after that. (Forks and clones are told apart by their start reason.)
   */
  awaitText = false;

  /** The stashed text (upstream-compatible accessor; pi-status-footer reads it). */
  get value(): string | undefined {
    return this.entry?.text;
  }

  /** The top (newest) stashed entry. */
  get entry(): StashedPrompt | undefined {
    return this.prompts.at(-1);
  }

  /** Every stashed entry, oldest first. */
  get entries(): readonly StashedPrompt[] {
    return this.prompts;
  }

  /** How many drafts are stashed (pi-status-footer reads it). */
  get count(): number {
    return this.prompts.length;
  }

  get hasPrompt(): boolean {
    return this.prompts.length > 0;
  }

  /** Push a draft on top; returns the oldest draft when the limit dropped it. */
  stash(prompt: string | StashedPrompt): StashedPrompt | undefined {
    this.prompts.push(typeof prompt === "string" ? { text: prompt } : { ...prompt });
    this.autoRestore = true;
    this.reset();
    return this.prompts.length > STASH_LIMIT ? this.prompts.shift() : undefined;
  }

  /** Pop the top draft. The drafts underneath stay shelved. */
  take(): StashedPrompt | undefined {
    const prompt = this.prompts.pop();
    this.autoRestore = false;
    this.reset();
    return prompt;
  }

  /** Put a draft at the bottom, under every other one (browsing with Ctrl+S). */
  shelve(prompt: StashedPrompt): void {
    this.prompts.unshift({ ...prompt });
  }

  /** Replace every draft, oldest first (loading saved or carried state). */
  load(prompts: readonly StashedPrompt[], autoRestore: boolean): void {
    this.prompts = prompts.slice(-STASH_LIMIT).map((prompt) => ({ ...prompt }));
    this.autoRestore = autoRestore && this.prompts.length > 0;
    this.reset();
  }

  private reset(): void {
    this.held = false;
    this.awaitText = false;
    this.cycle = undefined;
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

/**
 * Restore the top stashed draft. Automatic restoration only fills an empty editor, never
 * overwrites a newer draft, and only brings back the draft stashed last (`autoRestore`).
 */
export function restoreDraft(stash: PromptStash, target: DraftTarget, automatic: boolean): boolean {
  const entry = stash.entry;
  if (!entry) return false;
  if (automatic && (!stash.autoRestore || target.getText().length > 0)) return false;
  const total = stash.count;
  stash.take();
  target.apply(entry);
  if (!automatic && total > 1) stash.cycle = { text: entry.text, index: 1, total };
  target.changed?.();
  target.notify(restoredMessage(total, automatic), "info");
  return true;
}

function restoredMessage(total: number, automatic: boolean): string {
  if (total <= 1) return "Restored stashed prompt";
  const left = total - 1;
  return automatic
    ? `Restored stashed prompt (${left} more stashed)`
    : `Restored stashed prompt 1/${total} (ctrl+s for the next)`;
}

/**
 * Ctrl+S: push the draft onto the stash, or pop the top into an empty editor. Pressed again
 * on a draft it just restored, it moves that draft to the bottom and shows the next one, so
 * repeated presses browse every stashed draft.
 */
export function toggleDraft(stash: PromptStash, target: DraftTarget): void {
  const current = target.getText();
  const cycle = stash.cycle;
  if (cycle && current === cycle.text && stash.hasPrompt) {
    const next = stash.take()!;
    stash.shelve(target.capture(current));
    target.apply(next);
    const index = cycle.index % cycle.total + 1;
    stash.cycle = { text: next.text, index, total: cycle.total };
    target.changed?.();
    target.notify(`Restored stashed prompt ${index}/${cycle.total}`, "info");
    return;
  }
  if (current.length === 0) {
    if (!restoreDraft(stash, target, false)) target.notify("Nothing to stash", "warning");
    return;
  }
  const dropped = stash.stash(target.capture(current));
  target.clear();
  target.changed?.();
  target.notify(stash.count > 1 ? `Prompt stashed (${stash.count} stashed)` : "Prompt stashed", "info");
  if (dropped) target.notify(`Stash full: dropped the oldest of ${STASH_LIMIT} stashed prompts`, "warning");
}

/** A slash command: the editor is free again as soon as the command starts. */
export function isTemporaryAction(input: string): boolean {
  return input.trimStart().startsWith("/");
}

/**
 * Pi's built-in navigation commands. Each opens a selector and may then put the selected
 * user message into the editor (/tree only into an empty one, /fork and /clone always), so
 * restoring when the command starts would block or lose that message, or lose the draft.
 */
export function isNavigationAction(input: string): boolean {
  const command = input.trim();
  return command === "/tree" || command === "/fork" || command === "/clone";
}

/**
 * Pi's built-in commands that clear the editor only after they finish (/copy, /export,
 * /share, /import): a draft restored while they run would be wiped.
 */
export function isClearedAfterAction(input: string): boolean {
  const command = input.trim();
  return command === "/copy" || command === "/share"
    || command === "/export" || command.startsWith("/export ")
    || command === "/import" || command.startsWith("/import ");
}

/** /import replaces the session and then clears the editor (a fork's session start says so itself). */
export function isImportAction(input: string): boolean {
  const command = input.trim();
  return command === "/import" || command.startsWith("/import ");
}

/**
 * Commands that start a fresh session: Pi's /new and pi-clear-screen's /clear. The stash
 * carries into the new session (its start reason is "new"), so it is not restored when the
 * command starts.
 */
export function isNewSessionAction(input: string): boolean {
  const command = input.trim();
  return command === "/new" || command === "/clear";
}

/** A `!` or `!!` shell command: Pi awaits it inside the submit callback. */
export function isShellAction(input: string): boolean {
  return input.trimStart().startsWith("!");
}
