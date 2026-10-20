// Jev through Pi's own classifier models (`modelRegistry.findOfType("classifier", …)` and
// `modelRegistry.classify()`), for one yes/no judgment. A trimmed copy of
// packages/pi-tool-gate/src/jev.ts (same suite), so pi-sidebar has no sibling imports.

export const JEV = { provider: "typesafe", model: "jev-latest", timeoutMs: 3_000 } as const;

type Answer = { type: "bool"; probability: number } | { type: string };

interface ClassifierRegistry {
  findOfType(type: "classifier", provider: string, modelId: string): unknown;
  classify(
    model: never,
    context: { state: Record<string, unknown>; questions: Record<string, unknown> },
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ answers: Record<string, Answer>; stopReason: string; errorMessage?: string }>;
}

export type JevBool = { ok: true; probability: number } | { ok: false; reason: string };

/** The probability that `question` is true of `state`. Never throws. */
export async function askJevBool(
  registry: unknown,
  state: Record<string, unknown>,
  question: { instructions: string; criteria: { true: string; false: string } },
  signal?: AbortSignal,
): Promise<JevBool> {
  const reg = registry as Partial<ClassifierRegistry> | undefined;
  if (typeof reg?.findOfType !== "function" || typeof reg.classify !== "function") {
    return { ok: false, reason: "this Pi has no classifier models" };
  }
  let model: unknown;
  try {
    model = reg.findOfType("classifier", JEV.provider, JEV.model);
  } catch {
    model = undefined;
  }
  if (!model) return { ok: false, reason: `no classifier model ${JEV.provider}/${JEV.model}` };
  try {
    const result = await reg.classify(model as never, { state, questions: { q: { type: "bool", ...question } } }, {
      timeoutMs: JEV.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    if (result.stopReason !== "stop") return { ok: false, reason: (result.errorMessage ?? result.stopReason).slice(0, 160) };
    const answer = result.answers.q as { type: string; probability?: number } | undefined;
    if (answer?.type !== "bool" || !Number.isFinite(answer.probability)) return { ok: false, reason: "no answer" };
    return { ok: true, probability: answer.probability! };
  } catch (error) {
    return { ok: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
  }
}
