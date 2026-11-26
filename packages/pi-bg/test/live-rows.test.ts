import { expect, it } from "vitest";
import { LiveRows } from "../src/live-rows.ts";

it("redraws a row only when its line changed", () => {
  const rows = new LiveRows();
  let text = "a";
  let redraws = 0;
  rows.track("t", "k", () => redraws++, () => text);
  rows.tick(() => true);
  expect(redraws).toBe(0);
  text = "b";
  rows.tick(() => true);
  expect(redraws).toBe(1);
  rows.tick(() => true);
  expect(redraws).toBe(1);
});

it("a redraw that re-renders the row re-tracks it without another redraw", () => {
  const rows = new LiveRows();
  let text = "a";
  let redraws = 0;
  const line = () => text;
  const redraw = () => { redraws++; rows.track("t", "k", redraw, line); };
  rows.track("t", "k", redraw, line);
  text = "b";
  rows.tick(() => true);
  rows.tick(() => true);
  expect(redraws).toBe(1);
  expect(rows.size).toBe(1);
});

it("an ended task's rows redraw once with their final line, then drop", () => {
  const rows = new LiveRows();
  let text = "a";
  let redraws = 0;
  rows.track("t", "k", () => redraws++, () => text);
  text = "b";
  rows.tick(() => false);
  expect(redraws).toBe(1);
  expect(rows.size).toBe(0);
  text = "c";
  rows.tick(() => false);
  expect(redraws).toBe(1);
});

it("a row whose redraw or line throws is dropped", () => {
  const rows = new LiveRows();
  let text = "a";
  let badLine = false;
  rows.track("t", "redraw", () => { throw new Error("stale"); }, () => text);
  rows.track("t", "line", () => {}, () => { if (badLine) throw new Error("gone"); return text; });
  text = "b";
  badLine = true;
  expect(() => rows.tick(() => true)).not.toThrow();
  expect(rows.size).toBe(0);
});
