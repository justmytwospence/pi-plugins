import { isRecord } from "./config.ts";

export const PROMPTING_ENTRY = "tool-gate:prompting";
export const PROMPTING_STATUS_KEY = "permission-prompting";
/** A boolean is denyInsteadOfPrompting; undefined falls back to inheritance/config. */
export type PromptingOverride = boolean | undefined;

/** Fold only valid branch records; a reset clears all preceding overrides. */
export function restorePromptingOverride(entries: readonly unknown[]): PromptingOverride {
  let override: PromptingOverride;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== PROMPTING_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data) || data.version !== 1) continue;
    if (data.denyInsteadOfPrompting === null) override = undefined;
    else if (typeof data.denyInsteadOfPrompting === "boolean") override = data.denyInsteadOfPrompting;
  }
  return override;
}

export function effectiveDenyInsteadOfPrompting(override: PromptingOverride, inherited: boolean | undefined, configured: boolean): boolean {
  return override ?? inherited ?? configured;
}

export const PROMPTING_DISABLED = "Permission prompting is disabled. This call did not run.";
export const PROMPTING_CONTINUE = "Do not retry this call to request approval. Continue with permitted work and report this blocker if it prevents completion.";

/** A policy refusal, not a user decline and never a terminating block. */
export function promptingDenied(tool: string, held?: string): { block: true; reason: string } {
  return {
    block: true,
    reason: [
      `tool-gate held this ${tool} call: approval is required.`,
      ...(held ? [held] : []),
      PROMPTING_DISABLED,
      PROMPTING_CONTINUE,
    ].join("\n"),
  };
}
