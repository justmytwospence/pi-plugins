// A finished plan drawn in its lane as a picture of the rendered page. terminal-browser renders the
// page in its embedded mode (it joins a Unix socket we listen on, PIXEL_EMBED) and hands us its
// frames in shared memory (the "host" transport). We keep one frame per stretch of the page, send
// it to the terminal once as a Kitty graphics image, and close the browser. The lane then prints
// Kitty Unicode placeholders where the page should show: text like any other, so Pi's renderer,
// padding and overlays keep working. Scrolling only changes which image rows the placeholders
// name, so it costs what scrolling text does, with no frames at all; a live page scrolled by the
// browser was too slow in herdr and Ghostty, whose every frame is a whole new picture.
// Protocol as in terminal-browser's examples/embedded host and pixel-core's hosted.rs.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { allocateImageId, getCapabilities, getCellDimensions } from "@earendil-works/pi-tui";
import { READY_TITLE } from "./plan-html.js";

const PLACEHOLDER = "\u{10EEEE}";
// Kitty's row/column diacritics (rowcolumn-diacritics.txt), in order: index n is row or column n.
const DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351,
  0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d,
  0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599,
  0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
  0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6,
  0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2, 0x06e4, 0x06e7, 0x06e8, 0x06eb,
  0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747,
  0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817, 0x0818, 0x0819,
  0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822, 0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a,
  0x082b, 0x082c, 0x082d, 0x0951, 0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd,
  0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c, 0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f,
  0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1, 0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4,
  0x1dc5, 0x1dc6, 0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5, 0x1dd6, 0x1dd7,
  0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf, 0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5,
  0x1de6, 0x1dfe, 0x20d0, 0x20d1, 0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0,
  0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6, 0x2de7, 0x2de8, 0x2de9, 0x2dea,
  0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0, 0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8,
  0x2df9, 0x2dfa, 0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1, 0xa8e0, 0xa8e1,
  0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9, 0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef,
  0xa8f0, 0xa8f1, 0xaab0, 0xaab2, 0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23,
  0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189, 0x1d1aa, 0x1d1ab, 0x1d1ac,
  0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
].map((code) => String.fromCodePoint(code));

/** The most rows or columns placeholders can address. */
export const MAX_EMBED_CELLS = DIACRITICS.length;

/** The browser window per captured image, in rows: the page's rows in it are a few fewer. */
export const CHUNK_ROWS = 32;
/** The most images a page is captured in; a longer page is cut off. */
const MAX_CHUNKS = 64;
/** Captures of one page that run at once. */
const PARALLEL_CAPTURES = 3;
/**
 * Pixel bytes all pages may keep in the terminal together. herdr gives each pane 64 MiB of images
 * (ghostty-vt's KITTY_IMAGE_STORAGE_LIMIT_BYTES) and drops images beyond that, so the pages keep
 * well under it: the chunks the lanes show, the next ones when there is room, and nothing else.
 */
export const IMAGE_BUDGET_BYTES = 44 * 1024 * 1024;
/** How long a capture may take, from starting the browser to the page saying it is ready. */
const CAPTURE_TIMEOUT_MS = 20000;
/** After the page is ready, the frame captured is the first one at least this much later. */
const SETTLE_MS = 80;
/** The browser (which owns the frame's shared memory) stays this long after its frame is sent. */
const RELEASE_MS = 3000;
/** A narrower or wider lane is captured again once its width has held this long. */
const RESIZE_SETTLE_MS = 300;

/** CSS pixels per terminal row the page is drawn at: Pi's text and the page's then match in size. */
const ROW_CSS_PX = 18.5;

/**
 * The browser's pixel ratio. terminal-browser otherwise takes the scale of the display the mouse
 * pointer is on, so a page captured with the pointer on another screen came out at half the size.
 * This follows the terminal's cells instead (37px rows: 2, a Retina screen); PI_PLAN_MODE_SCALE
 * overrides it.
 */
export function displayScale(env: NodeJS.ProcessEnv = process.env, cellHeight = getCellDimensions().heightPx): number {
  const forced = Number(env.PI_PLAN_MODE_SCALE);
  if (Number.isFinite(forced) && forced > 0) return forced;
  const scale = cellHeight / ROW_CSS_PX;
  return Number.isFinite(scale) ? Math.max(1, Math.min(4, Math.round(scale * 4) / 4)) : 1;
}

/**
 * How a captured frame reaches the terminal: by its shared memory name when the terminal (or herdr)
 * runs on this machine, else as inline pixels, read from /dev/shm (Linux only). PI_PLAN_MODE_FRAMES
 * (shared or inline) overrides it.
 */
export function frameMedium(env: NodeJS.ProcessEnv = process.env): "shared" | "inline" {
  const forced = env.PI_PLAN_MODE_FRAMES?.trim();
  if (forced === "shared" || forced === "inline") return forced;
  if (env.HERDR_ENV === "1") return "shared";
  return env.SSH_CONNECTION ? "inline" : "shared";
}

export interface EmbedSize {
  cols: number;
  rows: number;
}

/** One line of placeholders for row `row` of image `imageId`, `cols` cells from column `firstCol`. */
export function placeholderLine(imageId: number, cols: number, row: number, firstCol = 0): string {
  const width = Math.max(0, Math.min(cols, MAX_EMBED_CELLS - firstCol));
  const color = `\x1b[38;2;${(imageId >> 16) & 255};${(imageId >> 8) & 255};${imageId & 255}m`;
  const rowMark = DIACRITICS[Math.max(0, Math.min(row, MAX_EMBED_CELLS - 1))] ?? "";
  let line = color;
  for (let col = 0; col < width; col += 1) line += PLACEHOLDER + rowMark + DIACRITICS[firstCol + col];
  return `${line}\x1b[39m`;
}

/** One line of placeholders per image row, each cell naming its row and column. */
export function placeholderLines(imageId: number, cols: number, rows: number, firstRow = 0): string[] {
  const lines: string[] = [];
  const last = Math.min(firstRow + rows, MAX_EMBED_CELLS);
  for (let row = Math.max(0, firstRow); row < last; row += 1) lines.push(placeholderLine(imageId, cols, row));
  return lines;
}

/**
 * The terminal-browser executable on PATH, or undefined. PI_PLAN_MODE_TERMINAL_BROWSER names one
 * instead; set empty, rendered plans are off (the tests run that way).
 */
export function findTerminalBrowser(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.PI_PLAN_MODE_TERMINAL_BROWSER;
  if (override !== undefined) return override || undefined;
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "terminal-browser");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}

/** Why rendered plans cannot work here, or undefined when they can. */
export function renderedPlansUnavailable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!findTerminalBrowser(env)) return "terminal-browser is not installed";
  if (getCapabilities().images !== "kitty") return "this terminal does not show Kitty graphics";
  if (frameMedium(env) === "inline" && process.platform !== "linux") return "over SSH, only from Linux";
  return undefined;
}

/** The terminal device Pi draws on (/dev/ttys001, /dev/pts/0), found without touching stdin. */
export function terminalDevice(pid = process.pid): string | undefined {
  try {
    const name = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    if (!name || name === "?" || name === "??") return undefined;
    return name.startsWith("/") ? name : `/dev/${name}`;
  } catch {
    return undefined;
  }
}

/** A 24-bit image id (it travels as a truecolor foreground), distinct from Pi's own images. */
function embedImageId(): number {
  const id = allocateImageId() & 0xffffff;
  return id < 256 ? id + 0x100000 : id;
}

/** A frame terminal-browser handed us: its pixels (RGBA) sit in shared memory under `shm`. */
export interface HostFrame {
  shm: string;
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** The cell size in pixels, as terminal-browser measured it. */
  cell?: [number, number];
}

function hostFrame(message: Record<string, unknown>): HostFrame | undefined {
  const { shm, width, height, cols, rows } = message;
  if (typeof shm !== "string" || !/^[\w/.-]+$/u.test(shm)) return undefined;
  if (typeof width !== "number" || typeof height !== "number") return undefined;
  if (typeof cols !== "number" || typeof rows !== "number") return undefined;
  const cell = message.cell;
  const measured =
    Array.isArray(cell) && typeof cell[0] === "number" && typeof cell[1] === "number" && cell[0] > 0 && cell[1] > 0
      ? ([cell[0], cell[1]] as [number, number])
      : undefined;
  return { shm, width, height, cols, rows, ...(measured ? { cell: measured } : {}) };
}

/** What the page said about itself when ready (CSS pixels): see plan-html.ts's ready script. */
export interface PageReport {
  height: number;
  windowWidth: number;
  windowHeight: number;
  ratio: number;
}

/**
 * Where the page sits in the browser's frame, in whole cells: the frame also holds terminal-browser's
 * toolbar above the page and a thin margin around it (there is no setting to drop them), so the lane
 * shows only the cells wholly inside the page. The toolbar and margins are in proportion to each
 * other (pixel-core's layout.ts: toolbar 2.1, bottom 0.2, left 0.2, right 0.45 of the base font), so
 * the frame's size less the page's says how big each is.
 */
export interface PageGeometry {
  /** The first image row and column wholly inside the page, and how many follow. */
  firstRow: number;
  rows: number;
  firstCol: number;
  cols: number;
  /** CSS pixels per row, and the CSS pixels of the page above the first row shown. */
  rowCss: number;
  hiddenTop: number;
}

/** Pixels allowed for rounding in the browser's layout, on each side. */
const EDGE_SLACK_PX = 3;

export function pageGeometry(frame: HostFrame, report: PageReport): PageGeometry {
  const [cellW, cellH] = frame.cell ?? [frame.width / Math.max(1, frame.cols), frame.height / Math.max(1, frame.rows)];
  const ratio = report.ratio > 0 ? report.ratio : 1;
  const pageW = Math.min(frame.width, report.windowWidth * ratio);
  const pageH = Math.min(frame.height, report.windowHeight * ratio);
  const top = (Math.max(0, frame.height - pageH) * 2.1) / 2.3;
  const left = (Math.max(0, frame.width - pageW) * 0.2) / 0.65;
  const firstRow = Math.ceil((top + EDGE_SLACK_PX) / cellH);
  const firstCol = Math.ceil((left + EDGE_SLACK_PX) / cellW);
  const rows = Math.max(1, Math.floor((top + pageH - EDGE_SLACK_PX) / cellH) - firstRow);
  const cols = Math.max(1, Math.floor((left + pageW - EDGE_SLACK_PX) / cellW) - firstCol);
  return { firstRow, rows, firstCol, cols, rowCss: cellH / ratio, hiddenTop: (firstRow * cellH - top) / ratio };
}

/** Deletes an image and frees its pixels in the terminal. */
export function deleteImage(imageId: number): string {
  return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/**
 * The frame as a Kitty image with a virtual placement (U=1) for placeholders: by its shared memory
 * name, or inline as compressed pixels read from /dev/shm.
 */
export function kittyImage(
  frame: HostFrame,
  imageId: number,
  medium: "shared" | "inline",
  readShm: (name: string) => Buffer = (name) => fs.readFileSync(path.join("/dev/shm", name)),
): string {
  const params = `f=32,s=${frame.width},v=${frame.height},i=${imageId},U=1,c=${frame.cols},r=${frame.rows},q=2`;
  if (medium === "shared") {
    return `\x1b_Ga=T,t=s,${params};${Buffer.from(frame.shm).toString("base64")}\x1b\\`;
  }
  const pixels = readShm(frame.shm).subarray(0, frame.width * frame.height * 4);
  const payload = zlib.deflateSync(pixels, { level: 1 }).toString("base64");
  let out = "";
  for (let at = 0; at === 0 || at < payload.length; at += 4096) {
    const more = at + 4096 < payload.length ? 1 : 0;
    const chunk = payload.slice(at, at + 4096);
    out += at === 0 ? `\x1b_Ga=T,o=z,${params},m=${more};${chunk}\x1b\\` : `\x1b_Gm=${more};${chunk}\x1b\\`;
  }
  return out;
}

let socketCounter = 0;

export interface CaptureOptions {
  /** The HTML file to capture. */
  file: string;
  /** The browser window, in cells. */
  cols: number;
  rows: number;
  /** The page's colours (RGBA), for the browser's own background while it loads. */
  colors?: { foreground: number[]; background: number[] };
  /** For tests: the executable, the terminal device, the timeout and the environment. */
  command?: string;
  tty?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface Capture {
  frame: HostFrame;
  page: PageReport;
  /** Close the browser (and free the frame's shared memory): only once the terminal has the frame. */
  release(): void;
}

const NUMBER = "(\\d+(?:\\.\\d+)?)";
const READY = new RegExp(`^${READY_TITLE} ${NUMBER} ${NUMBER} ${NUMBER} ${NUMBER}$`);

/**
 * Open the page in terminal-browser's embedded mode and wait for it to say it is ready (its title,
 * set by the page's script once diagrams and fonts are done; see plan-html.ts), then for a frame
 * drawn after that.
 */
export function capturePage(options: CaptureOptions): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const command = options.command ?? findTerminalBrowser(options.env);
    const tty = options.tty ?? terminalDevice();
    if (!command) return reject(new Error("terminal-browser is not installed"));
    if (!tty) return reject(new Error("no terminal device to draw on"));
    const dir = process.platform === "win32" ? os.tmpdir() : "/tmp";
    socketCounter += 1;
    const socketPath = path.join(dir, `pi-plan-embed-${process.pid}-${socketCounter}.sock`);
    fs.rmSync(socketPath, { force: true });
    let child: ChildProcess | undefined;
    let conn: net.Socket | undefined;
    let settled = false;
    let ready: { at: number; page: PageReport } | undefined;
    let latest: HostFrame | undefined;
    let stderr = "";
    let lateTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(
      () => fail("terminal-browser did not show the page in time"),
      options.timeoutMs ?? CAPTURE_TIMEOUT_MS,
    );
    timer.unref?.();
    const stopTimers = () => {
      clearTimeout(timer);
      if (lateTimer) clearTimeout(lateTimer);
    };
    const release = () => {
      stopTimers();
      const running = child;
      child = undefined;
      if (running && running.exitCode === null) {
        try {
          running.kill("SIGTERM");
        } catch {
          // already gone
        }
      }
      conn?.destroy();
      server.close();
      fs.rmSync(socketPath, { force: true });
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      release();
      reject(new Error(message));
    };
    const done = (frame: HostFrame) => {
      if (settled || !ready) return;
      settled = true;
      stopTimers();
      resolve({ frame, page: ready.page, release });
    };
    const handle = (line: string) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === "join") {
        conn?.write(
          `${JSON.stringify({
            type: "init",
            cols: options.cols,
            rows: options.rows,
            imageId: embedImageId(),
            transport: "host",
            focused: false,
            ...(options.colors ? { colors: options.colors } : {}),
          })}\n`,
        );
      } else if (message.type === "title" && typeof message.text === "string") {
        const match = READY.exec(message.text);
        if (!match || ready) return;
        ready = {
          at: Date.now(),
          page: {
            height: Number(match[1]),
            windowWidth: Number(match[2]),
            windowHeight: Number(match[3]),
            ratio: Number(match[4]),
          },
        };
        // Frames normally keep coming; if none does, the last one is the page as it stands.
        lateTimer = setTimeout(() => {
          if (latest) done(latest);
        }, SETTLE_MS * 4);
        lateTimer.unref?.();
      } else if (message.type === "frame") {
        const frame = hostFrame(message);
        if (!frame) return;
        latest = frame;
        if (ready && Date.now() - ready.at >= SETTLE_MS) done(frame);
      }
    };
    const server = net.createServer((socket) => {
      if (conn || settled) {
        socket.destroy();
        return;
      }
      conn = socket;
      let buffer = "";
      socket.on("data", (data: Buffer) => {
        buffer += data.toString("utf8");
        let at = buffer.indexOf("\n");
        while (at !== -1) {
          handle(buffer.slice(0, at));
          buffer = buffer.slice(at + 1);
          at = buffer.indexOf("\n");
        }
      });
      socket.on("error", () => undefined);
      socket.on("close", () => fail("terminal-browser closed the page"));
    });
    server.on("error", (error) => fail(error.message));
    server.listen(socketPath);
    const env: NodeJS.ProcessEnv = {
      ...(options.env ?? process.env),
      PIXEL_EMBED: socketPath,
      PIXEL_TTY: tty,
      PIXEL_DISPLAY_SCALE: String(displayScale(options.env ?? process.env)),
      // Never become a tab of a terminal-browser already open beside this pane.
      TERMINAL_BROWSER_NO_MERGE: "1",
    };
    delete env.PIXEL_PANE;
    child = spawn(command, ["open", options.file], { env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-1000);
    });
    child.on("error", (error) => fail(error.message));
    child.on("exit", (code) => {
      if (!settled) fail(stderr.trim().split("\n").pop() || `terminal-browser exited (${code})`);
    });
  });
}

/** What a lane needs from the rendered plans; LanesPage takes this so tests can stub it. */
export interface PlanRenders {
  /** Whether lanes should try to render plans (the setting is on and it can work here). */
  enabled(): boolean;
  /** The lane body for this plan: placeholder lines once its page is captured, else undefined. */
  body(id: string, revision: number, plan: string, size: EmbedSize): string[] | undefined;
  /** Where the lane is in its page: first and last row shown (1-based) and the page's rows. */
  position?(id: string): { first: number; last: number; total: number } | undefined;
  /** Why this lane's page could not be shown, if it could not. */
  failure(id: string): string | undefined;
  /** Scroll a lane's page by rows (Infinity: to the end); false when the lane shows no page. */
  scroll(id: string, rows: number): boolean;
  /** Call before a frame; `endFrame` after it. */
  beginFrame(): void;
  endFrame(): void;
  /** The planning screen is not showing. */
  hideAll(): void;
  dispose(): void;
}

/** One image of a page: CHUNK_ROWS browser rows, `geometry.rows` of them the page's. */
interface Chunk {
  image?: number;
  loading?: boolean;
  failed?: boolean;
  /** Pixel bytes the terminal holds for it, and when a frame last showed it. */
  bytes: number;
  used: number;
}

/** A captured page. Its first chunk is captured up front (it says how tall the page is); the rest
 * as the lane scrolls to them, and freed again when the image budget needs the room. */
interface Snapshot {
  sig: string;
  html: string;
  /** The capture files' prefix, and the browser's width in cells. */
  base: string;
  browserCols: number;
  rows: number;
  geometry: PageGeometry;
  chunks: Chunk[];
  /** The chunks the last frame showed: never freed for the budget. */
  wanted: Set<number>;
  dead: boolean;
}

interface Pending {
  sig: string;
  cancelled: boolean;
}

interface Entry {
  shown?: Snapshot;
  next?: Pending;
  /** A capture waiting for the lane's width to settle. */
  resizeTimer?: NodeJS.Timeout;
  resizeSig?: string;
  failure?: string;
  /** The last page that failed: not tried again until the plan, colours or width change. */
  failed?: string;
  /** The first page row the lane shows, and how many rows it showed last. */
  offset: number;
  visible: number;
}

/** One captured page per lane that shows a plan, kept across screens of the same planning run. */
export class RenderedPlans implements PlanRenders {
  private readonly entries = new Map<string, Entry>();
  private readonly drawn = new Set<string>();
  private readonly dir: string;
  private disposed = false;
  private files = 0;
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly options: {
      enabled(): boolean;
      html(plan: string, id: string): Promise<string>;
      onChange(): void;
      /** Writes to Pi's terminal: the captured images go out through it. */
      write(data: string): void;
      /** Changes when the page would come out differently (the theme or terminal colours changed). */
      styleKey?(): string;
      /** The page's colours for the browser while it loads. */
      colors?(): { foreground: number[]; background: number[] } | undefined;
      env?: NodeJS.ProcessEnv;
      /** Pixel bytes all pages together may keep in the terminal (IMAGE_BUDGET_BYTES). */
      budgetBytes?: number;
      /** For tests: capture a page instead of running terminal-browser. */
      capture?(options: CaptureOptions): Promise<Capture>;
      /** For tests: read a frame's shared memory (inline frames). */
      readShm?(name: string): Buffer;
    },
  ) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-render-"));
  }

  enabled(): boolean {
    return !this.disposed && this.options.enabled();
  }

  body(id: string, revision: number, plan: string, size: EmbedSize): string[] | undefined {
    if (!this.enabled()) return undefined;
    const cols = Math.max(1, Math.min(MAX_EMBED_CELLS - 3, Math.floor(size.cols)));
    const sig = JSON.stringify([revision, plan, this.options.styleKey?.() ?? "", cols]);
    let entry = this.entries.get(id);
    if (!entry) {
      entry = { offset: 0, visible: size.rows };
      this.entries.set(id, entry);
    }
    entry.visible = Math.max(1, size.rows);
    this.drawn.add(id);
    const wanted = entry.next?.sig ?? entry.resizeSig ?? entry.shown?.sig;
    if (sig !== wanted && sig !== entry.failed) this.want(id, entry, sig, plan, cols);
    const shown = entry.shown;
    if (!shown) return undefined;
    entry.offset = clampOffset(entry.offset, shown.rows, entry.visible);
    const { geometry } = shown;
    const width = Math.min(geometry.cols, cols);
    const last = Math.min(shown.rows, entry.offset + entry.visible);
    const now = Date.now();
    shown.wanted.clear();
    const lines: string[] = [];
    for (let row = entry.offset; row < last; row += 1) {
      const index = Math.floor(row / geometry.rows);
      const chunk = shown.chunks[index];
      shown.wanted.add(index);
      if (chunk) chunk.used = now;
      lines.push(
        chunk?.image === undefined
          ? ""
          : placeholderLine(chunk.image, width, geometry.firstRow + (row % geometry.rows), geometry.firstCol),
      );
    }
    for (const index of shown.wanted) this.load(shown, index, true);
    // The next chunk down too, when there is room for it: plain scrolling then never waits.
    const ahead = Math.floor((last - 1) / geometry.rows) + 1;
    if (ahead < shown.chunks.length) this.load(shown, ahead, false);
    return lines;
  }

  position(id: string): { first: number; last: number; total: number } | undefined {
    const entry = this.entries.get(id);
    if (!entry?.shown) return undefined;
    const last = Math.min(entry.shown.rows, entry.offset + entry.visible);
    return { first: entry.offset + 1, last, total: entry.shown.rows };
  }

  failure(id: string): string | undefined {
    return this.entries.get(id)?.failure;
  }

  scroll(id: string, rows: number): boolean {
    const entry = this.entries.get(id);
    if (!entry?.shown || !this.drawn.has(id)) return false;
    const target = rows === Number.POSITIVE_INFINITY ? entry.shown.rows : entry.offset + rows;
    entry.offset = clampOffset(target, entry.shown.rows, entry.visible);
    this.options.onChange();
    return true;
  }

  beginFrame(): void {
    this.drawn.clear();
  }

  endFrame(): void {
    // Images show only where a lane prints their placeholders, so there is nothing to hide.
  }

  hideAll(): void {
    this.drawn.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.next) entry.next.cancelled = true;
      if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
      if (entry.shown) this.drop(entry.shown);
    }
    this.entries.clear();
    this.queue.length = 0;
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** A new page is wanted: now, or once the width holds still when only the width changed. */
  private want(id: string, entry: Entry, sig: string, plan: string, cols: number) {
    if (entry.resizeTimer) clearTimeout(entry.resizeTimer);
    entry.resizeTimer = undefined;
    entry.resizeSig = undefined;
    if (!entry.shown || !sameButWidth(entry.shown.sig, sig)) {
      this.prepare(id, entry, sig, plan, cols);
      return;
    }
    entry.resizeSig = sig;
    entry.resizeTimer = setTimeout(() => {
      entry.resizeTimer = undefined;
      entry.resizeSig = undefined;
      if (this.entries.get(id) === entry && !this.disposed) this.prepare(id, entry, sig, plan, cols);
    }, RESIZE_SETTLE_MS);
    entry.resizeTimer.unref?.();
  }

  private prepare(id: string, entry: Entry, sig: string, plan: string, cols: number) {
    if (entry.next) entry.next.cancelled = true;
    const pending: Pending = { sig, cancelled: false };
    entry.next = pending;
    const live = () => !this.disposed && !pending.cancelled && this.entries.get(id) === entry;
    void this.measure(id, sig, plan, cols, live, entry).then(
      (snapshot) => {
        if (entry.next === pending) entry.next = undefined;
        if (!live()) {
          this.drop(snapshot);
          return;
        }
        const old = entry.shown;
        entry.shown = snapshot;
        entry.failure = undefined;
        entry.failed = undefined;
        if (old) this.drop(old);
        this.options.onChange();
      },
      (error: unknown) => {
        if (entry.next === pending) entry.next = undefined;
        if (!live()) return;
        entry.failed = sig;
        // A failed newer page leaves the shown one up.
        if (!entry.shown) entry.failure = error instanceof Error ? error.message : String(error);
        this.options.onChange();
      },
    );
  }

  /** The page's first chunk, which says how tall the page is and where it sits in the frame. */
  private async measure(
    id: string,
    sig: string,
    plan: string,
    cols: number,
    live: () => boolean,
    entry: Entry,
  ): Promise<Snapshot> {
    const html = await this.options.html(plan, id);
    if (!live()) throw new Error("cancelled");
    this.files += 1;
    // The browser is a little wider than the lane: its margins are cut off (pageGeometry), and what
    // is left over on the right is the page's own padding.
    const browserCols = Math.min(MAX_EMBED_CELLS, cols + 3);
    const base = path.join(this.dir, `${id}-${this.files}`);
    const first = await this.slot(() => this.capture(base, 0, html, browserCols, 0));
    try {
      if (!live()) throw new Error("cancelled");
      const geometry = pageGeometry(first.frame, first.page);
      const visible = Math.max(0, first.page.height - geometry.hiddenTop);
      const rows = Math.max(1, Math.min(geometry.rows * MAX_CHUNKS, Math.ceil(visible / geometry.rowCss)));
      const count = Math.ceil(rows / geometry.rows);
      const snapshot: Snapshot = {
        sig,
        html,
        base,
        browserCols,
        rows,
        geometry: { ...geometry, cols: Math.min(geometry.cols, cols) },
        chunks: Array.from({ length: count }, () => ({ bytes: 0, used: 0 })),
        wanted: new Set([0]),
        dead: false,
      };
      // The page the lane is about to show starts where the old one was.
      const start = Math.floor(clampOffset(entry.offset, rows, entry.visible) / geometry.rows);
      this.store(snapshot, 0, first);
      for (let index = start; index * geometry.rows < entry.offset + entry.visible && index < count; index += 1) {
        snapshot.wanted.add(index);
      }
      return snapshot;
    } finally {
      const timer = setTimeout(first.release, RELEASE_MS);
      timer.unref?.();
    }
  }

  /** Capture chunk `index` of a shown page, if it is not there yet. */
  private load(snapshot: Snapshot, index: number, needed: boolean) {
    const chunk = snapshot.chunks[index];
    if (!chunk || chunk.image !== undefined || chunk.loading || chunk.failed || snapshot.dead) return;
    const bytes = this.chunkBytes(snapshot);
    if (!needed && !this.makeRoom(bytes, false)) return;
    chunk.loading = true;
    const shift = Number((index * snapshot.geometry.rows * snapshot.geometry.rowCss).toFixed(3));
    void this.slot(() => this.capture(snapshot.base, index, snapshot.html, snapshot.browserCols, shift)).then(
      (capture) => {
        chunk.loading = false;
        if (snapshot.dead) {
          capture.release();
          return;
        }
        this.store(snapshot, index, capture);
        const timer = setTimeout(capture.release, RELEASE_MS);
        timer.unref?.();
        this.options.onChange();
      },
      () => {
        chunk.loading = false;
        chunk.failed = true;
      },
    );
  }

  /** Send a captured chunk to the terminal, freeing older chunks first if the budget needs it. */
  private store(snapshot: Snapshot, index: number, capture: Capture) {
    const chunk = snapshot.chunks[index];
    if (!chunk) return;
    const bytes = capture.frame.width * capture.frame.height * 4;
    this.makeRoom(bytes, true);
    const image = embedImageId();
    try {
      this.options.write(kittyImage(capture.frame, image, frameMedium(this.options.env), this.options.readShm));
    } catch {
      chunk.failed = true;
      return;
    }
    chunk.image = image;
    chunk.bytes = bytes;
    chunk.used = Date.now();
  }

  private chunkBytes(snapshot: Snapshot): number {
    const loaded = snapshot.chunks.find((chunk) => chunk.bytes > 0);
    return loaded?.bytes ?? 0;
  }

  /**
   * Free the least recently shown chunks no lane is showing until `bytes` more fit the budget.
   * With `force`, frees what it can and lets the image in anyway (a chunk a lane is showing).
   */
  private makeRoom(bytes: number, force: boolean): boolean {
    const budget = this.options.budgetBytes ?? IMAGE_BUDGET_BYTES;
    const loaded: { snapshot: Snapshot; index: number; chunk: Chunk }[] = [];
    let total = 0;
    for (const entry of this.entries.values()) {
      const snapshot = entry.shown;
      if (!snapshot) continue;
      snapshot.chunks.forEach((chunk, index) => {
        if (chunk.image === undefined) return;
        total += chunk.bytes;
        if (!snapshot.wanted.has(index)) loaded.push({ snapshot, index, chunk });
      });
    }
    loaded.sort((a, b) => a.chunk.used - b.chunk.used);
    const freed: number[] = [];
    while (total + bytes > budget && loaded.length > 0) {
      const victim = loaded.shift();
      if (!victim || victim.chunk.image === undefined) continue;
      freed.push(victim.chunk.image);
      total -= victim.chunk.bytes;
      victim.chunk.image = undefined;
      victim.chunk.bytes = 0;
    }
    this.deleteImages(freed);
    return force || total + bytes <= budget;
  }

  /** A page no lane shows any more: free its images. */
  private drop(snapshot: Snapshot) {
    snapshot.dead = true;
    const images = snapshot.chunks.flatMap((chunk) => (chunk.image === undefined ? [] : [chunk.image]));
    for (const chunk of snapshot.chunks) chunk.image = undefined;
    this.deleteImages(images);
  }

  private deleteImages(images: number[]) {
    if (images.length === 0) return;
    try {
      this.options.write(images.map(deleteImage).join(""));
    } catch {
      // the terminal is gone
    }
  }

  /** One browser capture of the page, moved up `shift` CSS pixels. */
  private async capture(base: string, index: number, html: string, cols: number, shift: number): Promise<Capture> {
    const file = `${base}-${index}.html`;
    fs.writeFileSync(file, html.replace("window.PI_SHIFT = 0;", `window.PI_SHIFT = ${shift};`));
    const colors = this.options.colors?.();
    const options: CaptureOptions = {
      file,
      cols,
      rows: CHUNK_ROWS,
      ...(colors ? { colors } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    };
    return (this.options.capture ?? capturePage)(options);
  }

  /** Run a capture when one of PARALLEL_CAPTURES slots is free. */
  private slot<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running += 1;
        run()
          .then(resolve, reject)
          .finally(() => {
            this.running -= 1;
            this.queue.shift()?.();
          });
      };
      if (this.running < PARALLEL_CAPTURES) start();
      else this.queue.push(start);
    });
  }
}

function clampOffset(offset: number, rows: number, visible: number): number {
  return Math.max(0, Math.min(Math.floor(offset), Math.max(0, rows - visible)));
}

/** Two page signatures that differ only in width. */
function sameButWidth(a: string, b: string): boolean {
  const x = JSON.parse(a) as unknown[];
  const y = JSON.parse(b) as unknown[];
  return x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
}
