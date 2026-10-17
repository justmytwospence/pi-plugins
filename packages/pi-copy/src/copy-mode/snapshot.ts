// A frozen copy of Pi's fullscreen transcript: every rendered line (not only the visible ones),
// which message or tool call each line belongs to, and where the transcript was scrolled.
//
// Pi's fullscreen layout keeps the transcript in a ScrollView whose child is the document
// container (header, startup notices, chat). Rendering that document at the view's content width
// gives exactly what fullscreen draws, folded output included as folded. The structure is found
// by duck typing; when it is not there (regular mode, an older Pi) the caller falls back to the
// session's text.
import { stripVTControlCharacters } from "node:util";
import { messageText } from "../transcript.ts";

export type BlockKind = "user" | "assistant" | "tool" | "bash" | "other";

export interface Block {
  start: number;
  /** Exclusive. */
  end: number;
  kind: BlockKind;
  error: boolean;
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

interface Node {
  children?: unknown[];
  render?: (width: number) => string[];
  constructor?: { name?: string };
  [key: string]: unknown;
}

interface ScrollViewLike extends Node {
  scrollTop: number;
  viewportHeight: number;
  scrollTo(row: number, options?: { disableFollow?: boolean }): void;
  getContentWidth(width: number): number;
}

const isScrollView = (n: unknown): n is ScrollViewLike =>
  !!n && typeof n === "object" && typeof (n as ScrollViewLike).scrollTo === "function" && typeof (n as ScrollViewLike).getContentWidth === "function" && typeof (n as ScrollViewLike).scrollTop === "number";

/** The transcript's ScrollView: Pi's primary scroll view, else the first primary one in the layout tree. */
export function findTranscript(tui: unknown): ScrollViewLike | undefined {
  const t = tui as { getPrimaryScrollView?: () => unknown; layoutRoot?: unknown } | undefined;
  try {
    const primary = t?.getPrimaryScrollView?.();
    if (isScrollView(primary)) return primary;
  } catch {
    // Not a fullscreen TUI.
  }
  const seen = new Set<unknown>();
  const walk = (n: unknown, depth: number): ScrollViewLike | undefined => {
    if (!n || typeof n !== "object" || seen.has(n) || depth > 8) return undefined;
    seen.add(n);
    if (isScrollView(n) && (n as { primary?: boolean }).primary !== false) return n;
    const node = n as { children?: unknown[]; entries?: Array<{ component?: unknown }> };
    for (const child of [...(node.children ?? []), ...(node.entries ?? []).map((e) => e?.component)]) {
      const found = walk(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return walk(t?.layoutRoot, 0);
}

const KIND_BY_NAME: Record<string, BlockKind> = {
  UserMessageComponent: "user",
  AssistantMessageComponent: "assistant",
  ToolExecutionComponent: "tool",
  BashExecutionComponent: "bash",
};

function kindOf(n: Node): { kind: BlockKind; error: boolean } | undefined {
  const name = n.constructor?.name ?? "";
  const kind = KIND_BY_NAME[name];
  if (!kind) return undefined;
  let error = false;
  if (kind === "tool") error = (n.result as { isError?: boolean } | undefined)?.isError === true;
  if (kind === "bash") error = typeof n.exitCode === "number" && n.exitCode !== 0;
  return { kind, error };
}

/**
 * Render a component tree into lines, recording a block for each message-level component.
 * A plain container's lines are its children's lines in order (pi-tui's Container), so children
 * are rendered one by one and their ranges are exact.
 */
export function renderBlocks(root: Node, width: number): { lines: string[]; blocks: Block[] } {
  const lines: string[] = [];
  const blocks: Block[] = [];
  const visit = (n: Node, depth: number) => {
    const known = kindOf(n);
    const plainContainer = !known && Array.isArray(n.children) && n.constructor?.name === "Container" && depth < 6;
    if (plainContainer) {
      for (const child of n.children as Node[]) visit(child, depth + 1);
      return;
    }
    const start = lines.length;
    const rendered = typeof n.render === "function" ? n.render(width) : [];
    for (const line of rendered) lines.push(line);
    if (known && rendered.length) blocks.push({ start, end: lines.length, ...known });
  };
  visit(root, 0);
  return { lines, blocks };
}

const strip = (line: string) => stripVTControlCharacters(line).replace(/\s+$/u, "");

/** The fullscreen transcript, or undefined when Pi is not in fullscreen mode. */
export function snapshotTranscript(tui: unknown, width: number): Snapshot | undefined {
  const view = findTranscript(tui);
  if (!view) return undefined;
  const doc = (view as unknown as { child?: Node }).child;
  const contentWidth = Math.max(1, view.getContentWidth(width));
  let lines: string[];
  let blocks: Block[] = [];
  if (doc && typeof doc.render === "function") ({ lines, blocks } = renderBlocks(doc, contentWidth));
  else lines = typeof view.render === "function" ? view.render(width) : [];
  if (!lines.length) return undefined;
  return {
    lines,
    plain: lines.map(strip),
    blocks,
    scrollTop: Math.max(0, Math.min(view.scrollTop, lines.length - 1)),
    viewportHeight: view.viewportHeight,
    scrollTo: (row) => view.scrollTo(row, { disableFollow: true }),
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
