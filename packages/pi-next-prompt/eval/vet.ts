// The vet's eval engine (eval/vet.target.ts). Sessions never store the suggestion (the `<next>` line is
// stripped before the message is saved), so this cannot replay what the model proposed. It measures
// whether the vet tells a good suggestion from a bad one instead: for each assistant turn on a sampled
// session's current branch that the user answered, it asks the vet with the user's REAL next message as
// the suggestion (a positive: what the user did send is the best available stand-in for a good
// suggestion) and with a next message taken from another sampled session (a negative: unrelated, so a
// useful vet rejects it). Everything here is pure; only `scoreTurns` calls Jev, through the caller's pool.
import { DEFAULT_CONFIG, QUESTIONS, type Pending, vetState } from "../src/index.ts";
import { type JevOutcome, askJev, bool } from "../src/jev.ts";
import { messageText } from "../src/transcript.ts";
import { pool } from "../../../evals/shared/pool.ts";
import { branchOf, prng, shuffle, type Session } from "../../../evals/shared/sessions.ts";
import { Spend } from "../../../evals/shared/spend.ts";

/** At most this many turns per session, chosen by the seed. */
export const TURNS_PER_SESSION = 12;
/** A real next message shorter or longer than this is not a suggestion the model would have made. */
export const MIN_CHARS = 3;
export const MAX_CHARS = 300;
/** The vet shows a suggestion at or above this probability. */
export const THRESHOLD = DEFAULT_CONFIG.jev.threshold;

/** One question to the vet. */
export interface Case extends Pending {
  kind: "real" | "mismatch";
  /** The session file and the turn's position, for the report. */
  file: string;
  turn: number;
}

export interface Cases {
  /** Turns whose real next message is the suggestion. */
  positives: Case[];
  /** The same turns with another session's next message as the suggestion. */
  negatives: Case[];
  /** Turns that qualified (before the cap). */
  candidates: number;
}

/** A suggestion as the model would have written it: one line of whitespace-collapsed text. */
const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

/** Whether the user's next message could have been a suggestion: not a command, a sensible length. */
export function isSuggestible(text: string): boolean {
  const value = normalize(text);
  return value.length >= MIN_CHARS && value.length <= MAX_CHARS && !value.startsWith("/") && !value.startsWith("!");
}

interface Turn {
  userPrompt: string;
  assistantTail: string;
  next: string;
}

/**
 * The turns of one branch: where the user's message follows an assistant message that has text, the
 * latest assistant message since the user's previous message (the one the live code vets), the prompt
 * it answered, and the user's next message. Only turns whose next message `isSuggestible`.
 */
export function turnsOf(session: Session): Turn[] {
  const turns: Turn[] = [];
  let userPrompt = "";
  let assistantTail = "";
  for (const entry of branchOf(session.entries)) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role?: string; content?: unknown } | undefined;
    if (message?.role === "assistant") assistantTail = messageText(message.content).trim();
    else if (message?.role === "user") {
      const text = messageText(message.content).trim();
      if (text && userPrompt && assistantTail && isSuggestible(text)) turns.push({ userPrompt, assistantTail, next: normalize(text) });
      if (text) userPrompt = text;
      assistantTail = "";
    }
  }
  return turns;
}

/**
 * The questions a run would ask: per session up to `perSession` turns (seeded shuffle), each as a
 * positive and, when another session has a turn to borrow from, as a negative with that turn's next
 * message (seeded pick, never the turn's own text). No Jev call.
 */
export function buildCases(sessions: readonly Session[], seed: number, perSession = TURNS_PER_SESSION): Cases {
  const chosen: Array<{ session: number; file: string; turn: number; value: Turn }> = [];
  let candidates = 0;
  sessions.forEach((session, s) => {
    const turns = turnsOf(session).map((value, turn) => ({ session: s, file: session.file, turn, value }));
    candidates += turns.length;
    chosen.push(...shuffle(turns, seed + s + 1).slice(0, perSession));
  });
  const random = prng(seed);
  const positives: Case[] = [];
  const negatives: Case[] = [];
  for (const t of chosen) {
    positives.push({ kind: "real", file: t.file, turn: t.turn, userPrompt: t.value.userPrompt, assistantTail: t.value.assistantTail, suggestion: t.value.next });
    const donors = chosen.filter((other) => other.session !== t.session && other.value.next !== t.value.next);
    const donor = donors[Math.floor(random() * donors.length)];
    if (donor) negatives.push({ kind: "mismatch", file: t.file, turn: t.turn, userPrompt: t.value.userPrompt, assistantTail: t.value.assistantTail, suggestion: donor.value.next });
  }
  return { positives, negatives, candidates };
}

/** Jev requests a run makes: one per positive and per negative. */
export const countRequests = (cases: Cases): number => cases.positives.length + cases.negatives.length;

export interface Scored {
  case: Case;
  /** The vet's probability that the suggestion is useful; undefined when Jev gave no answer. */
  probability?: number;
  reason?: string;
}

export interface Scoring {
  scored: Scored[];
  failures: number;
  requests: number;
  spend: Spend;
}

/** Asks the vet's question (same state and question as `vet()` in src/index.ts) for every case. */
export async function scoreTurns(registry: unknown, cases: readonly Case[], options: { concurrency: number; timeoutMs: number; ask?: typeof askJev }): Promise<Scoring> {
  const spend = new Spend();
  const ask = options.ask ?? askJev;
  const config = { ...DEFAULT_CONFIG.jev, timeoutMs: options.timeoutMs };
  const scored: Scored[] = new Array(cases.length);
  await pool(cases, options.concurrency, async (item, index) => {
    const outcome: JevOutcome = await ask(registry, config, vetState(item), QUESTIONS);
    spend.addOutcome(outcome);
    const probability = outcome.ok ? bool(outcome.answers, "useful") : undefined;
    scored[index] = { case: item, ...(probability === undefined ? { reason: outcome.ok ? "no answer" : outcome.reason } : { probability }) };
  });
  return { scored, failures: scored.filter((s) => s.probability === undefined).length, requests: cases.length, spend };
}

/** The probability that a random positive scores above a random negative (ties count half). NaN without both. */
export function auc(positives: readonly number[], negatives: readonly number[]): number {
  if (!positives.length || !negatives.length) return Number.NaN;
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (positives.length * negatives.length);
}

const mean = (values: readonly number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN);
const share = (values: readonly number[], test: (v: number) => boolean) => (values.length ? values.filter(test).length / values.length : Number.NaN);

export interface Summary {
  positives: number;
  negatives: number;
  passRateReal: number;
  rejectRateMismatch: number;
  separation: number;
  meanProbReal: number;
  meanProbMismatch: number;
  jevFailures: number;
}

/** The numbers worth comparing between runs, from the scored positives and negatives. */
export function summarize(real: readonly Scored[], mismatch: readonly Scored[], threshold = THRESHOLD): Summary {
  const p = real.flatMap((s) => (s.probability === undefined ? [] : [s.probability]));
  const n = mismatch.flatMap((s) => (s.probability === undefined ? [] : [s.probability]));
  return {
    positives: p.length,
    negatives: n.length,
    passRateReal: share(p, (v) => v >= threshold),
    rejectRateMismatch: share(n, (v) => v < threshold),
    separation: auc(p, n),
    meanProbReal: mean(p),
    meanProbMismatch: mean(n),
    jevFailures: real.length + mismatch.length - p.length - n.length,
  };
}

/** The `count` real next messages the vet scored lowest: what it would have hidden. */
export function lowestReal(real: readonly Scored[], count = 10): Scored[] {
  return real.filter((s) => s.probability !== undefined).sort((a, b) => (a.probability as number) - (b.probability as number)).slice(0, count);
}
