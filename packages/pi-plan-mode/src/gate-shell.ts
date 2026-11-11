// pi-tool-gate's answer to "does this shell command only read?" (shell-reads.ts), for the guards that
// run where this package's own session does not: planner sessions are in-process SDK sessions that
// load no extensions, so they reach the main session's bus through this binding. Undefined when the
// gate is not loaded: callers then use this package's own shell policy.
import { askShellReads } from "./shell-reads.js";

type Bus = Parameters<typeof askShellReads>[0];

let bus: Bus;

/** Bind the main session's event bus; called when this package starts. */
export function bindGateShell(events: Bus): void {
  bus = events;
}

/** The gate's verdict on a command, or undefined when it does not answer. */
export function gateShellReads(command: string, cwd: string): boolean | undefined {
  return askShellReads(bus, command, cwd);
}
