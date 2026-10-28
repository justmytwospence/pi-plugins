import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { pool } from "./pool.ts";

describe("pool", () => {
  test("runs every item once, never more than `concurrency` at a time", async () => {
    let inFlight = 0;
    let most = 0;
    const seen: number[] = [];
    await pool([...Array(20).keys()], 3, async (item, index) => {
      assert.equal(item, index);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      seen.push(item);
    });
    assert.equal(most, 3);
    assert.deepEqual(seen.sort((a, b) => a - b), [...Array(20).keys()]);
  });

  test("an empty list resolves, concurrency is at least one and at most the item count", async () => {
    await pool([], 8, async () => assert.fail("no items"));
    let most = 0;
    let inFlight = 0;
    const run = async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
    };
    await pool([1, 2], 0, run);
    assert.equal(most, 1);
    await pool([1, 2], 50, run);
    assert.equal(most, 2);
  });

  test("rejects with the first error", async () => {
    await assert.rejects(pool([1, 2, 3], 2, async (item) => { if (item === 2) throw new Error("boom"); }), /boom/u);
  });
});
