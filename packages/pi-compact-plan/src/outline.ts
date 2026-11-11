// An outline of the session for drafting a compaction plan when the full conversation is not in the
// prompt cache: every prompt and reply, one line per tool call, and each tool result shortened to
// its first and last lines and any error or warning lines. The summary itself is still written from
// the full transcript, so the outline only has to be enough to ask good questions and write a focus.

type Json = Record<string, unknown>;

export const OUTLINE_BUDGET_CHARS = 160_000;
export const TEXT_MAX = 4_000;
export const ARGS_MAX = 300;
export const LINE_MAX = 300;
export const HEAD_LINES = 3;
export const TAIL_LINES = 3;
export const SIGNAL_LINES = 8;

// Copied from pi-cache-guard's src/lean.ts (SIGNAL): the repository forbids runtime sibling imports.
const SIGNAL = /error|\bERR!?\b|warn|fail|panic|assert|exception|traceback|fatal|could not|cannot|can't|not found|denied|refused|conflict|exit code|✗|×/iu;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The text unchanged, or its first 60% and the rest's tail around an omission marker. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters omitted …]\n${tail > 0 ? text.slice(-tail) : ""}`;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

/** A tool result's first and last lines and its first error or warning lines, with gaps marked. */
export function abbreviateOutput(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= HEAD_LINES + TAIL_LINES + SIGNAL_LINES) return lines.map((l) => clip(l, LINE_MAX)).join("\n");
  const keep = new Set<number>();
  for (let i = 0; i < HEAD_LINES; i++) keep.add(i);
  for (let i = lines.length - TAIL_LINES; i < lines.length; i++) keep.add(i);
  let signals = 0;
  for (let i = 0; i < lines.length && signals < SIGNAL_LINES; i++) {
    if (keep.has(i) || !SIGNAL.test(lines[i] as string)) continue;
    keep.add(i);
    signals++;
  }
  const out: string[] = [];
  let previous = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i - previous > 1) out.push(`[… ${i - previous - 1} lines omitted …]`);
    out.push(clip(lines[i] as string, LINE_MAX));
    previous = i;
  }
  return out.join("\n");
}

const indent = (text: string) => text.split("\n").map((l) => `  ${l}`).join("\n");

/** The outline of LLM messages (the output of `convertToLlm`), within `budget` characters. */
export function outlineOf(messages: readonly unknown[], budget = OUTLINE_BUDGET_CHARS): string {
  const sections: string[] = [];
  for (const raw of messages) {
    if (!isObject(raw)) continue;
    if (raw.role === "user") {
      const text = textOf(raw.content).trim();
      if (text) sections.push(`[user]\n${clipMiddle(text, TEXT_MAX)}`);
    } else if (raw.role === "assistant") {
      const lines: string[] = [];
      const text = textOf(Array.isArray(raw.content) ? raw.content.filter((b) => isObject(b) && b.type === "text") : raw.content).trim();
      if (text) lines.push(clipMiddle(text, TEXT_MAX));
      if (Array.isArray(raw.content)) {
        for (const block of raw.content) {
          if (isObject(block) && block.type === "toolCall") lines.push(`→ ${String(block.name ?? "tool")} ${clip(JSON.stringify(block.arguments ?? {}), ARGS_MAX)}`);
        }
      }
      if (lines.length) sections.push(`[assistant]\n${lines.join("\n")}`);
    } else if (raw.role === "toolResult") {
      const text = textOf(raw.content);
      const header = `← ${typeof raw.toolName === "string" && raw.toolName ? raw.toolName : "tool"}${raw.isError === true ? " (error)" : ""}, ${text.split("\n").length} lines`;
      sections.push(`${header}\n${indent(abbreviateOutput(text))}`);
    }
  }
  const joined = sections.join("\n\n");
  if (joined.length <= budget) return joined;
  const headMax = Math.floor(budget * 0.2);
  const tailMax = Math.floor(budget * 0.8);
  let head = joined.slice(0, headMax);
  const cut = head.lastIndexOf("\n");
  if (cut > 0) head = head.slice(0, cut);
  let tail = joined.slice(-tailMax);
  const next = tail.indexOf("\n");
  if (next >= 0) tail = tail.slice(next + 1);
  return `${head}\n\n[… earlier part of the session omitted …]\n\n${tail}`;
}

export const outlineTokens = (outline: string): number => Math.ceil(outline.length / 4);
