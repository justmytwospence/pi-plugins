/**
 * Switchyard adapter for @justmytwospence/pi-issues. Self-contained: the host loads this file with
 * Node's native type stripping, so it uses erasable TypeScript only and imports nothing but the
 * types of its contract copy (`contract.ts`, erased on load).
 *
 * Tool views only (contract v2; a host from before v2 never calls `toolView`, so this adapter does
 * nothing there): `issue` reads `Started issue #12 · login-retry` or `Set issue status #12 · Done`.
 */

import type { ToolInfo, ToolViewData } from "./contract.ts";

export const TOOL_NAME = "issue";

export function issueView(tool: ToolInfo): ToolViewData | undefined {
  if (tool.name !== TOOL_NAME) return undefined;
  const args = (tool.args ?? {}) as Record<string, unknown>;
  const numbers = Array.isArray(args.issues) ? args.issues.filter((n): n is number => typeof n === "number") : [];
  const target = numbers.map((n) => `#${n}`).join(" ");
  const str = (k: string) => (typeof args[k] === "string" && (args[k] as string).trim() ? (args[k] as string).trim() : undefined);
  const meta: string[] = [];
  if (args.action === "status") {
    const status = str("status");
    if (status) meta.push(status.slice(0, 80));
    const repo = str("repo");
    if (repo) meta.push(repo.slice(0, 80));
  } else {
    const branch = str("branch");
    if (branch) meta.push(branch.slice(0, 80));
  }
  if (tool.isError) meta.push("failed");
  const plural = numbers.length > 1 ? "s" : "";
  return args.action === "status"
    ? { kind: "other", verb: `Set issue${plural} status`, activeVerb: `Setting issue${plural} status`, target, meta }
    : { kind: "other", verb: `Started issue${plural}`, activeVerb: `Starting issue${plural}`, target, meta };
}

export default {
  toolView: issueView,
};
