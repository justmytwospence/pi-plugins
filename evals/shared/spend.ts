// What a live eval run costs. Node builtins only, no imports from any package.
//
// Every eval that calls `askJev` keeps one `Spend`, adds each outcome's `usage?.cost?.total` and
// prints `spend.line()` at the end. A call without a reported cost (a failure, or a registry that
// does not report usage) still counts as a call and adds nothing.
//
// `estimate` is the dry run's figure: calls times a flat per-call price. The price is a guess, not a
// measurement: `EVAL_COST_PER_CALL` (USD, default 0.0003). The range is 0.5x to 2x of the estimate.

/** USD per call when `EVAL_COST_PER_CALL` is not set: an estimate, not a measured price. */
export const DEFAULT_COST_PER_CALL = 0.0003;
/** The estimate's range around calls x price. */
export const RANGE = { low: 0.5, high: 2 } as const;

export class Spend {
  calls = 0;
  total = 0;

  /** Counts one call; adds its cost when it is a finite number. */
  add(cost?: number): this {
    this.calls++;
    if (typeof cost === "number" && Number.isFinite(cost)) this.total += cost;
    return this;
  }

  /** Counts one `askJev` outcome: its `usage.cost.total` when it has one (a failed outcome has none). */
  addOutcome(outcome: unknown): this {
    const cost = (outcome as { usage?: { cost?: { total?: unknown } } } | null | undefined)?.usage?.cost?.total;
    return this.add(typeof cost === "number" ? cost : undefined);
  }

  /** Folds another accumulator in (the variants of a comparison). */
  merge(other: Spend): this {
    this.calls += other.calls;
    this.total += other.total;
    return this;
  }

  /** `spend: $0.0123 over 41 calls` */
  line(): string {
    return `spend: $${this.total.toFixed(4)} over ${this.calls} calls`;
  }

  toJSON(): { spend: number; calls: number } {
    return { spend: this.total, calls: this.calls };
  }
}

/** `EVAL_COST_PER_CALL` as a positive number, else the default. */
export function costPerCall(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.EVAL_COST_PER_CALL);
  return env.EVAL_COST_PER_CALL?.trim() && Number.isFinite(n) && n > 0 ? n : DEFAULT_COST_PER_CALL;
}

export interface Estimate {
  calls: number;
  costPerCall: number;
  /** USD, rounded to 1e-6. */
  usd: { low: number; expected: number; high: number };
  note: string;
}

export function estimate(calls: number, env: NodeJS.ProcessEnv = process.env): Estimate {
  const perCall = costPerCall(env);
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    calls,
    costPerCall: perCall,
    usd: { low: round(calls * perCall * RANGE.low), expected: round(calls * perCall), high: round(calls * perCall * RANGE.high) },
    note: `estimate only: ${calls} calls x $${perCall} (EVAL_COST_PER_CALL, default ${DEFAULT_COST_PER_CALL}), range ${RANGE.low}x to ${RANGE.high}x`,
  };
}
