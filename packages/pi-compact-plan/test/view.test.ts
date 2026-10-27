import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { type DraftState, DraftView, statusLine } from "../src/view.ts";

initTheme("dark");
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/gu, "");
const theme: any = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

describe("DraftView", () => {
  it("draws the title, the draft and the status, and follows state changes", () => {
    const state: DraftState = { goal: "ship it", draft: "- **Next task:** ship", status: "pending" };
    const view = new DraftView(() => state, theme);
    const lines = view.render(60).map((l) => strip(l).trimEnd());
    expect(lines[0]).toBe(" Compaction focus · ship it");
    expect(lines.some((l) => l.includes("Next task:") && l.includes("ship"))).toBe(true);
    expect(lines.at(-1)).toBe(" Waiting for approval");
    state.draft = "- edited";
    state.status = "compacted";
    state.edited = true;
    state.tokens = 12345;
    state.cached = 97;
    const after = view.render(120).map((l) => strip(l).trimEnd());
    expect(after.some((l) => l.includes("edited"))).toBe(true);
    expect(after.at(-1)).toBe(" ✓ Compacted with this focus (edited) · drafting read 12,345 tokens, 97% from cache");
  });

  it("names every status", () => {
    const base = { goal: "", draft: "" };
    expect(statusLine({ ...base, status: "drafting" }, theme)).toBe("Revising…");
    expect(statusLine({ ...base, status: "cancelled" }, theme)).toBe("Cancelled");
    expect(statusLine({ ...base, status: "failed", error: "boom" }, theme)).toBe("Compaction failed: boom");
  });
});
