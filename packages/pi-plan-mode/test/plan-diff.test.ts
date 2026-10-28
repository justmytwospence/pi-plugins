import assert from "node:assert/strict";
import { test } from "vitest";
import { planDiff } from "../src/plan-diff.js";

test("a plan diff lists changed lines only, with a gap between separate runs", () => {
  const before = "# Plan\n\n1. Pin data\n2. Keep it\n3. Same\n4. Old tail";
  const after = "# Plan\n\n1. Pin packages\n2. Keep it\n3. Same\n4. New tail";
  assert.deepEqual(planDiff(before, after), [
    { kind: "removed", text: "1. Pin data" },
    { kind: "added", text: "1. Pin packages" },
    { kind: "gap", text: "…" },
    { kind: "removed", text: "4. Old tail" },
    { kind: "added", text: "4. New tail" },
  ]);
  assert.deepEqual(planDiff("same", "same"), []);
});
