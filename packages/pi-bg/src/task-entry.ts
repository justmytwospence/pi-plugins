// A task's state as data, for remote hosts. Switchyard's adapter gets only the footer status text in
// RPC mode (and nothing at all from a terminal session); a `pi-bg:task` session entry at each change
// that matters (start, ready, end, and progress moving to another tenth) lets it list the tasks with
// their state and times without parsing that text. pi-bg never reads these entries back.
import type { Task } from "./registry.ts";

export const TASK_ENTRY = "pi-bg:task";

export interface TaskRecord {
  version: 1;
  id: string;
  name: string;
  kind: Task["kind"];
  status: Task["status"];
  origin: Task["origin"];
  /** The command, clipped. */
  command: string;
  cwd: string;
  logPath: string;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  /** A service whose ready pattern has matched. */
  ready: boolean;
  keep: boolean;
  killedBy?: Task["killedBy"];
  progress?: { fraction: number; count?: string; note?: string };
}

const COMMAND_LIMIT = 500;

export function taskRecord(t: Task): TaskRecord {
  return {
    version: 1,
    id: t.id,
    name: t.name,
    kind: t.kind,
    status: t.status,
    origin: t.origin,
    command: t.command.length > COMMAND_LIMIT ? `${t.command.slice(0, COMMAND_LIMIT - 1)}…` : t.command,
    cwd: t.cwd,
    logPath: t.logPath,
    startedAt: t.startedAt,
    ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
    ...(t.exitCode !== undefined ? { exitCode: t.exitCode } : {}),
    ready: t.ready,
    keep: t.keep,
    ...(t.killedBy ? { killedBy: t.killedBy } : {}),
    ...(t.progress
      ? {
          progress: {
            fraction: t.progress.fraction,
            ...(t.progress.count ? { count: t.progress.count } : {}),
            ...(t.progress.note ? { note: t.progress.note } : {}),
          },
        }
      : {}),
  };
}

/** The tenth a task's progress is in, so a record is written about ten times per task at most. */
export function progressTenth(t: Task): number | undefined {
  return t.progress ? Math.min(10, Math.floor(t.progress.fraction * 10)) : undefined;
}
