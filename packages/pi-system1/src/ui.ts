import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { whileBlocked } from "./herdr.ts";
import { inspectDecisionsAvailability } from "./provider.ts";
import { saveSystem1Waterfall } from "./settings.ts";
import {
  SYSTEM1_CHANGED,
  getSystem1RuntimeSnapshot,
  getSystem1SessionStart,
  readSystem1Setting,
  resolveSystem1Route,
  system1Path,
  type System1Backend,
} from "./system1.ts";
import type { System1Status } from "./system1-contract.ts";

export const DEFAULT_CLASSIFIER = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 5_000 };
export const BILLING_CONFIRMATION =
  "This waterfall can use OpenAI Decisions API billing, funded by your claimed Pro credits. Confirm the linked API organization has active included credits, no purchased balance, no auto-recharge and no paid continuation. Pi cannot verify the funding source. Continue?";
const PRESETS: { label: string; waterfall: System1Backend[] }[] = [
  { label: "Jev → OpenAI", waterfall: ["jev", "openai-decisions"] },
  { label: "OpenAI → Jev", waterfall: ["openai-decisions", "jev"] },
  { label: "Jev only", waterfall: ["jev"] },
  { label: "OpenAI only", waterfall: ["openai-decisions"] },
];
export const system1Label = (backend: System1Backend): string => (backend === "jev" ? "Jev" : "OpenAI");
export const system1OrderLabel = (waterfall: readonly System1Backend[]): string =>
  waterfall.map(system1Label).join(" → ");
type LocalAvailability = { availability: "unknown" | "configured" | "unavailable"; reason?: string };

/** Inspect local metadata/configuration only: never resolve credentials, refresh OAuth, or probe. */
export async function inspectSystem1Availability(
  registry: unknown,
  backend: System1Backend,
): Promise<LocalAvailability> {
  if (backend === "openai-decisions") return inspectDecisionsAvailability(registry);
  const reg = registry as
    | {
        findOfType?: (type: "classifier", provider: string, id: string) => unknown;
        classify?: unknown;
        hasConfiguredAuth?: (model: never) => boolean;
      }
    | undefined;
  try {
    const model = reg?.findOfType?.("classifier", DEFAULT_CLASSIFIER.provider, DEFAULT_CLASSIFIER.model);
    if (!model || typeof reg?.classify !== "function")
      return { availability: "unavailable", reason: "No TypeSafe/Jev classifier capability on this Pi host." };
    if (typeof reg.hasConfiguredAuth !== "function")
      return {
        availability: "unknown",
        reason: "This Pi host cannot inspect local classifier authentication configuration.",
      };
    return reg.hasConfiguredAuth(model as never)
      ? { availability: "configured" }
      : { availability: "unavailable", reason: "Configure /login typesafe or TYPESAFE_API_KEY." };
  } catch {
    return { availability: "unavailable", reason: "Local TypeSafe/Jev configuration is unavailable." };
  }
}

/** Detached UI state; runtime and local metadata are inspected outside synchronous rendering. */
export async function inspectSystem1Status(registry: unknown): Promise<System1Status> {
  const setting = readSystem1Setting();
  const route = resolveSystem1Route(DEFAULT_CLASSIFIER, setting);
  if (!route.ok) return { waterfall: [], candidates: [], status: "unavailable" };
  const local = await Promise.all(route.targets.map((target) => inspectSystem1Availability(registry, target.backend)));
  const runtime = getSystem1RuntimeSnapshot(registry, DEFAULT_CLASSIFIER);
  const candidates: System1Status["candidates"] = route.targets.map((target, index) => {
    const candidate = runtime.candidates.find(
      (value) => value.backend === target.backend && value.provider === target.provider && value.model === target.model,
    );
    return {
      ...target,
      local: local[index]!.availability === "unavailable" ? "missing" : local[index]!.availability,
      ...(candidate?.cooldownUntil === undefined ? {} : { cooldownUntil: candidate.cooldownUntil }),
      ...(candidate?.lastFailure
        ? { lastFailure: { code: candidate.lastFailure.code, at: candidate.lastFailure.at } }
        : {}),
    };
  });
  const now = Date.now();
  const eligible = candidates.filter(
    (candidate) =>
      candidate.local !== "missing" &&
      !(candidate.cooldownUntil && candidate.cooldownUntil > now) &&
      !runtime.candidates.find((value) => value.backend === candidate.backend)?.probing,
  );
  const lastUsed = runtime.lastUsed;
  const start = getSystem1SessionStart(registry);
  const status: System1Status["status"] = !eligible.length
    ? "unavailable"
    : runtime.lastOutcome && !runtime.lastOutcome.ok && runtime.lastOutcome.code === "exhausted"
      ? "unavailable"
      : lastUsed?.fallback
        ? "fallback"
        : eligible.some((candidate) => candidate.local === "configured")
          ? "ready"
          : "unknown";
  return {
    waterfall: [...route.waterfall],
    candidates,
    status,
    ...(start ? { sessionStart: start } : {}),
    ...(lastUsed
      ? {
          lastUsed: {
            backend: lastUsed.backend,
            provider: lastUsed.provider,
            model: lastUsed.model,
            at: lastUsed.at,
            fallback: lastUsed.fallback,
          },
        }
      : {}),
    ...(runtime.nextRetryAt === undefined ? {} : { nextRetryAt: runtime.nextRetryAt }),
  };
}

function save(pi: ExtensionAPI, ctx: ExtensionContext, waterfall: readonly System1Backend[]): void {
  try {
    saveSystem1Waterfall(waterfall);
  } catch {
    ctx.ui.notify(
      `Could not save System 1. Check permissions and correct any malformed configuration in ${system1Path()}.`,
      "error",
    );
    return;
  }
  pi.events.emit(SYSTEM1_CHANGED, { waterfall: [...waterfall] });
  ctx.ui.notify(`System 1: ${system1OrderLabel(waterfall)}. Disabled individual features stay disabled.`, "info");
}

/** Shared by the picker and direct command, inside their complete blocked lifetime. */
async function activate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  waterfall: readonly System1Backend[],
  current: () => boolean,
): Promise<void> {
  if (!current()) return;
  const setting = readSystem1Setting();
  if (setting.ok && JSON.stringify(setting.waterfall) === JSON.stringify(waterfall)) return;
  const key = setting.key;
  const unchanged = () => current() && readSystem1Setting().key === key;
  const includesOpenAI =
    waterfall.includes("openai-decisions") && !(setting.ok && setting.waterfall.includes("openai-decisions"));
  if (includesOpenAI) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "New OpenAI Decisions inclusion requires interactive billing confirmation. Use /system1 in a session with UI.",
        "warning",
      );
      return;
    }
    const answer = await ctx.ui.select(BILLING_CONFIRMATION, ["Use included credits", "Keep current order"]);
    if (answer !== "Use included credits" || !unchanged()) return;
  }
  // Explicit orders may contain locally unavailable rungs; configuration is not a probe.
  if (unchanged()) save(pi, ctx, waterfall);
}

export async function selectSystem1Waterfall(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  waterfall: readonly System1Backend[],
  current: () => boolean = () => true,
): Promise<void> {
  if (!ctx.hasUI || !waterfall.includes("openai-decisions")) return activate(pi, ctx, waterfall, current);
  await whileBlocked(pi.events, "System 1", () => activate(pi, ctx, waterfall, current));
}

/** Legacy singleton shortcut. */
export async function selectSystem1Backend(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  backend: System1Backend,
  current: () => boolean = () => true,
): Promise<void> {
  return selectSystem1Waterfall(pi, ctx, [backend], current);
}

export async function openSystem1Picker(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  current: () => boolean = () => true,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("System 1 picker requires UI. Use /system1 status or an explicit /system1 order.", "warning");
    return;
  }
  await whileBlocked(pi.events, "System 1", async () => {
    const setting = readSystem1Setting();
    const [jev, decisions, status] = await Promise.all([
      inspectSystem1Availability(ctx.modelRegistry, "jev"),
      inspectDecisionsAvailability(ctx.modelRegistry),
      inspectSystem1Status(ctx.modelRegistry),
    ]);
    const unchanged = () => current() && readSystem1Setting().key === setting.key;
    if (!unchanged()) return;
    // Seven phone-width lines. Physical IDs, failures and cooldowns belong in status.
    const question = [
      "System 1",
      setting.ok ? `Current: ${system1OrderLabel(setting.waterfall)}` : "Current: unavailable",
      `Jev: ${jev.availability === "unavailable" ? "missing" : jev.availability}; OpenAI: ${decisions.availability === "unavailable" ? "missing" : decisions.availability}`,
      status.lastUsed
        ? `Recent: ${system1Label(status.lastUsed.backend)}${status.lastUsed.fallback ? "*" : ""}`
        : "Recent: unknown",
      "Details/setup: /system1 status.",
      "Feature-off settings still apply.",
      "API credits: funding unknown to Pi.",
    ].join("\n");
    const choice = await ctx.ui.select(
      question,
      PRESETS.map((preset) => preset.label),
    );
    if (!unchanged()) return;
    const preset = PRESETS.find((preset) => preset.label === choice);
    if (preset) await activate(pi, ctx, preset.waterfall, unchanged);
  });
}
