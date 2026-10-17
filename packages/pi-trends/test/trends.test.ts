import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { columnChart, lineChart, sparkline } from "../src/chart.ts";
import { formatReport, renderOverlay, renderWidgetLine } from "../src/index.ts";
import { collectTurns } from "../src/turns.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;
const ts = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const usage = (input: number, output: number, cacheRead = 0, cost = 0.01) => ({ input, output, cacheRead, cacheWrite: 0, cost: { total: cost } });

const entries = [
  { type: "thinking_level_change", thinkingLevel: "medium", timestamp: ts(0) },
  { type: "message", timestamp: ts(1), message: { role: "user", content: "hi" } },
  { type: "message", timestamp: ts(5), message: { role: "assistant", provider: "p", model: "m", usage: usage(1000, 100), content: [{ type: "toolCall" }, { type: "text" }] } },
  { type: "message", timestamp: ts(6), message: { role: "toolResult" } },
  { type: "message", timestamp: ts(9), message: { role: "assistant", provider: "p", model: "m", usage: usage(200, 300, 1000), content: [{ type: "toolCall" }] } },
  { type: "thinking_level_change", thinkingLevel: "high", timestamp: ts(10) },
  { type: "compaction", timestamp: ts(11) },
  { type: "message", timestamp: ts(20), message: { role: "user", content: "again" } },
  { type: "message", timestamp: ts(50), message: { role: "assistant", provider: "p", model: "m", usage: usage(5000, 0), content: [] } },
];

describe("collectTurns", () => {
  const turns = collectTurns(entries, { contextWindow: () => 10_000 });
  it("splits at user messages and sums usage", () => {
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ index: 1, input: 1200, output: 400, cacheRead: 1000, toolCalls: 2, effort: "medium", durationMs: 8000 });
    expect(turns[0].cost).toBeCloseTo(0.02);
  });
  it("uses the last response for context and tracks effort and compaction", () => {
    expect(turns[0].contextTokens).toBe(1500);
    expect(turns[0].contextPercent).toBeCloseTo(15);
    expect(turns[1]).toMatchObject({ effort: "high", compacted: true, contextTokens: 5000, durationMs: 30000 });
  });
  it("falls back to the current effort without change entries", () => {
    expect(collectTurns(entries.slice(1, 3), { initialEffort: "low" })[0].effort).toBe("low");
    expect(collectTurns(entries.slice(1, 3))[0].contextPercent).toBeUndefined();
  });
});

describe("charts", () => {
  it("sparkline scales to max and leaves gaps", () => {
    expect(sparkline([0, 50, 100, undefined], 100)).toBe("▁▄█ ");
  });
  it("columnChart stacks blocks top-down", () => {
    expect(columnChart([2, 1], 2, 2)).toEqual(["█ ", "██"]);
  });
});

describe("rendering", () => {
  const turns = collectTurns(entries, { contextWindow: () => 10_000 });
  it("widget fits the width and degrades", () => {
    for (const width of [20, 46, 120]) {
      const line = renderWidgetLine(turns, width, theme);
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
    expect(renderWidgetLine(turns, 120, theme)).toContain("ctx");
    expect(renderWidgetLine([], 40, theme)).toContain("no turns");
  });
  it("overlay shows every metric and the cursor turn", () => {
    const { lines } = renderOverlay(turns, 0, 80, 2, theme);
    const text = lines.join("\n");
    for (const label of ["Context", "Effort", "Tokens", "Cost", "Tool calls", "Duration"]) expect(text).toContain(label);
    expect(text).toContain("Turn 1");
    expect(lines.every((l) => visibleWidth(l) <= 80)).toBe(true);
  });
  it("text report summarizes", () => {
    expect(formatReport(turns)).toMatch(/2 turns/);
  });
});

describe("lineChart", () => {
  it("joins points across the full width", () => {
    const { rows, cellOf } = lineChart([0, 10], 2, 1, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(2);
    expect(rows[0].trim()).not.toBe("");
    expect(cellOf(0)).toBe(0);
    expect(cellOf(1)).toBe(1);
  });
  it("breaks at gaps", () => {
    expect(lineChart([undefined, undefined], 2, 1).rows[0]).toBe("  ");
  });
});
