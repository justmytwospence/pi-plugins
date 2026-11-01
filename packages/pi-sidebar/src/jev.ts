// Compatibility adapter for Sidebar's single yes/no judgment. Transport follows the global
// System 1 selection; an unavailable or invalid answer never permits a guarded call.
import { askSystem1, provenanceOf, type System1DecisionProvenance, type System1Outcome, type ClassifierUsage } from "./system1.ts";

export const JEV = { provider: "typesafe", model: "jev-latest", timeoutMs: 5_000 } as const;

export type JevBool =
  | ({ ok: true; probability: number; latencyMs: number; usage?: ClassifierUsage } & System1DecisionProvenance)
  | Extract<System1Outcome, { ok: false }>;

/** The probability that `question` is true of `state`, using the configured System 1 waterfall. */
export async function askJevBool(
  registry: unknown,
  state: Record<string, unknown>,
  question: { instructions: string; criteria: { true: string; false: string } },
  signal?: AbortSignal,
): Promise<JevBool> {
  const outcome = await askSystem1(registry, { enabled: true, ...JEV }, state, { q: { type: "bool", ...question } }, signal);
  if (!outcome.ok) return outcome;
  const answer = outcome.answers.q;
  if (answer?.type !== "bool" || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) {
    return {
      ok: false,
      code: "invalid_answers",
      reason: "no valid answer",
      selectionKey: outcome.selectionKey,
      attempts: outcome.attempts,
      latencyMs: outcome.latencyMs,
      ...(outcome.usage ? { usage: outcome.usage } : {}),
    };
  }
  return {
    ok: true,
    probability: answer.probability,
    ...provenanceOf(outcome),
    latencyMs: outcome.latencyMs,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  };
}
