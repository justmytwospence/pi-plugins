/**
 * A port of vim-wordmotion (chaoren/vim-wordmotion, MIT): lowercase word
 * motions (`w`, `b`, `e`, `ge`) and objects (`iw`, `aw`) that split
 * CamelCase, ACRONYMS, snake_case and kebab-case into separate words.
 *
 * The plugin searches with 'cpoptions' containing `c`, so a line's words are
 * the non-overlapping matches of its word pattern from the start of the line;
 * a motion picks the next or previous of those matches.
 */

import { comparePos, type Pos, VimBuffer } from "./vim-pos.js";

const ALPHA = "\\p{Lu}\\p{Ll}";
const ALNUM = `${ALPHA}0-9`;
const KEYWORD = "\\p{L}\\p{N}_";
/** Blanks, plus hyphens between letters and underscores between alphanumerics. */
const SPACE = `(?:\\s|(?<=[${ALPHA}]-*)-(?=-*[${ALPHA}])|(?<=[${ALNUM}]_*)_(?=_*[${ALNUM}]))`;
const WORD = [
  "\\p{Lu}\\p{Ll}+", // CamelCase
  "\\p{Lu}+(?!\\p{Ll})", // UPPERCASE
  "\\p{Ll}+", // lowercase
  `#[0-9A-Fa-f]+(?![${KEYWORD}])`, // #0F0F0F
  `(?<![${KEYWORD}])0[xX][0-9A-Fa-f]+(?![${KEYWORD}])`,
  `(?<![${KEYWORD}])0[oO][0-7]+(?![${KEYWORD}])`,
  `(?<![${KEYWORD}])0[bB][01]+(?![${KEYWORD}])`,
  "[0-9]+",
  `(?:(?![${ALNUM}]|${SPACE}|#[0-9A-Fa-f])[^\\p{Cc}])+`, // other printable characters
].join("|");

const WORD_RE = new RegExp(WORD, "uy");
const WORD_OR_SPACE_RE = new RegExp(`${SPACE}+|${WORD}`, "uy");
const SPACE_AT = new RegExp(SPACE, "uy");

export type WordToken = {
  start: Pos;
  /** Exclusive end; equal to `start` for the empty-line and buffer-edge marks. */
  end: Pos;
  /** Zero-width `^$` (empty line) match. */
  emptyLine?: boolean;
  /** Zero-width `\%^` / `\%$` match. */
  edge?: boolean;
};

function lineTokens(line: string, lineIndex: number, withSpaces: boolean): WordToken[] {
  const re = withSpaces ? WORD_OR_SPACE_RE : WORD_RE;
  const tokens: WordToken[] = [];
  let i = 0;
  while (i < line.length) {
    re.lastIndex = i;
    const m = re.exec(line);
    if (m && m[0].length > 0) {
      tokens.push({
        start: { line: lineIndex, col: i },
        end: { line: lineIndex, col: i + m[0].length },
      });
      i += m[0].length;
    } else {
      i++;
    }
  }
  return tokens;
}

/** The plugin's word matches in buffer order, with `^$` and the buffer edges. */
export function wordmotionTokens(
  buf: VimBuffer,
  options: { emptyLines: boolean; withSpaces?: boolean },
): WordToken[] {
  const tokens: WordToken[] = [{ start: { line: 0, col: 0 }, end: { line: 0, col: 0 }, edge: true }];
  buf.lines.forEach((line, index) => {
    if (line.length === 0) {
      if (options.emptyLines) {
        tokens.push({ start: { line: index, col: 0 }, end: { line: index, col: 0 }, emptyLine: true });
      }
      return;
    }
    tokens.push(...lineTokens(line, index, options.withSpaces === true));
  });
  const last = buf.lineCount - 1;
  const endPos = { line: last, col: buf.lineLength(last) };
  tokens.push({ start: endPos, end: endPos, edge: true });
  return tokens;
}

/** True when the character at `pos` counts as a space for the plugin. */
export function isWordmotionSpace(buf: VimBuffer, pos: Pos): boolean {
  const line = buf.lines[pos.line] ?? "";
  if (pos.col >= line.length) return false;
  SPACE_AT.lastIndex = pos.col;
  return SPACE_AT.test(line);
}

/** Inclusive end position of a token (its start for zero-width matches). */
function endChar(token: WordToken): Pos {
  if (comparePos(token.start, token.end) === 0) return token.start;
  return { line: token.end.line, col: token.end.col - 1 };
}

type Flags = { backward: boolean; end: boolean; acceptCursor: boolean };

/** One `search()` for the plugin's pattern; null when nothing matches. */
function searchToken(tokens: WordToken[], from: Pos, flags: Flags): Pos | null {
  if (!flags.backward) {
    for (const token of tokens) {
      // `\%$` never matches ahead of a Normal-mode cursor on the last line.
      if (token.edge) continue;
      const at = flags.end ? endChar(token) : token.start;
      const cmp = comparePos(at, from);
      if (cmp > 0 || (cmp === 0 && flags.acceptCursor)) return at;
    }
    return null;
  }
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (flags.end && token.edge) continue;
    const at = flags.end ? endChar(token) : token.start;
    const cmp = comparePos(at, from);
    if (cmp < 0 || (cmp === 0 && flags.acceptCursor)) return at;
  }
  return null;
}

export type WordmotionKind = "w" | "b" | "e" | "ge";

export type WordmotionResult = {
  pos: Pos;
  /** Operator range is inclusive of `pos`. */
  inclusive: boolean;
  /** For `dw` across a line: the operated text ends before this line break. */
  endBeforeLineBreak?: Pos;
};

/**
 * `wordmotion#motion()`. `operator` is the pending operator (`"c"`, `"d"`,
 * another, or null for a plain motion).
 */
export function wordmotionMotion(
  text: string,
  from: Pos,
  count: number,
  kind: WordmotionKind,
  operator: string | null,
): WordmotionResult {
  const buf = new VimBuffer(text);
  let flagsEnd = kind === "e" || kind === "ge";
  const backward = kind === "b" || kind === "ge";
  let cw = false;
  if (operator === "c" && kind === "w") {
    flagsEnd = true;
    cw = true;
  }
  // `e` does not stop on an empty line; the plugin compares flags to 'e' exactly.
  const tokens = wordmotionTokens(buf, { emptyLines: !(kind === "e" || cw) });
  let pos: Pos = { ...from };
  let remaining = count;
  if (cw) {
    const found = searchToken(tokens, pos, { backward: false, end: true, acceptCursor: true });
    if (found) pos = found;
    remaining--;
  }
  while (remaining > 0) {
    const found = searchToken(tokens, pos, { backward, end: flagsEnd, acceptCursor: false });
    if (found) pos = found;
    remaining--;
  }
  const inclusive = operator !== null && flagsEnd;
  const result: WordmotionResult = { pos, inclusive };

  if (operator === "d" && kind === "w" && pos.line > from.line) {
    const line = buf.lines[pos.line] ?? "";
    if (/^\s*$/.test(line.slice(0, pos.col))) {
      result.endBeforeLineBreak = { line: pos.line - 1, col: buf.lineLength(pos.line - 1) };
    }
  }

  if (count > 0 && comparePos(pos, from) === 0) {
    if (kind === "ge" && pos.line === 0) {
      result.pos = { line: 0, col: 0 };
    } else if (kind === "w" && !cw && pos.line === buf.lineCount - 1) {
      result.pos = { line: pos.line, col: Math.max(0, buf.lineLength(pos.line) - (operator ? 0 : 1)) };
    }
  }
  return result;
}

/** `wordmotion#object()` outside Visual mode: inclusive `[start, end]`. */
export function wordmotionObject(
  text: string,
  from: Pos,
  count: number,
  inner: boolean,
): { start: Pos; end: Pos } | null {
  const buf = new VimBuffer(text);
  // Internal motions pass flags 'bc'/'ec' (not exactly 'e'), so `^$` stays in.
  const tokens = wordmotionTokens(buf, { emptyLines: true, withSpaces: inner });
  const tokensE = wordmotionTokens(buf, { emptyLines: false, withSpaces: inner });
  let cursor: Pos = { ...from };
  let backwards = false;
  // The plugin tests the lone cursor character, so only real blanks count here.
  if (!inner && /\s/.test(buf.charAt(cursor))) {
    backwards = true;
    const next = buf.search((b, p) => b.charAt(p) !== "" && !isWordmotionSpace(b, p), cursor);
    if (next) cursor = next;
  }
  const startFound = searchToken(tokens, cursor, { backward: true, end: false, acceptCursor: true });
  if (startFound) cursor = startFound;
  let start = { ...cursor };
  const endFound = searchToken(tokens, cursor, { backward: false, end: true, acceptCursor: true });
  if (endFound) cursor = endFound;
  for (let n = count - 1; n > 0; n--) {
    const found = searchToken(tokensE, cursor, { backward: false, end: true, acceptCursor: false });
    if (found) cursor = found;
  }
  if (!inner) {
    if (cursor.col === buf.lineLength(cursor.line) - 1) backwards = true;
    if (backwards) {
      // leading blanks immediately before the start
      let col = start.col;
      while (col > 0 && isWordmotionSpace(buf, { line: start.line, col: col - 1 })) col--;
      if (col < start.col) start = { line: start.line, col };
    } else {
      let col = cursor.col + 1;
      const line = cursor.line;
      if (col < buf.lineLength(line) && isWordmotionSpace(buf, { line, col })) {
        while (col < buf.lineLength(line) && isWordmotionSpace(buf, { line, col })) col++;
        cursor = { line, col: col - 1 };
      }
    }
  }
  if (comparePos(cursor, start) < 0) return null;
  return { start, end: cursor };
}
