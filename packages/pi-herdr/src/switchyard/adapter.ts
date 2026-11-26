/**
 * Switchyard adapter for @justmytwospence/pi-herdr. Self-contained: the host loads this file with
 * Node's native type stripping, so it uses erasable TypeScript only and imports nothing but the
 * types of its contract copy (`contract.ts`, erased on load).
 *
 * Tool views only (contract v2; a host from before v2 never calls `toolView`, so this adapter does
 * nothing there): each `herdr` action is one row, `Messaged reviewer · queue` or `Spawned fix-login
 * · worktree · fix-login`, opening to the message or task.
 */

import type { ToolInfo, ToolViewData } from "./contract.ts";

export const TOOL_NAME = "herdr";

const VERBS: Record<string, [string, string]> = {
  list: ["Listed agents", "Listing agents"],
  send: ["Messaged", "Messaging"],
  read: ["Read", "Reading"],
  wait: ["Waited on", "Waiting on"],
  spawn: ["Spawned", "Spawning"],
  interrupt: ["Interrupted", "Interrupting"],
  close: ["Closed", "Closing"],
  crew: ["Crew", "Crew"],
};

export function herdrView(tool: ToolInfo): ToolViewData | undefined {
  if (tool.name !== TOOL_NAME) return undefined;
  const args = (tool.args ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof args[k] === "string" && (args[k] as string).trim() ? (args[k] as string).trim() : undefined);
  const action = str("action") ?? "";
  const [verb, activeVerb] = VERBS[action] ?? ["Called herdr", "Calling herdr"];
  const names = Array.isArray(args.names) ? args.names.filter((n): n is string => typeof n === "string") : [];
  const firstLine = (s: string | undefined) => s?.split("\n")[0]!.slice(0, 120);
  let target = "";
  if (action === "send") target = str("name") ?? (names.length ? names.join(", ") : (str("cwd_prefix") ?? ""));
  else if (action === "spawn") target = str("name") ?? firstLine(str("task")) ?? "";
  else if (action === "crew") target = str("op") ?? "status";
  else if (action !== "list") target = str("name") ?? "";
  const meta: string[] = [];
  const machine = str("machine");
  if (machine) meta.push(machine.slice(0, 80));
  if (action === "send") {
    const delivery = str("delivery");
    if (delivery) meta.push(delivery);
    if (args.await_reply === true) meta.push("awaiting reply");
  }
  if (action === "spawn") {
    meta.push(str("where") ?? "tab");
    const branch = str("branch");
    if (branch) meta.push(branch.slice(0, 80));
    if (args.fork === true) meta.push("fork");
  }
  if (tool.isError) meta.push("failed");
  const body = action === "send" ? str("message") : action === "spawn" ? str("task") : undefined;
  return {
    kind: "other",
    verb,
    activeVerb,
    target: target.slice(0, 500),
    meta: meta.slice(0, 6),
    ...(body ? { detail: { t: "markdown", text: body } } : {}),
  };
}

export default {
  toolView: herdrView,
};
