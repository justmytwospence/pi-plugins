import { expect, test } from "vitest";
import autoEffort from "../src/index.ts";
import { countsFromBranch, describeCounts, emptyCounts, tally } from "../src/stats.ts";
import { answers, fakeJev, harness } from "./harness.ts";

const state = (data: Record<string, unknown>) => ({ type: "custom", customType: "auto-effort:state", data });

test("tally sorts each decision by its reason", () => {
  const counts = emptyCounts();
  for (const data of [
    { reason: "up", latencyMs: 200 },
    { reason: "down", latencyMs: 400 },
    { reason: "hold", latencyMs: 300 },
    { reason: "ack", latencyMs: 100 },
    { reason: "go-ahead" },
    { reason: "go-ahead" },
    { reason: "assessment unavailable: timed out" },
    // An answer without a usable rating.
    { reason: "unavailable", latencyMs: 500 },
  ]) {
    tally(counts, data);
  }
  expect(counts).toEqual({ assessments: 6, skipped: 2, raised: 1, lowered: 1, held: 2, failed: 2, latencyMs: 1_500, timed: 5 });
});

test("tally ignores older reasons, missing reasons, bad latencies and non-objects", () => {
  const counts = emptyCounts();
  for (const data of [{ reason: "direct" }, { e: 0.2, dwell: 1 }, null, "up", { reason: "hold", latencyMs: -1 }, { reason: "up", latencyMs: Number.NaN }]) tally(counts, data);
  expect(counts).toEqual({ ...emptyCounts(), assessments: 2, held: 1, raised: 1 });
});

test("countsFromBranch reads only the state entries", () => {
  const branch = [
    state({ reason: "up", latencyMs: 100 }),
    { type: "custom", customType: "auto-effort:effort-updates", data: { reason: "up" } },
    { type: "message", message: { role: "user", content: "up" } },
    state({ reason: "go-ahead" }),
  ];
  expect(countsFromBranch(branch, "auto-effort:state")).toEqual({ ...emptyCounts(), assessments: 1, raised: 1, skipped: 1, latencyMs: 100, timed: 1 });
});

test("describeCounts", () => {
  expect(describeCounts(emptyCounts())).toBe("Session: no assessments yet.");
  expect(describeCounts({ ...emptyCounts(), skipped: 2 })).toBe("Session: 0 assessments; 2 settled without a call (go-ahead).");
  expect(describeCounts({ assessments: 1, skipped: 0, raised: 1, lowered: 0, held: 0, failed: 0, latencyMs: 0, timed: 0 })).toBe(
    "Session: 1 assessment: 1 raised, 0 lowered, 0 held, 0 failed.",
  );
  expect(describeCounts({ assessments: 14, skipped: 6, raised: 3, lowered: 2, held: 8, failed: 1, latencyMs: 2_755, timed: 13 })).toBe(
    "Session: 14 assessments (avg 212 ms): 3 raised, 2 lowered, 8 held, 1 failed; 6 settled without a call (go-ahead).",
  );
});

test("/auto-effort status counts this session's decisions, restored from the branch", async () => {
  const h = harness();
  autoEffort(h.pi);
  let fail = false;
  const jev = fakeJev(() => (fail ? { model: "jev-latest", stopReason: "error", answers: {}, errorMessage: "boom" } : answers(3)));
  let branch: unknown[] = [state({ reason: "down", latencyMs: 300 }), state({ reason: "go-ahead" }), state({ reason: "direct" })];
  const ctx = h.ctx({ modelRegistry: jev.registry, sessionManager: { getBranch: () => branch } });
  const status = async () => {
    await h.commands.get("auto-effort").handler("status", ctx);
    return ctx.ui.notes.at(-1)!.message.split("\n").find((line: string) => line.startsWith("Session:"));
  };
  await h.emit("session_start", { type: "session_start" }, ctx);
  expect(await status()).toBe("Session: 1 assessment (avg 300 ms): 0 raised, 1 lowered, 0 held, 0 failed; 1 settled without a call (go-ahead).");

  // Live decisions add to the restored counts: a raise, a go-ahead with no call, a hold, a failure.
  await h.emit("before_agent_start", { prompt: "redesign the sync engine" }, ctx);
  await h.emit("before_agent_start", { prompt: "thanks!" }, ctx);
  await h.emit("before_agent_start", { prompt: "and the conflict resolver too" }, ctx);
  fail = true;
  await h.emit("before_agent_start", { prompt: "and the queue" }, ctx);
  expect(jev.calls).toHaveLength(3);
  expect(h.entries.map((e) => (e.data as { reason?: string }).reason)).toEqual(["up", "go-ahead", "hold", "assessment unavailable: boom"]);
  const line = await status();
  expect(line).toMatch(/^Session: 4 assessments \(avg \d+ ms\): 1 raised, 1 lowered, 1 held, 1 failed; 2 settled without a call \(go-ahead\)\.$/u);

  // /tree to another branch: its own entries are the counts now.
  branch = [state({ reason: "hold", latencyMs: 100 })];
  await h.emit("session_tree", { type: "session_tree", newLeafId: "b", oldLeafId: "a" }, ctx);
  expect(await status()).toBe("Session: 1 assessment (avg 100 ms): 0 raised, 0 lowered, 1 held, 0 failed.");
  branch = [];
  await h.emit("session_tree", { type: "session_tree", newLeafId: null, oldLeafId: "b" }, ctx);
  expect(await status()).toBe("Session: no assessments yet.");
});
