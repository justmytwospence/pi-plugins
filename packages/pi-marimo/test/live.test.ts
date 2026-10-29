import { expect, test } from "vitest";
import { densityOf, toPage } from "../src/core/live.js";
import { LiveCharts, frameLines, liveGeometry, placementLines, transmission } from "../src/ui/live-charts.js";
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

test("frames are double-buffered: each new one is uploaded to the hidden image, then the line places that image", async () => {
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  const written: string[] = [];
  let push!: (png: string) => void;
  const live = new LiveCharts(() => {}, () => ({ stop() {} }) as any, async (_h, _f, _g, onFrame) => { push = onFrame; return { frame: "AAAA", pointer() {}, close() {} } as any; }, (d) => written.push(d));
  const output: any = {};
  const g = { cols: 20, rows: 4, cellW: 9, cellH: 18 };
  live.state(output, "{}", g);
  await new Promise((r) => setTimeout(r, 0));
  const first = live.state(output, "{}", g) as any;
  expect(first.status).toBe("ready");
  const a = first.imageId;
  expect(written).toEqual([transmission("AAAA", a)]);
  expect(live.lines(first)).toEqual(placementLines(a, g));
  push("BBBB");
  const second = live.state(output, "{}", g) as any;
  expect(second.imageId).not.toBe(a);
  expect(written.at(-1)).toBe(transmission("BBBB", second.imageId));
  push("CCCC");
  expect((live.state(output, "{}", g) as any).imageId).toBe(a);
  // An unchanged frame is not sent again.
  push("CCCC");
  expect(written).toHaveLength(3);
  expect(transmission("x".repeat(9000), 7).match(/\x1b_G/gu)).toHaveLength(3);
  live.dispose();
});
