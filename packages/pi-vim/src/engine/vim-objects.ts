/**
 * Ports of Neovim's word, sentence, paragraph and tag-block code
 * (src/nvim/textobject.c) over a `VimBuffer`, plus the operator-range rules
 * of `do_pending_operator` that turn a motion's end into the operated span.
 * Positions are UTF-16 offsets; grapheme clusters are not special-cased here.
 */

import { comparePos, type Pos, samePos, VimBuffer } from "./vim-pos.js";

export const FORWARD = 1;
export const BACKWARD = -1;
export type Direction = typeof FORWARD | typeof BACKWARD;

/**
 * An operator span the way Vim's `oparg_T` holds it: `end` is inclusive when
 * `inclusive` is set, exclusive otherwise; `linewise` spans whole lines.
 */
export type OpSpan = {
  start: Pos;
  end: Pos;
  inclusive: boolean;
  linewise: boolean;
  /** Skip the exclusive end adjustment (Vim's CA_NO_ADJ_OP_END, set for tag blocks). */
  noAdjust?: boolean;
};

const isWhite = (c: string): boolean => c === " " || c === "\t";
const KEYWORD = /[\p{L}\p{N}\p{M}_]/u;

/** Neovim `cls()`: 0 blank (or NUL), 1 punctuation, 2 keyword; WORD folds 2 into 1. */
export function charClass(c: string, bigword: boolean): number {
  if (c === "" || c === " " || c === "\t") return 0;
  if (bigword) return 1;
  return KEYWORD.test(c) ? 2 : 1;
}

class Cursor {
  constructor(
    readonly buf: VimBuffer,
    public pos: Pos,
    readonly bigword: boolean,
  ) {}
  cls(): number {
    return charClass(this.buf.charAt(this.pos), this.bigword);
  }
  inc(): number {
    return this.buf.inc(this.pos);
  }
  dec(): number {
    return this.buf.dec(this.pos);
  }
  lineEmpty(): boolean {
    return this.buf.isLineEmpty(this.pos.line);
  }
}

/** Neovim `fwd_word()`. `eol`: the last word stops at the end of line (operators). */
export function fwdWord(
  buf: VimBuffer,
  from: Pos,
  count: number,
  bigword: boolean,
  eol: boolean,
): { pos: Pos; ok: boolean } {
  const cur = new Cursor(buf, { ...from }, bigword);
  while (--count >= 0) {
    const sclass = cur.cls();
    const lastLine = cur.pos.line === buf.lineCount - 1;
    let i = cur.inc();
    if (i === -1 || (i >= 1 && lastLine)) return { pos: cur.pos, ok: false };
    if (i >= 1 && eol && count === 0) return { pos: cur.pos, ok: true };
    if (sclass !== 0) {
      while (cur.cls() === sclass) {
        i = cur.inc();
        if (i === -1 || (i >= 1 && eol && count === 0)) return { pos: cur.pos, ok: true };
      }
    }
    while (cur.cls() === 0) {
      if (cur.pos.col === 0 && cur.lineEmpty()) break;
      i = cur.inc();
      if (i === -1 || (i >= 1 && eol && count === 0)) return { pos: cur.pos, ok: true };
    }
  }
  return { pos: cur.pos, ok: true };
}

function skipChars(cur: Cursor, cclass: number, dir: Direction): boolean {
  while (cur.cls() === cclass) {
    if ((dir === FORWARD ? cur.inc() : cur.dec()) === -1) return true;
  }
  return false;
}

/** Neovim `bck_word()`. */
export function bckWord(
  buf: VimBuffer,
  from: Pos,
  count: number,
  bigword: boolean,
  stop: boolean,
): { pos: Pos; ok: boolean } {
  const cur = new Cursor(buf, { ...from }, bigword);
  while (--count >= 0) {
    const sclass = cur.cls();
    if (cur.dec() === -1) return { pos: cur.pos, ok: false };
    let finished = false;
    if (!stop || sclass === cur.cls() || sclass === 0) {
      while (cur.cls() === 0) {
        if (cur.pos.col === 0 && cur.lineEmpty()) {
          finished = true;
          break;
        }
        if (cur.dec() === -1) return { pos: cur.pos, ok: true };
      }
      if (!finished && skipChars(cur, cur.cls(), BACKWARD)) {
        return { pos: cur.pos, ok: true };
      }
    }
    if (!finished) cur.inc();
    stop = false;
  }
  return { pos: cur.pos, ok: true };
}

/** Neovim `end_word()`. */
export function endWord(
  buf: VimBuffer,
  from: Pos,
  count: number,
  bigword: boolean,
  stop: boolean,
  empty: boolean,
): { pos: Pos; ok: boolean } {
  const cur = new Cursor(buf, { ...from }, bigword);
  while (--count >= 0) {
    const sclass = cur.cls();
    if (cur.inc() === -1) return { pos: cur.pos, ok: false };
    let finished = false;
    if (cur.cls() === sclass && sclass !== 0) {
      if (skipChars(cur, sclass, FORWARD)) return { pos: cur.pos, ok: false };
    } else if (!stop || sclass === 0) {
      while (cur.cls() === 0) {
        if (empty && cur.pos.col === 0 && cur.lineEmpty()) {
          finished = true;
          break;
        }
        if (cur.inc() === -1) return { pos: cur.pos, ok: false };
      }
      if (!finished && skipChars(cur, cur.cls(), FORWARD)) {
        return { pos: cur.pos, ok: false };
      }
    }
    if (!finished) cur.dec();
    stop = false;
  }
  return { pos: cur.pos, ok: true };
}

/** Neovim `bckend_word()` (`ge`/`gE`). */
export function bckendWord(
  buf: VimBuffer,
  from: Pos,
  count: number,
  bigword: boolean,
  eol: boolean,
): { pos: Pos; ok: boolean } {
  const cur = new Cursor(buf, { ...from }, bigword);
  while (--count >= 0) {
    const sclass = cur.cls();
    let i = cur.dec();
    if (i === -1) return { pos: cur.pos, ok: false };
    if (eol && i === 1) return { pos: cur.pos, ok: true };
    if (sclass !== 0) {
      while (cur.cls() === sclass) {
        i = cur.dec();
        if (i === -1 || (eol && i === 1)) return { pos: cur.pos, ok: true };
      }
    }
    while (cur.cls() === 0) {
      if (cur.pos.col === 0 && cur.lineEmpty()) break;
      i = cur.dec();
      if (i === -1 || (eol && i === 1)) return { pos: cur.pos, ok: true };
    }
  }
  return { pos: cur.pos, ok: true };
}

/**
 * Neovim `findmatch()` for a known bracket: the unmatched `want` scanning from
 * `from` (exclusive) toward `want`'s side, nesting on its partner. Quotes and
 * backslashes are not special (the `%` cpo flag text objects use).
 */
export function findMatchingBracket(
  buf: VimBuffer,
  from: Pos,
  want: string,
  partner: string,
  dir: Direction,
): Pos | null {
  const pos = { ...from };
  let depth = 0;
  for (;;) {
    if ((dir === FORWARD ? buf.inc(pos) : buf.dec(pos)) === -1) return null;
    const c = buf.charAt(pos);
    if (c === want) {
      if (depth === 0) return { ...pos };
      depth--;
    } else if (c === partner) {
      depth++;
    }
  }
}

/**
 * Neovim `current_block()` outside Visual mode (`i(`, `a{`, ...). When the
 * cursor is in no block, Neovim 0.12 uses the next block after it.
 */
export function currentBlock(
  buf: VimBuffer,
  from: Pos,
  count: number,
  include: boolean,
  what: string,
  other: string,
): OpSpan | null {
  const cursor: Pos = { ...from };
  if (what === "{") {
    while (inIndent(buf, cursor)) if (buf.inc(cursor) !== 0) break;
  }
  if (buf.charAt(cursor) === what) cursor.col++;

  let startPos: Pos | null = null;
  if (findMatchingBracket(buf, cursor, what, other, BACKWARD)) {
    let at = cursor;
    for (let n = 0; n < count; n++) {
      const found = findMatchingBracket(buf, at, what, other, BACKWARD);
      if (!found) {
        startPos = null;
        break;
      }
      startPos = found;
      at = found;
    }
  } else {
    // No enclosing block: Neovim 0.12 takes the next one forward.
    let at = cursor;
    for (let n = 0; n < count; n++) {
      const found = findMatchingBracket(buf, at, what, other, FORWARD);
      if (!found) {
        startPos = null;
        break;
      }
      startPos = found;
      at = found;
    }
  }
  if (!startPos) return null;
  const endPos = findMatchingBracket(buf, startPos, other, what, FORWARD);
  if (!endPos) return null;

  let start = { ...startPos };
  let end = { ...endPos };
  let sol = false;
  if (!include) {
    buf.incl(start);
    sol = end.col === 0;
    buf.decl(end);
    while (inIndent(buf, end)) {
      sol = true;
      if (buf.decl(end) !== 0) break;
    }
  }
  if (sol) {
    buf.incl(end);
    return { start, end, inclusive: false, linewise: false };
  }
  if (comparePos(start, end) <= 0) return { start, end, inclusive: true, linewise: false };
  end = { ...start };
  start = { ...start };
  return { start, end, inclusive: false, linewise: false };
}

/** Neovim `inindent(1)`: the cursor sits on a leading blank of its line. */
function inIndent(buf: VimBuffer, pos: Pos): boolean {
  const line = buf.lines[pos.line] ?? "";
  let col = 0;
  while (col < line.length && (line[col] === " " || line[col] === "\t")) col++;
  return col >= pos.col + 1;
}

function findNextQuote(line: string, col: number, quote: string, escape: string | null): number {
  for (;;) {
    const c = line[col];
    if (c === undefined) return -1;
    if (escape !== null && escape.includes(c)) {
      col++;
      if (line[col] === undefined) return -1;
    } else if (c === quote) {
      return col;
    }
    col++;
  }
}

function findPrevQuote(line: string, colStart: number, quote: string, escape: string | null): number {
  while (colStart > 0) {
    colStart--;
    let n = 0;
    if (escape !== null) {
      while (colStart - n > 0 && escape.includes(line[colStart - n - 1] ?? "")) n++;
    }
    if (n & 1) colStart -= n;
    else if (line[colStart] === quote) break;
  }
  return colStart;
}

/** Neovim `current_quote()` outside Visual mode (`i"`, `a'`, ...), line-local. */
export function currentQuote(
  buf: VimBuffer,
  from: Pos,
  count: number,
  include: boolean,
  quote: string,
): OpSpan | null {
  const line = buf.lines[from.line] ?? "";
  const escape = "\\";
  let colStart = from.col;
  let colEnd: number;
  if (line[colStart] === quote) {
    const firstCol = colStart;
    colStart = 0;
    for (;;) {
      colStart = findNextQuote(line, colStart, quote, null);
      if (colStart < 0 || colStart > firstCol) return null;
      colEnd = findNextQuote(line, colStart + 1, quote, escape);
      if (colEnd < 0) return null;
      if (colStart <= firstCol && firstCol <= colEnd) break;
      colStart = colEnd + 1;
    }
  } else {
    colStart = findPrevQuote(line, colStart, quote, escape);
    if (line[colStart] !== quote) {
      colStart = findNextQuote(line, colStart, quote, null);
      if (colStart < 0) return null;
    }
    colEnd = findNextQuote(line, colStart + 1, quote, escape);
    if (colEnd < 0) return null;
  }
  if (include) {
    const white = (c: string | undefined) => c === " " || c === "\t";
    if (white(line[colEnd + 1])) {
      while (white(line[colEnd + 1])) colEnd++;
    } else {
      while (colStart > 0 && white(line[colStart - 1])) colStart--;
    }
  }
  if (!include && count < 2) colStart++;
  const start = { line: from.line, col: colStart };
  if (include || count > 1) {
    return { start, end: { line: from.line, col: colEnd }, inclusive: true, linewise: false };
  }
  return { start, end: { line: from.line, col: colEnd }, inclusive: false, linewise: false };
}

/** Neovim `current_line()` (`il`): the line without surrounding blanks. `al` is all lines. */
export function currentLine(buf: VimBuffer, from: Pos, include: boolean): OpSpan | null {
  if (include) {
    return {
      start: { line: 0, col: 0 },
      end: { line: buf.lineCount - 1, col: 0 },
      inclusive: false,
      linewise: true,
    };
  }
  const line = buf.lines[from.line] ?? "";
  let start = 0;
  while (start < line.length && (line[start] === " " || line[start] === "\t")) start++;
  let end = line.length;
  while (end > start && /\s/.test(line[end - 1] ?? "")) end--;
  if (start === end) return null;
  return {
    start: { line: from.line, col: start },
    end: { line: from.line, col: end - 1 },
    inclusive: true,
    linewise: false,
  };
}

/** Neovim `startPS()` without nroff macros: an empty line or a form feed starts a paragraph. */
export function startPS(buf: VimBuffer, line: number): boolean {
  const s = buf.lines[line] ?? "";
  return s.length === 0 || s[0] === "\f";
}

/** Neovim `findsent()`. Returns the new position, or null on FAIL. */
export function findSentence(
  buf: VimBuffer,
  from: Pos,
  dir: Direction,
  count: number,
): Pos | null {
  const pos: Pos = { ...from };
  const func = (p: Pos) => (dir === FORWARD ? buf.incl(p) : buf.decl(p));
  let noskip = false;
  while (count--) {
    const prev = { ...pos };
    let gotoFound = false;
    if (buf.charAt(pos) === "") {
      do {
        if (func(pos) === -1) break;
      } while (buf.charAt(pos) === "");
      if (dir === FORWARD) gotoFound = true;
    } else if (dir === FORWARD && pos.col === 0 && startPS(buf, pos.line)) {
      if (pos.line === buf.lineCount - 1) return null;
      pos.line++;
      pos.col = 0;
      gotoFound = true;
    } else if (dir === BACKWARD) {
      buf.decl(pos);
    }

    if (!gotoFound) {
      let foundDot = false;
      for (;;) {
        const c = buf.charAt(pos);
        if (!(isWhite(c) || (c !== "" && ".!?)]\"'".includes(c)))) break;
        const tpos = { ...pos };
        if (buf.decl(tpos) === -1 || (buf.isLineEmpty(tpos.line) && dir === FORWARD)) break;
        if (foundDot) break;
        if (c !== "" && ".!?".includes(c)) foundDot = true;
        const tc = buf.charAt(tpos);
        if (c !== "" && ")]\"'".includes(c) && !(tc !== "" && ".!?)]\"'".includes(tc))) break;
        buf.decl(pos);
      }

      const startLine = pos.line;
      for (;;) {
        const c = buf.charAt(pos);
        if (c === "" || (pos.col === 0 && startPS(buf, pos.line))) {
          if (dir === BACKWARD && pos.line !== startLine) {
            pos.line++;
            pos.col = 0;
          }
          break;
        }
        if (c === "." || c === "!" || c === "?") {
          const tpos = { ...pos };
          let r: number;
          let tc = "";
          do {
            r = buf.inc(tpos);
            if (r === -1) break;
            tc = buf.charAt(tpos);
          } while (tc !== "" && ")]\"'".includes(tc));
          if (r === -1 || tc === " " || tc === "\t" || tc === "") {
            pos.line = tpos.line;
            pos.col = tpos.col;
            if (buf.charAt(pos) === "") buf.inc(pos);
            break;
          }
        }
        if (func(pos) === -1) {
          if (count) return null;
          noskip = true;
          break;
        }
      }
    }

    // found:
    while (!noskip) {
      const c = buf.charAt(pos);
      if (c !== " " && c !== "\t") break;
      if (buf.incl(pos) === -1) break;
    }

    if (samePos(prev, pos)) {
      if (func(pos) === -1) {
        if (count) return null;
        break;
      }
      count++;
    }
  }
  return pos;
}

function findFirstBlank(buf: VimBuffer, pos: Pos): void {
  while (buf.decl(pos) !== -1) {
    if (!isWhite(buf.charAt(pos))) {
      buf.incl(pos);
      break;
    }
  }
}

function findSentenceForward(buf: VimBuffer, cursor: Pos, count: number, atStartSent: boolean): void {
  while (count--) {
    const next = findSentence(buf, cursor, FORWARD, 1);
    if (next) {
      cursor.line = next.line;
      cursor.col = next.col;
    }
    if (atStartSent) findFirstBlank(buf, cursor);
    if (count === 0 || atStartSent) buf.decl(cursor);
    atStartSent = !atStartSent;
  }
}

/** Neovim `current_sent()` outside Visual mode (`is` / `as`). */
export function currentSentence(
  buf: VimBuffer,
  from: Pos,
  count: number,
  include: boolean,
): OpSpan | null {
  const startPos: Pos = { ...from };
  const pos: Pos = { ...from };
  const cursor: Pos = findSentence(buf, from, FORWARD, 1) ?? { ...from };

  while (isWhite(buf.charAt(pos))) buf.incl(pos);
  let startBlank: boolean;
  if (samePos(pos, cursor)) {
    startBlank = true;
    findFirstBlank(buf, startPos);
  } else {
    startBlank = false;
    const back = findSentence(buf, cursor, BACKWARD, 1);
    if (back) {
      cursor.line = back.line;
      cursor.col = back.col;
    }
    startPos.line = cursor.line;
    startPos.col = cursor.col;
  }
  let ncount = include ? count * 2 : count - (startBlank ? 1 : 0);
  if (ncount > 0) findSentenceForward(buf, cursor, ncount, true);
  else buf.decl(cursor);

  if (include) {
    if (startBlank) {
      findFirstBlank(buf, cursor);
      if (isWhite(buf.charAt(cursor))) buf.decl(cursor);
    } else if (!isWhite(buf.charAt(cursor))) {
      findFirstBlank(buf, startPos);
    }
  }

  const end = { ...cursor };
  const inclusive = buf.incl(end) === -1;
  return { start: startPos, end: inclusive ? cursor : end, inclusive, linewise: false };
}

/** Neovim `current_par()` outside Visual mode (`ip` / `ap`); always linewise. */
export function currentParagraph(
  buf: VimBuffer,
  cursorLine: number,
  count: number,
  include: boolean,
): { startLine: number; endLine: number } | null {
  // 1-based like the original, converted on return.
  const lineCount = buf.lineCount;
  const white = (l: number) => buf.isLineWhite(l - 1);
  const ps = (l: number) => startPS(buf, l - 1);
  let startLnum = cursorLine + 1;
  const whiteInFront = white(startLnum);
  while (startLnum > 1) {
    if (whiteInFront) {
      if (!white(startLnum - 1)) break;
    } else if (white(startLnum - 1) || ps(startLnum)) {
      break;
    }
    startLnum--;
  }
  let endLnum = startLnum;
  while (endLnum <= lineCount && white(endLnum)) endLnum++;
  endLnum--;
  let i = count;
  if (!include && whiteInFront) i--;
  let doWhite = false;
  while (i--) {
    if (endLnum === lineCount) return null;
    if (!include) doWhite = white(endLnum + 1);
    if (include || !doWhite) {
      endLnum++;
      while (endLnum < lineCount && !white(endLnum + 1) && !ps(endLnum + 1)) endLnum++;
    }
    if (i === 0 && whiteInFront && include) break;
    if (include || doWhite) {
      while (endLnum < lineCount && white(endLnum + 1)) endLnum++;
    }
  }
  if (!whiteInFront && !white(endLnum) && include) {
    while (startLnum > 1 && white(startLnum - 1)) startLnum--;
  }
  return { startLine: startLnum - 1, endLine: endLnum - 1 };
}

type Tag = { start: Pos; end: Pos; name: string; closing: boolean };

/** Start tags (`<a ...>`, not `<a/>`, `<!...>`) and end tags (`</a>`) in buffer order. */
function scanTags(buf: VimBuffer): Tag[] {
  const text = buf.text;
  const tags: Tag[] = [];
  const re = /<(\/?)([^\s>/!]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const closing = m[1] === "/";
    const gt = text.indexOf(">", m.index + m[0].length);
    if (closing) {
      if (gt === -1) continue;
      // `</[^>]*>`: anything up to the first `>`.
      tags.push({ start: buf.fromAbs(m.index), end: buf.fromAbs(gt), name: m[2]!.toLowerCase(), closing });
      continue;
    }
    const nameEnd = m.index + m[0].length;
    const next = text[nameEnd];
    if (gt === -1) {
      // `<aaa` at end of line also counts as a start tag.
      if (next === undefined || next === "\n") {
        tags.push({ start: buf.fromAbs(m.index), end: buf.fromAbs(nameEnd - 1), name: m[2]!.toLowerCase(), closing });
      }
      continue;
    }
    if (next !== ">" && next !== undefined && !/\s/.test(next)) continue;
    if (text[gt - 1] === "/" && gt - 1 >= nameEnd) continue;
    tags.push({ start: buf.fromAbs(m.index), end: buf.fromAbs(gt), name: m[2]!.toLowerCase(), closing });
  }
  return tags;
}

function inHtmlTag(buf: VimBuffer, cursor: Pos, endTag: boolean): boolean {
  const line = buf.lines[cursor.line] ?? "";
  let p = Math.min(cursor.col, line.length);
  while (p > 0) {
    if (line[p] === "<") break;
    p--;
    if (line[p] === ">") break;
  }
  if (line[p] !== "<") return false;
  if (endTag) return line[p + 1] === "/";
  if (line[p + 1] === "/") return false;
  const pos = { line: cursor.line, col: p };
  let lc = "";
  for (;;) {
    if (buf.inc(pos) < 0) return false;
    const c = buf.charAt(pos);
    if (c === ">") break;
    lc = c;
  }
  return lc !== "/";
}

/** Neovim `current_tagblock()` outside Visual mode (`it` / `at`). */
export function currentTagBlock(
  buf: VimBuffer,
  from: Pos,
  countArg: number,
  include: boolean,
): OpSpan | null {
  const tags = scanTags(buf);
  const cursor: Pos = { ...from };
  let oldEnd: Pos = { ...from };
  buf.decl(oldEnd);

  // ignore indent
  const lineText = buf.lines[cursor.line] ?? "";
  while (cursor.col < lineText.length && /^[ \t]*$/.test(lineText.slice(0, cursor.col + 1))) {
    if (buf.inc(cursor) !== 0) break;
  }
  if (inHtmlTag(buf, cursor, false)) {
    while (buf.charAt(cursor) !== ">") if (buf.inc(cursor) < 0) break;
  } else if (inHtmlTag(buf, cursor, true)) {
    while (buf.charAt(cursor) !== "<") if (buf.dec(cursor) < 0) break;
    buf.dec(cursor);
    oldEnd = { ...cursor };
  }

  let count = countArg;
  let searchFrom: Pos = { ...cursor };
  for (let attempt = 0; attempt < 1000; attempt++) {
    // Search backwards for `count` unclosed start tags.
    let found: Tag | null = null;
    let at = searchFrom;
    for (let n = 0; n < count; n++) {
      let depth = 0;
      found = null;
      for (let t = tags.length - 1; t >= 0; t--) {
        const tag = tags[t]!;
        if (comparePos(tag.start, at) >= 0) continue;
        if (tag.closing) depth++;
        else if (depth === 0) {
          found = tag;
          break;
        } else depth--;
      }
      if (!found) return null;
      at = found.start;
    }
    const startTag = found!;
    // Matching end tag for that name, nesting on same-name start tags.
    let depth = 0;
    let endTag: Tag | null = null;
    for (const tag of tags) {
      if (comparePos(tag.start, startTag.start) <= 0) continue;
      if (tag.name !== startTag.name) continue;
      if (!tag.closing) depth++;
      else if (depth === 0) {
        endTag = tag;
        break;
      } else depth--;
    }
    if (!endTag || comparePos(endTag.start, oldEnd) < 0) {
      count = 1;
      searchFrom = startTag.start;
      continue;
    }

    let start: Pos;
    let end: Pos;
    let inclusive = true;
    if (include) {
      start = { ...startTag.start };
      end = { ...endTag.end };
    } else {
      end = { ...endTag.start };
      if (end.col === 0) inclusive = false;
      else buf.dec(end);
      // after the start tag's `>`, skipping `>` inside quotes
      const p = { ...startTag.start };
      let inQuotes = false;
      start = { ...startTag.start };
      while (buf.inc(p) >= 0) {
        const c = buf.charAt(p);
        if (c === ">" && !inQuotes) {
          buf.inc(p);
          start = { ...p };
          break;
        } else if (c === '"' || c === "'") {
          inQuotes = !inQuotes;
        }
      }
    }
    if (comparePos(end, start) < 0) {
      return { start, end: start, inclusive: false, linewise: false, noAdjust: true };
    }
    return { start, end, inclusive, linewise: false, noAdjust: true };
  }
  return null;
}

/**
 * Turn an operator span into an absolute `[start, end)` range, applying
 * `do_pending_operator`'s exclusive adjustment: an exclusive motion ending in
 * column 0 of a later line ends on the previous line instead, and becomes
 * linewise when it started in the indent.
 */
/**
 * `op_delete`'s rule: a multi-line charwise delete that starts in the indent
 * and leaves only blanks after its end becomes linewise.
 */
export function deleteBecomesLinewise(buf: VimBuffer, startAbs: number, endAbs: number): boolean {
  const start = buf.fromAbs(startAbs);
  const end = buf.fromAbs(endAbs);
  if (end.line <= start.line) return false;
  const before = (buf.lines[start.line] ?? "").slice(0, start.col);
  const after = (buf.lines[end.line] ?? "").slice(end.col);
  return /^[ \t]*$/.test(before) && /^[ \t]*$/.test(after);
}

export function resolveOpSpan(
  buf: VimBuffer,
  span: OpSpan,
  options: { adjustExclusive?: boolean; visualEnd?: boolean } = {},
): { startAbs: number; endAbs: number; linewise: boolean; startLine: number; endLine: number } {
  let { start, end } = span;
  if (comparePos(end, start) < 0) [start, end] = [end, start];
  let { inclusive, linewise } = span;
  if (
    !linewise &&
    !inclusive &&
    options.adjustExclusive !== false &&
    !span.noAdjust &&
    end.col === 0 &&
    end.line > start.line
  ) {
    end = { line: end.line - 1, col: buf.lineLength(end.line - 1) };
    const before = (buf.lines[start.line] ?? "").slice(0, start.col);
    if (/^[ \t]*$/.test(before)) {
      linewise = true;
    } else if (end.col > 0) {
      end = { line: end.line, col: end.col - 1 };
      inclusive = true;
    }
  }
  if (linewise) {
    const startAbs = buf.abs({ line: start.line, col: 0 });
    const endAbs = buf.abs({ line: end.line, col: buf.lineLength(end.line) });
    return { startAbs, endAbs, linewise: true, startLine: start.line, endLine: end.line };
  }
  const startAbs = buf.abs(start);
  let endAbs = buf.abs(end);
  // An inclusive end on the end-of-line position stops at the line's end; it
  // never takes the line break (Vim clamps the byte count to the line).
  if (inclusive) {
    const ch = buf.charAt(end);
    // A Visual selection ending on the end-of-line position takes the break.
    endAbs += ch === "" ? (options.visualEnd && end.line < buf.lineCount - 1 ? 1 : 0) : ch.length;
  }
  return { startAbs, endAbs, linewise: false, startLine: start.line, endLine: end.line };
}
