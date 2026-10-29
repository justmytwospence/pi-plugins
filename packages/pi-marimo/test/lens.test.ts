import { describe, expect, test } from "vitest";
import { NotebookState } from "../src/core/notebook.js";
import { lensLines, lensStatusText, snapshot } from "../src/core/render.js";
import type { Followed } from "../src/core/watcher.js";
import { NotebookView, notebookLines } from "../src/ui/view.js";
import { notebookKey } from "../src/ui/identity.js";
import { NotebookSource } from "../src/ui/source.js";
import { visibleWidth } from "@earendil-works/pi-tui";

const attachment = { url: "http://127.0.0.1:2799", sessionId: "s1", path: "/tmp/pmt/fit.py" };
const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };

// The shape of marimo-lens's `_state` trait (SelectionState.payload()).
function selection(n: number, cell: string, note = "") {
  return {
    id: `sel-${n}`, label: `S${n}`, note, createdAt: "2026-10-16T10:00:00Z",
    target: { kind: "notebook", cellIds: [cell] },
    anchor: { kind: "point", x: 0.4, y: 0.5 },
    description: { label: "Altair chart" },
    domHint: { tag: "rect", ariaLabel: "year: 1937; count: 412" },
    snapshot: { status: "available" },
  };
}
function state(selections: unknown[], history: unknown[] = [], current?: string) {
  return { revision: selections.length + history.length, nextLabel: `S${selections.length + history.length + 1}`, currentSelectionId: current ?? null, selections, history };
}
const open = (s: unknown) => ({ model_id: "m1", message: { method: "open", state: { _state: s, _selector: null, _lens_id: "abc" }, buffer_paths: [], buffers: [] } });
const update = (s: unknown) => ({ model_id: "m1", message: { method: "update", state: { _state: s }, buffer_paths: [], buffers: [] } });

function notebook(): NotebookState {
  const nb = new NotebookState();
  nb.apply("kernel-ready", {
    cell_ids: ["md", "chart"],
    codes: ['mo.md("# Drawings by year")', "chart = alt.Chart(df).mark_bar()"],
    names: ["_", "by_year"],
  });
  return nb;
}

describe("marimo-lens", () => {
  test("selections come from model-lifecycle open, update and close", () => {
    const nb = notebook();
    expect(nb.apply("model-lifecycle", open(state([])))).toBe(true);
    expect(nb.lens.present).toBe(true);
    expect(nb.lens.selections()).toEqual([]);
    expect(nb.apply("model-lifecycle", update(state([selection(1, "chart", "Why the 1937 spike?")], [], "sel-1")))).toBe(true);
    expect(nb.lens.current()?.label).toBe("S1");
    expect(nb.lens.selections()[0]).toMatchObject({ label: "S1", note: "Why the 1937 spike?", cells: ["chart"], image: "available", what: "Altair chart · year: 1937; count: 412" });
    // The same state again is no change.
    expect(nb.apply("model-lifecycle", update(state([selection(1, "chart", "Why the 1937 spike?")], [], "sel-1")))).toBe(false);
    // Resolved: into history.
    const receipt = { selectionId: "sel-1", label: "S1", note: "Why the 1937 spike?", target: { kind: "notebook", cellIds: ["chart"] }, addressedAt: "2026-10-16T10:05:00Z", summary: "Three creators made 80% of 1937." };
    nb.apply("model-lifecycle", update(state([], [receipt])));
    expect(nb.lens.selections()).toEqual([]);
    expect(nb.lens.history()[0]).toMatchObject({ label: "S1", summary: "Three creators made 80% of 1937." });
    expect(nb.apply("model-lifecycle", { model_id: "m1", message: { method: "close" } })).toBe(true);
    expect(nb.lens.present).toBe(false);
  });

  test("other widgets and unknown shapes are ignored; kernel-ready resets", () => {
    const nb = notebook();
    expect(nb.apply("model-lifecycle", { model_id: "w", message: { method: "open", state: { value: 3 } } })).toBe(false);
    expect(nb.apply("model-lifecycle", { model_id: "w", message: { method: "update", state: { _state: state([selection(1, "chart")]) } } })).toBe(false);
    expect(nb.apply("model-lifecycle", { model_id: "x", message: { method: "update", state: { _state: { revision: 1 } } } })).toBe(false);
    expect(nb.apply("model-lifecycle", { model_id: "m1", message: { method: "custom", content: {} } })).toBe(false);
    nb.apply("model-lifecycle", open(state([selection(1, "chart")])));
    expect(nb.lens.selections()).toHaveLength(1);
    nb.apply("kernel-ready", { cell_ids: [], codes: [], names: [] });
    expect(nb.lens.present).toBe(false);
  });

  test("context lines, status line and the snapshot", () => {
    const nb = notebook();
    nb.apply("model-lifecycle", open(state([selection(1, "chart", "make this blue"), selection(2, "chart")], [], "sel-2")));
    const lines = lensLines(nb);
    expect(lines[0]).toBe("Lens: 2 open selections the user marked on rendered results (newest current):");
    expect(lines[1]).toBe('  S1 "make this blue" on chart "by_year" under "Drawings by year" -- marked: Altair chart · year: 1937; count: 412; image available');
    expect(lines[2]).toContain("S2 (current) (no note)");
    expect(lines.join("\n")).toContain("help(marimo_lens.agent)");
    expect(snapshot([{ notebook: nb, attachment }])).toContain("Lens: 2 open selections");
    expect(lensStatusText([{ notebook: nb, attachment }])).toBe('lens: fit.py · S1 "make this blue" · S2');
    expect(lensStatusText([{ notebook: notebook(), attachment }])).toBeUndefined();
  });

  test("the notebook view lists selections and tags their cells", () => {
    const nb = notebook();
    nb.apply("model-lifecycle", open(state([selection(1, "chart", "make this blue")])));
    const { lines } = notebookLines(nb, theme, Date.now());
    expect(lines[0]).toBe("Lens");
    expect(lines[1]).toBe("  S1  make this blue  by_year");
    expect(lines.find((l) => l.includes("by_year  →") || l.includes("by_year S1"))).toContain("by_year S1");
    const f: Followed = { attachment, notebook: nb, connection: "connected", current: true, touchedAt: 0 };
    const view = new NotebookView({ requestRender: () => {}, terminal: { rows: 20 } } as any, theme, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
    try {
      for (const width of [46, 120]) {
        const out = view.render(width);
        for (const l of out) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
        expect(out.join("\n")).toContain("idle · 1 selection");
      }
    } finally { view.dispose(); }
  });

  test("new selections show in the pill until the user's next message", () => {
    const nb = notebook();
    const f: Followed = { attachment, notebook: nb, connection: "connected", current: true, touchedAt: 0 };
    const source = new NotebookSource({ followed: () => [f], open: async () => {}, interrupt: async () => {}, changed: () => {}, hostedChanged: () => {} });
    source.update([f], 1000);
    expect(source.pill(1000)).toEqual({ label: "1 notebook" });
    nb.apply("model-lifecycle", open(state([selection(1, "chart", "x"), selection(2, "chart")])));
    source.update([f], 2000);
    expect(source.pill(2000)).toEqual({ label: "1 notebook · 2 selections" });
    expect(source.entries(2000)[0]!.detail).toBe("idle · 2 selections");
    source.seen(3000);
    expect(source.pill(3000)).toEqual({ label: "1 notebook" });
  });
});
