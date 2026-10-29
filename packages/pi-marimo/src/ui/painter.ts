// Draws live chart frames without flicker. Pi's renderer clears every image placement whenever an
// image line changes, and herdr deletes a replaced image before it uploads the new one; either way a
// changing chart flashes. So the chart's rows are plain text to Pi (a zero-width marker on the first),
// and the painter places the frames itself: after each render it finds the marker on screen and puts
// the current frame there; a new frame is uploaded to a second image and placed above the old one,
// and the old placement is removed only afterwards, so something is always on screen.
import { getPngDimensions, visibleWidth } from "@earendil-works/pi-tui";

export interface PaintableTui {
  getScreenLines(): string[];
  doRender(): void;
  terminal: { write(data: string): void; rows: number };
  fullRedraws?: number;
  /** Where overlays were drawn in the last frame (pi-tui internals; optional). */
  renderedOverlayLayouts?: Array<{ row: number; col: number; width: number; height: number }>;
  hasOverlay?(): boolean;
}

/** Charts drawn in the transcript sit under overlays; charts drawn inside an overlay (the notebook view) do not. */
export type Layer = "base" | "overlay";

export interface Geometry {
  cols: number;
  rows: number;
}

interface Slot {
  id: number;
  layer: Layer;
  geometry: Geometry;
  buffers: [number, number];
  shown: 0 | 1;
  frame: string;
  /** Image ids whose data the terminal holds. */
  uploaded: Set<number>;
  /** Where the shown image is placed now. */
  placed?: { row: number; col: number; rows: number; image: number };
  pendingDelete?: ReturnType<typeof setTimeout>;
}

const SWAP_DELETE_MS = 150;
const CHUNK = 4096;
let nextImageId = 0x5a000000 + Math.floor(Math.random() * 0x100000);
const imageId = (): number => (nextImageId = (nextImageId + 1) & 0x7fffffff);

/** The zero-width marker that finds a chart on screen: a colour set and reset, unique per chart. */
export const marker = (id: number): string => `\x1b[38;2;7;${(id >> 8) & 255};${id & 255}m\x1b[39m`;

export function upload(png: string, image: number): string {
  if (png.length <= CHUNK) return `\x1b_Ga=t,f=100,q=2,i=${image};${png}\x1b\\`;
  let out = "";
  for (let at = 0; at < png.length; at += CHUNK) {
    const last = at + CHUNK >= png.length;
    out += at === 0 ? `\x1b_Ga=t,f=100,q=2,i=${image},m=1;${png.slice(at, at + CHUNK)}\x1b\\` : `\x1b_Gm=${last ? 0 : 1};${png.slice(at, at + CHUNK)}\x1b\\`;
  }
  return out;
}

const removePlacements = (image: number) => `\x1b_Ga=d,d=i,i=${image},q=2\x1b\\`;
const removeImage = (image: number) => `\x1b_Ga=d,d=I,i=${image},q=2\x1b\\`;

/** The painter installed on a TUI, shared across reloads of the extension (each reload loads a fresh copy of this module). */
const SLOT = Symbol.for("pi-marimo/painter");
interface Retirable { retire?(): void }

export class Painter {
  private readonly slots = new Map<number, Slot>();
  private nextSlot = 1;
  private z = 1;
  private readonly write: (data: string) => void;
  /** Pi deleted placements (and maybe data) in what it last wrote. */
  private cleared: "placements" | "images" | undefined;
  /** Full-screen views open (the notebook view): images of the transcript underneath are taken off the screen. */
  private exclusive = 0;
  private wipe = false;
  retired = false;

  /** The painter for a TUI, hooking its renders once; undefined when the TUI cannot report its screen. */
  static for(tui: unknown): Painter | undefined {
    const t = tui as Partial<PaintableTui> | undefined;
    if (!t || typeof t.getScreenLines !== "function" || typeof t.doRender !== "function" || typeof t.terminal?.write !== "function") return undefined;
    const holder = t as { [SLOT]?: Painter & Retirable };
    const current = holder[SLOT];
    if (current instanceof Painter && !current.retired) return current;
    // A painter from an earlier load of the extension: it stops drawing and takes its images away.
    current?.retire?.();
    const p = new Painter(t as PaintableTui);
    holder[SLOT] = p;
    return p;
  }

  constructor(private readonly tui: PaintableTui) {
    const terminal = tui.terminal;
    const original = terminal.write.bind(terminal);
    this.write = original;
    terminal.write = (data: string) => {
      if (this.retired) return original(data);
      if (data.includes("a=d,d=A")) this.cleared = "images";
      else if (data.includes("a=d,d=a") && this.cleared !== "images") this.cleared = "placements";
      // Pi places transcript images even under an overlay; while a view covers the screen they are wiped after the render.
      if (this.exclusive && /\x1b_G[^;\x1b]*a=[Tp]/u.test(data)) this.wipe = true;
      original(data);
    };
    const render = tui.doRender.bind(tui);
    tui.doRender = () => {
      render();
      if (!this.retired) this.afterRender();
    };
  }

  /** Stops drawing for good (the extension reloads or the session ends): every chart's images go. */
  retire(): void {
    if (this.retired) return;
    for (const id of [...this.slots.keys()]) this.remove(id);
    this.retired = true;
  }

  /** A full-screen view opens or closes. While one is open, no transcript image shows through it. */
  setExclusive(open: boolean): void {
    this.exclusive = Math.max(0, this.exclusive + (open ? 1 : -1));
    if (open) this.wipe = true;
  }

  /** A new chart slot; its rows are `lines()`, its frames go through `present()`. */
  add(geometry: Geometry, layer: Layer = "base"): number {
    const id = this.nextSlot++;
    this.slots.set(id, { id, layer, geometry, buffers: [imageId(), imageId()], shown: 0, frame: "", uploaded: new Set() });
    return id;
  }

  /** The chart's rows for the renderer: blank, with the marker on the first. */
  lines(slot: number, rows: number): string[] {
    return [marker(slot), ...Array.from({ length: rows - 1 }, () => "")];
  }

  /** Shows a new frame: uploaded to the image not on screen, placed above the current one, which goes after. */
  present(slot: number, png: string): void {
    if (this.retired) return;
    const s = this.slots.get(slot);
    if (!s || png === s.frame) return;
    s.frame = png;
    const next = s.shown === 0 ? 1 : 0;
    const image = s.buffers[next];
    const previous = s.buffers[s.shown];
    let out = upload(png, image);
    s.uploaded.add(image);
    s.shown = next;
    if (s.placed) {
      out += this.place(s, s.placed.row, s.placed.col, s.placed.rows, image);
      if (s.pendingDelete) clearTimeout(s.pendingDelete);
      s.pendingDelete = setTimeout(() => {
        s.pendingDelete = undefined;
        if (s.buffers[s.shown] !== previous) this.write(removePlacements(previous));
      }, SWAP_DELETE_MS);
      s.pendingDelete.unref?.();
    }
    this.write(out);
  }

  /** Removes a chart: its placements and image data. */
  remove(slot: number): void {
    const s = this.slots.get(slot);
    if (!s) return;
    if (s.pendingDelete) clearTimeout(s.pendingDelete);
    this.slots.delete(slot);
    this.write(s.buffers.map(removeImage).join(""));
  }

  private place(s: Slot, row: number, col: number, rows: number, image: number): string {
    s.placed = { row, col, rows, image };
    let crop = "";
    if (rows < s.geometry.rows) {
      const dims = getPngDimensions(s.frame);
      if (dims) crop = `,x=0,y=0,w=${dims.widthPx},h=${Math.max(1, Math.floor((dims.heightPx * rows) / s.geometry.rows))}`;
    }
    this.z = this.z >= 1_000_000 ? 1 : this.z + 1;
    return `\x1b7\x1b[${row + 1};${col + 1}H\x1b_Ga=p,i=${image},p=1,c=${s.geometry.cols},r=${rows}${crop},C=1,z=${this.z},q=2\x1b\\\x1b8`;
  }

  private covered(row: number, col: number, rows: number, cols: number): boolean {
    const layouts = this.tui.renderedOverlayLayouts;
    if (!Array.isArray(layouts)) return this.tui.hasOverlay?.() ?? false;
    return layouts.some((o) => o.row < row + rows && row < o.row + o.height && o.col < col + cols && col < o.col + o.width);
  }

  /** After Pi drew a frame: put each chart where its marker is now, or take it away when the marker is gone. */
  private afterRender(): void {
    let out = "";
    if (this.exclusive && this.wipe) {
      this.wipe = false;
      out += "\x1b_Ga=d,d=a,q=2\x1b\\";
      this.cleared = this.cleared === "images" ? "images" : "placements";
    }
    if (!this.slots.size) { this.cleared = undefined; if (out) this.write(out); return; }
    const screen = this.tui.getScreenLines();
    const cleared = this.cleared;
    this.cleared = undefined;
    for (const s of this.slots.values()) {
      if (cleared === "images") s.uploaded.clear();
      if (cleared) s.placed = undefined;
      const m = marker(s.id);
      const row = screen.findIndex((line) => line.includes(m));
      const image = s.buffers[s.shown];
      if (row < 0 || !s.frame) {
        if (s.placed) { out += removePlacements(s.placed.image); s.placed = undefined; }
        continue;
      }
      const line = screen[row]!;
      const col = visibleWidth(line.slice(0, line.indexOf(m)));
      const rows = Math.min(s.geometry.rows, screen.length - row);
      // Pi keeps image lines of the transcript on top of overlays; a transcript chart under an overlay is hidden instead.
      if (s.layer === "base" && this.covered(row, col, rows, s.geometry.cols)) {
        if (s.placed) { out += removePlacements(s.placed.image); s.placed = undefined; }
        continue;
      }
      if (s.placed && s.placed.row === row && s.placed.col === col && s.placed.rows === rows && s.placed.image === image) continue;
      const before = s.placed;
      if (!s.uploaded.has(image)) { out += upload(s.frame, image); s.uploaded.add(image); }
      out += this.place(s, row, col, rows, image);
      if (before && before.image !== image) out += removePlacements(before.image);
    }
    if (out) this.write(out);
  }
}
