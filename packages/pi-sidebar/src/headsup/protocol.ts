// A heads-up check's reply: <headsup-none/>, or one note with its explanation. Anything else
// (prose, a tool call, a malformed block) counts as no note.

export const HEADSUP_KINDS = ["tradeoff", "suspect-result", "risk", "context", "share"] as const;
export type HeadsUpKind = (typeof HEADSUP_KINDS)[number];

/** What a share note suits: a short social post, a blog post, or either. */
export type ShareFormat = "post" | "blog" | "both";
const SHARE_FORMATS: readonly ShareFormat[] = ["post", "blog", "both"];

export interface HeadsUpNote {
  topic: string;
  kind: HeadsUpKind;
  text: string;
  detail: string;
  /** Share notes: what the idea suits. */
  format?: ShareFormat;
  /** Share notes: a drafted social post (at most MAX_POST_GRAPHEMES). */
  post?: string;
}

/** Bluesky's limit on a post's length, in graphemes. */
export const MAX_POST_GRAPHEMES = 300;

export const MAX_NOTE_CHARS = 200;
const MAX_DETAIL_CHARS = 2000;

const NOTE = /<headsup\b([^>]*)>([\s\S]*?)<\/headsup>/;
const DETAIL = /<headsup-detail>([\s\S]*?)<\/headsup-detail>/;
const POST = /<headsup-post>([\s\S]*?)<\/headsup-post>/;

/** The graphemes of a text (what Bluesky counts). */
export function graphemes(text: string): string[] {
  return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
}

/** A post's text kept within Bluesky's limit (line breaks kept, ends trimmed). */
export function fitPost(text: string): string {
  const trimmed = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const parts = graphemes(trimmed);
  return parts.length > MAX_POST_GRAPHEMES ? `${parts.slice(0, MAX_POST_GRAPHEMES - 1).join("").trimEnd()}…` : trimmed;
}

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
  const parsed: HeadsUpNote = {
    topic: topicId(attribute(note[1] ?? "", "topic"), body),
    kind,
    text: body.length > MAX_NOTE_CHARS ? `${body.slice(0, MAX_NOTE_CHARS - 1)}…` : body,
    detail: detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS - 1)}…` : detail,
  };
  if (kind !== "share") return parsed;
  const formatRaw = attribute(note[1] ?? "", "format");
  const post = fitPost(POST.exec(text)?.[1] ?? "");
  const format = (SHARE_FORMATS as readonly string[]).includes(formatRaw ?? "") ? (formatRaw as ShareFormat) : post ? "both" : "blog";
  return { ...parsed, format, ...(post ? { post } : {}) };
}

/** The text and tool-call count of a pi-ai assistant message. */
export function replyOf(message: { content?: unknown }): { text: string; toolCalls: number } {
  const blocks = Array.isArray(message.content) ? (message.content as Array<{ type?: string; text?: string }>) : [];
  return {
    text: blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n"),
    toolCalls: blocks.filter((b) => b.type === "toolCall").length,
  };
}
