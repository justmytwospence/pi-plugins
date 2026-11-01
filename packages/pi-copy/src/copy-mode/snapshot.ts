// A frozen copy of Pi's fullscreen transcript: every rendered line (not only the visible ones),
// which message or tool call each line belongs to, and where the transcript was scrolled.
//
// Pi's fullscreen layout keeps the transcript in a ScrollView whose child is the document
// container (header, startup notices, chat). Rendering that document at the view's content width
// gives exactly what fullscreen draws, folded output included as folded. The shared capture
// resolves the primary view and its allocated layout width; when unavailable the caller falls
// back to the session's text.
import { stripVTControlCharacters } from "node:util";
import { messageText } from "../transcript.ts";
import { EMPTY_TRANSCRIPT_CONTEXT, type BlockKind, type TranscriptCheckpoint, type TranscriptContext } from "../transcript-contract.ts";
import { indexTranscript } from "../transcript-index.ts";
import { captureTranscript, primaryTranscriptView } from "../transcript-viewport.ts";

export type { BlockKind } from "../transcript-contract.ts";

export interface Block {
  start: number;
  /** Exclusive. */
  end: number;
  kind: BlockKind;
  error: boolean;
  checkpoint?: TranscriptCheckpoint;
}

export interface Snapshot {
  /** Lines as drawn, with ANSI styling. */
  lines: string[];
  /** The same lines without styling: what is searched and copied. */
  plain: string[];
  blocks: Block[];
  /** First transcript line on screen when copy mode opened. */
  scrollTop: number;
  viewportHeight: number;
  /** Scroll Pi's transcript so this line is at the top (fullscreen only). */
  scrollTo?: (row: number) => void;
  /** Built from the session text because the fullscreen transcript was not reachable. */
  fallback: boolean;
}

/** The fullscreen primary transcript, when supported by the host. */
export function findTranscript(tui: unknown) {
  return primaryTranscriptView(tui);
}

/** Render the shared transcript index without filtering copyable blocks. */
export function renderBlocks(root: unknown, width: number, context: TranscriptContext = EMPTY_TRANSCRIPT_CONTEXT): { lines: string[]; blocks: Block[] } {
  return indexTranscript(root, width, context);
}

const strip = (line: string) => stripVTControlCharacters(line).replace(/\s+$/u, "");

/** The fullscreen transcript, or undefined when Pi is not in fullscreen mode. */
export function snapshotTranscript(tui: unknown, _width: number, context: TranscriptContext = EMPTY_TRANSCRIPT_CONTEXT): Snapshot | undefined {
  const capture = captureTranscript(tui, context);
  if (!capture?.lines.length) return undefined;
  return {
    lines: capture.lines,
    plain: capture.lines.map(strip),
    blocks: capture.blocks,
    scrollTop: Math.max(0, Math.min(capture.scrollTop, capture.lines.length - 1)),
    viewportHeight: capture.viewportHeight,
    scrollTo: capture.scrollTo,
    fallback: false,
  };
}

interface EntryLike {
  type?: string;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; command?: string; output?: string; exitCode?: number };
}

/** Plain lines from the session branch, for when the fullscreen transcript is not reachable. */
export function snapshotSession(entries: readonly unknown[], width: number): Snapshot {
  const lines: string[] = [];
  const blocks: Block[] = [];
  const wrap = (text: string) => text.split("\n").flatMap((l) => {
    if (l.length <= width) return [l];
    const out: string[] = [];
    for (let i = 0; i < l.length; i += width) out.push(l.slice(i, i + width));
    return out;
  });
  for (const raw of entries) {
    const e = raw as EntryLike;
    if (e?.type !== "message" || !e.message) continue;
    const m = e.message;
    let kind: BlockKind = "other";
    let error = false;
    let text = messageText(m.content);
    if (m.role === "user") kind = "user";
    else if (m.role === "assistant") kind = "assistant";
    else if (m.role === "toolResult") { kind = "tool"; error = m.isError === true; text = `[${m.toolName ?? "tool"}]\n${text}`; }
    else if (m.role === "bashExecution") { kind = "bash"; error = typeof m.exitCode === "number" && m.exitCode !== 0; text = `$ ${m.command ?? ""}\n${m.output ?? ""}`; }
    if (!text.trim()) continue;
    const start = lines.length;
    lines.push(...wrap(kind === "user" ? `> ${text}` : text), "");
    blocks.push({ start, end: lines.length, kind, error });
  }
  return { lines, plain: lines.map(strip), blocks, scrollTop: Math.max(0, lines.length - 1), viewportHeight: 0, fallback: true };
}
