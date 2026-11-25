// Adding draft review comments from another extension over Pi's event bus. Package-local contract
// file: copied verbatim into pi-diff-review and pi-ship (src/diff-review-contract.ts); change it in
// both. There is no shared runtime package: nothing here imports a sibling.
//
// The caller emits a request carrying its own `ctx`; pi-diff-review, when loaded and in the TUI,
// stores the comments as drafts, opens `/diff` on `scope` (any ref `/diff` accepts) and sets
// `result` to a Promise that resolves when the viewer closes, with how many of these comments the
// user sent to the agent. Nothing answering leaves `result` unset, so a caller falls back.

export const DIFF_REVIEW_COMMENTS_CHANNEL = "pi-plugins.diff-review-comments.v1";

export interface ExternalComment {
  /** Repository-relative path, in the new version of the file. */
  path: string;
  line: number;
  body: string;
}

export interface DiffReviewCommentsRequest {
  version: 1;
  /** The caller's ExtensionCommandContext-like context (opaque here). */
  ctx: unknown;
  /** What `/diff` takes: a ref such as a commit sha, or `unreviewed`, `head`, `branch`. */
  scope: string;
  comments: ExternalComment[];
  /** Set by pi-diff-review. */
  result?: Promise<{ sent: number; opened: boolean }>;
}

/** Emits the request; returns undefined when nothing answered (pi-diff-review absent or not in the TUI). */
export function requestDiffReview(
  events: { emit(channel: string, data: unknown): void },
  request: Omit<DiffReviewCommentsRequest, "version" | "result">,
): DiffReviewCommentsRequest["result"] {
  const full: DiffReviewCommentsRequest = { version: 1, ...request };
  events.emit(DIFF_REVIEW_COMMENTS_CHANNEL, full);
  return full.result;
}
