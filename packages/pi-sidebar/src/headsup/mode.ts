// Heads-up mode's setting for one session (on unless switched off; stored in main's session, so it
// follows /reload, resume and /tree) and what its checks have cost so far.

export const HEADSUP_ENTRY = "sidebar:headsup";
/**
 * `0` (or `off`, `false`) switches heads-up mode off by default; `sidebar` keeps it on but shows notes
 * only in Sidebar; `/sidebar headsup on|sidebar|off` still changes it per session.
 */
export const HEADSUP_ENV = "PI_SIDEBAR_HEADSUP";
/** `1` logs every check to ~/.pi/agent/pi-sidebar/headsup.log. */
export const HEADSUP_DEBUG_ENV = "PI_SIDEBAR_HEADSUP_DEBUG";

/** Where notes go: Sidebar when open and above main's editor otherwise, or only ever Sidebar. */
export type HeadsUpWhere = "any" | "sidebar";

export interface HeadsUpEntry {
  version: 1;
  on: boolean;
  /** Missing in entries written before the setting existed: "any". */
  where?: HeadsUpWhere;
  at: number;
}

type Entry = { type?: string; customType?: string; data?: unknown };

export function headsUpDefault(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[HEADSUP_ENV]?.trim().toLowerCase();
  return !(value === "0" || value === "off" || value === "false" || value === "no");
}

export function headsUpWhereDefault(env: NodeJS.ProcessEnv = process.env): HeadsUpWhere {
  return env[HEADSUP_ENV]?.trim().toLowerCase() === "sidebar" ? "sidebar" : "any";
}

/** Heads-up mode's last setting on a branch, if it was ever set. */
export function headsUpFromBranch(branch: readonly unknown[]): HeadsUpEntry | undefined {
  let found: HeadsUpEntry | undefined;
  for (const raw of branch) {
    const entry = raw as Entry;
    if (entry?.type !== "custom" || entry.customType !== HEADSUP_ENTRY) continue;
    const data = entry.data as Partial<HeadsUpEntry> | undefined;
    if (data?.version === 1 && typeof data.on === "boolean") {
      found = { version: 1, on: data.on, at: Number(data.at) || 0 };
      if (data.where === "sidebar" || data.where === "any") found.where = data.where;
    }
  }
  return found;
}

export interface CheckUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type CheckOutcome = "note" | "none" | "skipped" | "failed";

export class HeadsUpStats {
  checks = 0;
  notes = 0;
  skipped = 0;
  failed = 0;
  readonly usage: CheckUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  lastSkip: string | undefined;

  record(outcome: CheckOutcome, usage?: Partial<CheckUsage>, reason?: string): void {
    if (outcome === "skipped") {
      this.skipped++;
      this.lastSkip = reason;
      return;
    }
    if (outcome === "failed") this.failed++;
    else this.checks++;
    if (outcome === "note") this.notes++;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) this.usage[key] += usage?.[key] ?? 0;
  }

  reset(): void {
    this.checks = this.notes = this.skipped = this.failed = 0;
    Object.assign(this.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    this.lastSkip = undefined;
  }
}
