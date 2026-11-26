/**
 * Switchyard adapter for @justmytwospence/pi-next-prompt. Self-contained: the host loads this file
 * with Node's native type stripping, so it uses erasable TypeScript only and imports nothing but the
 * types of its contract copy (`contract.ts`, erased on load).
 *
 * Tool views only (contract v2; a host from before v2 never calls `toolView`, so this adapter does
 * nothing there): `offer_prompt` and `offer_terminal` read `Offered prompt <text> · displayed`.
 */

import type { ToolInfo, ToolViewData } from "./contract.ts";

const VERBS: Record<string, { verb: string; activeVerb: string; arg: string }> = {
  offer_prompt: { verb: "Offered prompt", activeVerb: "Offering prompt", arg: "text" },
  offer_terminal: { verb: "Offered command", activeVerb: "Offering command", arg: "command" },
};

/** The plugin's result `details` (src/index.ts OfferDetails). */
type OfferDetails = { status?: string; reason?: string };

export function offerView(tool: ToolInfo): ToolViewData | undefined {
  const v = VERBS[tool.name];
  if (!v) return undefined;
  const raw = (tool.args as Record<string, unknown> | null | undefined)?.[v.arg];
  const text = typeof raw === "string" ? raw : "";
  const lines = text.split("\n");
  const details = (tool.details ?? undefined) as OfferDetails | undefined;
  const status = typeof details?.status === "string" ? details.status : tool.isError ? "blocked" : undefined;
  const meta = tool.result === undefined || !status ? [] : [status === "queued" ? "queued behind a draft" : status];
  if (status === "blocked" && typeof details?.reason === "string") meta.push(details.reason.slice(0, 80));
  return {
    kind: "other",
    verb: v.verb,
    activeVerb: v.activeVerb,
    target: `${lines[0]!.slice(0, 200)}${lines.length > 1 || lines[0]!.length > 200 ? "…" : ""}`,
    meta,
    ...(text && (lines.length > 1 || text.length > 200)
      ? { detail: tool.name === "offer_terminal" ? { t: "code", text, lang: "bash" } : { t: "markdown", text } }
      : {}),
  };
}

export default {
  toolView: offerView,
};
