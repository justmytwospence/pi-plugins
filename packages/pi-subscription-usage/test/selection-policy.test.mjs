import { test, expect } from "vitest";
import { DEFAULT_THRESHOLD, theta, climb } from "../src/selection-policy.ts";

test("theta defaults, clamps and sanitizes pressure and each threshold independently", () => {
  expect(DEFAULT_THRESHOLD).toEqual({ relaxed: 0.5, tight: 0.85 });
  for (const p of [-1, 0, NaN, Infinity, undefined, "1"]) expect(theta(p)).toBe(0.5);
  expect(theta(0.5)).toBe(0.675);
  expect(theta(1)).toBe(0.85);
  expect(theta(2)).toBe(0.85);
  expect(theta(1, { relaxed: NaN, tight: 2 })).toBe(1);
  expect(theta(0, { relaxed: -1, tight: NaN })).toBe(0);
  expect(theta(1, { relaxed: 0.2, tight: Infinity })).toBeCloseTo(0.85);
  expect(theta(0.5, { relaxed: 0.8, tight: 0.2 })).toBe(0.5);
});

test("climb selects the highest cumulative option, not argmax, with floating point slack", () => {
  const options = ["low", "medium", "high"];
  const answer = { choice: "high", confidence: 0.5, probabilities: { low: 0.15, medium: 0.35, high: 0.5 } };
  expect(climb(options, answer, 0.5)).toBe("high");
  expect(climb(options, answer, 0.85)).toBe("medium");
  expect(climb(options, answer, 0.850001)).toBe("low");
  expect(climb(["only"], answer, 1)).toBe("only");
});

test("climb falls back to choice confidence only when no option has a finite probability", () => {
  const options = ["low", "medium", "high"];
  expect(climb(options, { choice: "high", confidence: 0.9, probabilities: {} }, 0.85)).toBe("high");
  expect(climb(options, { choice: "high", confidence: 0.8, probabilities: { high: NaN } }, 0.85)).toBe("low");
  expect(climb(options, { choice: "high", confidence: 1, probabilities: { high: Infinity, medium: 0.6 } }, 0.5)).toBe("medium");
  expect(climb(options, { choice: "unknown", confidence: 1, probabilities: { unknown: 1 } }, 0.5)).toBe("low");
  expect(climb(options, { choice: "high", confidence: 1, probabilities: { low: 1 } }, 0.5)).toBe("low");
});
