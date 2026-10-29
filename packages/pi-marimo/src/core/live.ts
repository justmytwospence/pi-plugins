// A live chart: the figure runs in a page of the sandboxed browser (chrome.ts), pointer events from
// the terminal go in as real mouse events, and each change comes back as a PNG for the view to draw.
// The page is sized to the cells the image covers, so a cell position maps straight to a pixel.
import type { ChromeHost } from "./chrome.js";
import type { CdpClient } from "./cdp.js";

export interface Geometry {
  /** The image's size in terminal cells, and a cell's size in physical pixels. */
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
}

export interface Pointer {
  type: "move" | "press" | "release" | "drag" | "wheel" | "dblclick";
  /** Position in cells from the image's top-left corner (fractions allowed). */
  x: number;
  y: number;
  button?: "left" | "middle" | "right" | "none";
  /** Logical lines; negative scrolls up. */
  wheelDelta?: number;
}

/** How many device pixels make one CSS pixel: 2 on a high-density terminal (cells over 28 px tall), else 1. */
export const densityOf = (g: Geometry): number => (g.cellH >= 28 ? 2 : 1);

/** A cell position as a CSS pixel in the page. */
export function toPage(g: Geometry, x: number, y: number): { x: number; y: number } {
  const s = densityOf(g);
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));
  const w = (g.cols * g.cellW) / s;
  const h = (g.rows * g.cellH) / s;
  return { x: clamp((x / g.cols) * w, w), y: clamp((y / g.rows) * h, h) };
}

const BUTTON = { left: "left", middle: "middle", right: "right", none: "none" } as const;

export class LiveChart {
  private frameData: string | undefined;
  private capturing = false;
  private dirty = false;
  private closed = false;
  private trailing: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    private readonly conn: CdpClient,
    private readonly targetId: string,
    private readonly sessionId: string,
    readonly geometry: Geometry,
    private readonly onFrame: (png: string) => void,
  ) {}

  /** Opens a page for the figure (JSON text with `data` and `layout`) and returns once its first frame is ready. */
  static async open(host: ChromeHost, figure: string, geometry: Geometry, onFrame: (png: string) => void): Promise<LiveChart> {
    const conn = await host.connection();
    const { targetId } = await conn.send("Target.createTarget", { url: "about:blank" }) as { targetId: string };
    const { sessionId } = await conn.send("Target.attachToTarget", { targetId, flatten: true }) as { sessionId: string };
    const chart = new LiveChart(conn, targetId, sessionId, geometry, onFrame);
    try {
      const s = densityOf(geometry);
      const w = Math.round((geometry.cols * geometry.cellW) / s);
      const h = Math.round((geometry.rows * geometry.cellH) / s);
      await chart.cmd("Page.enable");
      // The page runs at density 1 and the screenshot is scaled: a scaled page makes Chrome replay the last mouse position at the wrong spot, which ends every hover.
      await chart.cmd("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      const loaded = new Promise<void>((resolve) => { const off = conn.on("Page.loadEventFired", sessionId, () => { off(); resolve(); }); });
      await chart.cmd("Page.navigate", { url: host.hostUrl });
      await loaded;
      const shown = await chart.cmd("Runtime.evaluate", { expression: `window.show(${figure}, ${w}, ${h})`, awaitPromise: true, returnByValue: true });
      if (shown.exceptionDetails) throw new Error(String(shown.exceptionDetails.exception?.description ?? shown.exceptionDetails.text ?? "could not draw the figure").split("\n")[0]);
      await chart.capture();
      return chart;
    } catch (e) {
      chart.close();
      throw e;
    }
  }

  private cmd(method: string, params: Record<string, unknown> = {}) {
    return this.conn.send(method, params, this.sessionId);
  }

  get frame(): string | undefined {
    return this.frameData;
  }

  /** Takes a screenshot now; a request that arrives meanwhile is served by one more right after. */
  async capture(): Promise<void> {
    if (this.closed) return;
    if (this.capturing) { this.dirty = true; return; }
    this.capturing = true;
    try {
      do {
        this.dirty = false;
        const s = densityOf(this.geometry);
        const shot = await this.cmd("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: Math.round((this.geometry.cols * this.geometry.cellW) / s), height: Math.round((this.geometry.rows * this.geometry.cellH) / s), scale: s } });
        if (typeof shot.data === "string" && shot.data !== this.frameData && !this.closed) {
          this.frameData = shot.data;
          this.onFrame(shot.data);
        }
      } while (this.dirty && !this.closed);
    } catch { /* the page went away */ } finally {
      this.capturing = false;
    }
  }

  /** Forwards a pointer event as a real mouse event, then refreshes the frame (and once more shortly after, for transitions). */
  pointer(p: Pointer): void {
    if (this.closed) return;
    const at = toPage(this.geometry, p.x, p.y);
    const button = BUTTON[p.button ?? "none"];
    if (p.type === "dblclick") {
      // Plotly's double click resets the zoom: two quick clicks.
      const click = (count: number) => this.cmd("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", buttons: 1, clickCount: count })
        .then(() => this.cmd("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", buttons: 0, clickCount: count }));
      void click(1).then(() => click(2)).then(() => this.capture(), () => undefined);
      return;
    }
    let params: Record<string, unknown>;
    if (p.type === "wheel") params = { type: "mouseWheel", ...at, deltaX: 0, deltaY: (p.wheelDelta ?? 0) * 100 };
    else if (p.type === "press") params = { type: "mousePressed", ...at, button, buttons: 1, clickCount: 1 };
    else if (p.type === "release") params = { type: "mouseReleased", ...at, button, buttons: 0, clickCount: 1 };
    else params = { type: "mouseMoved", ...at, button: p.type === "drag" ? button : "none", buttons: p.type === "drag" ? 1 : 0 };
    void this.cmd("Input.dispatchMouseEvent", params).then(() => this.capture(), () => undefined);
    if (this.trailing) clearTimeout(this.trailing);
    this.trailing = setTimeout(() => void this.capture(), 120);
    this.trailing.unref?.();
  }

  /** Shows a ring where the keyboard pointer is (cells from the corner), or hides it with `null`. */
  cursor(at: { x: number; y: number } | null): void {
    if (this.closed) return;
    const page = at ? toPage(this.geometry, at.x, at.y) : undefined;
    void this.cmd("Runtime.evaluate", { expression: page ? `window.__cur(${page.x}, ${page.y})` : "window.__cur(null)" }).then(() => this.capture(), () => undefined);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.trailing) clearTimeout(this.trailing);
    void this.conn.send("Target.closeTarget", { targetId: this.targetId }).catch(() => undefined);
  }
}
