/** 0.5 is the median of Jev's answers: a stronger option is taken once it is at least as likely as not. */
export const DEFAULT_THRESHOLD = 0.5;

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
