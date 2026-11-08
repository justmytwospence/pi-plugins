/**
 * How sure Jev must be before a pick climbs to a stronger tier or effort: `relaxed` with no quota
 * pressure, `tight` at full pressure, linear in between.
 */
export interface Threshold {
  relaxed: number;
  tight: number;
}
/** 0.5 is the median of Jev's answers: a stronger option is taken once it is at least as likely as not. */
export const DEFAULT_THRESHOLD: Threshold = { relaxed: 0.5, tight: 0.85 };

/** theta(p) = relaxed + (tight - relaxed) * p, with p (quota pressure) clamped to 0..1. */
export function theta(pressure: number, threshold: Threshold = DEFAULT_THRESHOLD): number {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 0;
  const relaxed = finite01(threshold.relaxed, DEFAULT_THRESHOLD.relaxed);
  const tight = finite01(threshold.tight, DEFAULT_THRESHOLD.tight);
  return relaxed + (tight - relaxed) * p;
}

function finite01(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/**
 * The highest of `options` (weakest first) whose P(this option or stronger) reaches `bar`; else the
 * lowest. An answer without probabilities counts its choice at its confidence.
 */
export function climb<T extends string>(options: readonly T[], answer: { choice: string; probabilities: Record<string, number>; confidence: number }, bar: number): T {
  const probabilities = options.some((o) => Number.isFinite(answer.probabilities?.[o]))
    ? answer.probabilities
    : { [answer.choice]: answer.confidence };
  let atLeast = 0;
  for (let i = options.length - 1; i > 0; i--) {
    const p = probabilities[options[i]!];
    atLeast += Number.isFinite(p) ? p! : 0;
    // A hair of slack, so 0.35 + 0.5 summed in floating point still meets 0.85.
    if (atLeast >= bar - 1e-9) return options[i]!;
  }
  return options[0]!;
}
