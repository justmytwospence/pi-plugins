// The live charts of a notebook view: which expanded outputs have a running page, the latest frame of
// each, and where on screen each is drawn so the mouse can reach it.
import { allocateImageId, encodeKitty, getCellDimensions, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { CellOutput } from "../core/output.js";
import { type ChromeHost, sharedChrome } from "../core/chrome.js";
import { type Geometry, LiveChart, type Pointer } from "../core/live.js";

/** What a live page must do for the view (LiveChart does; tests stand in). */
export interface LivePage {
  pointer(p: Pointer): void;
  close(): void;
}
export type OpenLive = (host: ChromeHost, figure: string, geometry: Geometry, onFrame: (png: string) => void) => Promise<LivePage>;

export type LiveState =
  | { status: "opening" }
  | { status: "ready"; page: LivePage; frame: string; imageId: number; geometry: Geometry }
  | { status: "failed"; reason: string };

/** Where a drawn chart sits in the view's lines, and what to send events to. */
export interface LiveRect { top: number; left: number; geometry: Geometry; output: CellOutput }

/** The image's size in cells: as wide as allowed, as high as its aspect says, within `maxRows`. */
export function liveGeometry(maxCols: number, maxRows: number, aspect = 0.6): Geometry {
  const cell = getCellDimensions();
  let cols = Math.max(10, maxCols);
  let rows = Math.max(2, Math.round((cols * cell.widthPx * aspect) / cell.heightPx));
  if (rows > maxRows) {
    rows = Math.max(2, maxRows);
    cols = Math.max(10, Math.min(cols, Math.floor((rows * cell.heightPx) / (cell.widthPx * aspect))));
  }
  return { cols, rows, cellW: cell.widthPx, cellH: cell.heightPx };
}

/** The Kitty sequence and blank rows for a frame: a block `rows` lines high, drawn at its first line. */
export function frameLines(png: string, geometry: Geometry, imageId: number): string[] {
  return [encodeKitty(png, { columns: geometry.cols, rows: geometry.rows, imageId, moveCursor: false }), ...Array.from({ length: geometry.rows - 1 }, () => "")];
}

const IDLE_MS = 5 * 60_000;

export class LiveCharts {
  private readonly states = new Map<CellOutput, LiveState & { key: string }>();
  private seen = new Set<CellOutput>();
  rects: LiveRect[] = [];
  private pressed: LiveRect | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onChange: () => void,
    private readonly host: () => ChromeHost = sharedChrome,
    private readonly open: OpenLive = LiveChart.open,
  ) {}

  /** Call before building the rows of a frame. */
  beginFrame(): void {
    this.seen = new Set();
    this.rects = [];
  }

  /** Call after: pages for outputs no longer shown are closed, and the browser stops when none is left. */
  endFrame(): void {
    for (const [output, state] of this.states) {
      if (this.seen.has(output)) continue;
      if (state.status === "ready") state.page.close();
      this.states.delete(output);
    }
    if (this.states.size === 0 && !this.idle) {
      this.idle = setTimeout(() => { this.idle = undefined; if (this.states.size === 0) this.host().stop(); }, IDLE_MS);
      this.idle.unref?.();
    } else if (this.states.size > 0 && this.idle) { clearTimeout(this.idle); this.idle = undefined; }
  }

  /** The state of an output's live page, opening it when new (or when the room for it has changed). */
  state(output: CellOutput, figure: string, geometry: Geometry): LiveState {
    this.seen.add(output);
    const key = `${geometry.cols}x${geometry.rows}@${geometry.cellW}x${geometry.cellH}`;
    const known = this.states.get(output);
    if (known && known.key === key) return known;
    if (known?.status === "ready") known.page.close();
    const fresh: LiveState & { key: string } = { status: "opening", key };
    this.states.set(output, fresh);
    this.open(this.host(), figure, geometry, (png) => {
      const now = this.states.get(output);
      if (now && now.key === key && now.status === "ready") { now.frame = png; this.onChange(); }
    }).then(
      (page) => {
        const now = this.states.get(output);
        const frame = (page as { frame?: string }).frame ?? "";
        if (!now || now !== fresh) { page.close(); return; }
        this.states.set(output, { status: "ready", page, frame, imageId: allocateImageId(), geometry, key });
        this.onChange();
      },
      (e: unknown) => {
        if (this.states.get(output) === fresh) this.states.set(output, { status: "failed", reason: e instanceof Error ? e.message : String(e), key });
        this.onChange();
      },
    );
    return fresh;
  }

  /** Routes a mouse event (view-local cells) to the chart under it, or to the one being dragged. */
  mouse(e: TuiMouseEvent): { handled: boolean; capture?: boolean } | undefined {
    const hit = this.rects.find((r) => e.y >= r.top && e.y < r.top + r.geometry.rows && e.x >= r.left && e.x < r.left + r.geometry.cols);
    const target = this.pressed ?? hit;
    if (!target) return undefined;
    const state = this.states.get(target.output);
    if (state?.status !== "ready") return undefined;
    const type = e.type === "click" ? undefined : e.type;
    if (!type) return { handled: true };
    if (e.type === "press") this.pressed = target;
    if (e.type === "release") this.pressed = undefined;
    state.page.pointer({ type, x: e.x - target.left + 0.5, y: e.y - target.top + 0.5, button: e.button, ...(e.wheelDelta !== undefined ? { wheelDelta: e.wheelDelta } : {}) });
    return { handled: true, ...(e.type === "press" ? { capture: true } : {}) };
  }

  dispose(): void {
    if (this.idle) clearTimeout(this.idle);
    for (const state of this.states.values()) if (state.status === "ready") state.page.close();
    this.states.clear();
  }
}
