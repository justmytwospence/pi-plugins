// The placement contract between pi-worktree (git, session files) and a placement provider
// (pi-herdr inside Herdr; a Switchyard adapter later): where a moved or opened session runs.
// Shared verbatim by pi-worktree and pi-herdr (scripts/test-contracts.mjs); no import either way.
// pi-worktree emits PLACE_EVENT synchronously on pi.events. A provider that can place sessions for
// this Pi calls claim(name) before the emit returns and acts only when it returned true; for a
// request (not a probe) it then calls done(result) exactly once.
export const PLACE_EVENT = "worktree:place";

export interface PlaceMove {
  kind: "move";
  /** The repository's main checkout. */
  root: string;
  /** The checkout the conversation continues in: a linked worktree, or `root`. */
  path: string;
  branch?: string;
  /** A persisted session file whose header cwd is `path`, started with `pi --session`. */
  file: string;
  /** Display title and agent-name basis. */
  title: string;
  model?: string;
  thinking?: string;
  /** First prompt of the moved session; absent: it starts idle. */
  prompt?: string;
}

export interface PlaceOpen {
  kind: "open";
  root: string;
  /** A linked worktree to show, resuming its latest session when nothing runs there. */
  path: string;
  branch?: string;
  title: string;
}

export type PlaceRequest = PlaceMove | PlaceOpen;

export type PlaceResult =
  | { ok: true; detail: string; /** Moves only: close this session's pane. Call it last. */ close?: () => Promise<void> }
  | { ok: false; error: string };

export interface PlaceEvent {
  /** Absent: a probe asking whether any provider is present. */
  request?: PlaceRequest;
  claim(provider: string): boolean;
  done(result: PlaceResult): void;
}

interface Bus {
  emit(channel: string, data: unknown): void;
}

/** Ask for placement: the claiming provider and its result, or undefined when none claimed. */
export function place(events: Bus, request?: PlaceRequest): { provider: string; result: Promise<PlaceResult> } | undefined {
  let provider: string | undefined;
  let settle!: (result: PlaceResult) => void;
  const result = new Promise<PlaceResult>((resolve) => { settle = resolve; });
  const event: PlaceEvent = {
    ...(request ? { request } : {}),
    claim: (name) => {
      if (provider !== undefined) return false;
      provider = name;
      return true;
    },
    done: (r) => settle(r),
  };
  try { events.emit(PLACE_EVENT, event); } catch { return undefined; }
  return provider === undefined ? undefined : { provider, result };
}
