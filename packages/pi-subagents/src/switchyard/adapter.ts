/**
 * Switchyard adapter for @justmytwospence/pi-subagents. Self-contained: the host loads this file with
 * Node's native type stripping, so it imports nothing and uses erasable TypeScript only. The
 * local types are structurally compatible with Switchyard's UINode and AdapterContext.
 */

export type SubagentLink = {
  runId: string;
  label: string;
  status: string;
  sessionFile: string | null;
};
export type AdapterContext = {
  readonly state: {
    get<T = unknown>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    keys(): string[];
  };
  linkSubagent(link: SubagentLink): void;
};
export type SessionEntryInfo = { type: string; customType?: string; data?: unknown };
export type ToolEndEvent = {
  toolCallId: string;
  name: string;
  args: unknown;
  result: unknown;
  isError: boolean;
  details?: unknown;
};

/**
 * Run entries (`subagents:run`) and `subagent` tool
 * results (`details.runs`) become subagent links, keeping the latest state per run id. Clients
 * open a linked run as a read-only view of its native session file
 * ("Subagent: view only. Live control is not supported.").
 */

export const RUN_ENTRY = "subagents:run";
export const TOOL_NAME = "subagent";
export const VIEW_ONLY_NOTE = "Subagent: view only. Live control is not supported.";

export interface RunView {
  id: string;
  agent?: string;
  task?: string;
  label?: string;
  status: "running" | "done" | "failed" | "stopped" | "lost" | string;
  sessionFile?: string;
}

function asRun(x: unknown): RunView | undefined {
  if (!x || typeof x !== "object") return undefined;
  const r = x as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.status !== "string") return undefined;
  return r as unknown as RunView;
}

export function runLink(run: RunView): SubagentLink {
  const task = run.task ? (run.task.length > 60 ? `${run.task.slice(0, 57)}...` : run.task) : "";
  const label =
    run.label?.trim() || [run.agent, task].filter(Boolean).join(": ") || `Subagent ${run.id}`;
  return {
    runId: run.id,
    label,
    status: run.status,
    sessionFile: typeof run.sessionFile === "string" ? run.sessionFile : null,
  };
}

function publish(run: RunView, ctx: AdapterContext) {
  const link = runLink(run);
  const key = `run:${run.id}`;
  const prev = ctx.state.get<SubagentLink>(key);
  if (
    prev &&
    prev.label === link.label &&
    prev.status === link.status &&
    prev.sessionFile === link.sessionFile
  ) {
    return;
  }
  ctx.state.set(key, link);
  ctx.linkSubagent(link);
}

export default {
  onEntry(entry: SessionEntryInfo, ctx: AdapterContext): void {
    if (entry.customType !== RUN_ENTRY) return;
    const run = asRun(entry.data);
    if (run) publish(run, ctx);
  },

  onToolEnd(e: ToolEndEvent, ctx: AdapterContext): void {
    if (e.name !== TOOL_NAME) return;
    const details = (e.details ?? (e.result as { details?: unknown } | null)?.details) as
      | { runs?: unknown }
      | undefined;
    if (!Array.isArray(details?.runs)) return;
    for (const r of details.runs) {
      const run = asRun(r);
      if (run) publish(run, ctx);
    }
  },
};
