import assert from "node:assert/strict";
import { test } from "vitest";
import { PLAN_STANDARD } from "../src/handoff.js";
import { enterPlanText } from "../src/inline-plan.js";
import { writeMergedRequest } from "../src/planner/prompt.js";
import { buildPlanModePrompt } from "../src/prompt.js";

test("the self-contained plan standard is in every prompt that asks for a plan", () => {
  assert.match(PLAN_STANDARD, /the worker of a plan model pair/u);
  assert.match(
    PLAN_STANDARD,
    /make every implementation decision in the plan yourself, after checking it in the code/u,
  );
  assert.ok(enterPlanText("/p/calm-river.md", false).includes(PLAN_STANDARD));
  const entered = enterPlanText("/p/calm-river.md", false);
  assert.match(entered, /write scratch files under \/p\/calm-river\.spike \(create it when you need it\)/u);
  assert.match(entered, /Apart from the scratch directory, it is the only file you may write/u);
  assert.doesNotMatch(entered, /Only read-only shell commands run/u);
  const prompt = buildPlanModePrompt();
  assert.ok(prompt.includes(PLAN_STANDARD));
  assert.doesNotMatch(prompt, /behavior-level/u);
  const merged = writeMergedRequest(false);
  assert.ok(merged.startsWith("Write plan M: merge the planners' plans"));
  assert.ok(merged.includes(PLAN_STANDARD));
  assert.match(writeMergedRequest(true), /to the same standard as before\.$/u);
});
