import { expect, test, vi } from "vitest";
import { Painter, marker } from "../src/ui/painter.js";

function fakeTui(screen: string[]) {
  const writes: string[] = [];
  const tui = {
    screen,
    getScreenLines() { return [...this.screen]; },
    doRender() {},
    terminal: { rows: screen.length, write: (d: string) => { writes.push(d); } },
  };
  return { tui, writes };
}
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
const placements = (w: string) => [...w.matchAll(/a=p,i=(\d+)/gu)].map((m) => Number(m[1]));
const deletes = (w: string) => [...w.matchAll(/a=d,d=i,i=(\d+)/gu)].map((m) => Number(m[1]));
const uploads = (w: string) => [...w.matchAll(/a=t,f=100,q=2,i=(\d+)/gu)].map((m) => Number(m[1]));

test("the chart's rows are text to the renderer; after a render the painter places the frame where the marker is", () => {
  const { tui, writes } = fakeTui(["", "", "", "", "", ""]);
  const p = Painter.for(tui)!;
  const slot = p.add({ cols: 10, rows: 3 });
  const lines = p.lines(slot, 3);
  expect(lines).toEqual([marker(slot), "", ""]);
  expect(lines.join("")).not.toContain("\x1b_G");
  p.present(slot, PNG);
  expect(uploads(writes.join(""))).toHaveLength(1);
  expect(placements(writes.join(""))).toHaveLength(0);
  tui.screen[2] = `│ ▍ ${marker(slot)}`;
  tui.doRender();
  const placed = writes.at(-1)!;
  expect(placed).toContain("\x1b[3;5H");
  expect(placements(placed)).toHaveLength(1);
  // Nothing moved: the next render writes nothing.
  writes.length = 0;
  tui.doRender();
  expect(writes).toEqual([]);
});

test("a new frame goes to the other image, placed on top, and the old placement is removed only afterwards", () => {
  vi.useFakeTimers();
  try {
    const { tui, writes } = fakeTui(["", "", ""]);
    const p = Painter.for(tui)!;
    const slot = p.add({ cols: 10, rows: 2 });
    p.present(slot, PNG);
    tui.screen[0] = marker(slot);
    tui.doRender();
    const first = placements(writes.join(""))[0]!;
    writes.length = 0;
    p.present(slot, PNG.replace("AAAA", "BBBB"));
    const swap = writes.join("");
    const second = uploads(swap)[0]!;
    expect(second).not.toBe(first);
    expect(placements(swap)).toEqual([second]);
    expect(deletes(swap)).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(deletes(writes.join(""))).toEqual([first]);
    // The renderer's own image clears are noticed: the frame is placed again (and uploaded again when the data went).
    writes.length = 0;
    tui.terminal.write("\x1b_Ga=d,d=A,q=2\x1b\\");
    tui.doRender();
    expect(uploads(writes.join(""))).toEqual([second]);
    expect(placements(writes.join(""))).toEqual([second]);
  } finally { vi.useRealTimers(); }
});

test("scrolled partly off the bottom the placement is cropped; with the marker gone it is removed", () => {
  const { tui, writes } = fakeTui(["", "", "", ""]);
  const p = Painter.for(tui)!;
  const slot = p.add({ cols: 10, rows: 4 });
  p.present(slot, PNG);
  tui.screen[2] = marker(slot);
  tui.doRender();
  expect(writes.at(-1)).toMatch(/r=2,x=0,y=0,w=10,h=5,/u);
  tui.screen[2] = "";
  tui.doRender();
  expect(deletes(writes.at(-1)!)).toHaveLength(1);
});

test("a transcript chart under an overlay is taken away and comes back when the overlay closes; a chart inside the overlay stays", () => {
  const { tui, writes } = fakeTui(["", "", "", ""]);
  (tui as any).renderedOverlayLayouts = [];
  const p = Painter.for(tui)!;
  const base = p.add({ cols: 10, rows: 2 });
  const inView = p.add({ cols: 10, rows: 2 }, "overlay");
  p.present(base, PNG);
  p.present(inView, PNG);
  tui.screen[0] = marker(base);
  tui.screen[2] = marker(inView);
  tui.doRender();
  expect(placements(writes.join(""))).toHaveLength(2);
  writes.length = 0;
  (tui as any).renderedOverlayLayouts = [{ row: 0, col: 0, width: 80, height: 4 }];
  tui.doRender();
  expect(deletes(writes.join(""))).toHaveLength(1);
  expect(placements(writes.join(""))).toHaveLength(0);
  writes.length = 0;
  (tui as any).renderedOverlayLayouts = [];
  tui.doRender();
  expect(placements(writes.join(""))).toHaveLength(1);
});

test("while a full-screen view is open, images Pi places in the transcript are wiped after each render", () => {
  const { tui, writes } = fakeTui(["", ""]);
  const p = Painter.for(tui)!;
  p.setExclusive(true);
  tui.doRender();
  expect(writes.join("")).toContain("a=d,d=a");
  writes.length = 0;
  tui.doRender();
  expect(writes).toEqual([]);
  tui.terminal.write("\x1b_Ga=T,f=100,i=5;AAAA\x1b\\");
  tui.doRender();
  expect(writes.at(-1)).toContain("a=d,d=a");
  p.setExclusive(false);
  writes.length = 0;
  tui.terminal.write("\x1b_Ga=T,f=100,i=5;AAAA\x1b\\");
  tui.doRender();
  expect(writes).toEqual(["\x1b_Ga=T,f=100,i=5;AAAA\x1b\\"]);
});

test("a reload's painter retires the earlier one: its charts go and it stops drawing", () => {
  const { tui, writes } = fakeTui(["", ""]);
  const first = Painter.for(tui)!;
  const slot = first.add({ cols: 10, rows: 2 });
  first.present(slot, PNG);
  tui.screen[0] = marker(slot);
  tui.doRender();
  // A fresh copy of the module would make its own class; retiring is how it hands over.
  first.retire();
  expect(writes.at(-1)).toMatch(/a=d,d=I/u);
  writes.length = 0;
  tui.doRender();
  expect(writes).toEqual([]);
  const second = Painter.for(tui)!;
  expect(second).not.toBe(first);
  expect(Painter.for(tui)).toBe(second);
});
