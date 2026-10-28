// The threshold rule. Jev answers a choice over the four judged levels; need(L) is the probability
// the work needs at least L (the sum of the probabilities for L and every level above it). The level
// is the highest one within the bounds whose need clears a threshold theta, which rises with
// subscription pressure: relaxed when there is none, tight when a window is critical. A level only
// goes down once the current level's need is clearly below theta (hysteresis), so a borderline
// answer does not flip-flop.

/** Thinking levels auto-effort moves between, lowest first. */
export const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

/** The levels Jev chooses between, lowest first. The policy never picks `max`. */
export const JUDGED_LEVELS = ["low", "medium", "high", "xhigh"] as const;
const TOP = JUDGED_LEVELS.length - 1;

/**
 * `ceiling`: your latest manual level is the highest auto-effort sets.
 * `free`: any level from `floor` to `max`; a manual change sets the level now but is not a cap.
 */
export type Bounds = "ceiling" | "free";

export interface Policy {
  /** Lowest level auto-effort sets. */
  floor: Level;
  bounds: Bounds;
  /** Highest level in `free` bounds (never above xhigh). */
  max: Level;
  /** theta with no subscription pressure (relaxed) and at critical pressure (tight). */
  threshold: { relaxed: number; tight: number };
  /** The level goes down only when the current level's need is below theta minus this. */
  hysteresis: number;
  /** A go-ahead message ("yes", "continue") above this probability keeps the level. */
  ackThreshold: number;
}

export const DEFAULT_POLICY: Policy = {
  floor: "low",
  bounds: "free",
  max: "xhigh",
  // relaxed 0.5: the level is the median of Jev's distribution, unbiased.
  threshold: { relaxed: 0.5, tight: 0.85 },
  hysteresis: 0.1,
  ackThreshold: 0.7,
};

/** `raw` checked against the defaults; anything invalid keeps the default. Old keys are ignored. */
export function policyConfig(raw: unknown): Policy {
  const v = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const unit = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1 ? x : d);
  const level = (x: unknown, d: Level) => (typeof x === "string" && levelIndex(x) >= 0 && levelIndex(x) <= TOP ? (x as Level) : d);
  const t = (v.threshold && typeof v.threshold === "object" ? v.threshold : {}) as Record<string, unknown>;
  return {
    floor: level(v.floor, DEFAULT_POLICY.floor),
    bounds: v.bounds === "free" ? "free" : v.bounds === "ceiling" ? "ceiling" : DEFAULT_POLICY.bounds,
    max: level(v.max, DEFAULT_POLICY.max),
    threshold: { relaxed: unit(t.relaxed, DEFAULT_POLICY.threshold.relaxed), tight: unit(t.tight, DEFAULT_POLICY.threshold.tight) },
    hysteresis: unit(v.hysteresis, DEFAULT_POLICY.hysteresis),
    ackThreshold: unit(v.ackThreshold, DEFAULT_POLICY.ackThreshold),
  };
}

export function levelIndex(level: string): number {
  return LEVELS.indexOf(level as Level);
}

export interface Judgment {
  /** need(L) for each judged level: the probability the work needs at least L. */
  need: Record<string, number>;
  /** Probability the message is a go-ahead relying on the earlier plan. */
  ack: number;
}

/**
 * need(K) for each key of `order` (lowest first): the sum of the probabilities of K and every key
 * after it. Probabilities are normalized over `order`; missing or invalid ones count as zero.
 */
export function cumulative(probabilities: Record<string, number>, order: readonly string[]): Record<string, number> {
  const p = order.map((k) => {
    const x = probabilities[k];
    return typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;
  });
  const total = p.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  let sum = 0;
  for (let i = order.length - 1; i >= 0; i--) {
    sum += p[i]!;
    out[order[i]!] = total > 0 ? Math.min(1, sum / total) : 0;
  }
  return out;
}

/** Subscription pressure 0-1 by tier: none 0, caution 0.5, critical 1. */
export function pressureValue(tier: string | undefined): number {
  return tier === "critical" ? 1 : tier === "caution" ? 0.5 : 0;
}

/** theta = relaxed + (tight - relaxed) * p. */
export function threshold(policy: Pick<Policy, "threshold">, p: number): number {
  const q = Math.min(1, Math.max(0, Number.isFinite(p) ? p : 0));
  return policy.threshold.relaxed + (policy.threshold.tight - policy.threshold.relaxed) * q;
}

const EPS = 1e-9;

/** The highest index in [lo, hi] whose key's need is at least theta, else lo. */
export function pickIndex(need: Record<string, number>, order: readonly string[], lo: number, hi: number, theta: number): number {
  for (let i = hi; i > lo; i--) if ((need[order[i]!] ?? 0) >= theta - EPS) return i;
  return lo;
}

/**
 * The managed range as level indexes, or undefined when the levels are left alone (a ceiling of
 * off or minimal, or one below the floor). `ceiling` is your latest manual level.
 */
export function range(ceiling: string, policy: Pick<Policy, "floor" | "max">, bounds: Bounds): { floor: number; upper: number } | undefined {
  const floor = Math.min(Math.max(0, levelIndex(policy.floor)), TOP);
  if (bounds === "free") return { floor, upper: Math.min(Math.max(levelIndex(policy.max), floor), TOP) };
  const c = levelIndex(ceiling);
  if (c < 0 || c < floor) return undefined;
  return { floor, upper: Math.min(c, TOP) };
}

export interface Decision {
  level: string;
  reason: "ack" | "up" | "down" | "hold" | "unavailable";
  theta: number;
}

/**
 * The next level for a message or mid-run check. `current` is the session's level now, `ceiling`
 * your latest manual level, `p` the subscription pressure (0-1). Levels outside the managed range
 * (off, minimal) are left alone.
 */
export function decide(current: string, ceiling: string, judgment: Judgment | undefined, policy: Policy, p: number, bounds: Bounds = policy.bounds): Decision {
  const theta = threshold(policy, p);
  const r = range(ceiling, policy, bounds);
  const c = levelIndex(current);
  if (!r || c < 0) return { level: current, reason: "hold", theta };
  if (!judgment) return { level: current, reason: "unavailable", theta };
  // A go-ahead's own rating says nothing about the work it approves.
  if (judgment.ack > policy.ackThreshold) return { level: current, reason: "ack", theta };
  const target = pickIndex(judgment.need, JUDGED_LEVELS, r.floor, r.upper, theta);
  if (target === c) return { level: current, reason: "hold", theta };
  // Going down from a level inside the bounds needs a clear case.
  if (target < c && c <= r.upper && c >= r.floor && (judgment.need[current] ?? 0) >= theta - policy.hysteresis - EPS) {
    return { level: current, reason: "hold", theta };
  }
  return { level: LEVELS[target] as string, reason: target > c ? "up" : "down", theta };
}

/**
 * Where the level is heading after the last judgment: "up" when the next level's need is within
 * the hysteresis of theta and the bounds leave room, "down" when the current level holds only
 * through the hysteresis, else undefined.
 */
export function trend(level: string, ceiling: string, need: Record<string, number> | undefined, theta: number | undefined, policy: Policy, bounds: Bounds = policy.bounds): "up" | "down" | undefined {
  const r = range(ceiling, policy, bounds);
  const c = levelIndex(level);
  if (!r || !need || theta === undefined || c < 0) return undefined;
  if (c > r.floor && c <= TOP && (need[level] ?? 0) < theta - EPS) return "down";
  if (c < r.upper && (need[JUDGED_LEVELS[c + 1]!] ?? 0) >= theta - policy.hysteresis - EPS) return "up";
  return undefined;
}
