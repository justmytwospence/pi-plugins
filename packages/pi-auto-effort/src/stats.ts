// Counts of what auto-effort did on this session's branch, for `/auto-effort status`. Every
// decision is an `auto-effort:state` entry, so the same function tallies a live decision and the
// entries of a restored branch.

export interface Counts {
  /** Jev calls whose answer was applied (including failed ones). */
  assessments: number;
  /** Prompts settled without a call: a go-ahead the pre-filter recognized. */
  skipped: number;
  raised: number;
  lowered: number;
  /** Assessments that kept the level (including a go-ahead Jev recognized). */
  held: number;
  /** Assessments with no usable answer. */
  failed: number;
  /** Sum and number of the latencies of answered calls. */
  latencyMs: number;
  timed: number;
}

export const emptyCounts = (): Counts => ({ assessments: 0, skipped: 0, raised: 0, lowered: 0, held: 0, failed: 0, latencyMs: 0, timed: 0 });

/**
 * Adds one `auto-effort:state` entry's data. The reason tells the kind: `go-ahead` (no call),
 * `assessment unavailable: ...` (failed), `up`, `down`, `hold` or `ack`. Entries of older versions
 * with other reasons are not counted.
 */
export function tally(counts: Counts, data: unknown): void {
  if (!data || typeof data !== "object") return;
  const { reason, latencyMs } = data as { reason?: unknown; latencyMs?: unknown };
  if (typeof reason !== "string") return;
  if (reason === "go-ahead") {
    counts.skipped++;
    return;
  }
  if (reason.startsWith("assessment unavailable")) counts.failed++;
  else if (reason === "up") counts.raised++;
  else if (reason === "down") counts.lowered++;
  else if (reason === "hold" || reason === "ack") counts.held++;
  else return;
  counts.assessments++;
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
    counts.latencyMs += latencyMs;
    counts.timed++;
  }
}

/** The counts of a branch's `auto-effort:state` entries. */
export function countsFromBranch(entries: readonly unknown[], customType: string): Counts {
  const counts = emptyCounts();
  for (const entry of entries as Array<{ type?: string; customType?: string; data?: unknown }>) {
    if (entry?.type === "custom" && entry.customType === customType) tally(counts, entry.data);
  }
  return counts;
}

/** `Session: 14 assessments (avg 212 ms): 3 raised, 2 lowered, 8 held, 1 failed; 6 settled without a call (go-ahead).` */
export function describeCounts(counts: Counts): string {
  if (!counts.assessments && !counts.skipped) return "Session: no assessments yet.";
  const parts: string[] = [];
  if (counts.assessments) {
    const average = counts.timed ? ` (avg ${Math.round(counts.latencyMs / counts.timed)} ms)` : "";
    parts.push(`${counts.assessments} assessment${counts.assessments === 1 ? "" : "s"}${average}: ${counts.raised} raised, ${counts.lowered} lowered, ${counts.held} held, ${counts.failed} failed`);
  } else parts.push("0 assessments");
  if (counts.skipped) parts.push(`${counts.skipped} settled without a call (go-ahead)`);
  return `Session: ${parts.join("; ")}.`;
}
