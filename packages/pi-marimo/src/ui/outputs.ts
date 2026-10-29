// A cell's output and console as rows of the notebook view: text, a table's grid, an inline image
// (a PNG, or a Vega-Lite or Plotly chart drawn to one), or a live Plotly chart the mouse drives.
import { Image, getCapabilities } from "@earendil-works/pi-tui";
import type { Cell } from "../core/notebook.js";
import type { CellOutput } from "../core/output.js";
import type { FrameTheme } from "../frame.ts";
import { liveGeometry } from "./live-charts.js";
import type { Row, RowOptions } from "./rows.js";
import { tableGrid } from "./table.js";

/** The default indent of everything under a cell's line; the detail pane passes none. */
export const PAD = "      ";
/** Rows an inline image may take when the caller does not say; its width is the pane's. */
export const IMAGE_ROWS = 14;
/** The columns a picture may take: the pane's width less the indent and the bar. */
const imageCols = (opts: RowOptions, pad: string): number => Math.max(10, (opts.width ?? 80) - pad.length - 2);
const images = new WeakMap<CellOutput, { key: string; img: Image }>();

export const clean = (line: string) => line.replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, "").replace(/\t/gu, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");

/** An image output as rows: the first carries the terminal's image sequence, the rest are empty rows it covers. */
function inlineImage(output: CellOutput, theme: FrameTheme, pad: string, opts: RowOptions): Row[] | undefined {
  const maxRows = opts.imageRows ?? IMAGE_ROWS;
  if (maxRows < 2 || !output.image) return undefined;
  const cols = imageCols(opts, pad);
  // One Image per output and size: a resize or another pane width draws it anew.
  const key = `${cols}x${maxRows}`;
  let held = images.get(output);
  if (!held || held.key !== key) {
    held = { key, img: new Image(output.image.data, output.image.mime, { fallbackColor: (t) => theme.fg("dim", t) }, { maxWidthCells: cols, maxHeightCells: maxRows }) };
    images.set(output, held);
  }
  const lines = held.img.render(cols);
  if (!lines.some((l) => l.includes("\x1b_G"))) return undefined;
  const bar = `${pad}${opts.bar ?? theme.fg("accent", "▍")} `;
  const alt = `${bar}${theme.fg("dim", "[image png: scroll until it fits on screen]")}`;
  return lines.map((line, index) => ({ text: index === 0 ? `${bar}${line}` : bar.trimEnd(), image: { index, height: lines.length, alt } }));
}

/** The last `max` lines a cell printed. */
export function consoleRows(cell: Cell, theme: FrameTheme, max: number): Row[] {
  return (cell.console ?? []).slice(-max).map((l) => ({ text: `${PAD}${theme.fg("dim", "▍")} ${l.stream === "stderr" ? theme.fg("warning", clean(l.text)) : clean(l.text)}` }));
}

/** A cell's output: an image or chart when the terminal draws them, a table's grid, else its text. */
export function outputRows(cell: Cell, theme: FrameTheme, opts: RowOptions, limits: { textLines: number; tableRows: number }): Row[] {
  const out: Row[] = [];
  const pad = opts.pad ?? PAD;
  const push = (text: string) => out.push({ text });
  const output = cell.output;
  let chartNote: string | undefined;
  let whyStatic: string | undefined;
  if (output?.plotly) {
    const images = getCapabilities().images;
    if (!images) whyStatic = undefined;
    else if (!opts.live) whyStatic = "live charts are off";
    else if (images !== "kitty") whyStatic = `this terminal reports images=${String(images)}, live charts need kitty`;
    else if ((opts.imageRows ?? IMAGE_ROWS) < 4) whyStatic = "the view is too short";
  }
  if (output?.plotly && opts.live && getCapabilities().images && !whyStatic) {
    const geometry = liveGeometry(imageCols(opts, pad), opts.imageRows ?? IMAGE_ROWS);
    const state = opts.live.state(output, output.plotly, geometry);
    if (state.status === "ready") {
      const bar = `${pad}${opts.bar ?? theme.fg("accent", "▍")} `;
      const alt = `${bar}${theme.fg("dim", "[chart: scroll until it fits on screen]")}`;
      const lines = opts.live.lines(state);
      out.push(...lines.map((line, index): Row => ({ text: index === 0 ? `${bar}${line}` : bar.trimEnd(), image: { index, height: lines.length, alt, live: { output, geometry: state.geometry } } })));
      return out;
    }
    if (state.status === "opening") chartNote = "[chart: starting…]";
    else whyStatic = `live chart failed: ${state.reason.slice(0, 120)}`;
  }
  if (whyStatic) push(`${pad}${theme.fg("warning", "▍")} ${theme.fg("warning", `static image (${whyStatic})`)}`);
  const chart = output?.vega ? { spec: output.vega, via: opts.vega } : output?.plotly ? { spec: output.plotly, via: opts.plotly } : undefined;
  if (output && chart?.via && !output.image && !(chartNote && output.plotly) && getCapabilities().images && (opts.imageRows ?? IMAGE_ROWS) >= 2) {
    const state = chart.via.request(chart.spec, opts.onVega ?? (() => undefined));
    if (state.status === "ready") output.image = { mime: "image/png", data: state.png };
    else chartNote = state.status === "rendering" ? "[chart: drawing…]" : `[chart: could not draw (${state.reason.slice(0, 80)}); o opens the notebook]`;
  }
  const inline = output?.image && getCapabilities().images ? inlineImage(output, theme, pad, opts) : undefined;
  if (inline) out.push(...inline);
  else if (output?.table) {
    const driven = opts.table?.(cell) ?? { data: output.table };
    const data = driven.data;
    const have = data.records?.length ? data.records.length : data.rows.length;
    if (!have && (data.dataRef || data.lazy)) push(`${pad}${opts.bar ?? theme.fg("accent", "▍")} ${theme.fg("dim", "loading table…")}`);
    else {
      const grid = tableGrid(data, (opts.width ?? 80) - pad.length - 2, theme, Math.min(limits.tableRows, Math.max(1, have)), driven.render);
      grid.lines.forEach((line, i) => out.push({ text: `${pad}${opts.bar ?? theme.fg("accent", "▍")} ${line}`, ...(grid.rowAt[i] !== undefined ? { tableRow: grid.rowAt[i]! } : {}) }));
    }
  } else if (output && !(output.kind === "widgets" && !output.text)) {
    const text = output.kind === "text" || output.kind === "other" ? output.text : theme.fg("dim", chartNote ?? output.text);
    const lines = text.split("\n");
    for (const line of lines.slice(0, limits.textLines)) push(`${pad}${opts.bar ?? theme.fg("accent", "▍")} ${clean(line)}`);
    if (lines.length > limits.textLines) push(`${pad}${opts.bar ?? theme.fg("dim", "▍")} ${theme.fg("dim", `… ${lines.length - limits.textLines} more lines`)}`);
  }
  return out;
}
