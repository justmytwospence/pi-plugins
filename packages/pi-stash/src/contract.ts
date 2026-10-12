/**
 * Structural copy of the parts of the suite editor contract (version 1) that
 * pi-stash consumes. The canonical file is packages/pi-vim/src/contract.ts;
 * nothing imports across package directories. Every key is a `Symbol.for(...)`
 * registry symbol, so the same identifier resolves in every module instance.
 */

/** Property on an editor instance: `"main"` or `"embedded"`. */
export const EDITOR_SURFACE = Symbol.for("pi-plugins.editor-surface.v1");
/** Property on an editor: capture/restore plain draft snapshots. */
export const EDITOR_SNAPSHOT = Symbol.for("pi-plugins.editor-snapshot.v1");

export type EditorSurface = "main" | "embedded";
export type EditorMode = "insert" | "normal" | "visual" | "visual-line";

export interface EditorCursor {
  line: number;
  col: number;
}

/** Plain draft snapshot. `history` is opaque and only meaningful in-process. */
export interface EditorSnapshot {
  version: 1;
  text: string;
  cursor: EditorCursor;
  mode: EditorMode;
  anchor?: EditorCursor;
  history?: unknown;
}

export interface EditorSnapshotApi {
  capture(): EditorSnapshot;
  /** Returns false and changes nothing when the snapshot version is unsupported. */
  restore(snapshot: EditorSnapshot): boolean;
}

/** Read a component's editor surface marker. */
export function readEditorSurface(component: unknown): EditorSurface | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  const value = (component as Record<symbol, unknown>)[EDITOR_SURFACE];
  return value === "main" || value === "embedded" ? value : undefined;
}

/** Read an editor's snapshot API; undefined for editors without it (native text fallback). */
export function readEditorSnapshotApi(component: unknown): EditorSnapshotApi | undefined {
  if (typeof component !== "object" || component === null) return undefined;
  const value = (component as Record<symbol, unknown>)[EDITOR_SNAPSHOT] as Partial<EditorSnapshotApi> | undefined;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.capture !== "function" || typeof value.restore !== "function") return undefined;
  return value as EditorSnapshotApi;
}

/** A snapshot this consumer can hand back later. */
export function isEditorSnapshot(value: unknown): value is EditorSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Partial<EditorSnapshot>;
  const cursor = (point: unknown): point is EditorCursor => {
    if (typeof point !== "object" || point === null) return false;
    const { line, col } = point as EditorCursor;
    return Number.isSafeInteger(line) && line >= 0 && Number.isSafeInteger(col) && col >= 0;
  };
  return snapshot.version === 1 && typeof snapshot.text === "string"
    && cursor(snapshot.cursor)
    && ["insert", "normal", "visual", "visual-line"].includes(snapshot.mode ?? "")
    && (snapshot.anchor === undefined || cursor(snapshot.anchor));
}
