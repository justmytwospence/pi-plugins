/**
 * Vim-style cursor arithmetic over a buffer of lines, for algorithms ported
 * from Vim and its plugins (sentences, paragraphs, targets.vim, surround.vim).
 *
 * A position may sit on a character or on the end-of-line position
 * (`col === line.length`, Vim's NUL), which is the only position an empty line
 * has. `inc`/`dec` step through that NUL like Vim's `inc()`/`dec()`;
 * `incl`/`decl` skip it on non-empty lines like `incl()`/`decl()`.
 */

export type Pos = { line: number; col: number };

/** A single-position pattern: true when the pattern matches at `pos`. */
export type PosPattern = (buf: VimBuffer, pos: Pos) => boolean;

export type SearchFlags = {
  backward?: boolean;
  /** Accept a match at the cursor itself (Vim's `c` flag). */
  acceptCursor?: boolean;
  /** Do not search past this line (Vim's stopline); undefined = no limit. */
  stopline?: number;
};

export function comparePos(a: Pos, b: Pos): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

export function samePos(a: Pos, b: Pos): boolean {
  return a.line === b.line && a.col === b.col;
}

export class VimBuffer {
  readonly lines: string[];
  private readonly lineStarts: number[];

  constructor(text: string) {
    this.lines = text.split("\n");
    this.lineStarts = [];
    let abs = 0;
    for (const line of this.lines) {
      this.lineStarts.push(abs);
      abs += line.length + 1;
    }
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get text(): string {
    return this.lines.join("\n");
  }

  lineLength(line: number): number {
    return (this.lines[line] ?? "").length;
  }

  /** The character at `pos`, or "" on the end-of-line position. */
  charAt(pos: Pos): string {
    const line = this.lines[pos.line];
    if (line === undefined || pos.col < 0 || pos.col >= line.length) return "";
    return line[pos.col] ?? "";
  }

  abs(pos: Pos): number {
    return (this.lineStarts[pos.line] ?? 0) + pos.col;
  }

  fromAbs(abs: number): Pos {
    let line = 0;
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.lineStarts[mid] ?? 0) <= abs) {
        line = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    const col = Math.max(0, Math.min(abs - (this.lineStarts[line] ?? 0), this.lineLength(line)));
    return { line, col };
  }

  isLineEmpty(line: number): boolean {
    return this.lineLength(line) === 0;
  }

  /** Line holds nothing but blanks (Vim's `linewhite()`). */
  isLineWhite(line: number): boolean {
    return /^[ \t]*$/.test(this.lines[line] ?? "");
  }

  /**
   * Vim `inc()`: 0 = moved within the line, 2 = moved onto the end-of-line
   * position, 1 = moved to the next line, -1 = already at the end of buffer.
   */
  inc(pos: Pos): number {
    const len = this.lineLength(pos.line);
    if (pos.col < len) {
      pos.col++;
      return pos.col < len ? 0 : 2;
    }
    if (pos.line < this.lineCount - 1) {
      pos.line++;
      pos.col = 0;
      return 1;
    }
    return -1;
  }

  /** Vim `incl()`: `inc()` that skips the end-of-line position of a non-empty line. */
  incl(pos: Pos): number {
    let r = this.inc(pos);
    if (r >= 1 && pos.col) r = this.inc(pos);
    return r;
  }

  /** Vim `dec()`: 0 = within the line, 1 = to the previous line's end-of-line, -1 = at start. */
  dec(pos: Pos): number {
    if (pos.col > 0) {
      const len = this.lineLength(pos.line);
      pos.col = Math.min(pos.col, len) - 1;
      if (pos.col < 0) pos.col = 0;
      return 0;
    }
    if (pos.line > 0) {
      pos.line--;
      pos.col = this.lineLength(pos.line);
      return 1;
    }
    return -1;
  }

  /** Vim `decl()`: `dec()` that skips the end-of-line position of a non-empty line. */
  decl(pos: Pos): number {
    let r = this.dec(pos);
    if (r === 1 && pos.col) r = this.dec(pos);
    return r;
  }

  /**
   * Vim `search()`/`searchpos()` with a one-position pattern and the `W` flag
   * (no wrap). Positions include each line's end-of-line position, where only
   * patterns that accept an empty character (such as `$`) match.
   */
  search(pattern: PosPattern, from: Pos, flags: SearchFlags = {}): Pos | null {
    const { backward = false, acceptCursor = false, stopline } = flags;
    if (!backward) {
      const lastLine =
        stopline === undefined ? this.lineCount - 1 : Math.min(stopline, this.lineCount - 1);
      for (let line = from.line; line <= lastLine; line++) {
        const len = this.lineLength(line);
        const startCol = line === from.line ? from.col + (acceptCursor ? 0 : 1) : 0;
        for (let col = Math.max(0, startCol); col <= len; col++) {
          const pos = { line, col };
          if (pattern(this, pos)) return pos;
        }
      }
      return null;
    }
    const firstLine = stopline === undefined ? 0 : Math.max(0, stopline);
    for (let line = from.line; line >= firstLine; line--) {
      const len = this.lineLength(line);
      const startCol = line === from.line ? from.col - (acceptCursor ? 0 : 1) : len;
      for (let col = Math.min(startCol, len); col >= 0; col--) {
        const pos = { line, col };
        if (pattern(this, pos)) return pos;
      }
    }
    return null;
  }

  /** Normal-mode <Space> with 'whichwrap' containing `s`. */
  spaceRight(pos: Pos): Pos {
    const len = this.lineLength(pos.line);
    if (pos.col + 1 < len) return { line: pos.line, col: pos.col + 1 };
    if (pos.line < this.lineCount - 1) return { line: pos.line + 1, col: 0 };
    return { ...pos };
  }

  /** Normal-mode <BS> with 'whichwrap' containing `b`. */
  backspaceLeft(pos: Pos): Pos {
    if (pos.col > 0) return { line: pos.line, col: pos.col - 1 };
    if (pos.line > 0) {
      const len = this.lineLength(pos.line - 1);
      return { line: pos.line - 1, col: Math.max(0, len - 1) };
    }
    return { ...pos };
  }

  /** The last character of a line (col 0 when empty), Normal-mode `$`. */
  lineEndChar(line: number): Pos {
    return { line, col: Math.max(0, this.lineLength(line) - 1) };
  }
}

export function charPattern(test: (ch: string) => boolean): PosPattern {
  return (buf, pos) => {
    const ch = buf.charAt(pos);
    return ch !== "" && test(ch);
  };
}

export const NON_BLANK: PosPattern = charPattern((ch) => !/\s/.test(ch));
export const NON_BLANK_OR_EOL: PosPattern = (buf, pos) =>
  pos.col >= buf.lineLength(pos.line) || NON_BLANK(buf, pos);

/** A literal delimiter, optionally not preceded by a backslash (Vim's 'quoteescape'). */
export function literalPattern(ch: string, escapable = false): PosPattern {
  return (buf, pos) => {
    if (buf.charAt(pos) !== ch) return false;
    if (!escapable || pos.col === 0) return true;
    return (buf.lines[pos.line] ?? "")[pos.col - 1] !== "\\";
  };
}

export function anyOf(...patterns: PosPattern[]): PosPattern {
  return (buf, pos) => patterns.some((pattern) => pattern(buf, pos));
}
