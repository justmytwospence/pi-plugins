// Optional contract for one answer to "does this shell command only read?". pi-tool-gate owns it: its
// parser (bash.ts, plus the `readOnlyCommands` you configured) is the suite's read-only analysis.
// Other extensions that gate shell commands for their own reasons (pi-plan-mode's consult guard and
// planners, Sidebar's guard) ask on `pi-plugins.shell-reads.v1`, synchronously, and use their own
// parser only when nobody answers (the gate is not loaded). No import either way: each package
// keeps an identical copy of this file. Any owner saying false wins.

export const SHELL_READS_CHANNEL = "pi-plugins.shell-reads.v1";

export interface ShellReadsRequest {
  version: 1;
  command: string;
  cwd: string;
  /** The owner's answer: true when the command only reads, false when it may change something. */
  reads?: boolean;
}

interface Bus {
  on(channel: string, handler: (data: unknown) => unknown): unknown;
  emit(channel: string, data: unknown): void;
}

/**
 * Owner side: answer with `reads(command, cwd)`. Answer only from the command and directory,
 * synchronously and without side effects. A throwing predicate counts as false.
 */
export function declareShellReads(events: Bus | undefined, reads: (command: string, cwd: string) => boolean): void {
  events?.on(SHELL_READS_CHANNEL, (data: unknown) => {
    const request = data as Partial<ShellReadsRequest> | undefined;
    if (request?.version !== 1 || typeof request.command !== "string" || typeof request.cwd !== "string") return;
    let verdict: boolean;
    try {
      verdict = reads(request.command, request.cwd) === true;
    } catch {
      verdict = false;
    }
    request.reads = request.reads !== false && verdict;
  });
}

/** Asker side: whether the owner says this command only reads; undefined when none answers. */
export function askShellReads(events: Bus | undefined, command: string, cwd: string): boolean | undefined {
  if (!events) return undefined;
  const request: ShellReadsRequest = { version: 1, command, cwd };
  try {
    events.emit(SHELL_READS_CHANNEL, request);
  } catch {
    return undefined;
  }
  return typeof request.reads === "boolean" ? request.reads : undefined;
}
