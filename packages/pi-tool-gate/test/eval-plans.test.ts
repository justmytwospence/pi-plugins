import { expect, test } from "vitest";
import { countCalls, type Judged } from "../eval/plans.ts";

const judged = (bare?: boolean): Judged => ({ label: "allowed", tool: "bash", args: "ls", rules: [], state: {}, ...(bare ? { bare: {} } : {}) });

test("countCalls: one request per judged call, a second for each call compared without its script", () => {
  expect(countCalls({ judged: [] })).toBe(0);
  expect(countCalls({ judged: [judged(), judged(), judged(true)] })).toBe(4);
});
