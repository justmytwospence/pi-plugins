// Runs that outlive `/reload`. A reload loads this extension again in the same pi process and makes
// the old runtime stale (its pi.* calls throw). So the old runtime's session_shutdown (reason
// "reload") does not stop its children: it parks the calls whose outcome is still owed here, keyed
// by session file, and the new runtime's session_start adopts what was parked for its session. The
// registry is one per process, on globalThis, because the reloaded module is a fresh copy.
//
// A parked child keeps running; its callbacks go through its RunLink (run.ts), which the old
// runtime clears before parking and the adopting runtime sets again, so nothing reaches a stale
// runtime and a result that comes due meanwhile is delivered once, after adoption. A parcel no one
// adopts within 30 seconds (the reload failed, or the session went away) has its children stopped.
import type { Run } from "./run.ts";

export type Mode = "single" | "parallel" | "chain";

/** How long a parcel waits for its session to come back before its children are stopped. */
export const ADOPT_TIMEOUT_MS = 30_000;

const KEY = Symbol.for("pi-subagents.runs.v1");

/** One tool call whose result is still owed: its runs (ended or running) and what never started. */
export interface ParkedCall {
  mode: Mode;
  // Keep the original Run objects, including familyId/agentId. Adoption must never reserve
  // replacement observation identities or dispose the still-running child's observer.
  runs: Run[];
  /** Tasks of the call that had not started at the reload; they never will. */
  notStarted: number;
}

/** A result that was due but not yet sent (pi was busy), as the runtime queued it. */
export interface OwedResult {
  content: string;
  details: unknown;
  runs?: Run[];
  mode?: Mode;
  /** A line appended to the message, for example about tasks that never started. */
  note?: string;
}

/** What a runtime leaves for the next one of its session. */
export interface Parcel {
  calls: ParkedCall[];
  owed: OwedResult[];
  /** Runs whose result the agent already read. */
  consumed: string[];
}

interface Parked extends Parcel {
  timer: ReturnType<typeof setTimeout>;
}

function parcels(): Map<string, Parked> {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const current = g[KEY];
  if (current instanceof Map) return current as Map<string, Parked>;
  const next = new Map<string, Parked>();
  g[KEY] = next;
  return next;
}

/** The key runs are parked under: the session file, else (a session that is not saved) its id. */
export function sessionKey(sessionManager: { getSessionFile?: () => string | undefined; getSessionId?: () => string } | undefined): string | undefined {
  try {
    const file = sessionManager?.getSessionFile?.();
    if (file) return file;
    const id = sessionManager?.getSessionId?.();
    return id ? `session:${id}` : undefined;
  } catch {
    return undefined;
  }
}

/** Stops every child in a parcel; used when no runtime adopts it in time. */
function abandon(parcel: Parcel): void {
  for (const call of parcel.calls) {
    for (const run of call.runs) {
      try {
        run.child?.stop();
      } catch {
        // Already gone.
      }
    }
  }
}

/** Leaves `parcel` for the next runtime of the session `key`; unadopted after `timeoutMs`, its children are stopped. */
export function park(key: string, parcel: Parcel, timeoutMs = ADOPT_TIMEOUT_MS): void {
  const all = parcels();
  const previous = all.get(key);
  if (previous) {
    clearTimeout(previous.timer);
    parcel = { calls: [...previous.calls, ...parcel.calls], owed: [...previous.owed, ...parcel.owed], consumed: [...previous.consumed, ...parcel.consumed] };
  }
  const timer = setTimeout(() => {
    const entry = all.get(key);
    if (entry?.timer !== timer) return;
    all.delete(key);
    abandon(entry);
  }, timeoutMs);
  timer.unref?.();
  all.set(key, { ...parcel, timer });
}

/** Takes what was parked for the session `key`, if anything. */
export function adopt(key: string): Parcel | undefined {
  const all = parcels();
  const entry = all.get(key);
  if (!entry) return undefined;
  clearTimeout(entry.timer);
  all.delete(key);
  const { timer: _timer, ...parcel } = entry;
  return parcel;
}

/** Whether a run is parked, waiting for its session's next runtime. */
export function isParked(id: string): boolean {
  for (const entry of parcels().values()) {
    if (entry.calls.some((call) => call.runs.some((run) => run.id === id))) return true;
  }
  return false;
}
