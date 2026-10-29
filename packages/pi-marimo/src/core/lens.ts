// marimo-lens selections, read from the stream pi-marimo already follows.
//
// Lens (https://marimo-team.github.io/marimo-lens/) is an anywidget whose Python model
// owns a synced `_state` trait: {revision, nextLabel, currentSelectionId, selections,
// history}. marimo sends widget state to every frontend as `model-lifecycle` messages
// (open, update, close) and replays the open state to consumers that join later, so a
// kiosk consumer sees every selection without running anything in the kernel. Image
// bytes never travel in the trait; activity and reveals are ephemeral custom messages
// and are ignored.

import { truncate } from "./notebook.js";

export interface LensSelection {
  id: string;
  /** `S<n>`, never reused within one Lens. */
  label: string;
  note: string;
  /** Producing cell ids. */
  cells: string[];
  /** "notebook" | "dom" */
  targetKind: string;
  /** What the person pointed at: target description or the text under the mark. */
  what?: string;
  /** "point" | "rect" */
  anchor?: string;
  /** "pending" | "available" | "outdated" | "failed" */
  image?: string;
  /** Reopened after an earlier resolution with this summary. */
  previous?: string;
}

export interface LensReceipt {
  id: string;
  label: string;
  note: string;
  cells: string[];
  summary?: string;
  addressedAt?: string;
}

export interface LensState {
  revision: number;
  /** The label the next new selection must take (`S4`). */
  nextLabel: string;
  current?: string;
  selections: LensSelection[];
  history: LensReceipt[];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

function targetCells(target: Record<string, unknown>): string[] {
  return strings(target.cellIds ?? target.cell_ids);
}

function what(selection: Record<string, unknown>): string | undefined {
  const description = record(selection.description);
  const hint = record(selection.domHint);
  const parts = [str(description.label), str(description.detail), str(hint.ariaLabel) ?? str(hint.title) ?? str(hint.text)]
    .map((p) => p?.replace(/\s+/g, " ").trim())
    .filter((p): p is string => !!p);
  const unique = [...new Set(parts)];
  return unique.length ? truncate(unique.join(" · "), 120) : undefined;
}

function parseSelection(raw: unknown): LensSelection | undefined {
  const s = record(raw);
  const id = str(s.id);
  const label = str(s.label);
  if (!id || !label) return undefined;
  const target = record(s.target);
  const previous = record(s.previousResolution);
  return {
    id,
    label,
    note: str(s.note) ?? "",
    cells: targetCells(target),
    targetKind: str(target.kind) ?? "notebook",
    what: what(s),
    anchor: str(record(s.anchor).kind),
    image: str(record(s.snapshot).status),
    previous: str(previous.summary) ?? (str(previous.addressedAt) ? "" : undefined),
  };
}

function parseReceipt(raw: unknown): LensReceipt | undefined {
  const r = record(raw);
  const id = str(r.selectionId) ?? str(r.id);
  const label = str(r.label);
  if (!id || !label) return undefined;
  return { id, label, note: str(r.note) ?? "", cells: targetCells(record(r.target)), summary: str(r.summary), addressedAt: str(r.addressedAt) };
}

/** A Lens `_state` payload, or undefined when it does not look like one. */
export function parseLensState(raw: unknown): LensState | undefined {
  const s = record(raw);
  if (typeof s.revision !== "number" || !Array.isArray(s.selections)) return undefined;
  const selections = s.selections.map(parseSelection).filter((x): x is LensSelection => !!x);
  const history = (Array.isArray(s.history) ? s.history : []).map(parseReceipt).filter((x): x is LensReceipt => !!x);
  const current = str(s.currentSelectionId);
  return { revision: s.revision, nextLabel: str(s.nextLabel) ?? "S1", current: current && selections.some((x) => x.id === current) ? current : undefined, selections, history };
}

/** marimo-lens 0.2.3's `marimo-lens.command` protocol; a Lens on another version answers with an error, which the view shows. */
export const LENS_PROTOCOL_VERSION = 6;
/** Request ids pi-marimo sends start with this, so their answers can be told apart. */
export const LENS_REQUEST_PREFIX = "pi-marimo-";

export interface LensInstance {
  modelId: string;
  revision: number;
  nextLabel: string;
}

export interface LensResponse {
  ok: boolean;
  code?: string;
  message?: string;
  at: number;
}

export interface LensImage {
  width: number;
  height: number;
  sha256: string;
  base64: string;
}

/** A selection made from Pi's notebook view: one cell, with the user's note and, when there is one, a picture of its output. */
export interface LensMark {
  requestId: string;
  selectionId: string;
  label: string;
  revision: number;
  cellId: string;
  note: string;
  documentId: string;
  createdAt: string;
  /** What was marked, for Lens's description (nonblank). */
  what: string;
  detail?: string;
  image?: LensImage;
}

/** The `selection.put` command for a mark, and its buffers (the PNG, base64). */
export function lensMarkCommand(m: LensMark): { content: Record<string, unknown>; buffers: string[] } {
  const snapshot = m.image
    ? { status: "available", mediaType: "image/png", width: m.image.width, height: m.image.height, sha256: m.image.sha256, capturedAt: m.createdAt, id: `image:${m.selectionId}` }
    : { status: "failed", capturedAt: m.createdAt, error: "Marked in Pi's terminal notebook view, which has no picture of this output." };
  return {
    content: {
      protocol: "marimo-lens.command",
      version: LENS_PROTOCOL_VERSION,
      requestId: m.requestId,
      type: "selection.put",
      payload: {
        expectedRevision: m.revision,
        imageAction: m.image ? "replace" : "clear",
        selection: {
          id: m.selectionId,
          label: m.label,
          note: m.note,
          target: { kind: "notebook", cellIds: [m.cellId], documentId: m.documentId, documentPath: "/" },
          createdAt: m.createdAt,
          anchor: { kind: "point", x: 0.5, y: 0.5 },
          description: { label: truncate(m.what.trim() || "Cell", 256), ...(m.detail?.trim() ? { detail: truncate(m.detail.trim(), 512) } : {}) },
          snapshot,
        },
      },
    },
    buffers: m.image ? [m.image.base64] : [],
  };
}

/** The `selection.delete` command. */
export function lensDeleteCommand(o: { requestId: string; selectionId: string; revision: number }): Record<string, unknown> {
  return { protocol: "marimo-lens.command", version: LENS_PROTOCOL_VERSION, requestId: o.requestId, type: "selection.delete", payload: { selectionId: o.selectionId, expectedRevision: o.revision } };
}

/**
 * The Lens instances of one notebook session, by widget model id. A notebook normally
 * has one; when it has several, their selections are listed together.
 */
export class LensTracker {
  private models = new Map<string, LensState>();
  /** Ids of models known to be something other than Lens: their updates are ignored. */
  private others = new Set<string>();
  /** Lens's answers to pi-marimo's commands, by request id (the latest 20; kept across resets). */
  private responses = new Map<string, LensResponse>();

  reset(): void {
    this.models.clear();
    this.others.clear();
  }

  /** Apply one `model-lifecycle` message. Returns true when the Lens state changed. */
  apply(raw: unknown): boolean {
    const data = record(raw);
    const id = str(data.model_id);
    const message = record(data.message);
    const method = str(message.method);
    if (!id || !method) return false;
    if (method === "close") {
      this.others.delete(id);
      return this.models.delete(id);
    }
    if (method === "custom") {
      const content = record(message.content);
      const requestId = str(content.requestId);
      if (content.protocol !== "marimo-lens.response" || !requestId?.startsWith(LENS_REQUEST_PREFIX)) return false;
      const error = record(content.error);
      this.responses.set(requestId, { ok: content.ok === true, ...(str(error.code) ? { code: str(error.code) } : {}), ...(str(error.message) ? { message: str(error.message) } : {}), at: Date.now() });
      while (this.responses.size > 20) this.responses.delete(this.responses.keys().next().value as string);
      return true;
    }
    if (method !== "open" && method !== "update") return false;
    const state = record(message.state);
    if (method === "open") {
      // A Lens carries both of these synced traits.
      if (!("_lens_id" in state) || !("_state" in state)) {
        this.others.add(id);
        return this.models.delete(id);
      }
      this.others.delete(id);
    } else if (this.others.has(id) || !("_state" in state)) {
      return false;
    } else if (!this.models.has(id) && !("nextLabel" in record(state._state))) {
      // An update for a model never seen open: only trust a full Lens state.
      return false;
    }
    const parsed = parseLensState(state._state);
    if (!parsed) return false;
    const before = this.models.get(id);
    this.models.set(id, parsed);
    return JSON.stringify(before) !== JSON.stringify(parsed);
  }

  /** Whether any Lens is mounted. */
  get present(): boolean {
    return this.models.size > 0;
  }

  /** Each mounted Lens: where to send commands, and the revision and label a new selection must match. */
  instances(): LensInstance[] {
    return [...this.models].map(([modelId, s]) => ({ modelId, revision: s.revision, nextLabel: s.nextLabel }));
  }

  /** Lens's answer to one of pi-marimo's commands, once it came. */
  response(requestId: string): LensResponse | undefined {
    return this.responses.get(requestId);
  }

  /** Open selections of every Lens, in state order. */
  selections(): LensSelection[] {
    return [...this.models.values()].flatMap((m) => m.selections);
  }

  /** The current selection (the one the person made or activated last), when one is open. */
  current(): LensSelection | undefined {
    for (const m of this.models.values()) {
      const found = m.current ? m.selections.find((s) => s.id === m.current) : undefined;
      if (found) return found;
    }
    return undefined;
  }

  /** Addressed selections, newest last. */
  history(): LensReceipt[] {
    return [...this.models.values()].flatMap((m) => m.history);
  }
}
