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
  notebook.apply("kernel-ready", { cell_ids: Array.from({ length: 100 }, (_, i) => `cell-${i}`), codes: Array(100).fill("x = 1"), names: Array(100).fill("_") });
  return { attachment: { path: "/w/nb.py", url, sessionId }, notebook, connection: "connected", current: true, touchedAt: 0 };
}
function busy(f: Followed) { f.notebook.apply("cell-op", { cell_id: "cell-0", status: "running" }); }

test("notebook detail uses Ctrl-U/D half-page primary and Page keys full-page", () => {
  const f = followed();
  const view = new NotebookView(tui as any, theme, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    view.handleInput("g");
    view.handleInput("\x04");
    expect(view.render(100)[5]).toContain("cell-10");
    view.handleInput("\x1b[6~");
    expect(view.render(100)[5]).toContain("cell-30");
    view.handleInput("\x15");
    expect(view.render(100)[5]).toContain("cell-20");
    view.handleInput("\x1b[5~");
    expect(view.render(100)[5]).toContain("cell-0");
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
    expect(view.render(100).join("\n")).toContain("http://server-b.invalid");
    expect(view.render(100).join("\n")).not.toContain("http://server-a.invalid");
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

test("the header counts cells, stale and failed ones, and names the server and the last run", () => {
  const f = nbWith([{ id: "a", code: "x = 1" }, { id: "b", code: "y = x" }, { id: "m", code: 'mo.md("# T")' }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", stale_inputs: true, output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "ValueError", msg: "bad" }] } });
  const v = make(f, { servers: () => ["nb-server"], lastRun: () => "ran 3s · 1 error · 1m ago" });
  try {
    const text = screen(v);
    expect(text).toContain("2 cells");
    expect(text).toContain("1 stale");
    expect(text).toContain("1 error");
    expect(text).toContain("server nb-server");
    expect(text).toContain("ran 3s · 1 error · 1m ago");
    expect(text).toContain("http://fixture.invalid");
  } finally { v.dispose(); }
});

test("j/k move the cursor between cells and Enter expands its code, console and output", () => {
  const f = nbWith([{ id: "a", code: "print('hi')\nx = 1" }, { id: "b", code: "y = 2" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "running", timestamp: 1 });
  f.notebook.apply("cell-op", { cell_id: "a", console: [{ channel: "stdout", mimetype: "text/plain", data: "hi\n" }], output: { channel: "output", mimetype: "text/html", data: "<span>value &amp; more</span>" } });
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", timestamp: 2 });
  const v = make(f);
  try {
    expect(screen(v)).toMatch(/▸ ○ a/u);
    v.handleInput("j");
    expect(screen(v)).toMatch(/▸ ○ b/u);
    v.handleInput("k");
    v.handleInput("\r");
    const open = screen(v);
    expect(open).toMatch(/▾ ○ a/u);
    expect(open).toContain("│ print('hi')");
    expect(open).toContain("▍ hi");
    expect(open).toContain("▍ value & more");
    v.handleInput("\r");
    expect(screen(v)).not.toContain("value & more");
  } finally { v.dispose(); }
});

test("n and N jump between failed cells; / filters by name, variable or code and Esc clears", () => {
  const f = nbWith([{ id: "a", code: "x = 1", name: "load" }, { id: "b", code: "boom()" }, { id: "c", code: "z = 3" }]);
  f.notebook.apply("cell-op", { cell_id: "b", status: "idle", output: { channel: "marimo-error", mimetype: "application/vnd.marimo+error", data: [{ type: "exception", exception_type: "E", msg: "m" }] } });
  const v = make(f);
  try {
    v.handleInput("n");
    expect(screen(v)).toMatch(/▸ ✗ b/u);
    v.handleInput("N");
    expect(screen(v)).toMatch(/▸ ✗ b/u);
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
    expect(screen(v)).toMatch(/▸ ● c40/u);
    v.handleInput("k");
    expect(screen(v)).toMatch(/▸ ○ c39/u);
    v.handleInput("f");
    expect(screen(v)).toMatch(/▸ ● c40/u);
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
    expect(screen(v)).toContain("S stop server");
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
    v.handleInput("l");
    expect(screen(v)).toContain("[image png]");
    expect(screen(v)).not.toContain("\x1b_G");
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false } as any);
    v.invalidate?.();
    const shown = v.render(100);
    expect(shown.filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
    expect(shown.every((l) => visibleWidth(l) === 100)).toBe(true);
    // The agent-facing outline never carries image escapes.
    expect(notebookLines(f.notebook, theme2, 0, { expanded: new Set(["a"]) }).lines.join("\n")).not.toContain("\x1b_G");
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
    v.handleInput("l");
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
    v.handleInput("l");
    v.render(100);
    await new Promise((r) => setTimeout(r, 0));
    v.render(100);
    await new Promise((r) => setTimeout(r, 0));
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
  const f = nbWith([{ id: "a", code: "fig" }]);
  f.notebook.apply("cell-op", { cell_id: "a", status: "idle", output: { channel: "output", mimetype: "text/html", data: `<marimo-plotly data-figure='{&quot;data&quot;:[],&quot;layout&quot;:{}}'></marimo-plotly>` } });
  const events: any[] = [];
  let closed = false;
  const live = new LiveCharts(() => {}, () => ({ stop() {} }) as any, async () => ({ frame: png, pointer: (p: any) => events.push(p), close: () => { closed = true; } }));
  const v = new NotebookView(tui as any, theme2, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {}, undefined, undefined, live);
  try {
    v.handleInput("l");
    expect(screen(v)).toContain("starting");
    await new Promise((r) => setTimeout(r, 0));
    const shown = v.render(100);
    expect(shown.filter((l) => l.includes("\x1b_G"))).toHaveLength(1);
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
    // Collapsing the cell closes its page.
    v.handleInput("l");
    v.render(100);
    expect(closed).toBe(true);
  } finally { v.dispose(); setCapabilities({ images: null, trueColor: true, hyperlinks: false } as any); }
});
