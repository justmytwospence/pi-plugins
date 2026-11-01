import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { whileBlocked } from "./herdr.ts";
import { inspectDecisionsAvailability } from "./provider.ts";
import { saveSystem1Backend } from "./settings.ts";
import { SYSTEM1_CHANGED, readSystem1Setting, resolveSystem1Target, system1Path, type System1Backend } from "./system1.ts";
import type { System1Status } from "./system1-contract.ts";

export const DEFAULT_CLASSIFIER = { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 5_000 };
export const BILLING_CONFIRMATION = "OpenAI Decisions uses API billing, funded by your claimed Pro credits. Confirm that the linked API organization has active included credits, no purchased balance, no auto-recharge and no paid continuation. Pi cannot verify which credits fund a request. Continue?";
const SETUP = "Enable a Pi host with native Decisions support and configure /login system1-openai or SYSTEM1_OPENAI_API_KEY. Claim and check the linked Pro API credits and no-paid-continuation billing prerequisites, then use /system1 openai in a session with UI to confirm.";

/** Inspect local metadata/configuration only: never resolve credentials, refresh OAuth, or probe. */
export async function inspectSystem1Availability(registry: unknown, backend: System1Backend): Promise<Pick<System1Status, "availability" | "reason">> {
  if (backend === "openai-decisions") return inspectDecisionsAvailability(registry);
  const reg = registry as {
    findOfType?: (type: "classifier", provider: string, id: string) => unknown;
    classify?: unknown;
    hasConfiguredAuth?: (model: never) => boolean;
  } | undefined;
  try {
    const model = reg?.findOfType?.("classifier", DEFAULT_CLASSIFIER.provider, DEFAULT_CLASSIFIER.model);
    if (!model || typeof reg?.classify !== "function") return { availability: "unavailable", reason: "No TypeSafe/Jev classifier capability on this Pi host." };
    if (typeof reg.hasConfiguredAuth !== "function") return { availability: "unknown", reason: "This Pi host cannot inspect local classifier authentication configuration." };
    return reg.hasConfiguredAuth(model as never)
      ? { availability: "configured" }
      : { availability: "unavailable", reason: "Configure /login typesafe or TYPESAFE_API_KEY." };
  } catch {
    return { availability: "unavailable", reason: "Local TypeSafe/Jev configuration is unavailable." };
  }
}

export async function inspectSystem1Status(registry: unknown): Promise<System1Status> {
  const setting = readSystem1Setting();
  const target = resolveSystem1Target(DEFAULT_CLASSIFIER, setting);
  if (!target.ok) return { backend: "jev", label: "Jev", provider: "typesafe", model: "jev-latest", availability: "unavailable", reason: target.reason };
  return {
    backend: target.backend, label: target.backend === "jev" ? "Jev" : "Decisions", provider: target.provider, model: target.model,
    ...await inspectSystem1Availability(registry, target.backend),
  };
}

function save(pi: ExtensionAPI, ctx: ExtensionContext, backend: System1Backend): void {
  try {
    saveSystem1Backend(backend);
  } catch {
    ctx.ui.notify(`Could not save System 1. Check permissions and correct any malformed configuration in ${system1Path()}.`, "error");
    return;
  }
  pi.events.emit(SYSTEM1_CHANGED, { backend });
  ctx.ui.notify(`System 1: ${backend === "jev" ? "Jev" : "OpenAI Decisions (API credits)"}. Disabled individual features stay disabled.`, "info");
}

/** Shared by the picker and direct command, inside their complete blocked lifetime. */
async function activate(pi: ExtensionAPI, ctx: ExtensionContext, backend: System1Backend, current: () => boolean): Promise<void> {
  if (!current()) return;
  if (backend === "openai-decisions" && !ctx.hasUI) {
    ctx.ui.notify(`OpenAI Decisions activation requires interactive billing confirmation. ${SETUP}`, "warning");
    return;
  }
  const setting = readSystem1Setting();
  if (setting.ok && setting.backend === backend) return;
  const key = setting.key;
  const unchanged = () => current() && readSystem1Setting().key === key;
  if (backend === "openai-decisions") {
    const availability = await inspectDecisionsAvailability(ctx.modelRegistry);
    if (!unchanged()) return;
    if (availability.availability !== "configured") {
      ctx.ui.notify(`OpenAI Decisions unavailable: ${availability.reason ?? "native capability or isolated credentials are not configured"}. ${SETUP}`, "warning");
      return;
    }
    const answer = await ctx.ui.select(BILLING_CONFIRMATION, ["Use included credits", "Keep current backend"]);
    if (answer !== "Use included credits" || !unchanged()) return;
    // Local configuration may have changed while the confirmation was open.
    const confirmed = await inspectDecisionsAvailability(ctx.modelRegistry);
    if (!unchanged()) return;
    if (confirmed.availability !== "configured") {
      ctx.ui.notify(`OpenAI Decisions unavailable. ${SETUP}`, "warning");
      return;
    }
  }
  if (unchanged()) save(pi, ctx, backend);
}

export async function selectSystem1Backend(pi: ExtensionAPI, ctx: ExtensionContext, backend: System1Backend, current: () => boolean = () => true): Promise<void> {
  if (backend === "jev" || !ctx.hasUI) return activate(pi, ctx, backend, current);
  await whileBlocked(pi.events, "System 1", () => activate(pi, ctx, backend, current));
}

export async function openSystem1Picker(pi: ExtensionAPI, ctx: ExtensionContext, current: () => boolean = () => true): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("System 1 picker requires UI. Use /system1 status or /system1 jev. " + SETUP, "warning");
    return;
  }
  await whileBlocked(pi.events, "System 1", async () => {
    const setting = readSystem1Setting();
    const target = resolveSystem1Target(DEFAULT_CLASSIFIER, setting);
    const [jev, decisions] = await Promise.all([
      inspectSystem1Availability(ctx.modelRegistry, "jev"), inspectDecisionsAvailability(ctx.modelRegistry),
    ]);
    const unchanged = () => current() && readSystem1Setting().key === setting.key;
    if (!unchanged()) return;
    // Native selects have a bounded question viewport at phone width. Keep the heading
    // visible; detailed local failures remain available through /system1 status.
    const local = (value: Pick<System1Status, "availability" | "reason">) => value.availability;
    const question = [
      "System 1", target.ok ? `Current: ${target.backend}` : "Current: unavailable",
      target.ok ? `Target: ${target.provider}/${target.model}` : "Target: unavailable",
      `Jev: ${local(jev)}; Decisions: ${local(decisions)}`, "Details/setup: /system1 status.",
      "Feature-off settings still apply.",
      "Local availability; billing unverified.",
    ].join("\n");
    const choice = await ctx.ui.select(question, ["Jev", "OpenAI Decisions (Pro credits)"]);
    if (!unchanged()) return;
    if (choice === "Jev") await activate(pi, ctx, "jev", unchanged);
    else if (choice === "OpenAI Decisions (Pro credits)") await activate(pi, ctx, "openai-decisions", unchanged);
  });
}
