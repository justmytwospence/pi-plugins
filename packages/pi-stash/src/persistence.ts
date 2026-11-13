import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { isEditorSnapshot, type EditorSnapshot } from "./contract.ts";
import { STASH_LIMIT, type StashedPrompt } from "./core.ts";

/** Non-model session state, independent of the currently selected conversation branch. */
export const STASH_ENTRY_TYPE = "pi-stash.state";

type PersistedPrompt = { text: string; snapshot?: Omit<EditorSnapshot, "history"> };

/**
 * Version 1 holds at most one draft that automatic restoration may bring back; it is still
 * written for that case, so older copies keep reading it. Version 2 holds the whole stack.
 */
export type PersistedStashState =
  | { version: 1; prompt: PersistedPrompt | null }
  | { version: 2; prompts: PersistedPrompt[]; autoRestore: boolean };

/** The stack as saved and loaded: drafts oldest first, and whether the top may auto-restore. */
export interface StashStack {
  prompts: StashedPrompt[];
  autoRestore: boolean;
}

export type StashStateResult =
  | { status: "missing" }
  | ({ status: "valid" } & StashStack)
  | { status: "invalid" };

/** Whitelist the durable snapshot fields; history can be opaque or even circular. */
function copySnapshot(value: unknown, text: string): Omit<EditorSnapshot, "history"> | undefined {
  if (!isEditorSnapshot(value) || value.text !== text) return undefined;
  return {
    version: 1,
    text,
    cursor: { line: value.cursor.line, col: value.cursor.col },
    mode: value.mode,
    ...(value.anchor === undefined ? {} : { anchor: { line: value.anchor.line, col: value.anchor.col } }),
  };
}

function copyPrompt(entry: StashedPrompt): PersistedPrompt {
  const snapshot = copySnapshot(entry.snapshot, entry.text);
  return { text: entry.text, ...(snapshot ? { snapshot } : {}) };
}

/** Detached copies of drafts with only their durable fields (no opaque editor history). */
export function detachPrompts(entries: readonly StashedPrompt[]): StashedPrompt[] {
  return entries.map(copyPrompt);
}

/** A detached, JSON-safe snapshot of the main stash, never the current unstashed editor. */
export function serializeStash(entries: readonly StashedPrompt[], autoRestore: boolean): PersistedStashState {
  const prompts = entries.map(copyPrompt);
  if (prompts.length === 0) return { version: 1, prompt: null };
  if (prompts.length === 1 && autoRestore) return { version: 1, prompt: prompts[0]! };
  return { version: 2, prompts, autoRestore };
}

function readPrompt(value: unknown): StashedPrompt | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const prompt = value as Partial<PersistedPrompt>;
  if (typeof prompt.text !== "string" || prompt.text.length === 0) return undefined;
  const snapshot = copySnapshot(prompt.snapshot, prompt.text);
  return { text: prompt.text, ...(snapshot ? { snapshot } : {}) };
}

/** Last matching file entry wins, including null and malformed/unsupported envelopes. */
export function readStashState(entries: Iterable<unknown>): StashStateResult {
  let found = false;
  let latest: unknown;
  for (const value of entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as Partial<CustomEntry>;
    if (entry.type !== "custom" || entry.customType !== STASH_ENTRY_TYPE) continue;
    found = true;
    latest = entry.data;
  }
  if (!found) return { status: "missing" };
  if (typeof latest !== "object" || latest === null) return { status: "invalid" };
  const state = latest as Record<string, unknown>;
  if (state.version === 1) {
    if (state.prompt === null) return { status: "valid", prompts: [], autoRestore: false };
    const prompt = readPrompt(state.prompt);
    return prompt ? { status: "valid", prompts: [prompt], autoRestore: true } : { status: "invalid" };
  }
  if (state.version === 2) {
    if (!Array.isArray(state.prompts) || typeof state.autoRestore !== "boolean") return { status: "invalid" };
    const prompts = state.prompts.map(readPrompt);
    if (prompts.some((prompt) => prompt === undefined)) return { status: "invalid" };
    const kept = (prompts as StashedPrompt[]).slice(-STASH_LIMIT);
    return { status: "valid", prompts: kept, autoRestore: state.autoRestore && kept.length > 0 };
  }
  return { status: "invalid" };
}
