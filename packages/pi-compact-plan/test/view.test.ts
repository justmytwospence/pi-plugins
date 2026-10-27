import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type DraftState, DraftView, reviewStatus } from "../src/view.ts";

initTheme("dark");
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/gu, "");
const bgs = (lines: string[]) => new Set(lines.flatMap((l) => [...l.matchAll(/\x1b\[48;[0-9;]*m/gu)].map((m) => m[0])));
const theme: any = {
  fg: (_c: string, s: string) => s,
  bold: (s: string) => s,
  bg: (c: string, s: string) => `\x1b[48;5;${c === "toolPendingBg" ? 1 : c === "toolSuccessBg" ? 2 : 3}m${s}\x1b[49m`,
};

describe("DraftView", () => {
  it("draws the review card, then the outcome, as plan mode draws a plan", () => {
    const state: DraftState = { goal: "ship it", draft: "- **Next task:** ship", status: "pending" };
    const view = new DraftView(() => state, theme);
    let raw = view.render(80);
    let lines = raw.map((l) => strip(l).trimEnd());
    expect(lines[0]).toBe("");
    expect(lines[1]).toBe(" Compaction plan review");
    expect(lines[2]).toMatch(/^ • Next task: ship|^ - Next task: ship/u);
    expect(lines.at(-2)).toBe(" Waiting for approval · next: ship it");
    expect(bgs(raw)).toEqual(new Set(["\x1b[48;5;1m"]));
    Object.assign(state, { draft: "- edited", status: "compacted", edited: true, tokens: 12345, cached: 97 });
    raw = view.render(120);
    lines = raw.map((l) => strip(l).trimEnd());
    expect(lines[1]).toBe(" Compaction plan");
    expect(lines.at(-2)).toBe(" ✓ Compacted with this focus (edited) · next: ship it · drafting read 12,345 tokens, 97% cached");
    expect(bgs(raw)).toEqual(new Set(["\x1b[48;5;2m"]));
  });

  it("folds a long decided focus until expanded", () => {
    const draft = Array.from({ length: 20 }, (_, i) => `- item ${i}`).join("\n");
    let expanded = false;
    const view = new DraftView(() => ({ goal: "", draft, status: "cancelled" }), theme, () => expanded);
    expect(view.render(80).map(strip).some((l) => l.includes("… 8 more lines (ctrl+o to expand)"))).toBe(true);
    expanded = true;
    expect(view.render(80).map(strip).some((l) => l.includes("item 19"))).toBe(true);
  });

  it("names every status", () => {
    const base = { goal: "", draft: "" };
    expect(reviewStatus({ ...base, status: "drafting" })).toEqual({ tone: "pending", text: "Revising…", context: undefined });
    expect(reviewStatus({ ...base, status: "compacted", continued: true }).text).toBe("✓ Compacted with this focus, continuing");
    expect(reviewStatus({ ...base, status: "cancelled" }).tone).toBe("warning");
    expect(reviewStatus({ ...base, status: "failed", error: "boom" })).toMatchObject({ tone: "error", text: "Compaction failed: boom" });
  });
});
