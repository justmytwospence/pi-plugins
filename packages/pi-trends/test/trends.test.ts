import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { niceMax, normalize, plot, slots, sparkline } from "../src/chart.ts";
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
  const calls = collectTurns(entries, { contextWindow: () => 10_000 });
  it("makes one point per model call, grouped by prompt", () => {
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => [c.prompt, c.promptStart])).toEqual([[1, true], [1, false], [2, true]]);
  });
  it("keeps per-call usage, tools and duration including tool results", () => {
    expect(calls[0]).toMatchObject({ input: 1000, output: 100, toolCalls: 1, durationMs: 5000, effort: "medium" });
    expect(calls[0].contextPercent).toBeCloseTo(11);
    expect(calls[1]).toMatchObject({ cacheRead: 1000, toolCalls: 1, durationMs: 3000 });
    expect(calls[1].contextTokens).toBe(1500);
  });
  it("tracks effort changes and compaction", () => {
    expect(calls[2]).toMatchObject({ effort: "high", compacted: true, contextTokens: 5000, durationMs: 30000 });
  });
  it("falls back to the current effort without change entries", () => {
    expect(collectTurns(entries.slice(1, 3), { initialEffort: "low" })[0].effort).toBe("low");
    expect(collectTurns(entries.slice(1, 3))[0].contextPercent).toBeUndefined();
  });
});

describe("charts", () => {
  it("sparkline maps 0-1 levels and leaves gaps", () => {
    expect(sparkline([0, 0.5, 1, undefined])).toBe("▁▄█ ");
  });
  it("niceMax rounds up to 1/2/2.5/5", () => {
    expect([0.7, 1, 1.2, 2.2, 3, 7, 120].map(niceMax)).toEqual([1, 1, 2, 2.5, 5, 10, 200]);
  });
  it("slots align calls across charts", () => {
    const x = slots(4, 10);
    expect(x.dotsPerSlot).toBe(5);
    expect([0, 1, 2, 3].map(x.cellOf)).toEqual([0, 2, 5, 7]);
    expect(x.callAt(5)).toBe(2);
  });
  it("bars fill from the bottom with gaps; steps hold levels", () => {
    const x = slots(2, 2);
    expect(plot([1, 0.5], "bars", x, 2, 1)).toEqual(["⡇⡄"]);
    expect(plot([0, 0], "bars", x, 2, 1)).toEqual(["  "]);
    const step = plot([0, 1], "step", x, 2, 1)[0];
    expect(step).toHaveLength(2);
  });
  it("log scale keeps small values visible", () => {
    expect(normalize({ log: true }, 5000, [0, 420_000])).toBeGreaterThan(0.25);
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
    expect(renderWidgetLine([], 40, theme)).toContain("no model calls");
  });
  it("overlay shows every metric and the cursor turn", () => {
    const { lines } = renderOverlay(turns, 0, 80, 12, theme);
    const text = lines.join("\n");
    for (const label of ["Context", "Effort", "New tokens", "Cost", "Tool calls", "Duration"]) expect(text).toContain(label);
    expect(text).toContain("Call 1 (prompt 1)");
    expect(text).toContain("prompt");
    expect(text).toContain("calls 1-3 of 3");
    expect(lines.every((l) => visibleWidth(l) <= 80)).toBe(true);
  });
  it("text report summarizes", () => {
    expect(formatReport(turns)).toMatch(/3 model calls over 2 prompts/);
  });
});

