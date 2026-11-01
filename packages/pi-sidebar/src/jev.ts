// Compatibility adapter for Sidebar's single yes/no judgment. Transport follows the global
// System 1 selection; an unavailable or invalid answer never permits a guarded call.
import { askSystem1, type ClassifierProvenance, type ClassifierUsage } from "./system1.ts";

export const JEV = { provider: "typesafe", model: "jev-latest", timeoutMs: 5_000 } as const;

export type JevBool =
  | ({ ok: true; probability: number; selectionKey: string; latencyMs: number; usage?: ClassifierUsage } & ClassifierProvenance)
  | { ok: false; reason: string; usage?: ClassifierUsage };

/** The probability that `question` is true of `state`. Never throws; no backend fallback. */
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
    return { ok: false, reason: "no valid answer", ...(outcome.usage ? { usage: outcome.usage } : {}) };
  }
  return {
    ok: true,
    probability: answer.probability,
    backend: outcome.backend,
    provider: outcome.provider,
    model: outcome.model,
    selectionKey: outcome.selectionKey,
    latencyMs: outcome.latencyMs,
    ...(outcome.usage ? { usage: outcome.usage } : {}),
  };
}
