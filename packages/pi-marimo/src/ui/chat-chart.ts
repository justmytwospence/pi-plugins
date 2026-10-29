// A notebook chart in the chat transcript: the same live chart as the notebook view (a page of the
// sandboxed browser, frames drawn in place), shown under a one-line caption. The mouse over it goes
// to the page; `/marimo inspect` drives the latest one from the keyboard.
import { type Component, Image, type TuiMouseEvent, type TuiMouseEventResult, getCapabilities, getPngDimensions, truncateToWidth } from "@earendil-works/pi-tui";
import type { CellOutput } from "../core/output.js";
import { LiveCharts, liveGeometry } from "./live-charts.js";
import { Painter } from "./painter.js";

/** What the transcript keeps for a chart: enough to draw it again after a restart. */
export interface ChartEntry {
  /** Notebook file and cell (id and display name). */
  path: string;
  cell: string;
  label: string;
  /** A Plotly figure (JSON text): drawn live. */
  plotly?: string;
  /** Otherwise a picture (base64 PNG). */
  png?: string;
  /** Why there is neither, for the caption. */
  note?: string;
}

interface Theme { fg(color: string, text: string): string }

/** The chart text's columns from the component's left edge. */
const LEFT = 2;
const MAX_COLS = 72;
const MAX_ROWS = 18;

/** Every chart in the transcript, newest last: for `/marimo inspect`, and to close their pages. */
const charts: ChatChart[] = [];

export function latestChart(): ChatChart | undefined {
  return charts.at(-1);
}

export function disposeCharts(): void {
  for (const c of charts.splice(0)) c.dispose();
}

export class ChatChart implements Component {
  private readonly output: CellOutput;
  readonly live: LiveCharts;
  private image: Image | undefined;
  private readonly tui: () => unknown;
  /** A picture drawn by the painter: its slot and size. */
  private still: { slot: number; geometry: { cols: number; rows: number } } | undefined;

  constructor(readonly entry: ChartEntry, private readonly theme: Theme, requestRender: () => void, live?: LiveCharts, tui?: () => unknown) {
    this.output = { kind: "chart", text: entry.label, ...(entry.plotly ? { plotly: entry.plotly } : {}) };
    this.tui = () => tui?.();
    this.live = live ?? new LiveCharts(requestRender, undefined, undefined, undefined, () => Painter.for(this.tui()));
    charts.push(this);
    if (charts.length > 8) charts.shift()?.dispose();
  }

  render(width: number): string[] {
    const th = this.theme;
    const file = this.entry.path.split("/").at(-1) ?? this.entry.path;
    const lines = [truncateToWidth(`${th.fg("accent", "▍")} ${th.fg("dim", `marimo · ${this.entry.label} · ${file}`)}`, width)];
    const pad = " ".repeat(LEFT);
    this.live.rects = [];
    if (this.entry.plotly && getCapabilities().images === "kitty") {
      const geometry = liveGeometry(Math.min(MAX_COLS, width - LEFT - 1), MAX_ROWS);
      const state = this.live.state(this.output, this.entry.plotly, geometry);
      if (state.status === "ready") {
        this.live.rects.push({ top: lines.length, left: LEFT, geometry: state.geometry, output: this.output });
        lines.push(...this.live.lines(state).map((l, i) => (i === 0 ? `${pad}${l}` : "")));
        lines.push(th.fg("dim", `${pad}hover, drag to zoom, wheel · /marimo inspect drives it from the keyboard`));
        return lines;
      }
      lines.push(th.fg("dim", `${pad}${state.status === "opening" ? "[chart: starting…]" : `[chart: could not draw (${state.reason.slice(0, 100)})]`}`));
      return lines;
    }
    const painter = this.entry.png && getCapabilities().images === "kitty" ? Painter.for(this.tui()) : undefined;
    if (this.entry.png && painter) {
      // Pictures go through the painter too, so they hide under overlays like the live charts.
      if (!this.still) {
        const dims = getPngDimensions(this.entry.png);
        const geometry = liveGeometry(Math.min(MAX_COLS, width - LEFT - 1), MAX_ROWS, dims ? dims.heightPx / dims.widthPx : 0.6);
        this.still = { slot: painter.add(geometry), geometry };
        painter.present(this.still.slot, this.entry.png);
      }
      lines.push(...painter.lines(this.still.slot, this.still.geometry.rows).map((l, i) => (i === 0 ? `${pad}${l}` : "")));
      return lines;
    }
    if (this.entry.png && getCapabilities().images) {
      this.image ??= new Image(this.entry.png, "image/png", { fallbackColor: (t) => th.fg("dim", t) }, { maxWidthCells: MAX_COLS, maxHeightCells: MAX_ROWS });
      lines.push(...this.image.render(Math.max(10, width - LEFT)).map((l, i) => (i === 0 || l ? `${pad}${l}` : l)));
      return lines;
    }
    lines.push(th.fg("dim", `${pad}${this.entry.note ?? "[no chart output]"}`));
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.live.mouse(event);
  }

  invalidate(): void {
    this.image?.invalidate();
    this.live.refresh();
  }

  /** Starts the keyboard pointer; false when the chart is not live. */
  inspect(): boolean {
    return this.live.inspect(this.output);
  }

  dispose(): void {
    if (this.still) Painter.for(this.tui())?.remove(this.still.slot);
    this.still = undefined;
    this.live.dispose();
  }
}
