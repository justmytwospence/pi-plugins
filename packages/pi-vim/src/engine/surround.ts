/**
 * A port of surround.vim (tpope/vim-surround, Vim license): `ys{motion}`,
 * `yss`, Visual `S`, `ds` and `cs`. The editing steps are simulated on plain
 * text with the same text objects Vim uses for them, so results (including
 * where the cursor lands) follow the plugin. The unnamed register is left
 * untouched, as the plugin restores it.
 */

import {
  currentBlock,
  currentParagraph,
  currentQuote,
  currentSentence,
  currentTagBlock,
  deleteBecomesLinewise,
  type OpSpan,
  resolveOpSpan,
} from "./vim-objects.js";
import { resolveWordTextObjectRange } from "./text-objects.js";
import { type Pos, VimBuffer } from "./vim-pos.js";

/** Replacement characters that read more input before wrapping. */
export function surroundNeedsInput(char: string): "tag" | "function" | null {
  if (char === "t" || char === "T" || char === "<" || char === "\x14") return "tag";
  if (char === "f" || char === "F" || char === "\x06") return "function";
  return null;
}

export type SurroundReplacement = {
  char: string;
  /** Text typed at the tag or function prompt (a tag may end with `>`). */
  input?: string;
  /** A leading space was typed before the character (`ys iw (` style). */
  extraSpace?: boolean;
};

export type SurroundOptions = { shiftWidth: number };

const PAIRS = "b()B{}r[]a<>";
const leadingBlanks = (s: string) => /^[ \t]*/.exec(s)![0];

function fixIndent(str: string, spc: string, sw: number): string {
  const tab = " ".repeat(sw);
  const s = str.replace(/\t/g, tab);
  const pad = spc.replace(/\t/g, tab);
  return s.replace(/(^|\n)(?=.)/g, `$1${pad}`);
}

/** `s:wrap()` for charwise (`v`) and linewise (`V`) text. */
export function surroundWrap(
  keeperIn: string,
  repl: SurroundReplacement,
  type: "v" | "V",
  removed: string,
  special: boolean,
  currentLine: string,
  options: SurroundOptions,
): string {
  let keeper = keeperIn;
  const newchar = repl.char;
  const extraspace = repl.extraSpace ? " " : "";
  let before = "";
  let after = "";
  const initspaces = type === "V" ? leadingBlanks(keeper) : leadingBlanks(currentLine);
  const idx = PAIRS.indexOf(newchar);
  if (newchar === " ") {
    // nothing
  } else if (newchar === "p") {
    before = "\n";
    after = "\n\n";
  } else if (newchar === "s") {
    before = " ";
  } else if (newchar === ":") {
    before = ":";
  } else if (surroundNeedsInput(newchar) === "tag") {
    const typed = repl.input ?? "";
    if (typed !== "") {
      const keepAttributes = !typed.endsWith(">");
      let tag = typed.replace(/>*$/, "");
      const attributes = keepAttributes
        ? (/<[^ \t\n]+([\s\S]*?)>/.exec(removed)?.[1] ?? "")
        : "";
      if (tag.endsWith("/")) {
        tag = tag.slice(0, -1);
        before = `<${tag}${attributes} />`;
      } else {
        before = `<${tag}${attributes}>`;
        after = `</${tag.replace(/ .*/s, "")}>`;
      }
      if (newchar === "\x14") {
        before += "\n\t";
        if (type === "v") after = `\n${after}`;
      }
    }
  } else if (surroundNeedsInput(newchar) === "function") {
    const fnc = repl.input ?? "";
    if (newchar === "\x06") {
      before = `(${fnc} `;
      after = ")";
    } else if (fnc !== "") {
      before = `${fnc.replace(/\($/, "")}(`;
      after = ")";
      if (newchar === "F") {
        before += " ";
        after = ` ${after}`;
      }
    }
  } else if (idx >= 0) {
    const spc = idx % 3 === 1 ? " " : "";
    const base = Math.floor(idx / 3) * 3;
    before = PAIRS[base + 1] + spc;
    after = spc + PAIRS[base + 2];
  } else if (newchar === "\x1b" || newchar === "\x1d") {
    before = "{\n\t";
    after = "\n}";
  } else if (!/^\p{L}/u.test(newchar)) {
    before = newchar;
    after = newchar;
  }
  after = after.replace(/\n/g, `\n${initspaces}`);
  if (type === "V" || (special && type === "v")) {
    before = before.replace(/ +$/, "");
    after = after.replace(/^ +/, "");
    if (!after.startsWith("\n")) after = initspaces + after;
    if (!keeper.endsWith("\n") && !after.startsWith("\n")) keeper += "\n";
    else if (keeper.endsWith("\n") && after.startsWith("\n")) after = after.slice(1);
    if (!keeper.startsWith("\n") && !/\n[ \t]*$/.test(before)) {
      before += "\n";
      if (special) before += "\t";
    } else if (keeper.startsWith("\n") && /\n[ \t]*$/.test(before)) {
      keeper = keeper.slice(1);
    }
    if (type === "V" && /\n[ \t]*\n$/.test(keeper)) keeper = keeper.slice(0, -1);
  }
  if (type === "V") before = initspaces + before;
  if (/\n[ \t]*$/.test(before)) {
    if (type === "v") keeper = initspaces + keeper;
    const padding = /\n([ \t]+)$/.exec(before)?.[1] ?? "";
    before = before.replace(/\n[ \t]+$/, "\n");
    keeper = fixIndent(keeper, padding, options.shiftWidth);
  }
  if (type === "V") return before + keeper + after;
  return before + extraspace + keeper + extraspace + after;
}

export type SurroundEdit = { text: string; cursorAbs: number };

/** Replace `[startAbs, endAbs)` (or whole lines) and report the new text. */
function replaceLines(buf: VimBuffer, startLine: number, endLine: number, content: string): SurroundEdit {
  const lines = buf.lines.slice();
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  lines.splice(startLine, endLine - startLine + 1, ...body.split("\n"));
  const text = lines.join("\n");
  return { text, cursorAbs: new VimBuffer(text).abs({ line: startLine, col: 0 }) };
}

/**
 * `ys{motion}{char}` / `yss` / Visual `S` (`s:opfunc`). `span` is the operated
 * text; `fromVisual` marks Visual `S`, `lineCommand` marks `yss`.
 */
export function surroundAdd(
  text: string,
  span: { startAbs: number; endAbs: number; linewise: boolean; startLine: number; endLine: number },
  repl: SurroundReplacement,
  options: SurroundOptions & { fromVisual?: boolean; special?: boolean },
): SurroundEdit | null {
  const buf = new VimBuffer(text);
  if (span.linewise) {
    const lines = buf.lines.slice(span.startLine, span.endLine + 1);
    const keeper = `${lines.join("\n")}\n`;
    const wrapped = surroundWrap(keeper, repl, "V", "", options.special === true, "", options);
    return replaceLines(buf, span.startLine, span.endLine, wrapped);
  }
  if (span.endAbs <= span.startAbs) return null;
  let keeper = text.slice(span.startAbs, span.endAbs);
  let append = "";
  if (!options.fromVisual) {
    const m = /(?<![ \t\n])[ \t]*$/.exec(keeper);
    append = m ? m[0] : "";
    keeper = keeper.slice(0, keeper.length - append.length);
  }
  const startPos = buf.fromAbs(span.startAbs);
  const currentLine = buf.lines[startPos.line] ?? "";
  const wrapped = surroundWrap(keeper, repl, "v", "", options.special === true, currentLine, options) + append;
  return {
    text: text.slice(0, span.startAbs) + wrapped + text.slice(span.endAbs),
    cursorAbs: span.startAbs,
  };
}

/** The `yss` span: first non-blank through the last character, `count` lines. */
export function surroundLineSpan(
  text: string,
  cursorLine: number,
  count: number,
): { startAbs: number; endAbs: number; linewise: false; startLine: number; endLine: number } | null {
  const buf = new VimBuffer(text);
  const endLine = Math.min(buf.lineCount - 1, cursorLine + Math.max(1, count) - 1);
  const first = buf.lines[cursorLine] ?? "";
  const startCol = Math.min(leadingBlanks(first).length, first.length);
  const lastLen = buf.lineLength(endLine);
  if (lastLen === 0 || (endLine === cursorLine && startCol >= first.length)) return null;
  return {
    startAbs: buf.abs({ line: cursorLine, col: startCol }),
    endAbs: buf.abs({ line: endLine, col: lastLen }),
    linewise: false,
    startLine: cursorLine,
    endLine,
  };
}

/** `startAbs`: the cursor after the delete; `markAbs`: where the text was (Vim's `'[`). */
type Deleted = { text: string; removed: string; linewise: boolean; startAbs: number; markAbs: number };

function deleteSpan(text: string, span: OpSpan | null, linewiseRule = true): Deleted | null {
  if (!span) return null;
  const buf = new VimBuffer(text);
  const r = resolveOpSpan(buf, span);
  let linewise = r.linewise;
  let startLine = r.startLine;
  let endLine = r.endLine;
  if (!linewise && linewiseRule && deleteBecomesLinewise(buf, r.startAbs, r.endAbs)) {
    linewise = true;
    startLine = buf.fromAbs(r.startAbs).line;
    endLine = buf.fromAbs(r.endAbs).line;
  }
  if (linewise) {
    const lines = buf.lines.slice();
    const removedLines = lines.splice(startLine, endLine - startLine + 1);
    const next = lines.length > 0 ? lines : [""];
    const nextText = next.join("\n");
    const line = Math.min(startLine, next.length - 1);
    const nb = new VimBuffer(nextText);
    const col = leadingBlanks(next[line] ?? "").length;
    return {
      text: nextText,
      removed: `${removedLines.join("\n")}\n`,
      linewise: true,
      startAbs: nb.abs({ line, col: Math.min(col, Math.max(0, nb.lineLength(line) - 1)) }),
      markAbs: nb.abs({ line, col: 0 }),
    };
  }
  if (r.endAbs <= r.startAbs) {
    return { text, removed: "", linewise: false, startAbs: r.startAbs, markAbs: r.startAbs };
  }
  return {
    text: text.slice(0, r.startAbs) + text.slice(r.endAbs),
    removed: text.slice(r.startAbs, r.endAbs),
    linewise: false,
    startAbs: r.startAbs,
    markAbs: r.startAbs,
  };
}

/** Normal-mode cursor after an edit: never on the end-of-line position of a non-empty line. */
function clampNormal(text: string, abs: number): Pos {
  const buf = new VimBuffer(text);
  const pos = buf.fromAbs(abs);
  const len = buf.lineLength(pos.line);
  if (len > 0 && pos.col >= len) pos.col = len - 1;
  return pos;
}

const BRACKET_TARGETS: Record<string, [string, string]> = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  b: ["(", ")"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  B: ["{", "}"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "<": ["<", ">"],
  ">": ["<", ">"],
};

function innerObject(text: string, cursor: Pos, count: number, target: string): OpSpan | null {
  const buf = new VimBuffer(text);
  const pair = BRACKET_TARGETS[target];
  if (pair) return currentBlock(buf, cursor, count, false, pair[0], pair[1]);
  if (target === '"' || target === "'" || target === "`") {
    return currentQuote(buf, cursor, count, false, target);
  }
  if (target === "t") return currentTagBlock(buf, cursor, count, false);
  if (target === "s") return currentSentence(buf, cursor, count, false);
  if (target === "p") {
    const r = currentParagraph(buf, cursor.line, count, false);
    return r
      ? { start: { line: r.startLine, col: 0 }, end: { line: r.endLine, col: 0 }, inclusive: false, linewise: true }
      : null;
  }
  return null;
}

/** `normal! T{c}`, then `l` when on `{c}`, then `dt{c}`: the text between two `{c}`. */
function innerPunct(text: string, cursor: Pos, c: string): OpSpan | null {
  const buf = new VimBuffer(text);
  const line = buf.lines[cursor.line] ?? "";
  let col = cursor.col;
  const prev = line.lastIndexOf(c, col - 1);
  if (col > 0 && prev !== -1 && prev + 1 < col) col = prev + 1;
  if (line[col] === c) col++;
  const next = line.indexOf(c, col + 1);
  if (next === -1 || col >= line.length) return null;
  return {
    start: { line: cursor.line, col },
    end: { line: cursor.line, col: next },
    inclusive: false,
    linewise: false,
  };
}

/** `ds{target}` / `cs{target}{replacement}` (`s:dosurround`). Null: nothing changes. */
export function surroundChange(
  text: string,
  cursor: Pos,
  count: number,
  targetIn: string,
  repl: SurroundReplacement | null,
  options: SurroundOptions,
): SurroundEdit | null {
  let target = targetIn;
  let spc = false;
  if (target.startsWith(" ")) {
    target = target.slice(1);
    spc = true;
  }
  if (target === "a") target = ">";
  if (target === "r") target = "]";
  const isPunct = /^[\p{P}\p{S} \t]$/u.test(target) && !/[\][(){}<>"'`]/.test(target);
  if (target === "/") return null;

  // 1. Delete the inner text into "keeper".
  let inner: OpSpan | null;
  if (isPunct) inner = innerPunct(text, cursor, target);
  else if (target === "w" || target === "W") inner = innerWord(text, cursor, count, target === "W");
  else inner = innerObject(text, cursor, count, target);
  const first = deleteSpan(text, inner);
  if (!first || first.removed === "") return null;
  let keeper = first.removed;
  const keeperType: "v" | "V" = first.linewise ? "V" : "v";
  const afterFirst = first.text;
  const oldBuf = new VimBuffer(afterFirst);
  const cursorAbs = first.startAbs;
  const oldPos = clampNormal(afterFirst, cursorAbs);
  const oldline = oldBuf.lines[oldPos.line] ?? "";
  const oldlnum = oldPos.line;

  // 2. Delete the now-adjacent delimiters.
  let removed = "";
  let second: Deleted | null = null;
  const b1 = new VimBuffer(afterFirst);
  if (target === "p" || target === "s" || target === "w" || target === "W") {
    removed = "";
  } else if (target === '"' || target === "'" || target === "`") {
    // `i <Esc>d2i"`: the two quotes, with the inserted blank dropped again.
    const pos = clampNormal(afterFirst, cursorAbs);
    const at = b1.abs(pos);
    const withSpace = `${afterFirst.slice(0, at)} ${afterFirst.slice(at)}`;
    const span = currentQuote(new VimBuffer(withSpace), pos, 2, false, target);
    second = deleteSpan(withSpace, span, false);
    if (second) removed = second.removed.replace(" ", "");
  } else if (isPunct) {
    const pos = clampNormal(afterFirst, cursorAbs);
    const line = b1.lines[pos.line] ?? "";
    const open = line.lastIndexOf(target, pos.col - 1);
    const close = open === -1 ? -1 : line.indexOf(target, open + 1);
    if (open !== -1 && close !== -1) {
      const span: OpSpan = {
        start: { line: pos.line, col: open },
        end: { line: pos.line, col: close },
        inclusive: true,
        linewise: false,
      };
      second = deleteSpan(afterFirst, span, false);
      if (second) removed = second.removed;
    }
  } else {
    // One character back, then `da{target}`.
    const pos = clampNormal(afterFirst, cursorAbs);
    const back = { ...pos };
    b1.dec(back);
    if (b1.charAt(back) === "" && back.col > 0) back.col--;
    const pair = BRACKET_TARGETS[target];
    let span: OpSpan | null = null;
    if (pair) span = currentBlock(b1, back, 1, true, pair[0], pair[1]);
    else if (target === "t") span = currentTagBlock(b1, back, 1, true);
    second = deleteSpan(afterFirst, span, false);
    if (second) removed = second.removed;
  }

  const deleted = second && second.removed !== "" ? second : null;
  const working = deleted ? deleted.text : afterFirst;
  const markAbs = deleted ? deleted.markAbs : first.markAbs;
  const afterCursor = deleted ? deleted.startAbs : first.startAbs;
  const regtype: "v" | "V" = deleted
    ? deleted.linewise ? "V" : "v"
    : target === "p"
      ? "V"
      : target === "s" || target === "w" || target === "W"
        ? "v"
        : keeperType;
  const rem2 = removed.replace(/\n[\s\S]*/, "");
  const oldhead = oldline.slice(0, Math.max(0, oldline.length - rem2.length));

  if (/^[[({<T]$/.test(target) || spc) {
    keeper = keeper.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
  }

  const wb = new VimBuffer(working);
  const markPos = wb.fromAbs(Math.min(markAbs, working.length));
  const atLineEnd = markPos.col >= wb.lineLength(markPos.line);
  let putAfter = false;
  if (atLineEnd) {
    if (/^[ \t]*$/.test(oldhead) && !repl) {
      keeper = keeper.replace(
        new RegExp(`^\\n${escapeRegExp(oldhead)}([ \\t]*[\\s\\S]*?)\\n[ \\t]*$`),
        "$1",
      );
    }
    putAfter = true;
  }
  const cursorPos = clampNormal(working, afterCursor);
  if (cursorPos.line + 1 < oldlnum && regtype === "V") putAfter = true;
  if (repl) {
    keeper = surroundWrap(keeper, repl, regtype, removed, false, wb.lines[cursorPos.line] ?? "", options);
  }

  let result: string;
  let putLine: number;
  let resultCursor: number;
  if (regtype === "V") {
    const lines = wb.lines.slice();
    const body = keeper.endsWith("\n") ? keeper.slice(0, -1) : keeper;
    putLine = putAfter ? cursorPos.line + 1 : cursorPos.line;
    lines.splice(putLine, 0, ...body.split("\n"));
    result = lines.join("\n");
    resultCursor = new VimBuffer(result).abs({ line: putLine, col: 0 });
  } else {
    // `p` after a cursor clamped onto the last character, or `P` at the
    // deletion point: either way the text goes where the deletion was.
    const putAbs = Math.min(markAbs, working.length);
    result = working.slice(0, putAbs) + keeper + working.slice(putAbs);
    resultCursor = putAbs;
    putLine = new VimBuffer(result).fromAbs(putAbs).line;
  }
  const rb = new VimBuffer(result);
  if (/^[ \t]+$/.test(rb.lines[putLine] ?? "") && /^[ \t]*\n/.test(keeper)) {
    const ls = rb.lines.slice();
    ls[putLine] = "";
    result = ls.join("\n");
    resultCursor = new VimBuffer(result).abs({ line: putLine, col: 0 });
  }
  return { text: result, cursorAbs: resultCursor };
}

function innerWord(text: string, cursor: Pos, count: number, bigword: boolean): OpSpan | null {
  const buf = new VimBuffer(text);
  const line = buf.lines[cursor.line] ?? "";
  const lineStart = buf.abs({ line: cursor.line, col: 0 });
  const r = resolveWordTextObjectRange(line, lineStart, cursor.col, "i", count, bigword ? "WORD" : "word");
  if (!r) return null;
  return { start: buf.fromAbs(r.startAbs), end: buf.fromAbs(r.endAbs), inclusive: false, linewise: false };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
