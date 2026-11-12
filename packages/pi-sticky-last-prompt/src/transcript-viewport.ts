// Canonical: shared/transcript/transcript-viewport.ts. Sync: node scripts/sync-transcript-helpers.mjs
import { EMPTY_TRANSCRIPT_CONTEXT, type TranscriptContext, type TranscriptIndex } from "./transcript-contract.js";
import { indexTranscript, selectCheckpoint } from "./transcript-index.js";

export interface TranscriptView {
  children?: readonly unknown[];
  child?: unknown;
  scrollTop: number;
  viewportHeight: number;
  scrollTo(row: number, options?: { disableFollow?: boolean }): void;
  getContentWidth(width: number): number;
}
type Box = { component?: unknown; rect?: { width?: number }; children?: readonly Box[]; scrollContentLines?: readonly string[] };
type Host = {
  mode?: string;
  getPrimaryScrollView?: () => unknown;
  currentLayout?: { root?: Box };
  requestRender?: () => void;
};
export interface TranscriptCapture extends TranscriptIndex {
  view: TranscriptView;
  document: object;
  width: number;
  scrollTop: number;
  viewportHeight: number;
  scrollTo(row: number): void;
}
export function isTranscriptView(value: unknown): value is TranscriptView {
  const view = value as Partial<TranscriptView> | undefined;
  return !!view && Number.isFinite(view.scrollTop) && Number.isFinite(view.viewportHeight)
    && typeof view.scrollTo === "function" && typeof view.getContentWidth === "function";
}
export function transcriptDocument(view: TranscriptView): object | undefined {
  const doc = view.children?.[0] ?? view.child;
  return doc && typeof doc === "object" && typeof (doc as { render?: unknown }).render === "function" ? doc : undefined;
}
/** Private host geometry is deliberately isolated here; no new layout is performed. */
function transcriptViewBox(tui: unknown, view: TranscriptView): Box | undefined {
  const host = tui as Host | undefined;
  const pending: Box[] = host?.currentLayout?.root ? [host.currentLayout.root] : [];
  const seen = new Set<Box>();
  const matches: Box[] = [];
  while (pending.length && seen.size < 10_000) {
    const box = pending.pop()!;
    if (seen.has(box)) continue;
    seen.add(box);
    if (box.component === view && typeof box.rect?.width === "number" && box.rect.width > 0) matches.push(box);
    if (Array.isArray(box.children)) pending.push(...box.children);
  }
  return matches.length === 1 ? matches[0] : undefined;
}
export function transcriptViewWidth(tui: unknown, view: TranscriptView): number | undefined {
  const width = transcriptViewBox(tui, view)?.rect?.width;
  return width === undefined ? undefined : Math.floor(width);
}
export function primaryTranscriptView(tui: unknown): TranscriptView | undefined {
  const host = tui as Host | undefined;
  if (!host || host.mode === "regular") return undefined;
  try { const view = host.getPrimaryScrollView?.(); return isTranscriptView(view) ? view : undefined; }
  catch { return undefined; }
}
export function captureTranscriptView(view: TranscriptView, boxWidth: number, context: TranscriptContext = EMPTY_TRANSCRIPT_CONTEXT,
  requestRender: () => void = () => {}, validate: () => boolean = () => true): TranscriptCapture | undefined {
  try {
    const document = transcriptDocument(view);
    const width = view.getContentWidth(boxWidth);
    if (!document || !Number.isFinite(width) || width < 1) return undefined;
    const index = indexTranscript(document, Math.floor(width), context);
    const savedLines = [...index.lines];
    return { ...index, view, document, width, scrollTop: view.scrollTop, viewportHeight: view.viewportHeight,
      scrollTo(row) {
        try {
          if (!Number.isFinite(row) || !validate() || transcriptDocument(view) !== document || view.getContentWidth(boxWidth) !== width) return;
          const current = indexTranscript(document, Math.floor(width), context);
          if (current.lines.length !== savedLines.length || current.lines.some((line, i) => line !== savedLines[i])) return;
          view.scrollTo(Math.max(0, Math.floor(row)), { disableFollow: true });
          requestRender();
        } catch { /* A frozen selection cannot scroll a changed document. */ }
      } };
  } catch { return undefined; }
}
export function captureTranscript(tui: unknown, context: TranscriptContext = EMPTY_TRANSCRIPT_CONTEXT): TranscriptCapture | undefined {
  const view = primaryTranscriptView(tui);
  if (!view) return undefined;
  const width = transcriptViewWidth(tui, view);
  if (width === undefined) return undefined;
  const host = tui as Host;
  const layoutLines = transcriptViewBox(tui, view)?.scrollContentLines;
  if (!Array.isArray(layoutLines)) return undefined;
  const capture: TranscriptCapture | undefined = captureTranscriptView(view, width, context, () => host.requestRender?.(),
    () => primaryTranscriptView(tui) === view && transcriptViewWidth(tui, view) === width
      && transcriptViewBox(tui, view)?.scrollContentLines?.length === capture?.lines.length);
  // ScrollView clamps and suppresses follow against its last layout, not a fresh render.
  // Do not move against stale content height; let the normal frame catch up first.
  if (capture && capture.lines.length !== layoutLines.length) { host.requestRender?.(); return undefined; }
  return capture;
}
/**
 * The row a checkpoint jump left at the top of a transcript view, recorded on the view itself so
 * any copy of these helpers can see it. pi-sticky-last-prompt leaves its bar blank while the view
 * still sits on that row: a jump lands on a clean view, and any other scroll brings the bar back.
 */
const CHECKPOINT_LANDING = Symbol.for("pi-plugins.transcript.checkpoint-landing");
export function checkpointLanding(view: TranscriptView): number | undefined {
  const row = (view as { [CHECKPOINT_LANDING]?: unknown })[CHECKPOINT_LANDING];
  return typeof row === "number" ? row : undefined;
}
export function clearCheckpointLanding(view: TranscriptView): void {
  try { delete (view as { [CHECKPOINT_LANDING]?: unknown })[CHECKPOINT_LANDING]; } catch { /* Frozen view. */ }
}
function markCheckpointLanding(view: TranscriptView, row: number | undefined): void {
  try {
    if (row === undefined) clearCheckpointLanding(view);
    else Object.defineProperty(view, CHECKPOINT_LANDING, { value: row, writable: true, configurable: true, enumerable: false });
  } catch { /* A sealed view just keeps the bar. */ }
}
export function scrollToCheckpoint(tui: unknown, context: TranscriptContext, direction: -1 | 1): void {
  const capture = captureTranscript(tui, context);
  if (!capture) return;
  const target = selectCheckpoint(capture, capture.scrollTop, capture.viewportHeight, direction);
  if (target === undefined) {
    // Past the last checkpoint, Ctrl+D goes to the end and resumes following new output.
    const end = Math.max(0, capture.lines.length - capture.viewportHeight);
    if (direction < 0) return;
    capture.view.scrollTo(end);
    markCheckpointLanding(capture.view, undefined);
  } else {
    capture.view.scrollTo(target, { disableFollow: true });
    markCheckpointLanding(capture.view, capture.view.scrollTop);
  }
  (tui as Host).requestRender?.();
}
