// Canonical: shared/transcript/transcript-contract.ts. Sync: node scripts/sync-transcript-helpers.mjs
export const CHECKPOINT_DETAILS_KEY = "pi-plugins.transcript.v1";
export const TRANSCRIPT_BLOCK = Symbol.for("pi-plugins.transcript-block.v1");
export const TRANSCRIPT_ROWS = Symbol.for("pi-plugins.transcript-rows.v1");
export const USER_WORDS_CHANNEL = "pi-plugins.user-words.v1";

export interface TranscriptCheckpoint {
  id: string;
  kind: string;
}
export interface TranscriptAnnotation {
  version: 1;
  checkpoint: TranscriptCheckpoint;
}
const object = (value: unknown): value is Record<PropertyKey, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export function validCheckpoint(value: unknown): value is TranscriptCheckpoint {
  return (
    object(value) &&
    typeof value.id === "string" &&
    !!value.id.trim() &&
    typeof value.kind === "string" &&
    !!value.kind.trim()
  );
}
export type CheckpointValue<T extends { details?: object }> = Omit<T, "details"> & {
  details: ([NonNullable<T["details"]>] extends [never] ? object : NonNullable<T["details"]>) &
    Record<typeof CHECKPOINT_DETAILS_KEY, TranscriptAnnotation>;
};
export function transcriptCheckpoint<T extends { details?: object }>(
  value: T,
  checkpoint: TranscriptCheckpoint,
): CheckpointValue<T> {
  if (!validCheckpoint(checkpoint) || (value.details !== undefined && !object(value.details)))
    throw new TypeError("Invalid transcript checkpoint or details");
  return {
    ...value,
    details: { ...value.details, [CHECKPOINT_DETAILS_KEY]: { version: 1, checkpoint: { ...checkpoint } } },
  } as CheckpointValue<T>;
}
export function readTranscriptCheckpoint(details: unknown): TranscriptCheckpoint | undefined {
  if (!object(details)) return undefined;
  const annotation = details[CHECKPOINT_DETAILS_KEY];
  return object(annotation) && annotation.version === 1 && validCheckpoint(annotation.checkpoint)
    ? { id: annotation.checkpoint.id, kind: annotation.checkpoint.kind }
    : undefined;
}

export type BlockKind = "user" | "assistant" | "tool" | "bash" | "other";
export interface TranscriptDescription {
  kind?: BlockKind;
  error?: boolean;
  userText?: string;
  checkpoint?: TranscriptCheckpoint;
  /** Semantic subjects represented atomically by these rendered rows, not child geometry. */
  subjects?: readonly unknown[];
}
export interface TranscriptBlock {
  start: number;
  end: number;
  kind: BlockKind;
  error: boolean;
  source: object;
  userText?: string;
  checkpoint?: TranscriptCheckpoint;
}
export interface TranscriptIndex {
  lines: string[];
  blocks: TranscriptBlock[];
  horizons: number[];
}
export interface ToolCallView {
  toolName: string;
  toolCallId?: string;
  args: unknown;
  result: { content?: unknown; details?: unknown; isError?: boolean };
}
export type UserWordsExtractor = (call: ToolCallView) => string | undefined;
export interface UserWordsRequest {
  version: 1;
  register?: (toolName: string, extract: UserWordsExtractor) => void;
}
export type UserWordsRegistry = ReadonlyMap<string, readonly UserWordsExtractor[]>;
export interface TranscriptContext {
  userWords: UserWordsRegistry;
}
export interface TranscriptRenderContext {
  width: number;
  lines: readonly string[];
}
export interface TranscriptRowsContext extends TranscriptRenderContext {
  index(children: readonly unknown[], width: number): TranscriptIndex;
  splice(index: TranscriptIndex, start: number, deleteCount: number, insertLines: readonly string[]): TranscriptIndex;
}
export interface TranscriptHooks {
  [TRANSCRIPT_BLOCK]?: (context: TranscriptRenderContext) => TranscriptDescription | undefined;
  [TRANSCRIPT_ROWS]?: (context: TranscriptRowsContext) => TranscriptIndex | undefined;
}
export interface TranscriptOptions {
  describe?: (component: unknown) => TranscriptDescription | undefined;
}
export const EMPTY_TRANSCRIPT_CONTEXT: TranscriptContext = { userWords: new Map() };
