import { describe, expect, test, vi } from "vitest";
import { NotebookState } from "../src/core/notebook.js";
import { cellBadge, cellTitle, sectionOf } from "../src/ui/titles.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const table = `<marimo-ui-element object-id='a-0' random-id='r'><marimo-table data-data='&quot;[{&#92;&quot;a&#92;&quot;:1}]&quot;' data-total-rows='450' data-total-columns='4'></marimo-table></marimo-ui-element>`;
const widgets = [
  "<marimo-ui-element object-id='a-0' random-id='1'><marimo-slider data-initial-value='3' data-label='&quot;n&quot;' data-start='0' data-stop='10' data-steps='[]'></marimo-slider></marimo-ui-element>",
  "<marimo-ui-element object-id='a-1' random-id='2'><marimo-checkbox data-initial-value='true' data-label='&quot;on&quot;'></marimo-checkbox></marimo-ui-element>",
].join("");

function notebook(cells: Array<{ id: string; code: string; name?: string }>): NotebookState {
  const nb = new NotebookState();
  nb.apply("kernel-ready", { cell_ids: cells.map((c) => c.id), codes: cells.map((c) => c.code), names: cells.map((c) => c.name ?? "_") });
  return nb;
}
const cell = (nb: NotebookState, id: string) => nb.cells.get(id)!;
const error = (type: string, msg: string) => ({ channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: type, msg }] });

describe("a cell's title", () => {
  test("its name first; imports; the variables others use; what it shows; its other variables; its first line", () => {
    const nb = notebook([
      { id: "i", code: "import marimo as mo\nimport pandas as pd" },
      { id: "n", code: "daily = 1", name: "load" },
      { id: "d", code: "daily = load()\nsmooth = 2\nextra = 3\nlast = 4" },
      { id: "c", code: "alt.Chart(daily)" },
      { id: "w", code: "mo.ui.slider(1, 2)" },
      { id: "t", code: "df" },
      { id: "p", code: "tmp = 1\nprint(tmp)" },
      { id: "o", code: "\n  print('hello')\n" },
    ]);
    nb.apply("variables", { variables: [
      { name: "mo", declared_by: ["i"], used_by: ["w"] }, { name: "pd", declared_by: ["i"], used_by: [] },
      { name: "daily", declared_by: ["d"], used_by: ["c"] }, { name: "smooth", declared_by: ["d"], used_by: ["c"] }, { name: "extra", declared_by: ["d"], used_by: ["c"] }, { name: "last", declared_by: ["d"], used_by: [] },
      { name: "tmp", declared_by: ["p"], used_by: ["p"] },
    ] });
    nb.apply("variable-values", { variables: [{ name: "mo", value: "<module>", datatype: "module" }, { name: "pd", value: "<module>", datatype: "module" }] });
    nb.apply("cell-op", { cell_id: "c", status: "idle", output: { channel: "output", mimetype: "image/png", data: "iVBOR" } });
    nb.apply("cell-op", { cell_id: "w", status: "idle", output: { channel: "output", mimetype: "text/html", data: widgets } });
    nb.apply("cell-op", { cell_id: "t", status: "idle", output: { channel: "output", mimetype: "text/html", data: table } });
    expect(cellTitle(nb, cell(nb, "i"))).toBe("imports");
    expect(cellTitle(nb, cell(nb, "n"))).toBe("load");
    expect(cellTitle(nb, cell(nb, "d"))).toBe("daily, extra +1");
    expect(cellTitle(nb, cell(nb, "c"))).toBe("chart");
    expect(cellTitle(nb, cell(nb, "w"))).toBe("controls");
    expect(cellTitle(nb, cell(nb, "t"))).toBe("table");
    expect(cellTitle(nb, cell(nb, "p"))).toBe("tmp");
    expect(cellTitle(nb, cell(nb, "o"))).toBe("print('hello')");
  });

  test("imports are recognised by their code when no values are known; a markdown cell is its heading", () => {
    const nb = notebook([{ id: "i", code: "import numpy as np\nfrom os import path\nx = 1" }, { id: "m", code: 'mo.md("## The model\\n\\ntext")' }, { id: "p", code: 'mo.md("just some prose that goes on and on and on and on")' }]);
    expect(cellTitle(nb, cell(nb, "i"))).toBe("imports");
    expect(cellTitle(nb, cell(nb, "m"))).toBe("The model");
    expect(cellTitle(nb, cell(nb, "p")).length).toBeLessThanOrEqual(40);
    expect(cellTitle(nb, cell(nb, "p"))).toMatch(/^just some prose/u);
  });

  test("a cell's section path leaves out its own headings", () => {
    const nb = notebook([{ id: "a", code: 'mo.md("# One")' }, { id: "b", code: 'mo.md("## Two")' }, { id: "c", code: "x = 1" }]);
    expect(sectionOf(nb, "c")).toEqual(["One", "Two"]);
    expect(sectionOf(nb, "b")).toEqual(["One"]);
    expect(sectionOf(nb, "a")).toEqual([]);
  });
});

describe("a cell's badge", () => {
  test("what needs attention first, else the output's shape", () => {
    const nb = notebook([{ id: "a", code: "x = 1" }, { id: "b", code: "y = 2" }, { id: "c", code: "z = 3" }, { id: "d", code: "df" }, { id: "e", code: "w" }, { id: "f", code: "k = 1" }]);
    const badge = (id: string) => cellBadge(nb, cell(nb, id), 20_000, theme);
    expect(badge("a")).toBe("");
    nb.apply("cell-op", { cell_id: "a", status: "running", timestamp: 10 });
    expect(badge("a")).toBe("10s");
    nb.apply("cell-op", { cell_id: "b", status: "queued" });
    expect(badge("b")).toBe("queued");
    nb.apply("cell-op", { cell_id: "c", status: "idle", stale_inputs: true, output: error("KeyError", "'x'") });
    expect(badge("c")).toBe("KeyError");
    nb.apply("cell-op", { cell_id: "c", status: "idle", output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "ancestor-prevented", msg: "up" }] } });
    expect(badge("c")).toBe("blocked");
    nb.apply("cell-op", { cell_id: "c", status: "idle", stale_inputs: true, output: { channel: "output", mimetype: "text/plain", data: "3" } });
    expect(badge("c")).toBe("stale");
    nb.apply("cell-op", { cell_id: "d", status: "idle", output: { channel: "output", mimetype: "text/html", data: table } });
    expect(badge("d")).toBe("450×4");
    nb.apply("cell-op", { cell_id: "e", status: "idle", output: { channel: "output", mimetype: "text/html", data: widgets } });
    expect(badge("e")).toBe("2 inputs");
    nb.apply("cell-op", { cell_id: "f", status: "idle", output: { channel: "output", mimetype: "image/png", data: "iVBOR" } });
    expect(badge("f")).toBe("image");
  });

  test("a cell the agent changed or created says so, after the states that need attention", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(1_000_000);
      const nb = notebook([{ id: "a", code: "x = 1" }]);
      vi.setSystemTime(1_010_000);
      nb.apply("notebook-document-transaction", { transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "a", code: "x = 2" }, { type: "create-cell", cellId: "b", code: "y = 1" }] } });
      expect(cellBadge(nb, cell(nb, "a"), 0, theme)).toBe("changed");
      expect(cellBadge(nb, cell(nb, "b"), 0, theme)).toBe("new");
      nb.apply("cell-op", { cell_id: "a", status: "queued" });
      expect(cellBadge(nb, cell(nb, "a"), 0, theme)).toBe("queued");
    } finally { vi.useRealTimers(); }
  });
});
