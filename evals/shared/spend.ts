// Catalog-estimated usage cost for a live eval, not a cash charge or verified credit debit.
// Node builtins only, no imports from any package.
//
// Every eval keeps one `Spend`, adds each outcome's `usage?.cost?.total` (including failures), and
// prints `spend.line()` at the end. A call without a reported cost still counts and adds nothing.
//
// `estimate` is the dry run's figure: calls times a flat per-call price. The price is a guess, not a
// measurement: `EVAL_COST_PER_CALL` (USD, default 0.0003). The range is 0.5x to 2x of the estimate.

/** USD per call when `EVAL_COST_PER_CALL` is not set: an estimate, not a measured price. */
export const DEFAULT_COST_PER_CALL = 0.0003;
/** The estimate's range around calls x price. */
export const RANGE = { low: 0.5, high: 2 } as const;

/** Metadata-only audit; never inputs, answers or raw provider responses. */
export interface AttemptAudit {
  backend?: string;
  provider?: string;
  model?: string;
  targetKey?: string;
  status?: string;
  code?: string;
  reason?: string;
  latencyMs?: number;
  retryAt?: number;
  sdkCalls?: number;
  usage?: unknown;
}

export class Spend {
  /** Logical requests, not provider attempts or HTTP invoices. */
  calls = 0;
  total = 0;
  backendAttempts: Record<string, number> = {};
  registryCalls = 0;
  actualProviders: Record<string, number> = {};
  attempts: AttemptAudit[] = [];

  /** Counts one call; adds its cost when it is a finite number. */
  add(cost?: number): this {
    this.calls++;
    if (typeof cost === "number" && Number.isFinite(cost)) this.total += cost;
    return this;
  }

  /** Counts one outcome and adds its reported `usage.cost.total`, including on failure. */
  addOutcome(outcome: unknown): this {
    const result = outcome as {
      ok?: boolean; backend?: string; provider?: string; model?: string;
      usage?: { cost?: { total?: unknown } }; attempts?: AttemptAudit[];
    } | null | undefined;
    // The executor already aggregates failed and successful attempt usage. Never sum it again.
    const cost = result?.usage?.cost?.total;
    this.add(typeof cost === "number" ? cost : undefined);
    for (const attempt of result?.attempts ?? []) {
      const { backend, provider, model, targetKey, status, code, reason, latencyMs, retryAt, sdkCalls, usage } = attempt;
      this.attempts.push({ backend, provider, model, targetKey, status, code, reason, latencyMs, retryAt, sdkCalls, usage });
      if (backend && (status === "failed" || status === "succeeded")) this.backendAttempts[backend] = (this.backendAttempts[backend] ?? 0) + 1;
      if (typeof sdkCalls === "number" && Number.isInteger(sdkCalls) && sdkCalls >= 0) this.registryCalls += sdkCalls;
    }
    if (result?.ok && result.backend && result.provider && result.model) {
      const key = JSON.stringify([result.backend, result.provider, result.model]);
      this.actualProviders[key] = (this.actualProviders[key] ?? 0) + 1;
    }
    return this;
  }

  /** Folds another accumulator in (the variants of a comparison). */
  merge(other: Spend): this {
    this.calls += other.calls;
    this.total += other.total;
    this.registryCalls += other.registryCalls;
    for (const key of Object.keys(other.backendAttempts)) this.backendAttempts[key] = (this.backendAttempts[key] ?? 0) + other.backendAttempts[key]!;
    for (const key of Object.keys(other.actualProviders)) this.actualProviders[key] = (this.actualProviders[key] ?? 0) + other.actualProviders[key]!;
    this.attempts.push(...other.attempts);
    return this;
  }

  /** Catalog estimate, not a cash charge or verified credit debit. */
  line(): string {
    const audit = this.attempts.length ? `; ${Object.values(this.backendAttempts).reduce((a, b) => a + b, 0)} backend attempts, ${this.registryCalls} registry calls` : "";
    return `spend: $${this.total.toFixed(4)} over ${this.calls} calls (catalog estimate; not a cash charge or verified credit debit)${audit}`;
  }

  /** Operational observations, not HTTP invoices or verified credit debits. */
  audit() {
    return { backendAttempts: { ...this.backendAttempts }, registryCalls: this.registryCalls,
      actualProviders: { ...this.actualProviders }, attempts: this.attempts.slice() };
  }

  toJSON() {
    return { spend: this.total, calls: this.calls, ...this.audit() };
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
