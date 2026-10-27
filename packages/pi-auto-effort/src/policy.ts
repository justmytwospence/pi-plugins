/** Thinking levels auto-effort moves between, lowest first; the index is the effort score. */
export const LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

/**
 * `smoothed`: a running average with a margin, a jump rule and a dwell before going down.
 * `direct`: each assessment's score sets the level (on models where a change keeps the cache).
 */
export type Mode = "smoothed" | "direct";

export interface Policy {
  mode: Mode;
  /** Lowest level auto-effort sets. */
  floor: Level;
  /** Weight of the newest score in the running average (1 = no smoothing). */
  alpha: number;
  /** The average must differ from the current level by this much to move. */
  margin: number;
  /** A single score this far above the current level jumps straight to it... */
  jump: number;
  /** ...when Jev is at least this confident. */
  jumpConfidence: number;
  /** Assessments (messages, and mid-run checks) a level must hold before it can go down. */
  minDwell: number;
  /** A go-ahead message ("yes", "continue") above this probability keeps the level. */
  ackThreshold: number;
  /** Direct mode: a score Jev is less confident about than this keeps the level. */
  minConfidence: number;
}

export const DEFAULT_POLICY: Policy = {
  mode: "smoothed",
  floor: "low",
  alpha: 0.5,
  margin: 0.6,
  jump: 1.5,
  jumpConfidence: 0.6,
  minDwell: 2,
  ackThreshold: 0.7,
  minConfidence: 0.45,
};

/** The configured mode; anything but `direct` is `smoothed`. */
export function policyMode(policy: Pick<Policy, "mode">): Mode {
  return policy.mode === "direct" ? "direct" : "smoothed";
}

export interface EffortState {
  /** Running average of depth scores; undefined before the first judgment. */
  e?: number;
  /** Assessments since the level last changed. */
  dwell: number;
  /** The highest level auto-effort may set: your latest manual choice. */
  ceiling: string;
}

export interface Judgment {
  /** Depth score 0-3. */
  score: number;
  confidence: number;
  /** Probability the message is a go-ahead relying on the earlier plan. */
  ack: number;
}

export function levelIndex(level: string): number {
  return LEVELS.indexOf(level as Level);
}

export interface Decision {
  level: string;
  state: EffortState;
  reason: "ack" | "jump" | "up" | "down" | "hold" | "unavailable" | "direct" | "unsure";
}

/**
 * The next level for a message or mid-run check. `current` is the session's level now. Levels
 * outside the managed range (off, minimal), or a ceiling below the floor, are left alone. `mode`
 * overrides the policy's (a caller falls back to smoothed where a change would cost the cache).
 */
export function decide(current: string, state: EffortState, judgment: Judgment | undefined, policy: Policy, mode: Mode = policyMode(policy)): Decision {
  return mode === "direct" ? decideDirect(current, state, judgment, policy) : decideSmoothed(current, state, judgment, policy);
}

/**
 * Direct mode: the score, rounded and kept within the floor and ceiling, is the level. A go-ahead
 * or a score Jev is unsure of keeps it. The average tracks the latest score, so switching back to
 * smoothed starts from it.
 */
export function decideDirect(current: string, state: EffortState, judgment: Judgment | undefined, policy: Policy): Decision {
  const floor = levelIndex(policy.floor);
  const ceiling = levelIndex(state.ceiling);
  const c = levelIndex(current);
  if (c < 0 || ceiling < 0 || ceiling < floor) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "hold" };
  if (!judgment) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "unavailable" };
  if (judgment.ack > policy.ackThreshold) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "ack" };
  if (judgment.confidence < policy.minConfidence) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "unsure" };
  const e = judgment.score;
  const target = Math.min(Math.max(Math.round(e), floor), ceiling);
  if (target === c) return { level: current, state: { ...state, e, dwell: state.dwell + 1 }, reason: "hold" };
  return { level: LEVELS[target] as string, state: { ...state, e, dwell: 0 }, reason: "direct" };
}

function decideSmoothed(current: string, state: EffortState, judgment: Judgment | undefined, policy: Policy): Decision {
  const floor = levelIndex(policy.floor);
  const ceiling = levelIndex(state.ceiling);
  const c = levelIndex(current);
  if (c < 0 || ceiling < 0 || ceiling < floor) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "hold" };
  if (!judgment) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "unavailable" };
  const s = judgment.score;
  // A go-ahead's own score says nothing about the work it approves, so it leaves the average alone.
  if (judgment.ack > policy.ackThreshold) return { level: current, state: { ...state, dwell: state.dwell + 1 }, reason: "ack" };
  let e = state.e === undefined ? s : policy.alpha * s + (1 - policy.alpha) * state.e;
  let target = c;
  let reason: Decision["reason"] = "hold";
  if (s - c >= policy.jump && judgment.confidence >= policy.jumpConfidence) {
    target = Math.round(s);
    reason = "jump";
    // Lift the average with the jump so it does not pull the level straight back down.
    e = Math.max(e, s);
  } else if (e - c >= policy.margin) {
    target = Math.round(e);
    reason = "up";
  } else if (c - e >= policy.margin && state.dwell >= policy.minDwell) {
    target = Math.round(e);
    reason = "down";
  }
  target = Math.min(Math.max(target, floor), ceiling);
  const level = LEVELS[target] as string;
  if (target === c) return { level: current, state: { ...state, e, dwell: state.dwell + 1 }, reason: "hold" };
  return { level, state: { ...state, e, dwell: 0 }, reason };
}

/**
 * Where the level is heading: "up" or "down" when the running average sits at least half the
 * margin away from `level` and the bounds leave room to move that way, else undefined.
 */
export function trend(level: string, state: EffortState, policy: Policy): "up" | "down" | undefined {
  const c = levelIndex(level);
  const ceiling = levelIndex(state.ceiling);
  const floor = levelIndex(policy.floor);
  if (state.e === undefined || c < 0 || ceiling < 0) return undefined;
  const threshold = policy.margin / 2;
  if (state.e - c >= threshold && c < ceiling) return "up";
  if (c - state.e >= threshold && c > floor) return "down";
  return undefined;
}
