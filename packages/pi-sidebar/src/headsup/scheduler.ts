// When heads-up mode checks: at main's turn boundaries, once a run is long, and not too often.
// Pure (the clock comes in as arguments), so the policy is easy to test.

export interface SchedulerOptions {
  /** A run is long from this many of main's replies on. */
  minReplies: number;
  /** …or from this long on. */
  minRunMs: number;
  /** Checks during a run are at least this far apart. */
  intervalMs: number;
  /** The check when a long run ends needs at least this long since the last one. */
  endIntervalMs: number;
}

export const DEFAULT_SCHEDULE: SchedulerOptions = {
  minReplies: 5,
  minRunMs: 2 * 60_000,
  intervalMs: 3 * 60_000,
  endIntervalMs: 60_000,
};

export type Trigger = "turn" | "end";

export class HeadsUpScheduler {
  private runStart: number | undefined;
  private replies = 0;
  private repliesSinceCheck = 0;
  private lastCheck = Number.NEGATIVE_INFINITY;
  inFlight = false;

  constructor(private readonly options: SchedulerOptions = DEFAULT_SCHEDULE) {}

  runStarted(now: number): void {
    this.runStart = now;
    this.replies = 0;
    this.repliesSinceCheck = 0;
  }

  private long(now: number): boolean {
    if (this.runStart === undefined) return false;
    return this.replies >= this.options.minReplies || now - this.runStart >= this.options.minRunMs;
  }

  /** Main finished a reply mid-run: whether to check now. `blocked` while a note is showing. */
  replied(now: number, blocked: boolean): boolean {
    if (this.runStart === undefined) return false;
    this.replies++;
    this.repliesSinceCheck++;
    return !blocked && !this.inFlight && this.long(now) && now - this.lastCheck >= this.options.intervalMs;
  }

  /** Main's run ended: whether a long run gets a last check on what came since the previous one. */
  ended(now: number, blocked: boolean): boolean {
    const due = !blocked && !this.inFlight && this.long(now) && this.repliesSinceCheck > 0 && now - this.lastCheck >= this.options.endIntervalMs;
    this.runStart = undefined;
    return due;
  }

  started(now: number): void {
    this.inFlight = true;
    this.lastCheck = now;
    this.repliesSinceCheck = 0;
  }

  finished(): void {
    this.inFlight = false;
  }
}
