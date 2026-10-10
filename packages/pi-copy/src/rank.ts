import type { ClassifierAnswer, ClassifierQuestion } from "./jev.ts";
import { PROSE_KINDS, type Segment, segmentKey } from "./segments.ts";

export interface Judged {
  /** Score 0-3: how likely the user wants to copy this now. */
  want: number;
  /** For prose: probability it is a self-contained thing to paste elsewhere. */
  copyable?: number;
}

export interface RankSettings {
  /** Judge at most this many of the newest pieces. */
  maxPieces: number;
  /** Characters of each piece Jev reads. */
  pieceChars: number;
  /** Characters of state in one request. */
  stateBudgetChars: number;
  /** Prose below this copyable probability is left out of Suggested. */
  copyableThreshold: number;
  /** Weight of Jev's score against recency. */
  wantWeight: number;
}

export const DEFAULT_RANK: RankSettings = { maxPieces: 120, pieceChars: 600, stateBudgetChars: 60_000, copyableThreshold: 0.3, wantWeight: 0.6 };

/** The newest pieces that fit the request, oldest first. */
export function piecesToJudge(segments: readonly Segment[], settings: RankSettings): Segment[] {
  const chosen: Segment[] = [];
  let chars = 0;
  for (let i = segments.length - 1; i >= 0 && chosen.length < settings.maxPieces; i--) {
    const segment = segments[i] as Segment;
    const size = Math.min(segment.text.length, settings.pieceChars) + 40;
    if (chars + size > settings.stateBudgetChars) break;
    chosen.unshift(segment);
    chars += size;
  }
  return chosen;
}

export function rankState(pieces: readonly Segment[], recentUserMessages: readonly string[], settings: RankSettings): Record<string, unknown> {
  return {
    recent_user_messages: recentUserMessages.length ? recentUserMessages : ["(none)"],
    pieces: Object.fromEntries(
      pieces.map((p) => [p.id, { kind: p.kind, ...(p.lang ? { lang: p.lang } : {}), text: p.text.length > settings.pieceChars ? `${p.text.slice(0, settings.pieceChars - 1)}…` : p.text }]),
    ),
  };
}

export function rankQuestions(pieces: readonly Segment[]): Record<string, ClassifierQuestion> {
  const questions: Record<string, ClassifierQuestion> = {};
  for (const piece of pieces) {
    questions[`want::${piece.id}`] = {
      type: "score",
      instructions: `The user opened a picker to copy something from this coding session, right after \`recent_user_messages\`. How likely is \`pieces.${piece.id}\` the thing they want to copy now?`,
      criteria: [
        "Not something they would copy now",
        "Might copy it",
        "Likely to copy it",
        "Very likely exactly what they want to copy",
      ],
    };
    if (PROSE_KINDS.has(piece.kind)) {
      questions[`copyable::${piece.id}`] = {
        type: "bool",
        instructions: `Is \`pieces.${piece.id}\` a self-contained thing someone would paste somewhere else (a message, note, description, instructions, or a value), rather than explanation meant only for reading here?`,
        criteria: { true: "Worth pasting elsewhere as it is", false: "Explanation or chatter for this conversation only" },
      };
    }
  }
  return questions;
}

export function readJudgments(pieces: readonly Segment[], answers: Record<string, ClassifierAnswer>): Map<string, Judged> {
  const out = new Map<string, Judged>();
  for (const piece of pieces) {
    const want = answers[`want::${piece.id}`];
    const copyable = answers[`copyable::${piece.id}`];
    if (want?.type !== "score") continue;
    out.set(segmentKey(piece), { want: want.score, ...(copyable?.type === "bool" ? { copyable: copyable.probability } : {}) });
  }
  return out;
}

/**
 * Suggested order: `0.6·(want/3) + 0.4·recency` for judged pieces, recency alone (weighted 0.4)
 * for the rest; prose Jev judged not copyable is left out. Without judgments it is recency order.
 */
export function suggested(segments: readonly Segment[], judged: ReadonlyMap<string, Judged> | undefined, settings: RankSettings): Segment[] {
  const maxTurn = Math.max(1, ...segments.map((s) => s.turn));
  const maxOrder = Math.max(1, segments.length - 1);
  const score = (s: Segment) => {
    const recency = 0.8 * (s.turn / maxTurn) + 0.2 * (s.order / maxOrder);
    const j = judged?.get(segmentKey(s));
    return j ? settings.wantWeight * (j.want / 3) + (1 - settings.wantWeight) * recency : (1 - settings.wantWeight) * recency;
  };
  return segments
    .filter((s) => {
      const j = judged?.get(segmentKey(s));
      return !(j?.copyable !== undefined && j.copyable < settings.copyableThreshold);
    })
    .map((s) => ({ s, score: score(s) }))
    .sort((a, b) => b.score - a.score || b.s.order - a.s.order)
    .map((x) => x.s);
}

/** All pieces and whole messages, newest first. */
export function chronological(segments: readonly Segment[]): Segment[] {
  return [...segments].sort((a, b) => b.order - a.order);
}
