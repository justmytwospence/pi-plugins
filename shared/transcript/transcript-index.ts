// Canonical: shared/transcript/transcript-index.ts. Sync: node scripts/sync-transcript-helpers.mjs
import { stripVTControlCharacters } from "node:util";
import {
  EMPTY_TRANSCRIPT_CONTEXT, TRANSCRIPT_BLOCK, TRANSCRIPT_ROWS, USER_WORDS_CHANNEL,
  readTranscriptCheckpoint, validCheckpoint,
  type TranscriptBlock, type TranscriptContext, type TranscriptDescription, type TranscriptHooks,
  type TranscriptIndex, type TranscriptOptions, type TranscriptRenderContext,
  type ToolCallView, type UserWordsExtractor, type UserWordsRegistry, type UserWordsRequest,
} from "./transcript-contract.js";

const record = (value: unknown): Record<PropertyKey, any> | undefined => value && typeof value === "object" ? value as Record<PropertyKey, any> : undefined;
const visible = (lines: readonly string[]) => lines.some(line => /\x1b_G|\x1b\]1337;File=/.test(line) || stripVTControlCharacters(line).trim());
const nativeIds = new WeakMap<object, string>();
let nextId = 0;
function nativeId(source: object): string {
  let id = nativeIds.get(source);
  if (!id) { id = `native:${++nextId}`; nativeIds.set(source, id); }
  return id;
}
export function collectUserWords(events: { emit(channel: string, data: unknown): void } | undefined): UserWordsRegistry {
  const result = new Map<string, UserWordsExtractor[]>();
  let accepting = true;
  const request: UserWordsRequest = { version: 1, register(name, extract) {
    if (!accepting || typeof name !== "string" || !name || typeof extract !== "function") return;
    const list = result.get(name) ?? [];
    if (!list.includes(extract)) list.push(extract);
    result.set(name, list);
  } };
  try { events?.emit(USER_WORDS_CHANNEL, request); } catch { /* Optional provider discovery must not break input. */ }
  finally { accepting = false; }
  return result;
}
function userWords(call: ToolCallView, registry: UserWordsRegistry): string | undefined {
  for (const extract of [...(registry.get(call.toolName) ?? []), ...(registry.get("*") ?? [])]) {
    try { const text = extract(call); if (typeof text === "string" && text.trim()) return text; } catch { /* Isolate optional providers. */ }
  }
  return undefined;
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.flatMap(part => part?.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
}

/** Native SDK compatibility reads are structural, never judgments about the prose. */
function nativeDescription(source: Record<PropertyKey, any>, context: TranscriptContext): TranscriptDescription | undefined {
  const name = source.constructor?.name;
  const id = nativeId(source);
  if (name === "UserMessageComponent") return { kind: "user", userText: textOf(source.text), checkpoint: { id, kind: "prompt" } };
  if (name === "SkillInvocationMessageComponent") {
    const skill = source.skillBlock?.name;
    return { kind: "user", ...(typeof skill === "string" && skill.trim() ? { userText: `[skill] ${skill}` } : {}), checkpoint: { id, kind: "prompt" } };
  }
  if (name === "AssistantMessageComponent") {
    const message = source.lastMessage;
    const content: any[] = Array.isArray(message?.content) ? message.content : [];
    const terminal = ["stop", "length", "error", "aborted"].includes(message?.stopReason);
    const text = content.some(part => part?.type === "text" && typeof part.text === "string" && part.text.trim());
    const tools = content.some(part => part?.type === "toolCall");
    return { kind: "assistant", error: ["error", "aborted"].includes(message?.stopReason),
      ...(terminal && text && !tools && source.isStreaming !== true ? { checkpoint: { id, kind: "response" } } : {}) };
  }
  if (name === "ToolExecutionComponent") {
    const result = record(source.result);
    const finished = !!result && source.isPartial !== true;
    const words = finished && typeof source.toolName === "string" ? userWords({ toolName: source.toolName,
      toolCallId: source.toolCallId, args: source.args, result }, context.userWords) : undefined;
    return { kind: "tool", error: result?.isError === true,
      checkpoint: words ? { id: `feedback:${source.toolCallId ?? id}`, kind: "feedback" } : finished ? readTranscriptCheckpoint(result?.details) : undefined,
      ...(words ? { userText: words } : {}) };
  }
  if (name === "CustomMessageComponent") return { kind: "other", checkpoint: source.message?.display === false ? undefined : readTranscriptCheckpoint(source.message?.details) };
  if (name === "BashExecutionComponent") return { kind: "bash", error: source.status === "error" || source.status === "cancelled",
    ...(["complete", "error", "cancelled"].includes(source.status) ? { checkpoint: { id, kind: "shell" } } : {}) };
  if (name === "CompactionSummaryMessageComponent" || name === "BranchSummaryMessageComponent") return { kind: "other", checkpoint: { id, kind: "summary" } };
  return undefined;
}

export function describeTranscriptComponent(component: unknown, context: TranscriptContext & TranscriptRenderContext,
  options: TranscriptOptions = {}, seen = new Set<object>(), depth = 0): TranscriptDescription | undefined {
  const node = record(component);
  if (!node || seen.has(node) || depth > 32 || seen.size >= 10_000) return undefined;
  seen.add(node);
  let description: TranscriptDescription | undefined;
  try {
    description = options.describe?.(component);
    if (!description && typeof node[TRANSCRIPT_BLOCK] === "function") description = (node as TranscriptHooks)[TRANSCRIPT_BLOCK]?.({ width: context.width, lines: context.lines });
    description ??= nativeDescription(node, context);
  } catch { return undefined; }
  if (!description || typeof description !== "object") return undefined;
  const checkpoint = validCheckpoint(description.checkpoint) ? { ...description.checkpoint } : undefined;
  const result: TranscriptDescription = {
    kind: ["user", "assistant", "tool", "bash", "other"].includes(description.kind ?? "") ? description.kind : "other",
    error: description.error === true,
    ...(typeof description.userText === "string" && description.userText.trim() ? { userText: description.userText } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  };
  if (Array.isArray(description.subjects)) {
    for (const subject of description.subjects) {
      const child = describeTranscriptComponent(subject, context, options, seen, depth + 1);
      if (!child) continue;
      result.error ||= child.error;
      if (!result.checkpoint && child.checkpoint) result.checkpoint = child.checkpoint;
      if (child.userText) { result.userText = child.userText; result.checkpoint = child.checkpoint ?? result.checkpoint; }
    }
  }
  return result;
}

export function spliceTranscriptRows(index: TranscriptIndex, start: number, deleteCount: number, insertLines: readonly string[]): TranscriptIndex {
  if (!Number.isInteger(start) || !Number.isInteger(deleteCount) || start < 0 || deleteCount < 0 || start + deleteCount > index.lines.length) throw new TypeError("Invalid transcript row splice");
  const end = start + deleteCount, delta = insertLines.length - deleteCount;
  const mapStart = (row: number) => row < start ? row : row >= end ? row + delta : start + insertLines.length;
  const mapEnd = (row: number) => row <= start ? row : row >= end ? row + delta : start;
  return { lines: [...index.lines.slice(0, start), ...insertLines, ...index.lines.slice(end)],
    blocks: index.blocks.map(block => ({ ...block, start: mapStart(block.start), end: mapEnd(block.end) })).filter(block => block.end > block.start),
    horizons: index.horizons.map(mapEnd) };
}
const equalLines = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, i) => line === b[i]);
function validIndex(index: TranscriptIndex, lines: readonly string[]): boolean {
  return !!index && Array.isArray(index.lines) && equalLines(index.lines, lines) && Array.isArray(index.blocks) && Array.isArray(index.horizons)
    && index.blocks.every(block => Number.isInteger(block.start) && Number.isInteger(block.end) && block.start >= 0 && block.end <= lines.length && block.end > block.start && !!record(block.source)
      && (block.checkpoint === undefined || validCheckpoint(block.checkpoint)))
    && index.horizons.every(row => Number.isInteger(row) && row >= 0 && row <= lines.length);
}
function append(to: TranscriptIndex, from: TranscriptIndex): void {
  const offset = to.lines.length;
  for (const line of from.lines) to.lines.push(line);
  to.blocks.push(...from.blocks.map(block => ({ ...block, start: block.start + offset, end: block.end + offset })));
  to.horizons.push(...from.horizons.map(row => row + offset));
}
/*
 * Indexing runs on every frame for some consumers, so unchanged subtrees are reused. Memoized
 * results are shared and must never be mutated: row hooks receive fresh, unmemoized indexes, and
 * indexTranscript returns copies. A leaf is reused only when it renders the same rows and gets the
 * same description; a container only when it has the same children with the same reused results.
 */
type LeafMemo = { lines: readonly string[]; description: TranscriptDescription | undefined; result: TranscriptIndex };
type ContainerMemo = { children: readonly unknown[]; results: readonly TranscriptIndex[]; result: TranscriptIndex };
const MEMO_WIDTHS = 4;
const leafMemos = new WeakMap<object, Map<number, LeafMemo>>();
const containerMemos = new WeakMap<object, Map<number, ContainerMemo>>();
const finalIndexes = new WeakMap<TranscriptIndex, TranscriptIndex>();
/** Container prototypes whose render was observed to concatenate their children, by that render function. */
const concatenatingRenders = new WeakMap<object, unknown>();
function memoFor<T>(memos: WeakMap<object, Map<number, T>>, node: object, width: number): T | undefined {
  return memos.get(node)?.get(width);
}
function remember<T>(memos: WeakMap<object, Map<number, T>>, node: object, width: number, value: T): void {
  let byWidth = memos.get(node);
  if (!byWidth) memos.set(node, byWidth = new Map());
  byWidth.delete(width);
  byWidth.set(width, value);
  if (byWidth.size > MEMO_WIDTHS) byWidth.delete(byWidth.keys().next().value!);
}
const sameDescription = (a: TranscriptDescription | undefined, b: TranscriptDescription | undefined) => a === b || !!a && !!b
  && a.kind === b.kind && a.error === b.error && a.userText === b.userText
  && a.checkpoint?.id === b.checkpoint?.id && a.checkpoint?.kind === b.checkpoint?.kind;
const plainContainer = (node: Record<PropertyKey, any>) => node.constructor?.name === "Container" && Array.isArray(node.children)
  && !Object.hasOwn(node, "render") && typeof node[TRANSCRIPT_BLOCK] !== "function" && typeof node[TRANSCRIPT_ROWS] !== "function";
/** Pi's Container renders exactly its children's rows; once a prototype has shown that, skip its own render. */
const concatenates = (node: Record<PropertyKey, any>, options: TranscriptOptions) => !options.describe && plainContainer(node)
  && concatenatingRenders.get(Object.getPrototypeOf(node)) === node.render;

export function indexTranscript(root: unknown, width: number, context: TranscriptContext = EMPTY_TRANSCRIPT_CONTEXT, options: TranscriptOptions = {}): TranscriptIndex {
  const active = new Set<object>();
  let visited = 0;
  const children = (nodes: readonly unknown[], w: number, depth: number, memo = false): TranscriptIndex => {
    const out: TranscriptIndex = { lines: [], blocks: [], horizons: [] };
    for (const child of nodes) append(out, visit(child, w, depth + 1, memo));
    return out;
  };
  const visit = (value: unknown, w: number, depth: number, memo: boolean): TranscriptIndex => {
    const node = record(value);
    if (!node || typeof node.render !== "function") throw new TypeError("Unrenderable transcript node");
    if (active.has(node) || depth > 32 || ++visited > 10_000) throw new TypeError("Transcript tree limit");
    active.add(node);
    try {
      if (concatenates(node, options)) {
        const nodes: readonly unknown[] = [...node.children];
        if (!memo) return children(nodes, w, depth);
        const results = nodes.map(child => visit(child, w, depth + 1, true));
        const previous = memoFor(containerMemos, node, w);
        if (previous && previous.children.length === nodes.length
          && nodes.every((child, i) => child === previous.children[i] && results[i] === previous.results[i])) return previous.result;
        const result: TranscriptIndex = { lines: [], blocks: [], horizons: [] };
        for (const part of results) append(result, part);
        remember(containerMemos, node, w, { children: nodes, results, result });
        return result;
      }
      const rendered = node.render(w);
      if (!Array.isArray(rendered) || !rendered.every(line => typeof line === "string")) throw new TypeError("Invalid transcript render");
      const lines = [...rendered];
      if (typeof node[TRANSCRIPT_ROWS] === "function") {
        // Geometry may move existing descriptions, not invent or rewrite checkpoint membership.
        const allowed = new Map<object, Set<string>>();
        const signature = (block: { kind?: string; error?: boolean; userText?: string; checkpoint?: { id: string; kind: string } }) =>
          JSON.stringify([block.kind ?? "other", block.error === true, block.userText, block.checkpoint?.id, block.checkpoint?.kind]);
        const permit = (index: TranscriptIndex) => {
          for (const block of index.blocks) {
            const signatures = allowed.get(block.source) ?? new Set<string>();
            signatures.add(signature(block));
            allowed.set(block.source, signatures);
          }
          return index;
        };
        const own = describeTranscriptComponent(node, { ...context, width: w, lines }, options);
        if (own) allowed.set(node, new Set([signature(own)]));
        try {
          const mapped = (node as TranscriptHooks)[TRANSCRIPT_ROWS]?.({ width: w, lines,
            index: (nodes, childWidth) => permit(children(nodes, childWidth, depth, false)), splice: spliceTranscriptRows });
          if (mapped && validIndex(mapped, lines) && mapped.blocks.every(block => allowed.get(block.source)?.has(signature(block)))) return mapped;
        } catch { /* An unsupported transform stays opaque. */ }
        return { lines, blocks: [], horizons: [] };
      }
      const description = describeTranscriptComponent(node, { ...context, width: w, lines }, options);
      if (!description && node.constructor?.name === "Container" && Array.isArray(node.children)) {
        // Unmemoized: the first render of a container decides whether its prototype can be trusted.
        const composed = children(node.children, w, depth);
        if (!equalLines(composed.lines, lines)) return { lines, blocks: [], horizons: [] };
        if (plainContainer(node)) concatenatingRenders.set(Object.getPrototypeOf(node), node.render);
        return composed;
      }
      const previous = memo ? memoFor(leafMemos, node, w) : undefined;
      if (previous && equalLines(previous.lines, lines) && sameDescription(previous.description, description)) return previous.result;
      const hasContent = visible(lines);
      const result: TranscriptIndex = { lines, horizons: [], blocks: lines.length ? [{ start: 0, end: lines.length, source: node,
        kind: description?.kind ?? "other", error: description?.error === true,
        ...(description?.userText && hasContent ? { userText: description.userText } : {}),
        ...(description?.checkpoint && hasContent ? { checkpoint: description.checkpoint } : {}) }] : [] };
      if (memo) remember(leafMemos, node, w, { lines, description, result });
      return result;
    } finally { active.delete(node); }
  };
  if (!Number.isFinite(width) || width < 1) throw new TypeError("Invalid transcript width");
  const index = visit(root, Math.floor(width), 0, true);
  let final = finalIndexes.get(index);
  if (!final) {
    final = { lines: index.lines, blocks: index.blocks.map(block => ({ ...block })), horizons: index.horizons };
    let previous: string | undefined;
    for (const block of final.blocks) {
      const shown = visible(final.lines.slice(block.start, block.end));
      if (!shown) { delete block.checkpoint; delete block.userText; }
      const id = block.checkpoint?.id;
      if (id && id === previous) delete block.checkpoint;
      if (shown) previous = id;
    }
    finalIndexes.set(index, final);
  }
  return { lines: [...final.lines], blocks: final.blocks.map(block => ({ ...block })), horizons: [...final.horizons] };
}
export function indexTranscriptChildren(children: readonly unknown[], width: number, context: TranscriptContext = EMPTY_TRANSCRIPT_CONTEXT, options: TranscriptOptions = {}): TranscriptIndex {
  // This synthetic plain Container has exactly concatenating render semantics.
  const root = new class Container {
    readonly children: readonly unknown[];
    constructor(children: readonly unknown[]) { this.children = children; }
    render(w: number): string[] { return this.children.flatMap(child => (child as { render(w: number): string[] }).render(w)); }
  }(children);
  return indexTranscript(root, width, context, options);
}
export function selectCheckpoint(index: TranscriptIndex, scrollTop: number, viewportHeight: number, direction: -1 | 1): number | undefined {
  const max = Math.max(0, index.lines.length - viewportHeight);
  const targets = [...new Set(index.blocks.filter(block => block.checkpoint).map(block => Math.max(0, Math.min(max, block.start - 1))))].sort((a, b) => a - b);
  return direction < 0 ? targets.filter(row => row < scrollTop).at(-1) : targets.find(row => row > scrollTop);
}
