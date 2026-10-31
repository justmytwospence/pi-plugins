import type { CustomEntry } from "@earendil-works/pi-coding-agent";
import { isEditorSnapshot, type EditorSnapshot } from "./contract.ts";
import type { StashedPrompt } from "./core.ts";

/** Non-model session state, independent of the currently selected conversation branch. */
export const STASH_ENTRY_TYPE = "pi-stash.state";

export interface PersistedStashState {
  version: 1;
  prompt: { text: string; snapshot?: Omit<EditorSnapshot, "history"> } | null;
}

export type StashStateResult =
  | { status: "missing" }
  | { status: "valid"; entry?: StashedPrompt }
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

/** A detached, JSON-safe snapshot of the main stash, never the current unstashed editor. */
export function serializeStash(entry: StashedPrompt | undefined): PersistedStashState {
  if (!entry) return { version: 1, prompt: null };
  const snapshot = copySnapshot(entry.snapshot, entry.text);
  return { version: 1, prompt: { text: entry.text, ...(snapshot ? { snapshot } : {}) } };
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
  const state = latest as Partial<PersistedStashState>;
  if (state.version !== 1) return { status: "invalid" };
  if (state.prompt === null) return { status: "valid" };
  if (typeof state.prompt !== "object" || state.prompt === null
    || typeof state.prompt.text !== "string" || state.prompt.text.length === 0) return { status: "invalid" };
  const snapshot = copySnapshot(state.prompt.snapshot, state.prompt.text);
  return { status: "valid", entry: { text: state.prompt.text, ...(snapshot ? { snapshot } : {}) } };
}
