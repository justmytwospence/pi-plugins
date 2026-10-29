import { expect, test } from "vitest";
import { densityOf, toPage } from "../src/core/live.js";
import { frameLines, liveGeometry } from "../src/ui/live-charts.js";
import { setCellDimensions } from "@earendil-works/pi-tui";

const g = { cols: 60, rows: 17, cellW: 18, cellH: 36 };

test("a high-density terminal doubles the page's pixel ratio, and a cell maps to a page pixel inside the chart", () => {
  expect(densityOf(g)).toBe(2);
  expect(densityOf({ ...g, cellW: 9, cellH: 18 })).toBe(1);
  // 60 x 17 cells of 18 x 36 px at density 2 is a 540 x 306 page.
  expect(toPage(g, 30, 8.5)).toEqual({ x: 270, y: 153 });
  expect(toPage(g, -5, 99)).toEqual({ x: 0, y: 305 });
});

test("the chart is as wide as allowed, shortens to fit the rows, and its frame is one block of that many lines", () => {
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  expect(liveGeometry(60, 20)).toMatchObject({ cols: 60, rows: 18 });
  const tall = liveGeometry(60, 8);
  expect(tall.rows).toBe(8);
  expect(tall.cols).toBeLessThan(60);
  const lines = frameLines("iVBOR", { cols: 40, rows: 5, cellW: 9, cellH: 18 }, 7);
  expect(lines).toHaveLength(5);
  expect(lines[0]).toContain("\x1b_G");
  expect(lines[0]).toContain("c=40");
  expect(lines[0]).toContain("r=5");
  expect(lines.slice(1)).toEqual(["", "", "", ""]);
});
