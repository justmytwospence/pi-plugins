import { describe, expect, it } from "vitest";
import { askJevBool } from "../src/jev.ts";

const question = { instructions: "Does it change anything?", criteria: { true: "yes", false: "no" } };

function registry(results: unknown[]) {
  let calls = 0;
  return {
    get calls() { return calls; },
    findOfType: () => ({}),
    classify: async () => {
      calls++;
      return results.shift();
    },
  };
}

describe("askJevBool", () => {
  it("retries a timed-out request once", async () => {
    const reg = registry([
      { answers: {}, stopReason: "error", errorMessage: "Request timed out after 5000ms" },
      { answers: { q: { type: "bool", probability: 0.2 } }, stopReason: "stop" },
    ]);
    expect(await askJevBool(reg, {}, question)).toEqual({ ok: true, probability: 0.2 });
    expect(reg.calls).toBe(2);
  });

  it("does not retry other errors", async () => {
    const reg = registry([{ answers: {}, stopReason: "error", errorMessage: "400" }]);
    expect(await askJevBool(reg, {}, question)).toEqual({ ok: false, reason: "400" });
    expect(reg.calls).toBe(1);
  });
});
