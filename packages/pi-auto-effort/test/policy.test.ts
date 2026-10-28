import { describe, expect, test } from "vitest";
import {
  DEFAULT_POLICY,
  JUDGED_LEVELS,
  type Policy,
  cumulative,
  decide,
  pickIndex,
  policyConfig,
  pressureValue,
  range,
  threshold,
  trend,
} from "../src/policy.ts";

/** A judgment from [low, medium, high, xhigh] probabilities. */
const j = (p: number[], ack = 0) => ({ need: cumulative({ low: p[0]!, medium: p[1]!, high: p[2]!, xhigh: p[3]! }, JUDGED_LEVELS), ack });
const trivial = j([0.85, 0.1, 0.04, 0.01]);
const routine = j([0.15, 0.7, 0.1, 0.05]);
const multi = j([0.05, 0.2, 0.6, 0.15]);
const hard = j([0.02, 0.03, 0.25, 0.7]);
/** need(high) 0.45: under the relaxed theta 0.5, within the hysteresis of it. */
const borderline = j([0.15, 0.4, 0.35, 0.1]);
const CEILING: Policy = { ...DEFAULT_POLICY, bounds: "ceiling" };

describe("need", () => {
  test("need(L) is the probability of L or above, normalized", () => {
    const need = cumulative({ low: 0.1, medium: 0.2, high: 0.3, xhigh: 0.4 }, JUDGED_LEVELS);
    expect(need.low).toBeCloseTo(1);
    expect(need.medium).toBeCloseTo(0.9);
    expect(need.high).toBeCloseTo(0.7);
    expect(need.xhigh).toBeCloseTo(0.4);
    const unnormalized = cumulative({ low: 2, high: 2, bogus: 9, xhigh: Number.NaN }, JUDGED_LEVELS);
    expect(unnormalized).toEqual({ low: 1, medium: 0.5, high: 0.5, xhigh: 0 });
    expect(cumulative({}, JUDGED_LEVELS)).toEqual({ low: 0, medium: 0, high: 0, xhigh: 0 });
  });

  test("theta moves from relaxed to tight with pressure", () => {
    expect(pressureValue("none")).toBe(0);
    expect(pressureValue("caution")).toBe(0.5);
    expect(pressureValue("critical")).toBe(1);
    expect(threshold(DEFAULT_POLICY, 0)).toBeCloseTo(0.5);
    expect(threshold(DEFAULT_POLICY, 0.5)).toBeCloseTo(0.675);
    expect(threshold(DEFAULT_POLICY, 1)).toBeCloseTo(0.85);
    expect(threshold(DEFAULT_POLICY, 7)).toBeCloseTo(0.85);
  });

  test("pickIndex takes the highest key clearing theta within the range, else the lowest", () => {
    expect(pickIndex(multi.need, JUDGED_LEVELS, 0, 3, 0.5)).toBe(2);
    expect(pickIndex(multi.need, JUDGED_LEVELS, 0, 1, 0.5)).toBe(1);
    expect(pickIndex(multi.need, JUDGED_LEVELS, 1, 3, 0.99)).toBe(1);
  });
});

describe("decide", () => {
  test("the highest level whose need clears theta", () => {
    expect(decide("high", "xhigh", trivial, DEFAULT_POLICY, 0)).toMatchObject({ level: "low", reason: "down" });
    expect(decide("low", "xhigh", routine, DEFAULT_POLICY, 0)).toMatchObject({ level: "medium", reason: "up" });
    expect(decide("low", "xhigh", multi, DEFAULT_POLICY, 0)).toMatchObject({ level: "high", reason: "up" });
    expect(decide("low", "xhigh", hard, DEFAULT_POLICY, 0)).toMatchObject({ level: "xhigh", reason: "up", theta: 0.5 });
    // relaxed 0.5 is the median of Jev's distribution: need(high) 0.45 is not enough.
    expect(decide("low", "xhigh", borderline, DEFAULT_POLICY, 0)).toMatchObject({ level: "medium", reason: "up" });
  });

  test("pressure raises theta: only clear needs keep a high level", () => {
    // need(xhigh) 0.7: enough at caution (0.675), not at critical (0.85), where need(high) 0.95 is.
    expect(decide("low", "xhigh", hard, DEFAULT_POLICY, 0.5).level).toBe("xhigh");
    expect(decide("low", "xhigh", hard, DEFAULT_POLICY, 1).level).toBe("high");
    // need(high) 0.75 is not enough at critical; need(medium) 0.95 is.
    expect(decide("low", "xhigh", multi, DEFAULT_POLICY, 1).level).toBe("medium");
  });

  test("hysteresis: going down needs the current level's need below theta minus the margin", () => {
    // need(high) 0.45: under theta 0.5 but within 0.1 of it, so high holds.
    expect(decide("high", "xhigh", borderline, DEFAULT_POLICY, 0)).toMatchObject({ level: "high", reason: "hold" });
    // The same answer from below does not go up: raising uses theta directly.
    expect(decide("medium", "xhigh", borderline, DEFAULT_POLICY, 0)).toMatchObject({ level: "medium", reason: "hold" });
    // need(high) 0.2: clearly below, so it goes down.
    expect(decide("high", "xhigh", j([0.3, 0.5, 0.15, 0.05]), DEFAULT_POLICY, 0)).toMatchObject({ level: "medium", reason: "down" });
    expect(decide("high", "xhigh", borderline, { ...DEFAULT_POLICY, hysteresis: 0 }, 0)).toMatchObject({ level: "medium", reason: "down" });
  });

  test("a go-ahead keeps the level", () => {
    expect(decide("high", "xhigh", j([0.9, 0.05, 0.03, 0.02], 0.95), DEFAULT_POLICY, 0)).toMatchObject({ level: "high", reason: "ack" });
  });

  test("ceiling bounds: the manual level caps it, the floor holds it up", () => {
    expect(decide("medium", "medium", hard, CEILING, 0).level).toBe("medium");
    expect(decide("high", "high", trivial, { ...CEILING, floor: "medium" }, 0).level).toBe("medium");
    // A max ceiling only caps: the policy never picks max.
    expect(decide("max", "max", hard, CEILING, 0)).toMatchObject({ level: "xhigh", reason: "down" });
    expect(decide("medium", "medium", hard, DEFAULT_POLICY, 0, "ceiling").level).toBe("medium");
  });

  test("free bounds (the default): anything from the floor to policy.max, whatever the manual level", () => {
    expect(DEFAULT_POLICY.bounds).toBe("free");
    expect(decide("low", "low", hard, DEFAULT_POLICY, 0).level).toBe("xhigh");
    expect(decide("low", "low", hard, { ...DEFAULT_POLICY, max: "high" }, 0, "free").level).toBe("high");
    // max is never above xhigh.
    expect(range("low", { ...DEFAULT_POLICY, max: "max" }, "free")).toEqual({ floor: 0, upper: 3 });
    expect(decide("low", "high", hard, CEILING, 0, "free").level).toBe("xhigh");
  });

  test("levels outside the managed range and missing judgments are left alone", () => {
    expect(decide("off", "off", hard, DEFAULT_POLICY, 0)).toMatchObject({ level: "off", reason: "hold" });
    expect(decide("minimal", "minimal", hard, DEFAULT_POLICY, 0).level).toBe("minimal");
    expect(decide("minimal", "minimal", hard, DEFAULT_POLICY, 0, "free").level).toBe("minimal");
    expect(decide("high", "xhigh", undefined, DEFAULT_POLICY, 0)).toMatchObject({ level: "high", reason: "unavailable" });
  });
});

test("trend: up when the next level is close to theta, down when the level holds only through hysteresis", () => {
  expect(trend("high", "xhigh", borderline.need, 0.5, CEILING)).toBe("down");
  expect(trend("medium", "xhigh", borderline.need, 0.5, CEILING)).toBe("up");
  // No room above the ceiling.
  expect(trend("medium", "medium", borderline.need, 0.5, CEILING)).toBeUndefined();
  expect(trend("medium", "medium", borderline.need, 0.5, DEFAULT_POLICY)).toBe("up");
  expect(trend("high", "xhigh", multi.need, 0.5, CEILING)).toBeUndefined();
  expect(trend("low", "high", trivial.need, 0.5, CEILING)).toBeUndefined();
  expect(trend("medium", "xhigh", undefined, 0.5, CEILING)).toBeUndefined();
  expect(trend("minimal", "xhigh", hard.need, 0.5, CEILING)).toBeUndefined();
});

test("policyConfig keeps valid values and ignores old and invalid keys", () => {
  expect(policyConfig(undefined)).toEqual(DEFAULT_POLICY);
  const old = { mode: "direct", alpha: 0.3, margin: 1, jump: 2, minDwell: 5, floor: "medium", bounds: "ceiling" };
  const p: Policy = policyConfig(old);
  expect(p).toEqual({ ...DEFAULT_POLICY, floor: "medium", bounds: "ceiling" });
  expect(p).not.toHaveProperty("alpha");
  expect(policyConfig({ floor: "max", max: "max", bounds: "loose", threshold: { relaxed: 2, tight: 0.9 }, hysteresis: -1 })).toEqual({
    ...DEFAULT_POLICY,
    threshold: { relaxed: 0.5, tight: 0.9 },
  });
});
