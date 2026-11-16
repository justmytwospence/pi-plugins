import { test, expect } from "vitest";
import { DEFAULT_THRESHOLD, climb } from "../src/selection-policy.ts";

test("the default threshold is the median", () => {
  expect(DEFAULT_THRESHOLD).toBe(0.5);
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
