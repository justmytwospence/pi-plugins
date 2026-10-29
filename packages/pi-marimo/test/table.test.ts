import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import type { TableData } from "../src/core/output.js";
import { parseFilter } from "../src/ui/table-session.js";
import { columnCard, rowCard, tableLines, type TableRender } from "../src/ui/table.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/gu, "");

const data = (extra: Partial<TableData> = {}): TableData => ({
  columns: ["name", "n", "ok"],
  numeric: [false, true, false],
  rows: [],
  records: [
    { name: "alpha", n: 709000, ok: true, _marimo_row_id: "r0" },
    { name: "b", n: 2, ok: false, _marimo_row_id: "r1" },
    { name: "c", n: null, ok: true, _marimo_row_id: "r2" },
  ],
  fieldTypes: { name: { kind: "string", dtype: "object" }, n: { kind: "integer", dtype: "int64" }, ok: { kind: "boolean", dtype: "bool" } },
  totalRows: 30,
  pageSize: 3,
  ...extra,
});
const view = (extra: Partial<TableRender> = {}): TableRender => ({ focused: false, colOffset: 0, selected: new Set(), sort: [], rowIdOf: (i) => `r${i}`, firstRow: 0, ...extra });

test("a grid has a header, types, a rule and body rows with separators; values are formatted by kind", () => {
  const lines = tableLines(data(), 60, theme, 10, view());
  expect(lines[0]).toContain("name");
  expect(lines[1]).toContain("int64");
  expect(lines[2]).toMatch(/^─+┼─/u);
  expect(lines[3]).toContain("│");
  const text = lines.join("\n");
  expect(text).toContain("709,000");
  expect(text).toContain("✓");
  expect(text).toContain("✗");
  expect(text).toMatch(/\x1b\[3m\s*null/u);
  expect(lines.at(-1)).toBe("rows 1–3 of 30 · page 1 of 10");
  for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
});

test("frozen row headers stay while the window scrolls, with ◂ and ▸", () => {
  const columns = Array.from({ length: 8 }, (_, i) => `column_${i}`);
  const record = Object.fromEntries([["Index0", 0], ...columns.map((c) => [c, `${c}-value`])]);
  const t: TableData = { columns, numeric: columns.map(() => false), rows: [], records: [record], rowHeaders: ["Index0"], totalRows: 1 };
  const first = tableLines(t, 50, theme, 5, view({ colOffset: 0 })).join("\n");
  expect(first).toContain("▸");
  expect(first).not.toContain("◂");
  const scrolled = tableLines(t, 50, theme, 5, view({ colOffset: 2 })).join("\n");
  expect(scrolled).toContain("Index0");
  expect(scrolled).toContain("◂");
  expect(scrolled).not.toContain("column_0");
  expect(scrolled).toMatch(/cols \d+–\d+ of 8/u);
});

test("sort marks: ↓ for one sort, with priorities for two", () => {
  expect(tableLines(data(), 60, theme, 5, view({ sort: [{ by: "n", descending: true }] }))[0]).toContain("n ↓");
  const two = tableLines(data(), 60, theme, 5, view({ sort: [{ by: "n", descending: true }, { by: "name", descending: false }] }))[0]!;
  expect(two).toContain("↓1");
  expect(two).toContain("↑2");
});

test("the cursor cell is inverse; the selection column shows ☑ for a selected row id", () => {
  const lines = tableLines(data({ selection: "multi" }), 60, theme, 5, view({ focused: true, cursorRow: 0, cursorCol: 1, selected: new Set(["r1"]) }));
  expect(lines.join("\n")).toContain("\x1b[7m");
  const body = lines.map(plain);
  expect(body.find((l) => l.includes("alpha"))).toMatch(/^☐/u);
  expect(body.find((l) => /\bb\b/u.test(l) && l.includes("│"))).toMatch(/^☑/u);
});

test("summaries add a sparkline row for a numeric column", () => {
  const summaries = { stats: { n: { min: 2, max: 90 } }, bins: { n: [1, 5, 9, 2].map((count, i) => ({ bin_start: i, bin_end: i + 1, count })) }, counts: {} };
  const lines = tableLines(data(), 60, theme, 5, view({ summaries }));
  expect(lines.join("\n")).toMatch(/[▁▂▃▄▅▆▇█]{3}/u);
  expect(lines.join("\n")).toContain("2–90");
});

test("cell styles colour a cell", () => {
  const t = data({ cellStyles: { r0: { n: { color: "#ff0000", fontWeight: "bold" } } } });
  expect(tableLines(t, 60, theme, 5, view()).join("\n")).toContain("\x1b[38;2;255;0;0m");
});

test("the row card lists every column, the hidden ones too; the column card its stats", () => {
  const t = data({ hidden: ["secret"], records: [{ name: "alpha", n: 1, ok: true, secret: "x", _marimo_row_id: "r0" }] });
  const card = rowCard(t, 0, 50, theme, 4);
  expect(card[0]).toBe("row 5");
  expect(card.join("\n")).toContain("secret");
  expect(card.join("\n")).toContain("alpha");
  const col = columnCard(t, "n", { stats: { n: { min: 1, max: 5, nulls: 0 } }, bins: {}, counts: {} }, [["a", 4], ["b", 2]], 40, theme);
  expect(col[0]).toBe("n · int64");
  expect(col.join("\n")).toContain("top values");
});

test("parseFilter reads the filter syntax", () => {
  expect(parseFilter("n", "integer", "> 5")).toMatchObject({ operator: ">", value: 5, negate: false });
  expect(parseFilter("n", "integer", "1..10")).toMatchObject({ operator: "between", value: { min: 1, max: 10 } });
  expect(parseFilter("name", "string", "in a, b")).toMatchObject({ operator: "in", value: ["a", "b"] });
  expect(parseFilter("name", "string", "null")).toMatchObject({ operator: "is_null" });
  expect(parseFilter("name", "string", "!latte")).toMatchObject({ operator: "contains", value: "latte", negate: true });
  expect(parseFilter("name", "string", "> x")).toEqual({ error: "> needs a number or date column" });
  expect(parseFilter("n", "integer", "> x")).toEqual({ error: "not a number: x" });
});
