import { MAX_PAGE, type Coverage, type TranscriptPage, type TranscriptQuery, type TranscriptRecord } from "./protocol.ts";

const TOOL_CHARS = 4000;
export const MAX_ARCHIVE_CHARS = 512 * 1024;
const clip = (s: string, max: number) => s.length > max ? `${s.slice(0, max)}\n[omitted ${s.length - max} characters]` : s;
/** Allowlist projection: never serialize provider metadata, images, details or payloads. */
export function projectTranscript(messages: readonly unknown[]): { text: string; coverage: Coverage } {
  const lines: string[] = [];
  let partial = false;
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    if (typeof m.role !== "string" || m.role === "system") continue;
    const parts: string[] = [];
    if (typeof m.content === "string") parts.push(m.content);
    if (Array.isArray(m.content)) for (const rawBlock of m.content) {
      const b = rawBlock as Record<string, unknown> | null;
      if (!b) continue;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
      else if (b.type === "toolCall" && typeof b.name === "string") parts.push(`[tool call: ${b.name}]`);
      else if (b.type === "image") { parts.push("[image omitted]"); partial = true; }
      else { parts.push("[non-text content omitted]"); partial = true; }
    }
    if (typeof m.summary === "string") { parts.push(m.summary); partial = true; }
    if (m.role === "bashExecution" && typeof m.output === "string") parts.push(m.output);
    let text = parts.join("\n");
    if (m.role === "toolResult" || m.role === "bashExecution") {
      if (text.length > TOOL_CHARS) partial = true;
      text = clip(text, TOOL_CHARS);
    }
    if (text) lines.push(`${m.role}:\n${text}`);
  }
  let text = lines.join("\n\n");
  if (text.length > MAX_ARCHIVE_CHARS) { text = clip(text, MAX_ARCHIVE_CHARS); partial = true; }
  while (Buffer.byteLength(JSON.stringify(text)) > MAX_ARCHIVE_CHARS) { text = `${text.slice(0, Math.floor(text.length * 0.8))}\n[archive remainder omitted]`; partial = true; }
  return { text, coverage: partial ? "partial" : "complete" };
}
export function transcriptPage(query: TranscriptQuery, record: TranscriptRecord | undefined): TranscriptPage {
  const unavailable = (reason: string): TranscriptPage => ({ agentId: query.agentId, revision: record?.revision ?? 0, coverage: "unavailable", text: "", unavailable: reason });
  if (!record) return unavailable("Transcript unavailable");
  if (query.revision !== undefined && query.revision !== record.revision) return unavailable("Transcript revision is no longer available");
  let offset = 0;
  if (query.cursor !== undefined) {
    const match = /^(\d+):(\d+)$/.exec(query.cursor);
    if (!match || Number(match[1]) !== record.revision || !Number.isSafeInteger(Number(match[2]))) return unavailable("Invalid or stale transcript cursor");
    offset = Number(match[2]);
    if (offset > record.text.length) return unavailable("Invalid transcript cursor");
  }
  if (query.limitChars !== undefined && (!Number.isSafeInteger(query.limitChars) || query.limitChars < 1)) return unavailable("Invalid transcript page limit");
  const limit = Math.min(query.limitChars ?? 32768, MAX_PAGE - 2048);
  let text = record.text.slice(offset, offset + limit);
  // Both character and UTF-8 byte limits apply, including non-ASCII transcripts.
  while (Buffer.byteLength(JSON.stringify(text)) > MAX_PAGE - 2048) text = text.slice(0, Math.max(1, Math.floor(text.length * 0.8)));
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  const end = offset + text.length;
  return { agentId: query.agentId, revision: record.revision, coverage: record.coverage, text, ...(end < record.text.length ? { nextCursor: `${record.revision}:${end}` } : {}) };
}
