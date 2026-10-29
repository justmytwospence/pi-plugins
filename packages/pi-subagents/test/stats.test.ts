import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { type StatRecord, computeStats, formatStats, latestPerRun, median, modelSource, readAllRuns, runRecords } from "../src/stats.ts";

const rec = (id: string, over: Partial<StatRecord> = {}): StatRecord => ({ id, agent: "explorer", model: "a/m1", status: "done", turns: 4, cost: 0.4, source: { model: "profile", thinking: "profile" }, ...over });

const records = [
  rec("1"),
  rec("2", { cost: 0.2, turns: 2 }),
  rec("3", { agent: "worker", model: "a/m2", cost: 2, turns: 10, source: { model: "explicit" } }),
  rec("4", { agent: "worker", model: "a/m2", status: "failed", error: "account rate limit reached; resume it after the window resets", cost: 0, turns: 0, source: { model: "tier" } }),
  rec("5", { agent: "worker", status: "failed", error: "boom", source: undefined, cost: 1, turns: 5 }),
  rec("6", { source: { model: "default" } }),
];

test("median and modelSource", () => {
  expect(median([])).toBe(0);
  expect(median([3, 1, 2])).toBe(2);
  expect(median([1, 2, 3, 4])).toBe(2.5);
  expect(modelSource({})).toBe("unknown");
  expect(modelSource({ source: { model: "weird" } })).toBe("unknown");
  expect(modelSource({ source: { model: "tier" } })).toBe("tier");
});

test("computeStats: runs, sources, roles, models, failures and cost", () => {
  const s = computeStats(records);
  expect(s.runs).toBe(6);
  expect(s.totalCost).toBeCloseTo(4);
  expect(s.bySource).toEqual({ explicit: 1, profile: 2, tier: 1, default: 1, unknown: 1 });
  expect(s.byRole[0]).toMatchObject({ role: "explorer", runs: 3 });
  expect(s.byRole[0]!.medianCost).toBeCloseTo(0.4);
  expect(s.byRole[1]).toMatchObject({ role: "worker", runs: 3 });
  expect(s.byRole[1]!.totalCost).toBeCloseTo(3);
  const m1 = s.byModel.find((m) => m.model === "a/m1")!;
  expect(m1.runs).toBe(4);
  expect(m1.medianCostPerTurn).toBeCloseTo(0.1);
  expect(s.byModel.find((m) => m.model === "a/m2")).toMatchObject({ runs: 2, medianCostPerTurn: 0.2 });
  expect(s.failed).toBe(2);
  expect(s.rateLimited).toBe(1);
  expect(computeStats([]).runs).toBe(0);
});

test("latestPerRun keeps the last record of each id", () => {
  expect(latestPerRun([rec("1", { status: "running" }), rec("2"), rec("1")]).map((r) => `${r.id} ${r.status}`)).toEqual(["1 done", "2 done"]);
});

test("formatStats is a compact table within the width", () => {
  const text = formatStats(computeStats(records), "in this session", 40);
  expect(text).toContain("6 runs, $4.00 total");
  expect(text).toMatch(/^profile\s+2\s+33%$/mu);
  expect(text).toMatch(/^unknown\s+1\s+17%$/mu);
  expect(text).toMatch(/^worker\s+3\s+\$1\.00\s+\$3\.00$/mu);
  expect(text).toContain("Failed: 2 (rate-limited: 1)");
  for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
  expect(text).not.toMatch(/[^\x00-\x7f…]/u);
  expect(formatStats(computeStats([]), "in this session")).toBe("No subagent runs in this session.");
});

test("runRecords and readAllRuns read run entries from branches and session files", () => {
  const entry = (data: unknown) => ({ type: "custom", customType: "subagents:run", data });
  expect(runRecords([entry(rec("1")), { type: "message" }, { type: "custom", customType: "other", data: {} }])).toHaveLength(1);
  const dir = mkdtempSync(path.join(tmpdir(), "stats-"));
  mkdirSync(path.join(dir, "--p--"));
  writeFileSync(path.join(dir, "--p--", "a.jsonl"), [JSON.stringify({ type: "session" }), JSON.stringify(entry(rec("1", { status: "running" }))), "{torn subagents:run", JSON.stringify(entry(rec("1")))].join("\n"));
  writeFileSync(path.join(dir, "b.jsonl"), JSON.stringify(entry(rec("2"))));
  const all = latestPerRun(readAllRuns(dir));
  expect(all.map((r) => `${r.id} ${r.status}`).sort()).toEqual(["1 done", "2 done"]);
  expect(readAllRuns(path.join(dir, "missing"))).toEqual([]);
});
