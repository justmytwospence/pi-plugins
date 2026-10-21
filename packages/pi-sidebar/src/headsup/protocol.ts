// A heads-up check's reply: <headsup-none/>, or one note with its explanation. Anything else
// (prose, a tool call, a malformed block) counts as no note.

export const HEADSUP_KINDS = ["tradeoff", "suspect-result", "risk", "context"] as const;
export type HeadsUpKind = (typeof HEADSUP_KINDS)[number];

export interface HeadsUpNote {
  topic: string;
  kind: HeadsUpKind;
  text: string;
  detail: string;
}

export const MAX_NOTE_CHARS = 200;
const MAX_DETAIL_CHARS = 2000;

const NOTE = /<headsup\b([^>]*)>([\s\S]*?)<\/headsup>/;
const DETAIL = /<headsup-detail>([\s\S]*?)<\/headsup-detail>/;

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return match?.[1];
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function topicId(raw: string | undefined, text: string): string {
  const base = (raw ?? text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base.slice(0, 60) || "note";
}

/** The note in a check's reply, or undefined for none (or anything unreadable). */
export function parseHeadsUp(reply: { text: string; toolCalls?: number }): HeadsUpNote | undefined {
  if ((reply.toolCalls ?? 0) > 0) return undefined;
  const text = reply.text;
  if (!text || /<headsup-none\s*\/?>/.test(text)) return undefined;
  const note = NOTE.exec(text);
  if (!note) return undefined;
  const body = clean(note[2] ?? "");
  if (!body) return undefined;
  const kindRaw = attribute(note[1] ?? "", "kind");
  const kind = (HEADSUP_KINDS as readonly string[]).includes(kindRaw ?? "") ? (kindRaw as HeadsUpKind) : "context";
  const detail = clean(DETAIL.exec(text)?.[1] ?? "");
  return {
    topic: topicId(attribute(note[1] ?? "", "topic"), body),
    kind,
    text: body.length > MAX_NOTE_CHARS ? `${body.slice(0, MAX_NOTE_CHARS - 1)}…` : body,
    detail: detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…` : detail,
  };
}

/** The text and tool-call count of a pi-ai assistant message. */
export function replyOf(message: { content?: unknown }): { text: string; toolCalls: number } {
  const blocks = Array.isArray(message.content) ? (message.content as Array<{ type?: string; text?: string }>) : [];
  return {
    text: blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n"),
    toolCalls: blocks.filter((b) => b.type === "toolCall").length,
  };
}
