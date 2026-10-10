// Shared verbatim by pi-herdr and opencode-herdr (src/core).
//
// Text helpers both hosts use: titles from prompts, short model names, and replies cut to fit in a
// message.

/** "claude-opus-5-5" -> "opus-5-5", "gpt-6-astra" stays; provider prefixes and date suffixes go. */
export function shortModel(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return bare.replace(/^claude-/u, "").replace(/-\d{8}$/u, "");
}

/** The first line of a prompt, without slash-command noise, cut to `max` characters. */
export function titleFromPrompt(text: string | undefined, max = 60): string | undefined {
  if (!text) return undefined;
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("/"));
  if (!line) return undefined;
  const flat = line.replace(/\s+/gu, " ");
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export const MAX_LINES = 2_000;
export const MAX_BYTES = 50 * 1024;

/** Drops a trailing next-prompt suggestion (`<next>…</next>`, pi-next-prompt and its ports). */
export function stripNext(text: string): string {
  return text.replace(/\n?\s*<next>[\s\S]*?<\/next>\s*$/u, "").trimEnd();
}

/** Cuts to MAX_LINES / MAX_BYTES, keeping the end (where conclusions are), with a note. */
export function clipReply(text: string, source: string): string {
  let out = text;
  let cut = false;
  const lines = out.split("\n");
  if (lines.length > MAX_LINES) {
    out = lines.slice(-MAX_LINES).join("\n");
    cut = true;
  }
  if (Buffer.byteLength(out) > MAX_BYTES) {
    out = Buffer.from(out).subarray(-MAX_BYTES).toString().replace(/^[^\n]*\n/u, "");
    cut = true;
  }
  return cut ? `[earlier part cut; full reply in ${source}]\n${out}` : out;
}
