// Offline routing fixtures: Jev classifies the delegated task, but no selected chat model is called.
// One logical request per case/repeat; each configured rung can classify once (no timeout retry).
// Bound the maximum registry-classify count, not just the logical requests.
import { defineEval, type PlanContext } from "../../../evals/shared/target.ts";
import { BUILTIN_AGENTS } from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev, resolveSystem1Route, type ClassifierAnswer } from "../src/jev.ts";
import { type AvailableModel, type Resolved, type Tier, type TierConfig, fixedAgentDefaults, physicalChatModels, pickQuestions, providerTiers, readPicks, resolve } from "../src/pick.ts";

const PARENT_REQUEST = "Implement strict cross-provider lifecycle orchestration, model guards, interactive footer controls, and remote-client integration. This child owns only the delegated task.";
const TASKS = {
  lookup: { role: "explorer", task: "Find the definition and all call sites of resolveProviderFlow. Return file paths and line numbers. Do not redesign or review it.", tiers: ["fast", "balanced"], efforts: ["low"] },
  mechanical: { role: "worker", task: "Rename the exported constant DEFAULT_DELAY_MS to DEFAULT_RETRY_DELAY_MS in src/retry.ts and its imports. Update the matching test names and run the existing retry tests. Do not change behavior.", tiers: ["fast", "balanced"], efforts: ["low", "medium"] },
  specified: { role: "worker", task: "Implement the approved --dry-run flag: add a boolean parser option, print the existing planned operations instead of executing them when true, and add the three specified CLI tests for default, enabled, and invalid-value cases. The design and expected outputs are already settled.", tiers: ["balanced", "strong"], efforts: ["medium", "high"] },
  docs: { role: "writer", task: "Update the README configuration table from the supplied exported defaults and write one example JSON object. Verify field names against config.ts. Do not design configuration behavior.", tiers: ["fast", "balanced"], efforts: ["low", "medium"] },
  debug: { role: "worker", task: "Diagnose an intermittent stale-owner race across cancellation, reload, and model-change callbacks. The root cause is unknown and the traces contradict the current ownership invariant. Build a minimal reproducer, establish the causal ordering, and implement a fix with adversarial scheduling tests.", tiers: ["strong", "premium"], efforts: ["high", "xhigh"] },
  design: { role: "planner", task: "Design a cross-process recovery protocol that preserves exactly-once commit ownership during worker crashes and coordinator failover. Current leases can expire during a commit, there is no shared transactional store, and safety versus availability is unresolved. Analyze failure interleavings and recommend a justified protocol.", tiers: ["strong", "premium"], efforts: ["high", "xhigh"] },
} as const;

const PARENTS = [
  { family: "anthropic", model: "anthropic/claude-opus-5-5" },
  { family: "openai", model: "openai/gpt-6-astra" },
  { family: "google", model: "google/antigravity-gemini-4-argon" },
  { family: "muse", model: "muse-code/muse-wonder-1.0" },
] as const;

export interface RoutingCase {
  id: string;
  role: string;
  task: string;
  parent: { model: string; thinking: string };
  acceptableTiers: readonly Tier[];
  acceptableEfforts: readonly string[];
  hard: boolean;
}

/** Fixed-order full matrix; do not silently drop hard or routine cases from the calibration. */
export const CASES: readonly RoutingCase[] = PARENTS.flatMap(({ family, model }) =>
  (Object.entries(TASKS) as Array<[keyof typeof TASKS, (typeof TASKS)[keyof typeof TASKS]]>).map(([suffix, task]) => ({
    id: `${family}-${suffix}`, role: task.role, task: task.task,
    parent: { model, thinking: "xhigh" },
    acceptableTiers: task.tiers as readonly Tier[], acceptableEfforts: task.efforts,
    hard: suffix === "debug" || suffix === "design",
  })),
);

// Deterministic physical-chat registry. The supported thinking levels mirror the inspected
// catalog: Anthropic lacks minimal/off; OpenAI maps minimal to low; Muse supports minimal.
const model = (provider: string, id: string): AvailableModel => ({
  provider, id, type: "chat", api: "openai-completions", reasoning: true,
  thinkingLevelMap: {
    off: provider === "openai" && /-(?:luna|terra)$/u.test(id) ? "none" : null,
    minimal: provider === "muse-code" ? "minimal" : provider === "openai" ? "low" : null,
    low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
  },
});
export const AVAILABLE: readonly AvailableModel[] = [
  model("anthropic", "claude-haiku-5-5"), model("anthropic", "claude-sonnet-5-5"), model("anthropic", "claude-opus-5-5"), model("anthropic", "claude-fable-5-1"),
  model("openai", "gpt-6-luna"), model("openai", "gpt-6.1-terra"), model("openai", "gpt-6.1-sol"), model("openai", "gpt-6-astra"),
  model("google", "antigravity-gemini-3.8-flash"), model("google", "antigravity-gemini-4-argon"),
  model("muse-code", "muse-spark-1.3"), model("muse-code", "muse-wonder-1.0"),
];

function settings(env: NodeJS.ProcessEnv): { cases: readonly RoutingCase[]; repeats: number } {
  const raw = env.EVAL_ROUTING_REPEATS;
  const repeats = raw === undefined ? 3 : Number(raw);
  if (!/^[1-3]$/u.test(raw ?? "3") || !Number.isInteger(repeats)) throw new Error("EVAL_ROUTING_REPEATS must be an integer from 1 to 3");
  const filter = env.EVAL_ROUTING_CASE_IDS;
  if (filter === undefined) return { cases: CASES, repeats };
  const ids = filter.split(",").map((id) => id.trim());
  const known = new Set(CASES.map((c) => c.id));
  if (ids.some((id) => !id || !known.has(id))) throw new Error(`EVAL_ROUTING_CASE_IDS has unknown or empty ID: ${filter}`);
  if (new Set(ids).size !== ids.length) throw new Error("EVAL_ROUTING_CASE_IDS contains duplicate IDs");
  return { cases: CASES.filter((c) => ids.includes(c.id)), repeats };
}

/** Configured policy only; an observed winner never reduces the potential attempt count. */
function configuredRungs(ctx: PlanContext): number {
  const count = ctx.classifier?.waterfall?.length ?? ctx.classifier?.targets?.length;
  if (count !== undefined) {
    if (count < 1) throw new Error("routing calibration requires a nonempty configured classifier policy");
    return count;
  }
  // Older callers can supply a singleton policy, or omit the metadata entirely.
  if (ctx.classifier?.backend) return 1;
  const route = resolveSystem1Route(DEFAULT_CONFIG.jev);
  if (!route.ok) throw new Error(`routing calibration cannot resolve System 1 policy: ${route.reason}`);
  return route.targets.length;
}

/** Score the resolved selection, not just a raw Jev label. Equivalent physical tier IDs count. */
export function scoreCase(c: RoutingCase, result: Resolved | { error: string } | undefined, tiers: TierConfig) {
  if (!result || "error" in result) return { tierOK: false, effortOK: false, jointOK: false, overEscalated: false, underEscalated: false };
  const accepted = c.acceptableTiers.filter((tier) => Boolean(tiers.models[tier]));
  const tierOK = accepted.some((tier) => tier === result.tier || tiers.models[tier] === result.model);
  const effortOK = c.acceptableEfforts.includes(result.thinking);
  const overEscalated = !c.hard && (result.tier === "premium" || result.thinking === "xhigh");
  const underEscalated = c.hard && (result.tier === "fast" || result.tier === "balanced");
  return { tierOK, effortOK, jointOK: tierOK && effortOK, overEscalated, underEscalated };
}

const probability = (answer: ClassifierAnswer | undefined) =>
  answer?.type === "choice" ? `${answer.choice}(${(answer.probabilities[answer.choice] ?? answer.confidence).toFixed(2)})` : "-";

export default defineEval({
  id: "routing",
  title: "Task-calibrated subagent model and effort selection",
  package: "pi-subagents",
  kind: "cases",
  plan(ctx) {
    const { cases, repeats } = settings(ctx.env);
    const calls = cases.length * repeats;
    const rungs = configuredRungs(ctx);
    return { calls, notes: `${cases.length} cases x ${repeats} repeats = ${calls} logical calls, up to ${calls * rungs} registry-classify attempts (${rungs} configured rungs; retryTimeout:false); no chat-model calls` };
  },
  async run(ctx) {
    const { cases, repeats } = settings(ctx.env);
    const count = cases.length * repeats;
    const rungs = configuredRungs(ctx);
    const potentialAttempts = count * rungs;
    if (potentialAttempts > 100) throw new Error(`routing calibration would exceed 100 registry-classify calls (${count} logical calls x ${rungs} configured rungs = ${potentialAttempts} potential attempts). Use EVAL_ROUTING_REPEATS=2 for 48 logical calls/up to 96 attempts with the full two-rung matrix; repeats are never reduced automatically.`);
    // Preserve the raw registry snapshot for availability decisions. Filtering it first would
    // make a nonempty registry of excluded entries look like an unknown empty registry.
    const available = AVAILABLE;
    const physical = physicalChatModels(available);
    if (physical.length !== available.length) throw new Error("routing fixture must contain only physical chat models");
    const tasks = cases.flatMap((c) => Array.from({ length: repeats }, (_, i) => ({ c, repeat: i + 1 })));
    const lines = new Array<string>(count);
    let failures = 0, tierCorrect = 0, effortCorrect = 0, jointCorrect = 0, overEscalations = 0, underEscalations = 0, hardCorrect = 0;
    await ctx.pool(tasks, ctx.concurrency, async ({ c, repeat }, i) => {
      const tiers: TierConfig = { models: providerTiers(c.parent.model, {}, {}, available), descriptions: DEFAULT_CONFIG.tierDescriptions };
      const agent = BUILTIN_AGENTS.find((a) => a.name === c.role);
      const given = { agent: c.role };
      const fixed = fixedAgentDefaults(agent, c.parent.model, available);
      const questions = pickQuestions({ ...fixed, ...given }, BUILTIN_AGENTS, tiers, true);
      if (!Object.keys(questions).length) throw new Error(`no classifier questions for ${c.id}`);
      const outcome = await askJev(ctx.registry, { ...DEFAULT_CONFIG.jev, timeoutMs: ctx.timeoutMs },
        { task: c.task, parent_request: PARENT_REQUEST, role: c.role }, questions, undefined, { retryTimeout: false });
      ctx.spend.addOutcome(outcome);
      if (!outcome.ok) {
        failures++;
        lines[i] = `${c.id} #${repeat}: FAILED ${outcome.reason} (tier/effort/joint miss)`;
        return;
      }
      const picks = readPicks(outcome.answers, { tiers: (Object.keys(tiers.models) as Tier[]).filter((tier) => Boolean(tiers.models[tier])) });
      const result = resolve(given, BUILTIN_AGENTS, picks, tiers, c.parent, { available });
      const scored = scoreCase(c, result, tiers);
      tierCorrect += Number(scored.tierOK);
      effortCorrect += Number(scored.effortOK);
      jointCorrect += Number(scored.jointOK);
      overEscalations += Number(scored.overEscalated);
      underEscalations += Number(scored.underEscalated);
      if (c.hard) hardCorrect += Number(scored.jointOK);
      const selected = "error" in result ? result.error : `${result.tier ?? "-"}/${result.thinking} ${result.model}`;
      lines[i] = `${c.id} #${repeat}: ${selected}; answers ${probability(outcome.answers.tier)}/${probability(outcome.answers.effort)}; ${scored.jointOK ? "OK" : `MISS tier=${scored.tierOK} effort=${scored.effortOK}`}${scored.overEscalated ? " OVER" : ""}${scored.underEscalated ? " UNDER" : ""}`;
    });
    const hardCount = tasks.filter(({ c }) => c.hard).length;
    const metrics = {
      calls: ctx.spend.calls, failures, tierAccuracy: tierCorrect / count, effortAccuracy: effortCorrect / count,
      jointAccuracy: jointCorrect / count, overEscalations, underEscalations,
      hardTaskAccuracy: hardCount ? hardCorrect / hardCount : 0,
    };
    const pass = failures === 0 && metrics.jointAccuracy >= 0.85 && (!hardCount || metrics.hardTaskAccuracy >= 0.80)
      && overEscalations === 0 && underEscalations === 0;
    return { metrics, report: [...lines, `routing: ${jointCorrect}/${count} joint; hard ${hardCorrect}/${hardCount}; ${failures} failed calls; ${overEscalations} over-escalations; ${underEscalations} under-escalations`].join("\n"), pass, failures };
  },
});
