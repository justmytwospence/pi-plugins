import { visibleWidth } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import { tableLines } from "../src/ui/table.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };

test("a table grid: numbers right-aligned, a rule under the header, how much of the table it shows", () => {
  const lines = tableLines({ columns: ["name", "n"], numeric: [false, true], rows: [["alpha", "1"], ["b", "1,200"]], totalRows: 1204, totalColumns: 2 }, 60, theme, 10);
  expect(lines).toEqual(["name       n", "─────  ─────", "alpha      1", "b      1,200", "2 of 1,204 rows · 2 columns"]);
});

test("columns that do not fit give way to `… +N cols`; every line fits the width; `many` rows", () => {
  const columns = Array.from({ length: 12 }, (_, i) => `column_${i}`);
  const lines = tableLines({ columns, numeric: columns.map(() => false), rows: [columns.map((c) => `${c}-value`)], totalRows: "many" }, 50, theme, 5);
  expect(lines[0]).toMatch(/… \+\d+ cols$/u);
  for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  expect(lines.at(-1)).toBe("1 of many rows · 12 columns");
});
