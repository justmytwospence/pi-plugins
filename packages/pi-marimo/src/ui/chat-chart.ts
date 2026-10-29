// A notebook chart in the chat transcript: the same live chart as the notebook view (a page of the
// sandboxed browser, frames drawn in place), shown under a one-line caption. The mouse over it goes
// to the page; `/marimo inspect` drives the latest one from the keyboard.
import { type Component, Image, type TuiMouseEvent, type TuiMouseEventResult, getCapabilities, truncateToWidth } from "@earendil-works/pi-tui";
import type { CellOutput } from "../core/output.js";
import { LiveCharts, liveGeometry } from "./live-charts.js";

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

  constructor(readonly entry: ChartEntry, private readonly theme: Theme, requestRender: () => void, live?: LiveCharts) {
    this.output = { kind: "chart", text: entry.label, ...(entry.plotly ? { plotly: entry.plotly } : {}) };
    this.live = live ?? new LiveCharts(requestRender);
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
    this.live.dispose();
  }
}
