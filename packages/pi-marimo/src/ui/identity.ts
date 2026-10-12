import { normalize } from "../core/io.js";
import type { Followed } from "../core/watcher.js";

/** One notebook across reconnects; two servers hosting the same file remain distinct. */
export function notebookKey(f: Followed): string {
  return JSON.stringify([f.attachment.url, f.canonicalPath ?? normalize(f.attachment.path)]);
}

/** A confirmation is narrower than the row identity: it belongs to this kernel session only. */
export function interruptKey(f: Followed): string {
  return JSON.stringify([notebookKey(f), f.attachment.sessionId]);
}

export function notebookPath(key: string): string {
  try {
    const value: unknown = JSON.parse(key);
    if (Array.isArray(value) && typeof value[1] === "string") return value[1];
  } catch {
    // A stale or malformed source key remains harmless display text.
  }
  return key;
}
