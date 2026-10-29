import { expect, test, vi } from "vitest";
import { NotebookState } from "../src/core/notebook.js";
import type { Followed } from "../src/core/watcher.js";
import { INPUT_CONTEXT } from "../src/activity.js";
import { NotebookView, notebookLines } from "../src/ui/view.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { NotebookSource } from "../src/ui/source.js";
import { notebookKey } from "../src/ui/identity.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const tui = { requestRender: () => {}, terminal: { rows: 28 } };
function followed(url = "http://fixture.invalid", sessionId = "s"): Followed {
  const notebook = new NotebookState();
  notebook.apply("kernel-ready", { cell_ids: Array.from({ length: 100 }, (_, i) => `cell-${i}`), codes: Array(100).fill("x = 1"), names: Array.from({ length: 100 }, (_, i) => `cell-${i}`) });
  return { attachment: { path: "/w/nb.py", url, sessionId }, notebook, connection: "connected", current: true, touchedAt: 0 };
}
function busy(f: Followed) { f.notebook.apply("cell-op", { cell_id: "cell-0", status: "running" }); }

test("^U/^D scroll the detail by half a page and the page keys by a whole one; j/k move the cursor", () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "long" }, { id: "b", code: "y = 2", name: "next" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/plain", data: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") } });
  const view = new NotebookView(tui as any, theme, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    expect(view.render(100).join("\n")).toContain("▍ line 0");
    view.handleInput("\x04");
    let text = view.render(100).join("\n");
    expect(text).not.toContain("▍ line 0");
    expect(text).toContain("▍ line 9");
    expect(text).toMatch(/▌○ long/u);
    view.handleInput("\x1b[6~");
    expect(view.render(100).join("\n")).toContain("│ x = 1");
    view.handleInput("\x15");
    view.handleInput("\x1b[5~");
    text = view.render(100).join("\n");
    expect(text).toContain("▍ line 0");
    view.handleInput("j");
    expect(view.render(100).join("\n")).toMatch(/▌○ next/u);
    expect(view[INPUT_CONTEXT]()).toBe("viewer");
  } finally { view.dispose(); }
});

test("the notebook producer rechecks connected busy eligibility before interrupting", async () => {
  const f = followed();
  const key = notebookKey(f);
  const interrupt = vi.fn(async () => {});
  const source = new NotebookSource({ followed: () => [f], open: async () => {}, interrupt, changed: () => {}, hostedChanged: () => {} });
  expect(source.section.canStop!(key)).toBe(false);
  busy(f);
  source.update([f]);
  expect(source.section.canStop!(key)).toBe(true);
  await source.section.stop!(key);
  expect(interrupt).toHaveBeenCalledOnce();
  f.connection = "disconnected";
  expect(source.section.canStop!(key)).toBe(false);
  await source.section.stop!(key);
  expect(interrupt).toHaveBeenCalledOnce();
});

test("two servers hosting the same file have distinct stable rows, interrupts and details", async () => {
  const a = followed("http://server-a.invalid");
  const b = followed("http://server-b.invalid");
  busy(a); busy(b);
  const interrupt = vi.fn(async () => {});
  const source = new NotebookSource({ followed: () => [a, b], open: async () => {}, interrupt, changed: () => {}, hostedChanged: () => {} });
  source.update([a, b]);
  const rows = source.entries(100);
  expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  await source.section.stop!(rows[1]!.key);
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(b);
  const view = new NotebookView(tui as any, theme, rows[1]!.key, { followed: () => [a, b], interrupt, openInBrowser: () => {} }, () => {});
  try {
    expect(view.render(100).join("\n")).toContain("server-b.invalid");
    expect(view.render(100).join("\n")).not.toContain("server-a.invalid");
  } finally { view.dispose(); }
  const before = notebookKey(b);
  b.attachment.sessionId = "reconnected";
  expect(notebookKey(b)).toBe(before);
});

test("confirmation is invalidated by replacement, disappearance, observed idle and disconnect", () => {
  const initial = followed(); busy(initial);
  let all = [initial];
  const interrupt = vi.fn(async () => {});
  const view = new NotebookView(tui as any, theme, notebookKey(initial), { followed: () => all, interrupt, openInBrowser: () => {} }, () => {});
  try {
    view.handleInput("x");
    const replacement = followed(initial.attachment.url, "new-session"); busy(replacement);
    all = [replacement];
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    all = [];
    view.render(100);
    all = [replacement];
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    replacement.notebook.apply("cell-op", { cell_id: "cell-0", status: "idle" });
    view.render(100);
    busy(replacement);
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    replacement.connection = "disconnected";
    view.render(100);
    replacement.connection = "connected";
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    view.handleInput("x");
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(replacement);
  } finally { view.dispose(); }
});


// --- the view you can drive: cursor, expansion, filter, jumps, runs, header, output ---
const theme2 = theme;
function nbWith(cells: Array<{ id: string; code: string; name?: string }>): Followed {
  const notebook = new NotebookState();
  notebook.apply("kernel-ready", { cell_ids: cells.map((c) => c.id), codes: cells.map((c) => c.code), names: cells.map((c) => c.name ?? "_") });
  return { attachment: { path: "/w/nb.py", url: "http://fixture.invalid", sessionId: "s" }, notebook, connection: "connected", current: true, touchedAt: 0 };
}
const make = (f: Followed, extra: Partial<ConstructorParameters<typeof NotebookView>[3]> = {}) =>
  new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, ...extra }, () => {});
const screen = (v: NotebookView) => v.render(100).join("\n");

test("the header is one line: state, the agent, the last run and where the server is; the path and URL are on the ? page", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }, { id: "b", code: "y = x" }, { id: "m", code: 'mo.md("# T")' }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", stale_inputs: true, output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "ValueError", msg: "bad" }] } });
  const v = make(f, { servers: () => ["nb-server"], lastRun: () => "ran 3s · 1 error · 1m ago" });
  try {
    const lines = v.render(100);
    expect(lines[1]).toContain("nb.py");
    expect(lines[1]).toContain("idle · 1 error");
    expect(lines[1]).toContain("ran 3s · 1 error · 1m ago");
    expect(lines[1]).toContain("server nb-server");
    const text = lines.join("\n");
    expect(text).not.toContain("2 cells");
    expect(text).not.toContain("http://fixture.invalid");
    expect(text).not.toContain("/w/nb.py");
    expect(text).not.toContain("session s");
    v.handleInput("?");
    expect(screen(v)).toContain("/w/nb.py · http://fixture.invalid · server nb-server");
  } finally { v.dispose(); }
});

test("j/k move the cursor between cells; the detail shows the cell's output, folds its code, and Enter opens it", () => {
  const f = nbWith([{ id: "a", code: "print('hi')\nx = 1", name: "first" }, { id: "b", code: "y = 2", name: "second" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "running", timestamp: 1 });
  f.notebook.apply("cell-op", { cell_id: "a", console: [{ channel: "stdout", mimetype: "text/plain", data: "hi\n" }], output: { channel: "output", mimetype: "text/html", data: "<span>value &amp; more</span>" } });
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", timestamp: 2 });
  const v = make(f);
  try {
    const first = screen(v);
    expect(first).toMatch(/▌○ first/u);
    expect(first).toContain("▍ hi");
    expect(first).toContain("▍ value & more");
    // Folded: the first line, dim, and how many more.
    expect(first).toContain("│ print('hi')  ⋯ +1");
    expect(first).not.toContain("x = 1");
    expect(v.render(100).slice(3, -3).join("\n")).not.toMatch(/\bcode\b/u);
    v.handleInput("j");
    expect(screen(v)).toMatch(/▌○ second/u);
    expect(screen(v)).not.toContain("▍ value & more");
    v.handleInput("k");
    v.handleInput("\r");
    const open = screen(v);
    expect(open).toMatch(/▌○ first/u);
    expect(open).toContain("│ x = 1");
    expect(open).not.toContain("⋯ +1");
    v.handleInput("\r");
    expect(screen(v)).not.toContain("│ x = 1");
    expect(screen(v)).toContain("│ print('hi')  ⋯ +1");
  } finally { v.dispose(); }
});

test("e and E jump between failed cells; / filters by name, variable or code and Esc clears", () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "load" }, { id: "b", code: "boom()" }, { id: "c", code: "z = 3" }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "E", msg: "m" }] } });
  const v = make(f);
  try {
    v.handleInput("e");
    expect(screen(v)).toMatch(/▌✗ boom\(\) +E/u);
    v.handleInput("E");
    expect(screen(v)).toMatch(/▌✗ boom\(\) +E/u);
    expect(screen(v)).toContain("E: m");
    v.handleInput("/");
    expect(v[INPUT_CONTEXT]()).toBe("filter");
    for (const ch of "load") v.handleInput(ch);
    v.handleInput("\r");
    expect(v[INPUT_CONTEXT]()).toBe("viewer");
    const filtered = screen(v);
    expect(filtered).toContain("load");
    expect(filtered).not.toContain("boom()");
    v.handleInput("\x1b");
    expect(screen(v)).toContain("boom()");
    // Esc with no filter goes back.
    let closed = false;
    const w = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => { closed = true; });
    w.handleInput("\x1b");
    expect(closed).toBe(true);
    w.dispose();
  } finally { v.dispose(); }
});

test("following keeps the cursor on the running cell until the user moves; f follows again", () => {
  const f = nbWith(Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, code: `v${i} = ${i}` })));
  f.notebook.apply("cell-op", { cell_id: "c40", status: "running", timestamp: 1 });
  const v = make(f);
  try {
    expect(screen(v)).toMatch(/▌● v40 = 40/u);
    v.handleInput("k");
    expect(screen(v)).toMatch(/▌○ v39 = 39/u);
    v.handleInput("f");
    expect(screen(v)).toMatch(/▌● v40 = 40/u);
  } finally { v.dispose(); }
});

test("r runs the cell under the cursor with its current code; R and A need a second press", async () => {
  const f = nbWith([{ id: "a", code: "x = 1" }, { id: "b", code: "y = x" }, { id: "m", code: 'mo.md("# T")' }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", stale_inputs: true });
  const run = vi.fn(async () => {});
  const v = make(f, { run });
  try {
    v.handleInput("j");
    v.handleInput("r");
    expect(run).toHaveBeenCalledExactlyOnceWith(f, [{ id: "b", code: "y = x" }]);
    v.handleInput("R");
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen(v)).toContain("R again to run stale cells");
    v.handleInput("R");
    expect(run).toHaveBeenLastCalledWith(f, [{ id: "b", code: "y = x" }]);
    v.handleInput("A");
    v.handleInput("j");
    v.handleInput("A");
    expect(run).toHaveBeenCalledTimes(2);
    // The armed A fires on the next A.
    v.handleInput("A");
    expect(run).toHaveBeenLastCalledWith(f, [{ id: "a", code: "x = 1" }, { id: "b", code: "y = x" }]);
    expect(run).toHaveBeenCalledTimes(3);
    f.connection = "disconnected";
    v.handleInput("r");
    expect(run).toHaveBeenCalledTimes(3);
    expect(screen(v)).toContain("not connected");
  } finally { v.dispose(); }
});

test("a failed run shows the reason in the footer", async () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const v = make(f, { run: async () => { throw new Error("marimo answered 500"); } });
  try {
    v.handleInput("r");
    await new Promise((r) => setTimeout(r, 5));
    expect(screen(v)).toContain("Could not run: marimo answered 500");
  } finally { v.dispose(); }
});

test("S stops the server the notebook's row stands for, after a second press, and only when there is one", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const stopServers = vi.fn(() => 1);
  const none = make(f, { stopServers });
  try {
    none.handleInput("S");
    none.handleInput("S");
    expect(stopServers).not.toHaveBeenCalled();
    expect(screen(none)).not.toContain("stop server");
  } finally { none.dispose(); }
  const v = make(f, { servers: () => ["marimo nb.py"], stopServers });
  try {
    v.handleInput("S");
    expect(screen(v)).toContain("S again to stop the server");
    v.handleInput("j");
    v.handleInput("S");
    expect(stopServers).not.toHaveBeenCalled();
    v.handleInput("S");
    expect(stopServers).toHaveBeenCalledExactlyOnceWith(f);
    expect(screen(v)).toContain("Stopping the marimo server");
  } finally { v.dispose(); }
});

test("a png output draws inline only when its whole block is on screen, and only on a terminal that shows images", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  const f = nbWith([{ id: "a", code: "plot()" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "image/png", data: png } });
  const v = make(f);
  try {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any);
    expect(screen(v)).toContain("[image png]");
    expect(screen(v)).not.toContain("\x1b_G");
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
    v.invalidate?.();
    const shown = v.render(100);
    expect(shown.filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
    expect(shown.every((l) => visibleWidth(l) === 100)).toBe(true);
    // The agent-facing outline never carries image escapes.
    expect(notebookLines(f.notebook, theme2, 0).lines.join("\n")).not.toContain("\x1b_G");
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test("a Vega-Lite chart shows a drawing note, then the image once the renderer finishes", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const { VegaRenderer } = await import("../src/core/vega.js");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  const f = nbWith([{ id: "a", code: "chart" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "application/vnd.vegalite.v6+json", data: '{"mark":"bar"}' } });
  let release!: (png: string) => void;
  const renderer = new VegaRenderer(() => new Promise<string>((r) => { release = r; }));
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {}, renderer);
  try {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
    expect(screen(v)).toContain("drawing");
    release(png);
    await new Promise((r) => setTimeout(r, 0));
    expect(v.render(100).filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
    // Without image support it stays the label and never starts a render.
    setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any);
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test("a Plotly figure is drawn through its own renderer", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const { ChartRenderer } = await import("../src/core/vega.js");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  const f = nbWith([{ id: "a", code: "fig" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: `<marimo-plotly data-figure='{&quot;data&quot;:[],&quot;layout&quot;:{}}'></marimo-plotly>` } });
  const asked: string[] = [];
  const plotly = new ChartRenderer(async (spec) => { asked.push(spec); return png; });
  // The live browser is unavailable, so the figure falls back to the static render.
  const { LiveCharts } = await import("../src/ui/live-charts.js");
  const noLive = new LiveCharts(() => {}, () => ({ stop() {} }) as any, async () => { throw new Error("no browser"); });
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {}, undefined, plotly, noLive);
  try {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
    v.render(100);
    await new Promise((r) => setTimeout(r, 0));
    v.render(100);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen(v)).toContain("static image (live chart failed: no browser)");
    expect(asked).toEqual(['{"data":[],"layout":{}}']);
    expect(v.render(100).filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test("a live Plotly chart is drawn from its page's frames, and the mouse over it goes to that page", async () => {
  const { setCapabilities, setCellDimensions } = await import("@earendil-works/pi-tui");
  const { LiveCharts } = await import("../src/ui/live-charts.js");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
  const f = nbWith([{ id: "a", code: "fig" }, { id: "b", code: "y = 2" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: `<marimo-plotly data-figure='{&quot;data&quot;:[],&quot;layout&quot;:{}}'></marimo-plotly>` } });
  const events: any[] = [];
  let closed = false;
  const live = new LiveCharts(() => {}, () => ({ stop() {} }) as any, async () => ({ frame: png, pointer: (p: any) => events.push(p), close: () => { closed = true; } }), (d: string) => { written.push(d); });
  const written: string[] = [];
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {}, undefined, undefined, live);
  try {
    expect(screen(v)).toContain("starting");
    await new Promise((r) => setTimeout(r, 0));
    const shown = v.render(100);
    expect(shown.filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
    // The frame was uploaded out of band and the line only places it.
    expect(written.at(-1)).toMatch(/^\x1b_Ga=t,f=100,q=2,i=\d+;/u);
    expect(shown.find((l) => l.includes("\x1b_G"))).toMatch(/\x1b_Ga=p,i=\d+,p=1,c=\d+,r=\d+,C=1,q=2\x1b\\/u);
    expect(live.rects).toHaveLength(1);
    const r = live.rects[0]!;
    expect(shown[r.top]).toContain("\x1b_G");
    expect(shown.every((l) => visibleWidth(l) === 100)).toBe(true);
    const ev = (type: string, x: number, y: number, extra = {}) => ({ type, button: "left", x, y, screenX: x, screenY: y, width: 100, height: 40, shift: false, alt: false, ctrl: false, ...extra }) as any;
    // Hover inside the chart reaches the page, in cells from its corner; outside it is left alone.
    expect(v.handleMouse(ev("move", r.left + 3, r.top + 2, { button: "none" }))).toEqual({ handled: true });
    expect(events.at(-1)).toMatchObject({ type: "move", x: 3.5, y: 2.5 });
    expect(v.handleMouse(ev("move", 0, 0, { button: "none" }))).toBeUndefined();
    // A press captures the drag, which keeps going when the pointer leaves the chart.
    expect(v.handleMouse(ev("press", r.left + 1, r.top + 1))).toEqual({ handled: true, capture: true });
    expect(v.handleMouse(ev("drag", 0, 0))).toEqual({ handled: true });
    expect(events.at(-1)).toMatchObject({ type: "drag" });
    v.handleMouse(ev("release", 0, 0));
    expect(v.handleMouse(ev("move", 0, 0, { button: "none" }))).toBeUndefined();
    // Moving to a cell without the chart closes its page.
    v.handleInput("j");
    v.render(100);
    expect(closed).toBe(true);
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test("the keyboard pointer drives a live chart without a mouse: arrows move it, space drags, plus zooms, esc leaves", async () => {
  const { setCapabilities, setCellDimensions } = await import("@earendil-works/pi-tui");
  const { LiveCharts } = await import("../src/ui/live-charts.js");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  setCellDimensions({ widthPx: 9, heightPx: 18 });
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
  const f = nbWith([{ id: "a", code: "fig" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: `<marimo-plotly data-figure='{&quot;data&quot;:[],&quot;layout&quot;:{}}'></marimo-plotly>` } });
  const events: any[] = [];
  const rings: any[] = [];
  const live = new LiveCharts(() => {}, () => ({ stop() {} }) as any, async () => ({ frame: png, pointer: (p: any) => events.push(p), cursor: (c: any) => rings.push(c && { x: c.x, y: c.y }), close: () => {} }), () => {});
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {}, undefined, undefined, live);
  try {
    v.handleInput("i");
    expect(screen(v)).toContain("Select a cell with a live chart");
    v.render(100);
    await new Promise((r) => setTimeout(r, 0));
    v.render(100);
    v.handleInput("j");
    expect(screen(v)).toContain("i inspect chart");
    v.handleInput("i");
    expect(live.inspecting).toBe(true);
    expect(screen(v)).toContain("space starts/ends a drag");
    const start = events.at(-1);
    v.handleInput("\x1b[C"); // right
    expect(events.at(-1)).toMatchObject({ type: "move", x: start.x + 0.5, y: start.y });
    v.handleInput("J"); // shift-down: farther
    expect(events.at(-1)).toMatchObject({ type: "move", y: start.y + 3 });
    v.handleInput(" ");
    expect(events.at(-1)).toMatchObject({ type: "press", button: "left" });
    v.handleInput("h");
    expect(events.at(-1)).toMatchObject({ type: "drag", button: "left" });
    v.handleInput(" ");
    expect(events.at(-1)).toMatchObject({ type: "release" });
    v.handleInput("+");
    expect(events.at(-1)).toMatchObject({ type: "wheel", wheelDelta: -3 });
    v.handleInput("0");
    expect(events.at(-1)).toMatchObject({ type: "dblclick" });
    expect(rings.at(-1)).not.toBeNull();
    // The pointer holds every key while it is on (j does not move the notebook cursor), and esc hands them back.
    v.handleInput("\x1b");
    expect(live.inspecting).toBe(false);
    expect(rings.at(-1)).toBeNull();
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

// --- reading and steering: outputs, folds, mouse, help, variables, agent changes, widgets, docks ---
const press = (v: NotebookView, keys: string) => { for (const k of keys) v.handleInput(k); };

test("O stacks the cell's whole section in the detail, the markdown as prose; O again shows the cell alone", () => {
  const f = nbWith([{ id: "m", code: 'mo.md("""\n# Title\n\nSome prose here.\n""")' }, { id: "a", code: "x = 1" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/plain", data: "forty-two" } });
  const v = make(f);
  try {
    v.handleInput("j");
    expect(screen(v)).not.toContain("Some prose here.");
    expect(screen(v)).toContain("▍ forty-two");
    v.handleInput("O");
    expect(screen(v)).toContain("Some prose here.");
    expect(screen(v)).toContain("▍ forty-two");
    expect(screen(v)).toContain("Section view: the whole section.");
    expect(screen(v)).toMatch(/▌○ x = 1/u);
    v.handleInput("O");
    expect(screen(v)).not.toContain("Some prose here.");
    expect(screen(v)).toContain("Cell view.");
    v.handleInput("O");
    expect(screen(v)).toContain("Some prose here.");
  } finally { v.handleInput("O"); v.dispose(); }
});

test("a table output is a grid in the detail, and its shape is the outline's badge", () => {
  const table = `<marimo-ui-element object-id='a-0' random-id='r'><marimo-table data-data='&quot;[{&#92;&quot;city&#92;&quot;:&#92;&quot;Oslo&#92;&quot;,&#92;&quot;pop&#92;&quot;:709000}]&quot;' data-total-rows='1' data-total-columns='2' data-field-types='[[&quot;pop&quot;,[&quot;integer&quot;,&quot;int64&quot;]]]'></marimo-table></marimo-ui-element>`;
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: table } });
  const v = make(f);
  try {
    expect(screen(v)).toMatch(/▌○ table +1×2/u);
    expect(screen(v)).toMatch(/city\s*┃\s*pop/u);
    expect(screen(v)).toMatch(/Oslo\s*┃\s*709,000/u);
    expect(screen(v)).toContain("rows 1–1 of 1");
  } finally { v.dispose(); }
});

test("z folds the section the cursor is in, Z folds every one, [ and ] go between sections", () => {
  const f = nbWith([{ id: "h1", code: 'mo.md("# One")' }, { id: "a", code: "a = 1" }, { id: "b", code: "b = 2" }, { id: "h2", code: 'mo.md("# Two")' }, { id: "c", code: "c = 3" }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "E", msg: "m" }] } });
  const v = make(f);
  try {
    expect(screen(v)).toMatch(/▌ One/u);
    v.handleInput("j");
    v.handleInput("z");
    const folded = screen(v);
    expect(folded).toMatch(/▌ One {2}▸ 2 cells · 1 error/u);
    expect(folded).not.toContain("a = 1");
    expect(folded).toContain("c = 3");
    v.handleInput("]");
    expect(screen(v)).toMatch(/▌ Two/u);
    v.handleInput("Z");
    expect(screen(v)).toContain("a = 1");
    v.handleInput("Z");
    expect(screen(v)).toMatch(/Two {2}▸ 1 cell/u);
    expect(screen(v)).not.toContain("c = 3");
    v.handleInput("[");
    expect(screen(v)).toMatch(/▌ One/u);
    // Tab and Shift+Tab fold as z and Z do.
    v.handleInput("\x1b[Z");
    expect(screen(v)).toContain("a = 1");
    v.handleInput("\t");
    expect(screen(v)).toMatch(/▌ One {2}▸ 2 cells/u);
    v.handleInput("\t");
    expect(screen(v)).toContain("a = 1");
  } finally { v.dispose(); }
});

test("{ goes to the previous notebook, } to the next", () => {
  const a = nbWith([{ id: "a", code: "x = 1" }]);
  const b = nbWith([{ id: "b", code: "y = 1" }]);
  b.attachment = { ...b.attachment, path: "/w/other.py" };
  const v = new NotebookView(tui as any, theme2, notebookKey(a), { followed: () => [a, b], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    v.handleInput("{");
    expect(screen(v)).toContain("Notebook other.py");
    v.handleInput("}");
    expect(screen(v)).toContain("Notebook nb.py");
  } finally { v.dispose(); }
});

test("the mouse: the wheel scrolls the pane under it, a click selects a cell, a second click (or a double click) opens its code, a click on the code line toggles it", () => {
  const f = followed();
  const v = new NotebookView(tui as any, theme, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  const ev = (type: string, y: number, extra = {}) => ({ type, button: type === "wheel" ? "none" : "left", x: 10, y, screenX: 10, screenY: y, width: 100, height: 28, shift: false, alt: false, ctrl: false, ...extra }) as any;
  try {
    v.render(100);
    expect(v.handleMouse(ev("wheel", 10, { wheelDelta: 3 }))).toEqual({ handled: true });
    expect(v.render(100)[3]).toContain("cell-3");
    expect(v.handleMouse(ev("press", 7))).toEqual({ handled: true, render: false });
    v.handleMouse(ev("click", 7));
    expect(screen(v)).toMatch(/▌○ cell-7/u);
    expect(screen(v)).toContain("│ x = 1");
    v.handleMouse(ev("click", 7, { clickCount: 2 }));
    expect(screen(v)).toContain("│ x = 1");
    // On the detail: a click on the code folds or opens it (one line either way here).
    const codeRow = v.render(100).findIndex((l) => l.includes("│ x = 1"));
    expect(v.handleMouse(ev("click", codeRow, { x: 60 }))).toEqual({ handled: true });
    // Outside the rows, and moves, are left alone.
    expect(v.handleMouse(ev("click", 1))).toBeUndefined();
    expect(v.handleMouse(ev("move", 7, { button: "none" }))).toBeUndefined();
  } finally { v.dispose(); }
});

test("? lists every key and any key closes it", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const v = make(f);
  try {
    expect(screen(v)).toContain("? keys · esc back");
    v.handleInput("?");
    expect(screen(v)).toContain("Notebook view keys");
    expect(screen(v)).toContain("Widgets");
    v.handleInput("j");
    expect(screen(v)).not.toContain("Notebook view keys");
  } finally { v.dispose(); }
});

function dataflow(): Followed {
  const f = nbWith([{ id: "a", code: "x = 1", name: "load" }, { id: "b", code: "y = x + 1" }, { id: "c", code: "z = y * x" }]);
  f.notebook.apply("variables", { variables: [{ name: "x", declared_by: ["a"], used_by: ["b", "c"] }, { name: "y", declared_by: ["b"], used_by: ["c"] }, { name: "z", declared_by: ["c"], used_by: [] }] });
  f.notebook.apply("variable-values", { variables: [{ name: "x", value: "1", datatype: "int" }] });
  return f;
}

test("v lists the variables; Enter goes to the cell that defines one, > to the first that uses it", () => {
  const f = dataflow();
  const v = make(f);
  try {
    v.handleInput("v");
    const pane = screen(v);
    expect(pane).toMatch(/● x\s+int\s+1\s+← load · 2 uses/u);
    expect(pane).toMatch(/ y\s+.*← y · 1 use/u);
    v.handleInput("j");
    v.handleInput("\r");
    expect(screen(v)).toMatch(/▌○ y/u);
    v.handleInput("v");
    v.handleInput("g");
    v.handleInput(">");
    expect(screen(v)).toMatch(/▌○ y/u);
    expect(screen(v)).toContain("uses x · used by z");
    expect(screen(v)).not.toContain("= x (int)");
    expect(screen(v)).not.toContain("<");
  } finally { v.dispose(); }
});

test("< and > follow the dataflow up and down", () => {
  const f = dataflow();
  const v = make(f);
  try {
    v.handleInput("G");
    v.handleInput("<");
    expect(screen(v)).toMatch(/▌○ y/u);
    v.handleInput("<");
    expect(screen(v)).toMatch(/▌○ load/u);
    v.handleInput("<");
    expect(screen(v)).toContain("No upstream cell.");
    v.handleInput(">");
    expect(screen(v)).toMatch(/▌○ y/u);
  } finally { v.dispose(); }
});

test("the agent's changes since the last prompt: marked, counted, c jumps to them, d shows the diff, removed cells listed", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(1_000_000);
    const f = nbWith([{ id: "a", code: "x = 1" }, { id: "b", code: "y = x + 1" }, { id: "c", code: "z = 3" }]);
    vi.setSystemTime(1_010_000);
    f.notebook.apply("notebook-document-transaction", { transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "b", code: "y = x + 2" }, { type: "delete-cell", cellId: "c" }] } });
    const v = make(f);
    try {
      const text = screen(v);
      expect(text).toMatch(/○ y = x \+ 2 +changed/u);
      expect(text).toContain("agent: 1 changed · 1 removed");
      expect(text).toMatch(/✗ Removed: z = 3/u);
      v.handleInput("c");
      expect(screen(v)).toMatch(/▌○ y = x \+ 2/u);
      expect(screen(v)).toContain("changed by the agent");
      v.handleInput("d");
      const diff = screen(v);
      expect(diff).toMatch(/-\s*\d+ y = x \+ 1/u);
      expect(diff).toMatch(/\+\s*\d+ y = x \+ 2/u);
      v.handleInput("k");
      v.handleInput("d");
      expect(screen(v)).toContain("The agent has not changed this cell since your last message.");
    } finally { v.dispose(); }
  } finally { vi.useRealTimers(); }
});

const widgetHtml = [
  "<marimo-ui-element object-id='a-0' random-id='1'><marimo-slider data-initial-value='3' data-label='&quot;n&quot;' data-start='0' data-stop='10' data-steps='[]'></marimo-slider></marimo-ui-element>",
  "<marimo-ui-element object-id='a-1' random-id='2'><marimo-checkbox data-initial-value='true' data-label='&quot;on&quot;'></marimo-checkbox></marimo-ui-element>",
  "<marimo-ui-element object-id='a-2' random-id='3'><marimo-text data-initial-value='&quot;hi&quot;' data-label='&quot;t&quot;'></marimo-text></marimo-ui-element>",
].join("");

test("w drives a cell's widgets: h/l change a slider, space a checkbox, Enter types a text's value", () => {
  const f = nbWith([{ id: "a", code: "n = mo.ui.slider(0, 10)" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: widgetHtml } });
  const setWidget = vi.fn((g: Followed, cell: any, w: any, value: unknown) => g.notebook.setUserValue(cell.id, w.objectId, w.label, value));
  const v = make(f, { setWidget });
  try {
    expect(screen(v)).toMatch(/◆ n {2}━+●─+ {2}3 {2}0–10/u);
    expect(screen(v)).toContain("w widgets");
    v.handleInput("w");
    expect(screen(v)).toContain("widget: h/l change");
    v.handleInput("l");
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.objectContaining({ id: "a" }), expect.objectContaining({ objectId: "a-0" }), 4);
    expect(screen(v)).toMatch(/▸ n {2}━+●─+ {2}4 {2}0–10/u);
    v.handleInput("j");
    v.handleInput(" ");
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-1" }), false);
    v.handleInput("j");
    v.handleInput("\r");
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    press(v, "!");
    v.handleInput("\r");
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-2" }), "hi!");
    expect(v[INPUT_CONTEXT]()).toBe("viewer");
    v.handleInput("\x1b");
    expect(screen(v)).not.toContain("widget: h/l change");
  } finally { v.dispose(); }
});

test("a asks the agent about the cell from a prompt docked in the view", () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "load" }]);
  const ask = vi.fn();
  const v = make(f, { ask, agentBusy: () => true });
  try {
    v.handleInput("a");
    expect(v[INPUT_CONTEXT]()).toBe("editor");
    const open = screen(v);
    expect(open).toContain("Ask the agent about load in nb.py");
    expect(open).toContain("the agent is working: this goes in as a follow-up");
    for (const width of [46, 120]) for (const l of v.render(width)) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
    press(v, "why?");
    v.handleInput("\r");
    expect(ask).toHaveBeenCalledExactlyOnceWith(f, expect.objectContaining({ id: "a" }), "why?");
    expect(v[INPUT_CONTEXT]()).toBe("viewer");
    expect(screen(v)).toContain("Sent to the agent.");
  } finally { v.dispose(); }
});

test(": runs Python in the kernel and shows what it printed and returned", async () => {
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const scratch = vi.fn(async (_f: Followed, _code: string, onEvent: (e: any) => void) => {
    onEvent({ stream: "stdout", text: "two" });
    onEvent({ stream: "stderr", text: "careful" });
    return { success: true, output: { mimetype: "text/plain", data: "'ok'" } };
  });
  const v = make(f, { scratch });
  try {
    v.handleInput(":");
    expect(screen(v)).toContain("Python in nb.py's kernel");
    press(v, "1+1");
    v.handleInput("\r");
    expect(scratch).toHaveBeenCalledWith(f, "1+1", expect.any(Function), expect.any(AbortSignal));
    await new Promise((r) => setTimeout(r, 0));
    const text = screen(v);
    expect(text).toContain(">>> 1+1");
    expect(text).toContain("two");
    expect(text).toContain("careful");
    expect(text).toContain("'ok'");
    v.handleInput("\x1b");
    expect(screen(v)).not.toContain(">>> 1+1");
  } finally { v.dispose(); }
});

test("m marks the cell for the agent through Lens (or says there is none), M twice removes its mark", async () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "chart" }]);
  const mark = vi.fn(async () => "S1");
  const unmark = vi.fn(async () => {});
  const v = make(f, { mark, unmark });
  try {
    v.handleInput("m");
    expect(screen(v)).toContain("No Lens in this notebook");
    const lensState = (selections: unknown[]) => ({ revision: selections.length, nextLabel: `S${selections.length + 1}`, currentSelectionId: null, selections, history: [] });
    f.notebook.apply("model-lifecycle", { model_id: "m1", message: { method: "open", state: { _state: lensState([]), _lens_id: "l" } } });
    v.handleInput("m");
    expect(screen(v)).toContain("Note for the agent on chart (Lens S1)");
    press(v, "look");
    v.handleInput("\r");
    expect(mark).toHaveBeenCalledExactlyOnceWith(f, expect.objectContaining({ id: "a" }), "look");
    await new Promise((r) => setTimeout(r, 0));
    expect(screen(v)).toContain("Marked S1.");
    f.notebook.apply("model-lifecycle", { model_id: "m1", message: { method: "update", state: { _state: lensState([{ id: "sel-1", label: "S1", note: "look", target: { kind: "notebook", cellIds: ["a"] } }]) } } });
    v.handleInput("M");
    expect(screen(v)).toContain("M again removes S1");
    v.handleInput("M");
    expect(unmark).toHaveBeenCalledExactlyOnceWith(f, "sel-1");
  } finally { v.dispose(); }
});

// --- the outline and the detail ---
function notebookWithResults(): Followed {
  const f = nbWith([
    { id: "Zx1a", code: "import marimo as mo\nimport pandas as pd" },
    { id: "Hd2b", code: 'mo.md("# Coffee sales")' },
    { id: "Ld3c", code: "daily = load()\nsmooth = daily.rolling(7).mean()" },
    { id: "Bm4d", code: "model = boom(daily)" },
    { id: "Ch5e", code: "alt.Chart(daily)" },
  ]);
  f.notebook.apply("variables", { variables: [
    { name: "mo", declared_by: ["Zx1a"], used_by: ["Hd2b"] }, { name: "pd", declared_by: ["Zx1a"], used_by: [] },
    { name: "daily", declared_by: ["Ld3c"], used_by: ["Bm4d", "Ch5e"] }, { name: "smooth", declared_by: ["Ld3c"], used_by: [] }, { name: "model", declared_by: ["Bm4d"], used_by: [] },
  ] });
  f.notebook.apply("variable-values", { variables: [{ name: "mo", value: "<module 'marimo'>", datatype: "module" }, { name: "pd", value: "<module 'pandas'>", datatype: "module" }, { name: "daily", value: "<Series object at 0x1042>", datatype: "Series" }] });
  f.notebook.apply("cell-op", { cell_id: "Ld3c", status: "idle" });
  f.notebook.apply("cell-op", { cell_id: "Bm4d", status: "idle", console: [{ channel: "stderr", mimetype: "text/plain", data: "Traceback (most recent call last):\n  File \"cell\", line 1\nKeyError: 'revenue'\n" }], output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "KeyError", msg: "'revenue'" }] } });
  f.notebook.apply("cell-op", { cell_id: "Ch5e", status: "idle", output: { channel: "output", mimetype: "image/png", data: "iVBOR" } });
  return f;
}

test("wide, the outline and the detail sit side by side, every line exactly as wide as the view, with no ids and no reprs", () => {
  const v = make(notebookWithResults());
  try {
    for (const width of [100, 140]) {
      const lines = v.render(width);
      for (const l of lines) expect(visibleWidth(l)).toBe(width);
      const text = lines.join("\n");
      // The title is where its markdown cell is, after the imports cell, and the cells are titled by what they are.
      expect(text).toMatch(/imports[\s\S]*Coffee sales[\s\S]*daily[\s\S]*model[\s\S]*chart/u);
      expect(text).toMatch(/▌ ?○ imports.* │ imports/u);
      for (const id of ["Zx1a", "Hd2b", "Ld3c", "Bm4d", "Ch5e"]) expect(text).not.toContain(id);
    }
    v.handleInput("j");
    v.handleInput("j");
    const detail = screen(v);
    expect(detail).toMatch(/▌ {2}○ daily/u);
        expect(detail).not.toContain("<Series object");
    expect(detail).toContain("used by model, chart");
  } finally { v.dispose(); }
});

test("narrow, a few outline rows around the cursor sit above the detail, and the mouse knows which is which", () => {
  const f = notebookWithResults();
  let closed = false;
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => { closed = true; });
  const ev = (type: string, y: number, extra = {}) => ({ type, button: type === "wheel" ? "none" : "left", x: 10, y, screenX: 10, screenY: y, width: 80, height: 28, shift: false, alt: false, ctrl: false, ...extra }) as any;
  try {
    for (const l of v.render(80)) expect(visibleWidth(l)).toBe(80);
    v.handleInput("j");
    v.handleInput("j");
    v.handleInput("j");
    const lines = v.render(80);
    const text = lines.join("\n");
    // The outline (with the cursor's neighbours), a rule, then the cell's detail with its traceback.
    expect(text).toMatch(/daily[\s\S]*▌ {2}✗ model +KeyError[\s\S]*chart[\s\S]*─{20,}[\s\S]*Traceback \(most recent call last\)/u);
    expect(text).toContain("enter code");
    const rule = lines.findIndex((l, i) => i > 2 && /│ ─{20,} │/u.test(l));
    // As many outline rows above the cursor as below it.
    const cursorRow = lines.findIndex((l) => l.includes("▌  ✗ model"));
    expect(cursorRow - 3).toBe(rule - 1 - cursorRow);
    expect(rule).toBeGreaterThan(3);
    expect(rule).toBeLessThan(12);
    // Enter opens the code in place.
    v.handleInput("\r");
    expect(v.render(80).join("\n")).toContain("model = boom(daily)");
    // A click on an outline row selects it; a click on the detail's code line folds the code.
    const row = v.render(80).findIndex((l) => l.includes("○ chart"));
    v.handleMouse(ev("click", row, { clickCount: 1 }));
    expect(v.render(80).join("\n")).toMatch(/▌ {2}○ chart/u);
    v.handleInput("k");
    const code = v.render(80).findIndex((l) => l.includes("│ model = boom(daily)"));
    v.handleMouse(ev("click", code));
    expect(v.render(80).join("\n")).toContain("│ model = boom(daily)");
    // The wheel over the outline moves the cursor.
    v.handleMouse(ev("wheel", 4, { wheelDelta: 1 }));
    expect(v.render(80).join("\n")).toMatch(/▌ {2}○ chart/u);
    v.handleInput("\x1b");
    expect(closed).toBe(true);
  } finally { v.dispose(); }
});

test("the detail of a failed cell: its error, the traceback, the code folded to a line count that Enter opens", () => {
  const f = notebookWithResults();
  const v = make(f);
  try {
    v.handleInput("e");
    const text = screen(v);
    expect(text).toMatch(/▌ {2}✗ model +KeyError/u);
    expect(text).toContain("KeyError: 'revenue'");
    expect(text).toContain("Traceback (most recent call last)");
    expect(text).toContain("│ model = boom(daily)");
    expect(v.render(100).slice(3, -3).join("\n")).not.toMatch(/\b(error|code|printed)\b/u);
  } finally { v.dispose(); }
});

test("the view's own picture stays on screen while the painter takes the transcript's away", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC";
  const f = nbWith([{ id: "a", code: "plot()" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "image/png", data: png } });
  const writes: string[] = [];
  const painted = { requestRender: () => {}, getScreenLines: () => [] as string[], doRender: () => {}, terminal: { rows: 28, write: (d: string) => { writes.push(d); } } };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
  const v = new NotebookView(painted as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    const line = v.render(120).find((l) => l.includes("\x1b_G"))!;
    const id = /(?:,|G)i=(\d+)/u.exec(line)![1];
    writes.length = 0;
    // Pi writes the frame, with the view's picture and a transcript image under the overlay.
    painted.terminal.write(`${line}\x1b_Ga=p,q=2,i=999\x1b\\`);
    painted.doRender();
    const after = writes.slice(1).join("");
    expect(after).toContain("a=d,d=i,i=999");
    expect(after).not.toContain(`i=${id},`);
    expect(after).not.toContain("a=d,d=a");
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

// --- docked beside the chat ---
test("docked: the banner says how to switch, Esc goes to the chat, q closes, and it never wipes the chat's pictures", async () => {
  const { setCapabilities } = await import("@earendil-works/pi-tui");
  const f = nbWith([{ id: "a", code: "x = 1" }]);
  const writes: string[] = [];
  const painted = { requestRender: () => {}, getScreenLines: () => [] as string[], doRender: () => {}, terminal: { rows: 28, write: (d: string) => { writes.push(d); } } };
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
  const focusMain = vi.fn();
  const done = vi.fn();
  const v = new NotebookView(painted as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, docked: { focused: () => false, focusMain } }, done);
  try {
    const lines = v.render(100);
    expect(lines[0]).toContain("Notebook nb.py · ctrl+] focus");
    expect(lines.join("\n")).toContain("esc chat · q close");
    v.handleInput("\x1b");
    expect(focusMain).toHaveBeenCalledOnce();
    expect(done).not.toHaveBeenCalled();
    v.handleInput("q");
    expect(done).toHaveBeenCalledOnce();
    painted.terminal.write("x");
    painted.doRender();
    expect(writes.join("")).not.toContain("a=d,d=a");
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});

test("| docks the full-screen view with its state, and undocks the docked one", () => {
  const cells = Array.from({ length: 12 }, (_, i) => ({ id: `cell-${i}`, code: `x = ${i}` }));
  const f = nbWith(cells);
  const dock = vi.fn();
  const done = vi.fn();
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, dock }, done);
  try {
    for (let i = 0; i < 10; i++) v.handleInput("j");
    v.handleInput("\r");
    v.handleInput("O");
    v.handleInput("|");
    expect(dock).toHaveBeenCalledWith(notebookKey(f), expect.objectContaining({ cursor: "cell-10", codeOpen: ["cell-10"], section: true }));
    expect(done).toHaveBeenCalled();
  } finally { v.dispose(); const reset = make(f); reset.handleInput("O"); reset.dispose(); }
  const undock = vi.fn();
  const d = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {}, docked: { focused: () => true, focusMain: () => {} }, undock }, () => {});
  try {
    d.handleInput("|");
    expect(undock).toHaveBeenCalledOnce();
  } finally { d.dispose(); }
});

test("a view started from a state shows the same cell and code", () => {
  const f = nbWith(Array.from({ length: 12 }, (_, i) => ({ id: `cell-${i}`, code: `x = ${i}`, name: `cell-${i}` })));
  const v = make(f, { initial: { cursor: "cell-10", codeOpen: ["cell-10"], section: false, follow: false, scroll: 0, detailScroll: 0, folded: [], diffs: [], filter: "", mode: "cells", varFilter: "" } });
  try {
    const text = screen(v);
    expect(text).toContain("▌○ cell-10");
    expect(text).toContain("│ x = 10");
  } finally { v.dispose(); }
});

// --- parts, tables, markdown editing, code blocks ---

test("ctrl+j and ctrl+k move between sections", () => {
  const f = nbWith([{ id: "h1", code: 'mo.md("# One")' }, { id: "a", code: "a = 1" }, { id: "h2", code: 'mo.md("# Two")' }, { id: "c", code: "c = 3" }]);
  const v = make(f);
  try {
    expect(screen(v)).toMatch(/▌ One/u);
    v.handleInput("\n");
    expect(screen(v)).toMatch(/▌ Two/u);
    v.handleInput("\x0b");
    expect(screen(v)).toMatch(/▌ One/u);
  } finally { v.dispose(); }
});

test("n and p walk a cell's parts and Enter acts on the focused one", () => {
  const f = nbWith([{ id: "a", code: "x = 1\nprint(x)" }, { id: "b", code: "y = 2" }]);
  const slider = "<marimo-ui-element object-id='a-0' random-id='x'><marimo-slider data-initial-value='1' data-label='&quot;s&quot;' data-start='0' data-stop='2' data-step='1' data-steps='[]'></marimo-slider></marimo-ui-element>";
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", console: [{ channel: "stdout", mimetype: "text/plain", data: "one\ntwo\n" }], output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "KeyError", msg: "k" }] } });
  f.notebook.apply("cell-op", { cell_id: "a", output: { channel: "output", mimetype: "text/html", data: slider } });
  // The error output was replaced by the widget; set the error again through the cell's own state.
  f.notebook.cells.get("a")!.error = "KeyError: k";
  const v = make(f, { setWidget: () => {} });
  try {
    // The focused part's rows carry the accent bar; there are no labels.
    const focused = () => screen(v).split("\n").filter((l) => / │ ▌ /u.test(l) || /^│ ▌ /u.test(l)).join("\n");
    expect(v.render(100).slice(3, -3).map((l) => l.split(" │ ")[1] ?? "").join("\n")).not.toMatch(/\bprinted\b/u);
    v.handleInput("n");
    expect(focused()).toContain("KeyError: k");
    v.handleInput("n");
    expect(focused()).toContain("one");
    v.handleInput("n");
    expect(focused()).toMatch(/◆ s/u);
    v.handleInput("n");
    expect(focused()).toContain("x = 1");
    expect(screen(v)).toContain("⋯ +1");
    v.handleInput("\r");
    expect(screen(v)).not.toContain("⋯ +1");
    expect(screen(v)).toContain("print(x)");
    v.handleInput("p");
    expect(focused()).toMatch(/◆ s/u);
    v.handleInput("j");
    v.handleInput("k");
    expect(focused()).toBe("");
  } finally { v.dispose(); }
});

const tableHtml = (selection = "multi") => `<marimo-ui-element object-id='t-0' random-id='r'><marimo-table data-data='&quot;[{&#92;&quot;city&#92;&quot;:&#92;&quot;Oslo&#92;&quot;,&#92;&quot;pop&#92;&quot;:709000,&#92;&quot;_marimo_row_id&#92;&quot;:&#92;&quot;0&#92;&quot;}]&quot;' data-total-rows='30' data-total-columns='2' data-page-size='1' data-selection='&quot;${selection}&quot;' data-field-types='[[&quot;city&quot;,[&quot;string&quot;,&quot;object&quot;]],[&quot;pop&quot;,[&quot;integer&quot;,&quot;int64&quot;]]]'></marimo-table></marimo-ui-element>`;

test("t drives a marimo table: paging, sorting and selection go through the kernel", async () => {
  const { clearTableSessions } = await import("../src/ui/table-session.js");
  clearTableSessions();
  const f = nbWith([{ id: "a", code: "df" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: tableHtml() } });
  const calls: any[] = [];
  const call = vi.fn(async (_f: unknown, _id: string, fn: string, args: any) => {
    calls.push({ fn, args });
    return { data: JSON.stringify([{ city: "Rome", pop: 5, _marimo_row_id: "9" }]), total_rows: 30 };
  });
  const setTableSelection = vi.fn();
  const v = make(f, { table: { call, file: async () => "[]" }, setTableSelection });
  try {
    v.render(100);
    v.handleInput("t");
    expect(screen(v)).toContain("table: hjkl move");
    v.handleInput("]");
    await Promise.resolve();
    expect(calls.at(-1)).toMatchObject({ fn: "search", args: { page_number: 1, page_size: 1 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen(v)).toContain("Rome");
    v.handleInput("s");
    expect(calls.at(-1)?.args.sort).toEqual([{ by: "city", descending: false }]);
    await new Promise((r) => setTimeout(r, 0));
    v.handleInput(" ");
    expect(setTableSelection).toHaveBeenCalledWith(f, expect.anything(), "t-0", ["9"]);
    v.handleInput("\r");
    expect(screen(v)).toContain("row 1");
    v.handleInput("\x1b");
    expect(screen(v)).not.toContain("row 1");
    expect(screen(v)).toContain("table: hjkl move");
    v.handleInput("\x1b");
    expect(screen(v)).not.toContain("table: hjkl move");
  } finally { v.dispose(); clearTableSessions(); }
});

test("Enter on a markdown cell edits it and saves through editCell", () => {
  const f = nbWith([{ id: "m", code: 'mo.md("# Title")' }, { id: "a", code: "x = 1" }]);
  const editCell = vi.fn(async () => {});
  const v = make(f, { editCell });
  try {
    expect(screen(v)).not.toContain("│ mo.md");
    v.handleInput("\r");
    const text = screen(v);
    expect(text).toContain("Edit markdown");
    expect(text).toContain("# Title");
    v.handleInput("!");
    v.handleInput("\r");
    expect(editCell).toHaveBeenCalledWith(f, expect.objectContaining({ id: "m" }), 'mo.md(r"""\n# Title!\n""")');
  } finally { v.dispose(); }
});

test("code has a background block when the theme has one", () => {
  const f = nbWith([{ id: "a", code: "x = 1\ny = 2" }]);
  const bgTheme = { ...theme, bg: (c: string, t: string) => `<${c}>${t}</${c}>` };
  const v = new NotebookView(tui as any, bgTheme as any, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    screen(v);
    v.handleInput("\r");
    const text = screen(v);
    expect(text).toContain("<toolPendingBg>");
    expect(text).not.toContain("│ y = 2");
  } finally { v.dispose(); }
});

test("the mouse drives widgets: a press on a slider sets it and a drag moves it, a click toggles a checkbox, the wheel steps the focused one", () => {
  const f = nbWith([{ id: "a", code: "n = mo.ui.slider(0, 10)" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: widgetHtml } });
  const setWidget = vi.fn((g: Followed, cell: any, w: any, value: unknown) => g.notebook.setUserValue(cell.id, w.objectId, w.label, value));
  const v = make(f, { setWidget });
  const ev = (type: string, x: number, y: number, extra = {}) => ({ type, button: type === "wheel" ? "none" : "left", x, y, screenX: x, screenY: y, width: 100, height: 28, shift: false, alt: false, ctrl: false, ...extra }) as any;
  try {
    const lines = v.render(100);
    const sliderRow = lines.findIndex((l) => l.includes("◆ n "));
    const boxRow = lines.findIndex((l) => l.includes("◆ on "));
    // Where the slider's bar starts: the line's text, from the frame's border.
    const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/gu, "");
    const barAt = strip(lines[sliderRow]!).indexOf("━");
    // The press at the bar's last cell sets the top value and captures the drag.
    expect(v.handleMouse(ev("press", barAt + 15, sliderRow))).toEqual({ handled: true, capture: true });
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.objectContaining({ id: "a" }), expect.objectContaining({ objectId: "a-0" }), 10);
    v.handleMouse(ev("drag", barAt, sliderRow));
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-0" }), 0);
    v.handleMouse(ev("release", barAt, sliderRow));
    // The wheel over the focused slider steps it; up is more.
    v.handleMouse(ev("wheel", barAt, sliderRow, { wheelDelta: -1 }));
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-0" }), 1);
    // A click on the checkbox toggles it.
    const boxAt = strip(v.render(100)[boxRow]!).indexOf("[x]");
    v.handleMouse(ev("press", boxAt, boxRow));
    v.handleMouse(ev("click", boxAt, boxRow));
    expect(setWidget).toHaveBeenLastCalledWith(f, expect.anything(), expect.objectContaining({ objectId: "a-1" }), false);
    expect(v.render(100).join("\n")).toContain("▸ on");
  } finally { v.dispose(); }
});
