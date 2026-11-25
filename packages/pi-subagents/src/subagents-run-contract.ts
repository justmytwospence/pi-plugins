// Starting subagent runs from another extension over Pi's event bus. Package-local contract file:
// copied verbatim into pi-subagents and pi-ship (src/subagents-run-contract.ts); change it in both.
// There is no shared runtime package: nothing here imports a sibling.
//
// The caller emits a request carrying its own `ctx`; pi-subagents, when loaded, sets `result` to a
// Promise that resolves once every run has finished. Nothing answering leaves `result` unset, so a
// caller falls back without pi-subagents. The runs are ordinary foreground runs of the `subagent`
// tool (`signal` stops them).

export const SUBAGENTS_RUN_CHANNEL = "pi-plugins.subagents-run.v1";

export interface SubagentsRunTask {
  task: string;
  label?: string;
  agent?: string;
  cwd?: string;
}

export interface SubagentsRunOutput {
  label: string;
  status: string;
  output: string;
  error?: string;
}

export interface SubagentsRunRequest {
  version: 1;
  /** The caller's ExtensionContext (opaque here). */
  ctx: unknown;
  tasks: SubagentsRunTask[];
  signal?: AbortSignal;
  /** Set by pi-subagents. */
  result?: Promise<{ runs: SubagentsRunOutput[]; isError: boolean }>;
}

/** Emits the request; returns undefined when nothing answered (pi-subagents not loaded). */
export function requestSubagents(
  events: { emit(channel: string, data: unknown): void },
  request: Omit<SubagentsRunRequest, "version" | "result">,
): SubagentsRunRequest["result"] {
  const full: SubagentsRunRequest = { version: 1, ...request };
  events.emit(SUBAGENTS_RUN_CHANNEL, full);
  return full.result;
}
