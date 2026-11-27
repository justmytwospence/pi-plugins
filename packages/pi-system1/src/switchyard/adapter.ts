/**
 * Switchyard adapter for @justmytwospence/pi-system1. Self-contained: the host loads this file with
 * Node's native type stripping, so it uses erasable TypeScript only and imports nothing but the
 * types of its contract copy (`contract.ts`, erased on load).
 *
 * Tool views only (contract v2; a host from before v2 never calls `toolView`, so this adapter does
 * nothing there): `system1_judge` reads `Judged only_reads, risky · jev · 0.8s`, opening to the
 * answers.
 */

import type { AdapterContext, AdapterFeature, ToolInfo, ToolViewData, UINode } from "./contract.ts";

/** Contract v2 feature guard: `ctx.features` is undefined on a host from before v2. */
const supports = (ctx: { readonly features?: readonly string[] }, feature: AdapterFeature): boolean =>
  ctx.features?.includes(feature) === true;

export const TOOL_NAME = "system1_judge";

/** The tool's result `details` (src/system1.ts System1Outcome), as far as the row needs it. */
type Outcome =
  | { ok: true; answers?: Record<string, Record<string, unknown>>; backend?: string; model?: string; latencyMs?: number }
  | { ok: false; code?: string; reason?: string; latencyMs?: number };

/** One answer in a few characters: a probability, a choice or a score. */
export function answerText(a: Record<string, unknown>): string {
  if (typeof a.probability === "number") return a.probability.toFixed(2);
  if (typeof a.choice === "string") return a.choice;
  if (typeof a.score === "number") return String(Math.round(a.score * 100) / 100);
  return "Unsupported answer";
}

export function judgeView(tool: ToolInfo, ctx: Pick<AdapterContext, "features">): ToolViewData | undefined {
  if (tool.name !== TOOL_NAME) return undefined;
  const questions = (tool.args as { questions?: unknown } | null | undefined)?.questions;
  const ids = questions && typeof questions === "object" ? Object.keys(questions) : [];
  const outcome = tool.details as Outcome | undefined;
  const meta: string[] = [];
  let detail: UINode | undefined;
  if (tool.result !== undefined && outcome && typeof outcome === "object") {
    if (outcome.ok) {
      const via = outcome.backend ?? outcome.model;
      if (via) meta.push(via.slice(0, 80));
      const answers = Object.entries(outcome.answers ?? {}).map(([label, a]) => ({ label, value: answerText(a), mono: true }));
      if (answers.length) {
        detail = supports(ctx, "ui.nodes.v2")
          ? { t: "facts", items: answers }
          : { t: "table", columns: ["Question", "Answer"], rows: answers.map((a) => [a.label, a.value]) };
      }
    } else {
      meta.push("failed");
      if (outcome.reason) detail = { t: "text", text: outcome.reason, tone: "danger" };
    }
    if (typeof outcome.latencyMs === "number") meta.push(`${(outcome.latencyMs / 1000).toFixed(1)}s`);
  } else if (tool.isError) meta.push("failed");
  return {
    kind: "other",
    verb: "Judged",
    activeVerb: "Judging",
    target: ids.join(", ").slice(0, 500),
    meta,
    ...(detail ? { detail } : {}),
  };
}

export default {
  toolView: judgeView,
};
