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
}

export interface Geometry {
  cols: number;
  rows: number;
}

interface Slot {
  id: number;
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

const painters = new WeakMap<object, Painter>();

export class Painter {
  private readonly slots = new Map<number, Slot>();
  private nextSlot = 1;
  private z = 1;
  private readonly write: (data: string) => void;
  /** Pi deleted placements (and maybe data) in what it last wrote. */
  private cleared: "placements" | "images" | undefined;

  /** The painter for a TUI, hooking its renders once; undefined when the TUI cannot report its screen. */
  static for(tui: unknown): Painter | undefined {
    const t = tui as Partial<PaintableTui> | undefined;
    if (!t || typeof t.getScreenLines !== "function" || typeof t.doRender !== "function" || typeof t.terminal?.write !== "function") return undefined;
    let p = painters.get(t);
    if (!p) {
      p = new Painter(t as PaintableTui);
      painters.set(t, p);
    }
    return p;
  }

  constructor(private readonly tui: PaintableTui) {
    const terminal = tui.terminal;
    const original = terminal.write.bind(terminal);
    this.write = original;
    terminal.write = (data: string) => {
      if (data.includes("a=d,d=A")) this.cleared = "images";
      else if (data.includes("a=d,d=a") && this.cleared !== "images") this.cleared = "placements";
      original(data);
    };
    const render = tui.doRender.bind(tui);
    tui.doRender = () => {
      render();
      this.afterRender();
    };
  }

  /** A new chart slot; its rows are `lines()`, its frames go through `present()`. */
  add(geometry: Geometry): number {
    const id = this.nextSlot++;
    this.slots.set(id, { id, geometry, buffers: [imageId(), imageId()], shown: 0, frame: "", uploaded: new Set() });
    return id;
  }

  /** The chart's rows for the renderer: blank, with the marker on the first. */
  lines(slot: number, rows: number): string[] {
    return [marker(slot), ...Array.from({ length: rows - 1 }, () => "")];
  }

  /** Shows a new frame: uploaded to the image not on screen, placed above the current one, which goes after. */
  present(slot: number, png: string): void {
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

  /** After Pi drew a frame: put each chart where its marker is now, or take it away when the marker is gone. */
  private afterRender(): void {
    if (!this.slots.size) { this.cleared = undefined; return; }
    const screen = this.tui.getScreenLines();
    const cleared = this.cleared;
    this.cleared = undefined;
    let out = "";
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
      if (s.placed && s.placed.row === row && s.placed.col === col && s.placed.rows === rows && s.placed.image === image) continue;
      const before = s.placed;
      if (!s.uploaded.has(image)) { out += upload(s.frame, image); s.uploaded.add(image); }
      out += this.place(s, row, col, rows, image);
      if (before && before.image !== image) out += removePlacements(before.image);
    }
    if (out) this.write(out);
  }
}
