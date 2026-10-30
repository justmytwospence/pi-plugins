import { CURSOR_MARKER, renderFakeCursor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import headless from "@xterm/headless";
import type { IBufferCell, IDisposable, IUnicodeVersionProvider } from "@xterm/headless";

const RESET = "\x1b[0m";
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/g;

/** Keep xterm's cell allocation consistent with Pi, including streamed graphemes. */
class PiUnicode implements IUnicodeVersionProvider {
  readonly version = "pi";
  private readonly segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  private cluster = "";
  private previous = 0;
  private serial = 0;

  wcwidth(codepoint: number): 0 | 1 | 2 {
    return Math.min(2, visibleWidth(String.fromCodePoint(codepoint))) as 0 | 1 | 2;
  }

  charProperties(codepoint: number, preceding: number): number {
    const char = String.fromCodePoint(codepoint);
    let width = this.wcwidth(codepoint);
    let join = false;
    let cluster = char;
    const oldWidth = (preceding >> 1) & 3;
    if (preceding && oldWidth && preceding === this.previous) {
      // Retain only one bounded, transient cluster, never a second screen/history.
      const candidate = this.cluster + char;
      if (candidate.length <= 128 && this.segmenter.segment(candidate)[Symbol.iterator]().next().value?.segment === candidate) {
        const combinedWidth = visibleWidth(candidate);
        if (combinedWidth >= oldWidth && combinedWidth <= 2) {
          width = combinedWidth as 0 | 1 | 2;
          join = true;
          cluster = candidate;
        }
      } else if (width === 0) {
        width = oldWidth as 1 | 2;
        join = true;
        cluster = this.cluster;
      }
    }
    this.cluster = cluster;
    // xterm 6 Unicode properties: provider state in bits 3+, width in 1-2,
    // and bit 0 joins this codepoint to the previous cell. A fresh state token
    // prevents joining across parser resets/cursor movement or unrelated calls.
    this.serial = (this.serial % 0xffffff) + 1;
    this.previous = (this.serial << 3) | (width << 1) | Number(join);
    return this.previous;
  }

  dispose(): void {
    this.cluster = "";
    this.previous = 0;
  }
}

function colorSgr(cell: IBufferCell, foreground: boolean): string | undefined {
  const value = foreground ? cell.getFgColor() : cell.getBgColor();
  const prefix = foreground ? 38 : 48;
  if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
    return `${prefix};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
  }
  if (foreground ? cell.isFgPalette() : cell.isBgPalette()) {
    if (value < 8) return String((foreground ? 30 : 40) + value);
    if (value < 16) return String((foreground ? 90 : 100) + value - 8);
    return `${prefix};5;${value}`;
  }
  return undefined;
}

function cellSgr(cell: IBufferCell): string {
  const attributes: (string | number | undefined)[] = [
    cell.isBold() ? 1 : undefined,
    cell.isDim() ? 2 : undefined,
    cell.isItalic() ? 3 : undefined,
    cell.isUnderline() ? 4 : undefined,
    cell.isBlink() ? 5 : undefined,
    cell.isInverse() ? 7 : undefined,
    cell.isInvisible() ? 8 : undefined,
    cell.isStrikethrough() ? 9 : undefined,
    cell.isOverline() ? 53 : undefined,
    colorSgr(cell, true),
    colorSgr(cell, false),
  ];
  const codes = attributes.filter((attribute) => attribute !== undefined);
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

/** In-memory VT emulator projected onto Pi's renderer; raw PTY output never escapes. */
export class TerminalScreen {
  readonly terminal: headless.Terminal;
  private readonly unicode = new PiUnicode();
  private readonly listeners: IDisposable[];
  private readonly pendingFlushes = new Set<() => void>();
  private cursorVisible = true;
  private disposed = false;

  constructor(cols: number, rows: number, onChange: () => void, onReply: (data: string) => void) {
    this.terminal = new headless.Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 1000,
      logLevel: "off",
    });
    this.terminal.unicode.register(this.unicode);
    this.terminal.unicode.activeVersion = this.unicode.version;
    this.listeners = [
      this.terminal.onWriteParsed(onChange),
      this.terminal.onResize(onChange),
      this.terminal.onData(onReply),
      ...(["h", "l"] as const).map((final) => this.terminal.parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        if (params.includes(25)) this.cursorVisible = final === "h";
        return false; // Observe DECTCEM without swallowing other modes in the sequence.
      })),
      this.terminal.parser.registerEscHandler({ final: "c" }, () => {
        this.cursorVisible = true;
        return false;
      }),
    ];
  }

  write(data: string): void {
    if (!this.disposed) this.terminal.write(data);
  }

  flush(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        this.pendingFlushes.delete(finish);
        resolve();
      };
      this.pendingFlushes.add(finish);
      this.terminal.write("", finish);
    });
  }

  resize(cols: number, rows: number): void {
    if (!this.disposed) this.terminal.resize(cols, rows);
  }

  get maxScrollback(): number {
    return this.disposed ? 0 : this.terminal.buffer.active.baseY;
  }

  render(scrollOffset: number, focused: boolean): string[] {
    const { cols, rows } = this.terminal;
    if (this.disposed) return Array.from({ length: rows }, () => " ".repeat(cols));
    const buffer = this.terminal.buffer.active;
    const offset = Math.max(0, Math.min(this.maxScrollback, Math.floor(scrollOffset) || 0));
    const showCursor = focused && this.cursorVisible && offset === 0;
    const cursorX = Math.min(buffer.cursorX, cols - 1); // Pending wrap is still on the last cell.
    const cell = buffer.getNullCell();
    const lines: string[] = [];
    for (let y = 0; y < rows; y++) {
      const line = buffer.getLine(buffer.baseY - offset + y);
      let cursorColumn = showCursor && y === buffer.cursorY ? cursorX : -1;
      // Cursor addressing can place the cursor on a wide glyph's continuation.
      if (cursorColumn > 0 && line?.getCell(cursorColumn, cell)?.getWidth() === 0) cursorColumn--;
      let result = RESET;
      let style = "";
      for (let x = 0; x < cols;) {
        const current = line?.getCell(x, cell);
        const width = current?.getWidth() ?? 1;
        if (width === 0) {
          x++;
          continue;
        }
        const nextStyle = current ? cellSgr(current) : "";
        if (nextStyle !== style) {
          result += RESET + nextStyle;
          style = nextStyle;
        }
        // Only cell text and freshly generated SGR are allowed back to the host.
        const chars = (current?.getChars() ?? "").replace(CONTROL_CHARACTERS, "") || " ";
        const text = truncateToWidth(chars, Math.min(width, cols - x), "", true);
        result += x === cursorColumn ? CURSOR_MARKER + renderFakeCursor(text) : text;
        x += width;
      }
      lines.push(truncateToWidth(result + RESET, cols, "", true));
    }
    return lines;
  }

  /** Static, sanitized occupied rows; the omitted count includes meaningful blank rows. */
  headTail(height: number): { head: string[]; tail: string[]; omitted: number } {
    height = Math.max(0, Math.floor(height) || 0);
    const buffer = this.terminal.buffer.active;
    const rows = this.terminal.rows;
    const physicalTotal = this.maxScrollback + rows;
    const cell = buffer.getNullCell();
    let occupiedEnd = 0;
    for (let y = physicalTotal - 1; y >= 0; y--) {
      const line = buffer.getLine(y);
      if (!line) continue;
      let occupied = false;
      for (let x = 0; x < this.terminal.cols; x++) {
        const current = line.getCell(x, cell);
        if (current && (current.getChars() !== "" || cellSgr(current) !== "")) { occupied = true; break; }
      }
      if (occupied) { occupiedEnd = y + 1; break; }
    }
    const cursorEnd = buffer.baseY + buffer.cursorY;
    const total = Math.max(0, Math.min(physicalTotal, Math.max(cursorEnd, occupiedEnd)));
    const slice = (start: number, count: number): string[] => {
      const lines: string[] = [];
      while (count > 0) {
        // Address physical buffer rows, not the shortened snapshot extent.
        const offset = Math.max(0, Math.min(this.maxScrollback, physicalTotal - rows - start));
        const skip = start - (this.maxScrollback - offset);
        const chunk = this.render(offset, false).slice(skip, skip + count);
        lines.push(...chunk);
        start += chunk.length;
        count -= chunk.length;
      }
      return lines;
    };
    if (total <= height) return { head: [], tail: slice(0, total), omitted: 0 };
    if (!this.maxScrollback || height < 3) {
      const count = Math.min(height, total);
      return { head: [], tail: slice(total - count, count), omitted: 0 };
    }
    const head = Math.floor((height - 1) / 2);
    const tail = height - 1 - head;
    return { head: slice(0, head), tail: slice(total - tail, tail), omitted: total - head - tail };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const listener of this.listeners) listener.dispose();
    this.terminal.dispose();
    this.unicode.dispose();
    for (const finish of this.pendingFlushes) finish();
  }
}
