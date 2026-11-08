import { expect, test } from "vitest";
import {
  DEFAULT_LIMITS,
  Tracker,
  limitsPolicy,
  pressureValue,
  windowLength,
  windowLabel,
} from "../src/quota-pressure.ts";

// The fixtures were written for these thresholds; the defaults are earlier and gentler (tested below).
const P = limitsPolicy({ caution: { used: 0.75, projected: 1.0 }, critical: { used: 0.9, projected: 1.5, exhaustMinutes: 30 } });

const M = 60_000;
const H = 60 * M;
const t0 = Date.UTC(2026, 0, 1);
const at = (min) => t0 + min * M;

function feed(t, window, resetsAt, points) {
  for (const [min, used] of points) t.record({ window, used, resetsAt, at: at(min) });
}

/** Weekly: a slow day, then +2% in the last half hour. */
function weeklyBurst() {
  const points = [];
  for (let m = -24 * 60; m <= -30; m += 30) points.push([m, 0.28 - 0.0015 * ((-30 - m) / 60)]);
  points.push([0, 0.3]);
  return points;
}

/** A burst: +44% in the last 20 minutes. */
const burst = [[-120, 0.2], [-90, 0.22], [-60, 0.24], [-30, 0.26], [-20, 0.4], [-10, 0.55], [0, 0.7]];
/** Steady 24% an hour for two hours. */
const steady = [[-120, 0.02], [-90, 0.14], [-60, 0.26], [-30, 0.38], [0, 0.5]];

test("absolute use enters a tier at once", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.76, resetsAt: at(120), at: t0 });
  expect(t.assess(t0, P)).toMatchObject({ tier: "caution", window: "5h", reason: "used" });
  t.record({ window: "5h", used: 0.91, resetsAt: at(120), at: at(1) });
  expect(t.assess(at(1), P)).toMatchObject({ tier: "critical" });

  const r = new Tracker();
  r.record({ window: "7d", used: 0.4, resetsAt: at(600), at: t0, exhausted: true });
  expect(r.assess(t0, P)).toMatchObject({ tier: "critical", reason: "exhausted", used: 1 });
});

test("a short burst far from the weekly reset stays none", () => {
  const t = new Tracker();
  feed(t, "7d", at(5 * 24 * 60), weeklyBurst());
  const p = t.assess(t0, P);
  expect(p.tier).toBe("none");
  expect(p.warming).toBe(false);
  expect(p.projected).toBeLessThan(0.9);
});

test("a burst near the 5h reset goes critical at once: it runs out within 30 minutes", () => {
  const t = new Tracker();
  feed(t, "5h", at(60), burst);
  const p = t.assess(t0, P);
  expect(p).toMatchObject({ tier: "critical", reason: "runs out soon", warming: false });
  expect(p.exhaustsAt - t0).toBeLessThan(30 * M);
});

test("sustained burn past the reset goes caution after a confirming assessment", () => {
  const t = new Tracker();
  feed(t, "5h", at(180), steady);
  const first = t.assess(t0, P);
  expect(first.tier).toBe("none");
  expect(t.view(t0, P)[0]).toMatchObject({ pending: "caution" });
  expect(t.assess(at(4), P).tier).toBe("none");
  t.record({ window: "5h", used: 0.52, resetsAt: at(180), at: at(5) });
  const p = t.assess(at(5), P);
  expect(p.tier).toBe("caution");
  expect(p.projected).toBeGreaterThan(1);
  expect(p.projected).toBeLessThan(1.5);
});

test("warm-up: the linear pace stands in until there is enough history", () => {
  // 34% used at 20% of a 5h window elapsed: projected 170%.
  const t = new Tracker();
  t.record({ window: "5h", used: 0.34, resetsAt: at(240), at: t0 });
  const p = t.assess(t0, P);
  expect(p.tier).toBe("none");
  expect(p.warming).toBe(true);
  expect(p.projected).toBeGreaterThan(1.5);
  expect(t.assess(at(5), P)).toMatchObject({ tier: "critical", warming: true, reason: "pace" });

  // 30% used at 5% elapsed: too early to say anything.
  const early = new Tracker();
  early.record({ window: "5h", used: 0.3, resetsAt: at(285), at: t0 });
  expect(early.assess(t0, P).projected).toBeUndefined();

  // Three readings spanning half an hour switch to the weighted forecast.
  const w = new Tracker();
  feed(w, "5h", at(240), [[-30, 0.3], [-15, 0.31], [0, 0.32]]);
  expect(w.assess(t0, P).warming).toBe(false);
});

test("a window rollover clears the tier at once", () => {
  const t = new Tracker();
  feed(t, "5h", at(180), steady);
  t.assess(t0, P);
  t.record({ window: "5h", used: 0.52, resetsAt: at(180), at: at(5) });
  expect(t.assess(at(5), P).tier).toBe("caution");
  // The reset moved: a new window, so the tier clears at once.
  t.record({ window: "5h", used: 0.52, resetsAt: at(400), at: at(6) });
  expect(t.assess(at(6), P).tier).toBe("none");
});

test("exit: two quiet assessments at least 5 minutes apart", () => {
  const t = new Tracker();
  t.record({ window: "spend_limit", used: 0.8, at: t0, spend: true });
  expect(t.assess(t0, P).tier).toBe("caution");
  // A small drop (under 5 points) is not a new window, and 0.76 stays above 0.70.
  t.record({ window: "spend_limit", used: 0.76, at: at(1), spend: true });
  expect(t.assess(at(1), P).tier).toBe("caution");
  // A drop of 5 points or more is a new window: history and tier start over.
  t.record({ window: "spend_limit", used: 0.6, at: at(2), spend: true });
  expect(t.assess(at(2), P).tier).toBe("none");

  const c = new Tracker();
  feed(c, "5h", at(180), steady);
  c.assess(t0, P);
  c.record({ window: "5h", used: 0.52, resetsAt: at(180), at: at(5) });
  expect(c.assess(at(5), P).tier).toBe("caution");
  for (let m = 10; m <= 90; m += 5) c.record({ window: "5h", used: 0.52, resetsAt: at(180), at: at(m) });
  // Quiet for over an hour: projected at reset is well under 95%, but the first quiet assessment only starts the exit.
  expect(c.assess(at(90), P).tier).toBe("caution");
  expect(c.assess(at(93), P).tier).toBe("caution");
  expect(c.assess(at(95), P).tier).toBe("none");
});

test("old readings count as a minimum, but not for the weighted forecast", () => {
  const t = new Tracker();
  feed(t, "5h", at(180), steady);
  // 20 minutes later, no new reading: absolute and linear pace still apply.
  const p = t.assess(at(20), P);
  expect(p.warming).toBe(true);
  expect(p.used).toBe(0.5);

  const abs = new Tracker();
  abs.record({ window: "5h", used: 0.8, resetsAt: at(120), at: t0 });
  expect(abs.assess(at(20), P).tier).toBe("caution");
  // Past the reset the reading means nothing.
  expect(abs.assess(at(121), P)).toMatchObject({ tier: "none" });
});

test("out-of-order readings are dropped; long gaps give no recent rate", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.5, resetsAt: at(120), at: t0 });
  t.record({ window: "5h", used: 0.1, resetsAt: at(120), at: at(-10) });
  expect(t.readings()[0].used).toBe(0.5);

  // Readings an hour apart: the recent rate falls back to the sustained one.
  const g = new Tracker();
  feed(g, "5h", at(100), [[-180, 0.1], [-120, 0.2], [-60, 0.3], [0, 0.4]]);
  const p = g.assess(t0, P);
  expect(p.warming).toBe(false);
  expect(Math.abs(p.projected - (0.4 + (0.1 / 60) * 100))).toBeLessThan(0.01);
});

test("the worst window wins", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.8, resetsAt: at(120), at: t0 });
  t.record({ window: "7d", used: 0.95, resetsAt: at(3000), at: t0 });
  const p = t.assess(t0, P);
  expect(p).toMatchObject({ tier: "critical", window: "7d" });
});

test("spend windows never project", () => {
  const t = new Tracker();
  for (let m = -60; m <= 0; m += 10) t.record({ window: "spend_limit", used: 0.3 + (m + 60) / 200, at: at(m), spend: true });
  const p = t.assess(t0, P);
  expect(p.projected).toBeUndefined();
  expect(p.tier).toBe("none");
});

test("disabled: no pressure", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.99, resetsAt: at(60), at: t0 });
  expect(t.assess(t0, { ...P, enabled: false })).toEqual({ tier: "none" });
});

test("settings: invalid values fall back to the defaults", () => {
  const p = limitsPolicy({ enabled: false, caution: { used: "high", projected: 1.2 }, critical: { exhaustMinutes: -1 }, steps: { critical: 1 }, extra: 1 });
  expect(p.enabled).toBe(false);
  expect(p.caution).toEqual({ used: 0.6, projected: 1.2 });
  expect(p.critical.exhaustMinutes).toBe(60);
  expect(p).not.toHaveProperty("steps");
  expect(limitsPolicy(undefined)).toEqual(DEFAULT_LIMITS);
});

test("defaults: caution from 60% used or 90% projected, critical from 80%, 120% projected or an hour left", () => {
  expect(DEFAULT_LIMITS.caution).toEqual({ used: 0.6, projected: 0.9 });
  expect(DEFAULT_LIMITS.critical).toEqual({ used: 0.8, projected: 1.2, exhaustMinutes: 60 });
  const t = new Tracker();
  t.record({ window: "5h", used: 0.61, resetsAt: at(120), at: t0 });
  expect(t.assess(t0, DEFAULT_LIMITS)).toMatchObject({ tier: "caution", reason: "used" });
  t.record({ window: "5h", used: 0.81, resetsAt: at(120), at: at(1) });
  expect(t.assess(at(1), DEFAULT_LIMITS)).toMatchObject({ tier: "critical" });
});

test("pressure mapping and window normalization preserve the pure engine policy", () => {
  expect(["none", "caution", "critical"].map(pressureValue)).toEqual([0, 0.5, 1]);
  for (const window of ["5h", "five_hour", "primary"]) expect(windowLength({ window })).toBe(5 * H);
  for (const window of ["7d", "7d scoped", "seven_day", "secondary"]) expect(windowLength({ window })).toBe(7 * 24 * H);
  expect(windowLength({ window: "unknown" })).toBeUndefined();
  expect(windowLength({ window: "5h", spend: true })).toBeUndefined();
  expect(windowLength({ window: "custom", lengthMs: 2 * H })).toBe(2 * H);
  expect(windowLabel({ window: "primary", lengthMs: 90 * M })).toBe("90m");
  expect(windowLabel({ window: "secondary" })).toBe("7d");
});

test("status reads and elapsed idle time do not advance confirmations; sparse boundary calls do", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.34, resetsAt: at(240), at: t0 });
  expect(t.assess(t0, P, false).tier).toBe("none");
  expect(t.view(at(30), P)[0]).not.toHaveProperty("pending");
  // The first committed boundary starts, rather than completes, confirmation.
  expect(t.assess(at(30), P).tier).toBe("none");
  expect(t.view(at(35), P)[0]).toMatchObject({ tier: "none", pending: "caution", ageMs: 35 * M });
  expect(t.assess(at(35), P, false).tier).toBe("caution");
  expect(t.view(at(35), P)[0].tier).toBe("none");
  expect(t.assess(at(35), P).tier).toBe("caution");
  expect(t.readings()).toHaveLength(1);
  expect(t.readings()[0].at).toBe(t0);
});

test("weighted forecast freshness uses the exact original observation age", () => {
  const t = new Tracker();
  feed(t, "5h", at(180), steady);
  expect(t.view(at(15), P)[0]).toMatchObject({ warming: false, ageMs: 15 * M });
  expect(t.view(at(15) + 1, P)[0]).toMatchObject({ warming: true, ageMs: 15 * M + 1 });
  expect(t.readings()[0].at).toBe(t0);
});

test("retaining the snapshot removes disappeared windows; tier reset keeps original readings", () => {
  const t = new Tracker();
  t.record({ window: "5h", used: 0.8, resetsAt: at(120), at: t0 });
  t.record({ window: "7d", used: 0.95, resetsAt: at(3000), at: t0 });
  expect(t.assess(t0, P).tier).toBe("critical");
  t.retain(new Set(["5h"]));
  expect(t.assess(t0, P)).toMatchObject({ tier: "caution", window: "5h" });
  t.clearTiers();
  expect(t.view(t0, P)[0].tier).toBe("none");
  expect(t.readings()).toHaveLength(1);
  expect(t.readings()[0].used).toBe(0.8);
  expect(t.assess(at(120), P).tier).toBe("none");
  expect(t.readings()).toEqual([]);
});
