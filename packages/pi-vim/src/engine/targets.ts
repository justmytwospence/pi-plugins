/**
 * A port of targets.vim (wellle/targets.vim, MIT) text objects: pair, quote,
 * separator, argument and tag targets with the `i`/`a`/`I`/`A` modifiers,
 * `n`/`l` (next/last) and seeking by targets.vim's default `seekRanges`.
 * The prompt is always fully visible, so off-screen range types never occur.
 */

import { currentBlock, currentTagBlock, findMatchingBracket, FORWARD } from "./vim-objects.js";
import {
  anyOf,
  charPattern,
  comparePos,
  literalPattern,
  NON_BLANK,
  NON_BLANK_OR_EOL,
  type Pos,
  type PosPattern,
  samePos,
  type SearchFlags,
  VimBuffer,
} from "./vim-pos.js";

export type TargetsModifier = "i" | "a" | "I" | "A";
export type TargetsWhich = "c" | "n" | "l";

export type TargetsResult = {
  start: Pos;
  /** Inclusive end. */
  end: Pos;
  linewise: boolean;
  /** Nothing between the delimiters (only `c`/`d` act, at `start`). */
  empty: boolean;
};

type Target = {
  sl: number;
  sc: number;
  el: number;
  ec: number;
  linewise: boolean;
  error: string | null;
  gen?: Generator;
};

const invalid = (error: string): Target => ({ sl: 0, sc: 0, el: 0, ec: 0, linewise: false, error });
const fromValues = (s: Pos | null, e: Pos | null): Target =>
  s && e
    ? { sl: s.line, sc: s.col, el: e.line, ec: e.col, linewise: false, error: null }
    : invalid("zero found");

type State = "invalid" | "empty" | "nonempty";
function stateOf(t: Target): State {
  if (t.error !== null) return "invalid";
  if (t.sl < t.el) return "nonempty";
  if (t.sl > t.el) return "invalid";
  if (t.sc === t.ec + 1) return "empty";
  if (t.sc > t.ec) return "invalid";
  return "nonempty";
}

/** Mutable cursor plus the buffer, standing in for Vim's window state. */
class Ctx {
  cursor: Pos;
  constructor(
    readonly buf: VimBuffer,
    cursor: Pos,
  ) {
    this.cursor = { ...cursor };
  }
  /** `searchpos()`/`search()` without `n`: moves the cursor on success. */
  search(pattern: PosPattern, flags: SearchFlags & { noMove?: boolean } = {}): Pos | null {
    const found = this.buf.search(pattern, this.cursor, flags);
    if (found && !flags.noMove) this.cursor = { ...found };
    return found;
  }
  /** `targets#util#search`: repeat a search; true on failure. */
  searchN(pattern: PosPattern, flags: SearchFlags, count = 1): boolean {
    for (let i = 0; i < count; i++) if (!this.search(pattern, flags)) return true;
    return false;
  }
  charAt(pos: Pos = this.cursor): string {
    return this.buf.charAt(pos);
  }
}

const posS = (t: Target): Pos => ({ line: t.sl, col: t.sc });
const posE = (t: Target): Pos => ({ line: t.el, col: t.ec });
const setS = (t: Target, p: Pos | null) => {
  if (p) {
    t.sl = p.line;
    t.sc = p.col;
  } else t.error = t.error ?? "zero found";
};
const setE = (t: Target, p: Pos | null) => {
  if (p) {
    t.el = p.line;
    t.ec = p.col;
  } else t.error = t.error ?? "zero found";
};

// --- modifiers -------------------------------------------------------------

type ModArgs = { separator?: PosPattern };
type ModFunc = (ctx: Ctx, t: Target, args: ModArgs) => void;

const keep: ModFunc = () => {};

const drop: ModFunc = (ctx, t) => {
  if (stateOf(t) === "invalid") return;
  const buf = ctx.buf;
  let sLinewise = false;
  let eLinewise = false;
  ctx.cursor = posS(t);
  if (!buf.search(NON_BLANK, ctx.cursor, { stopline: ctx.cursor.line })) sLinewise = true;
  ctx.cursor = buf.spaceRight(ctx.cursor);
  setS(t, ctx.cursor);

  ctx.cursor = posE(t);
  if (t.sl < t.el && !buf.search(NON_BLANK, ctx.cursor, { backward: true, stopline: ctx.cursor.line })) {
    eLinewise = true;
    const above = Math.max(0, ctx.cursor.line - 1);
    ctx.cursor = buf.lineEndChar(above);
  } else {
    ctx.cursor = buf.backspaceLeft(ctx.cursor);
  }
  setE(t, ctx.cursor);
  t.linewise = sLinewise && eLinewise;
};

const dropr: ModFunc = (ctx, t) => {
  ctx.cursor = ctx.buf.backspaceLeft(posE(t));
  setE(t, ctx.cursor);
};

const shrink: ModFunc = (ctx, t, args) => {
  if (stateOf(t) === "invalid") return;
  ctx.cursor = posE(t);
  setE(t, ctx.search(NON_BLANK, { backward: true, stopline: t.sl }));
  if (stateOf(t) !== "nonempty") {
    drop(ctx, t, args);
    return;
  }
  ctx.cursor = posS(t);
  setS(t, ctx.search(NON_BLANK, { stopline: t.el }));
};

function expand(ctx: Ctx, t: Target, direction?: "<" | ">"): void {
  const buf = ctx.buf;
  if (!direction || direction === ">") {
    ctx.cursor = posE(t);
    const found = ctx.search(NON_BLANK_OR_EOL, { stopline: ctx.cursor.line });
    if (found && found.col - 1 > t.ec) {
      setE(t, { line: found.line, col: found.col - 1 });
      return;
    }
  }
  if (!direction || direction === "<") {
    ctx.cursor = posS(t);
    const found = ctx.search(NON_BLANK, { backward: true, stopline: ctx.cursor.line });
    if (found) {
      setS(t, { line: found.line, col: found.col + 1 });
      return;
    }
    t.sc = 0;
  }
  void buf;
}

const expandMod: ModFunc = (ctx, t) => expand(ctx, t);

const expands: ModFunc = (ctx, t) => {
  ctx.cursor = posE(t);
  const e = ctx.search(NON_BLANK_OR_EOL, { stopline: ctx.cursor.line });
  if (e && e.col - 1 > t.ec) {
    ctx.cursor = posS(t);
    const s = ctx.search(NON_BLANK, { backward: true, stopline: ctx.cursor.line });
    if (s && s.col + 1 < t.sc) setE(t, { line: e.line, col: e.col - 1 });
  }
};

const dropa: ModFunc = (ctx, t, args) => {
  const sep = args.separator!;
  const startOpening = !sep(ctx.buf, posS(t));
  const endOpening = !sep(ctx.buf, posE(t));
  if (startOpening) {
    if (endOpening) {
      drop(ctx, t, args);
      return;
    }
    ctx.cursor = posS(t);
    setS(t, ctx.search(NON_BLANK, { stopline: t.el }));
    expand(ctx, t, ">");
    return;
  }
  if (!endOpening) {
    dropr(ctx, t, args);
    return;
  }
  ctx.cursor = posE(t);
  setE(t, ctx.search(NON_BLANK, { backward: true, stopline: t.sl }));
  expand(ctx, t, "<");
};

const innert: ModFunc = (ctx, t) => {
  ctx.cursor = posS(t);
  setS(t, ctx.search(literalPattern(">")));
  ctx.cursor = posE(t);
  setE(t, ctx.search(literalPattern("<"), { backward: true }));
};

// --- sources ---------------------------------------------------------------

type GenOpts = { first: boolean };
type GenState = { rate?: number };
type GenFunc = (ctx: Ctx, opts: GenOpts, state: GenState) => Target;

type Source = {
  gens: Record<TargetsWhich, GenFunc>;
  mods: Record<TargetsModifier, ModFunc[]>;
  modArgs: ModArgs;
};

function selectBlockAround(ctx: Ctx, count: number, open: string, close: string): Target {
  const span = currentBlock(ctx.buf, ctx.cursor, count, true, open, close);
  if (!span || samePos(span.start, span.end)) return invalid("pair select");
  return fromValues(span.start, span.end);
}

function selectTagAround(ctx: Ctx, count: number): Target {
  const span = currentTagBlock(ctx.buf, ctx.cursor, count, true);
  if (!span || samePos(span.start, span.end)) return invalid("pair select");
  return fromValues(span.start, span.end);
}

function pairSource(open: string, close: string, tag = false): Source {
  const select = (ctx: Ctx, count: number) =>
    tag ? selectTagAround(ctx, count) : selectBlockAround(ctx, count, open, close);
  const opening: PosPattern = tag
    ? (buf, pos) => buf.charAt(pos) === "<" && /[A-Za-z]/.test(buf.charAt({ line: pos.line, col: pos.col + 1 }))
    : literalPattern(open);
  const closing: PosPattern = tag
    ? (buf, pos) =>
        /[A-Za-z]/.test(buf.charAt(pos)) &&
        pos.col >= 2 &&
        (buf.lines[pos.line] ?? "").slice(pos.col - 2, pos.col) === "</"
    : literalPattern(close);
  return {
    gens: {
      c: (ctx, opts) => {
        const target = select(ctx, opts.first ? 1 : 2);
        if (target.error === null) ctx.cursor = posE(target);
        return target;
      },
      n: (ctx) => {
        if (ctx.searchN(opening, {})) return invalid("no target");
        const old = { ...ctx.cursor };
        const target = select(ctx, 1);
        ctx.cursor = old;
        return target;
      },
      l: (ctx) => {
        if (ctx.searchN(closing, { backward: true })) return invalid("no target");
        const old = { ...ctx.cursor };
        const target = select(ctx, 1);
        ctx.cursor = old;
        return target;
      },
    },
    mods: tag
      ? { i: [innert, drop], a: [keep], I: [innert, shrink], A: [expandMod] }
      : { i: [drop], a: [keep], I: [shrink], A: [expandMod] },
    modArgs: {},
  };
}

/** `targets#util#select`: delimiters around the cursor (multi-line, no seeking). */
function selectDelims(ctx: Ctx, opening: PosPattern, closing: PosPattern, dir: ">" | "<" | ""): Target {
  if (dir === "") return invalid("select without direction");
  if (dir === ">") {
    const s = ctx.search(opening, { backward: true, acceptCursor: true });
    const e = ctx.search(closing, {});
    return fromValues(s, e);
  }
  const e = ctx.search(closing, { acceptCursor: true });
  const s = ctx.search(opening, { backward: true });
  return fromValues(s, e);
}

type QuoteArgs = [dir: ">" | "<" | "", rate: number, skipL: number, skipR: number];
const QUOTE_ARGS: Record<string, QuoteArgs> = {
  r1n: [">", 1, 0, 0],
  r1l: [">", 1, 1, 0],
  r2n: [">", 2, 0, 0],
  r2l: [">", 2, 1, 0],
  r2b: [">", 2, 1, 1],
  l2r: ["<", 2, 0, 1],
  n2b: ["", 2, 1, 1],
};
const QUOTE_DIRS: Record<string, string[]> = {
  r1n: ["001", "201", "100", "102"],
  r1l: ["010", "012", "111", "210", "212"],
  r2n: ["101"],
  r2l: ["011", "211"],
  r2b: ["000"],
  l2r: ["110", "112"],
  n2b: ["002", "200", "202"],
};
const QUOTE_TABLE = new Map<string, QuoteArgs>();
for (const [key, reps] of Object.entries(QUOTE_DIRS)) {
  for (const rep of reps) QUOTE_TABLE.set(rep, QUOTE_ARGS[key]!);
}

function quoteDir(ctx: Ctx, delimiter: PosPattern, quote: string): QuoteArgs {
  const line = ctx.buf.lines[ctx.cursor.line] ?? "";
  const col = ctx.cursor.col;
  const count = (from: number, to: number) => {
    let n = 0;
    for (let c = from; c < to; c++) if (delimiter(ctx.buf, { line: ctx.cursor.line, col: c })) n++;
    return n;
  };
  const truncate = (n: number) => (n === 0 ? 0 : n % 2 === 0 ? 2 : 1);
  const lc = truncate(count(0, col));
  // Vim counts the cursor character on its own, without the escape lookbehind.
  const cc = line[col] === quote ? 1 : 0;
  const rc = truncate(count(col + 1, line.length));
  return QUOTE_TABLE.get(`${lc}${cc}${rc}`) ?? ["", 0, 0, 0];
}

function quoteSource(quote: string): Source {
  const delimiter = literalPattern(quote, true);
  return {
    gens: {
      c: (ctx, opts) => {
        if (!opts.first) return invalid("only one current quote");
        const [dir] = quoteDir(ctx, delimiter, quote);
        return selectDelims(ctx, delimiter, delimiter, dir);
      },
      n: (ctx, _opts, state) => {
        let cnt: number;
        if (state.rate === undefined) {
          const [, rate, , skipR] = quoteDir(ctx, delimiter, quote);
          state.rate = rate;
          cnt = rate - skipR;
        } else {
          cnt = state.rate;
        }
        if (ctx.searchN(delimiter, {}, cnt)) return invalid("QN");
        const target = selectDelims(ctx, delimiter, delimiter, ">");
        if (target.error === null) ctx.cursor = posS(target);
        return target;
      },
      l: (ctx, _opts, state) => {
        let cnt: number;
        if (state.rate === undefined) {
          const [, rate, skipL] = quoteDir(ctx, delimiter, quote);
          state.rate = rate;
          cnt = rate - skipL;
        } else {
          cnt = state.rate;
        }
        if (ctx.searchN(delimiter, { backward: true }, cnt)) return invalid("QL");
        const target = selectDelims(ctx, delimiter, delimiter, "<");
        if (target.error === null) ctx.cursor = posE(target);
        return target;
      },
    },
    mods: { i: [drop], a: [keep], I: [shrink], A: [expandMod] },
    modArgs: {},
  };
}

function separatorSource(sep: string): Source {
  const delimiter = literalPattern(sep);
  return {
    gens: {
      c: (ctx, opts) => {
        if (!opts.first) return invalid("only one current separator");
        return selectDelims(ctx, delimiter, delimiter, ">");
      },
      n: (ctx) => {
        if (ctx.searchN(delimiter, {})) return invalid("no target");
        const old = { ...ctx.cursor };
        const target = selectDelims(ctx, delimiter, delimiter, ">");
        ctx.cursor = old;
        return target;
      },
      l: (ctx, opts) => {
        if (ctx.searchN(delimiter, { backward: true, acceptCursor: opts.first })) return invalid("no target");
        const old = { ...ctx.cursor };
        const target = selectDelims(ctx, delimiter, delimiter, "<");
        ctx.cursor = old;
        return target;
      },
    },
    mods: { i: [drop], a: [dropr], I: [shrink], A: [expands] },
    modArgs: {},
  };
}

// --- argument source ---------------------------------------------------------

const ARG_OPEN = charPattern((c) => c === "(" || c === "[");
const ARG_CLOSE = charPattern((c) => c === ")" || c === "]");
const ARG_SEP = literalPattern(",");
const ARG_ALL = anyOf(ARG_OPEN, ARG_CLOSE, ARG_SEP);
const ARG_OUTER = anyOf(ARG_OPEN, ARG_CLOSE);

const PARTNER: Record<string, [string, number]> = {
  "(": [")", FORWARD],
  "[": ["]", FORWARD],
  ")": ["(", -1],
  "]": ["[", -1],
};

/** Normal-mode `%` on a bracket. */
function jumpPercent(ctx: Ctx): void {
  const c = ctx.charAt();
  const partner = PARTNER[c];
  if (!partner) return;
  const found = findMatchingBracket(ctx.buf, ctx.cursor, partner[0], c, partner[1] as 1 | -1);
  if (found) ctx.cursor = found;
}

function findArgBoundary(
  ctx: Ctx,
  flags1: SearchFlags,
  flags2: SearchFlags,
  skip: PosPattern,
  finish: PosPattern,
  all: PosPattern,
  separator: PosPattern | null,
): Pos | null {
  let tl: Pos | null = null;
  let r = ctx.search(all, flags1);
  for (;;) {
    if (!r) return null;
    if (separator && separator(ctx.buf, ctx.cursor)) {
      if (!tl) tl = { ...r };
    } else if (finish(ctx.buf, ctx.cursor)) {
      if (tl) return tl;
      break;
    } else if (skip(ctx.buf, ctx.cursor)) {
      jumpPercent(ctx);
    } else {
      return null;
    }
    r = ctx.search(all, flags2);
  }
  return r;
}

const W: SearchFlags = {};
const CW: SearchFlags = { acceptCursor: true };
const BW: SearchFlags = { backward: true };
const BCW: SearchFlags = { backward: true, acceptCursor: true };

function findArg(
  ctx: Ctx,
  direction: "^" | ">" | "<",
  flags1: SearchFlags,
  flags2: SearchFlags,
  flags3: SearchFlags,
  opening: PosPattern,
  closing: PosPattern,
): [Pos, Pos] | null {
  const oldpos = { ...ctx.cursor };
  let end: Pos;
  if (closing(ctx.buf, oldpos) && direction !== "^") {
    end = oldpos;
  } else {
    const e = findArgBoundary(ctx, flags1, flags1, opening, closing, ARG_ALL, ARG_SEP);
    if (!e) return null;
    end = e;
    if (opening(ctx.buf, oldpos) || ARG_SEP(ctx.buf, oldpos)) return [oldpos, end];
    ctx.cursor = oldpos;
  }
  const s = findArgBoundary(ctx, flags2, flags3, closing, opening, ARG_ALL, ARG_SEP);
  if (!s) return null;
  return [s, end];
}

function selectArg(ctx: Ctx, direction: "^" | ">" | "<"): Target {
  const oldpos = { ...ctx.cursor };
  let result: [Pos, Pos] | null;
  if (direction === "^") {
    result = ARG_CLOSE(ctx.buf, ctx.cursor)
      ? findArg(ctx, direction, CW, BW, BW, ARG_OPEN, ARG_CLOSE)
      : findArg(ctx, direction, W, BCW, BW, ARG_OPEN, ARG_CLOSE);
  } else if (direction === ">") {
    result = findArg(ctx, direction, W, BW, BW, ARG_OPEN, ARG_CLOSE);
  } else {
    const r = findArg(ctx, direction, BW, W, W, ARG_CLOSE, ARG_OPEN);
    result = r ? [r[1], r[0]] : null;
  }
  if (!result) {
    ctx.cursor = oldpos;
    return invalid("argument select");
  }
  return fromValues(result[0], result[1]);
}

function argumentSource(): Source {
  return {
    gens: {
      c: (ctx, opts) => {
        let target: Target;
        if (opts.first) {
          target = selectArg(ctx, "^");
        } else {
          if (!findArgBoundary(ctx, CW, CW, ARG_OPEN, ARG_CLOSE, ARG_OUTER, null)) return invalid("AC 1");
          ctx.cursor = ctx.buf.spaceRight(ctx.cursor);
          target = selectArg(ctx, "<");
        }
        if (target.error === null) ctx.cursor = posE(target);
        return target;
      },
      n: (ctx) => {
        let pattern = anyOf(ARG_OPEN, ARG_SEP);
        for (;;) {
          if (ctx.searchN(pattern, {})) return invalid("no target");
          const old = { ...ctx.cursor };
          const target = selectArg(ctx, ">");
          ctx.cursor = old;
          if (stateOf(target) !== "invalid") return target;
          pattern = ARG_OPEN;
        }
      },
      l: (ctx) => {
        let pattern = anyOf(ARG_CLOSE, ARG_SEP);
        for (;;) {
          if (ctx.searchN(pattern, { backward: true })) return invalid("no target");
          const old = { ...ctx.cursor };
          const target = selectArg(ctx, "<");
          ctx.cursor = old;
          if (stateOf(target) !== "invalid") return target;
          pattern = ARG_CLOSE;
        }
      },
    },
    mods: { i: [drop], a: [dropa], I: [shrink], A: [expandMod] },
    modArgs: { separator: ARG_SEP },
  };
}

// --- triggers ----------------------------------------------------------------

const PAIRS: Record<string, [string, string]> = {
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
export const TARGETS_SEPARATORS = ",.;:+-=~_*#/|\\&$";

/** True when `trigger` names a targets.vim text object. */
export function isTargetsTrigger(trigger: string): boolean {
  return (
    trigger.length === 1 &&
    (trigger in PAIRS ||
      trigger === "t" ||
      trigger === "q" ||
      trigger === "a" ||
      trigger === '"' ||
      trigger === "'" ||
      trigger === "`" ||
      TARGETS_SEPARATORS.includes(trigger))
  );
}

function sourcesFor(trigger: string): Source[] {
  if (trigger === "b") {
    return [pairSource("(", ")"), pairSource("[", "]"), pairSource("{", "}")];
  }
  if (trigger === "q") return [quoteSource("'"), quoteSource('"'), quoteSource("`")];
  const pair = PAIRS[trigger];
  if (pair) return [pairSource(pair[0], pair[1])];
  if (trigger === "t") return [pairSource("<", ">", true)];
  if (trigger === "a") return [argumentSource()];
  if (trigger === '"' || trigger === "'" || trigger === "`") return [quoteSource(trigger)];
  if (TARGETS_SEPARATORS.includes(trigger)) return [separatorSource(trigger)];
  return [];
}

// --- generators and seeking ---------------------------------------------------

class Generator {
  oldpos: Pos;
  readonly state: GenState = {};
  current: Target = invalid("no target");
  constructor(
    readonly buf: VimBuffer,
    readonly source: Source,
    readonly which: TargetsWhich,
    oldpos: Pos,
  ) {
    this.oldpos = { ...oldpos };
  }
  next(first: boolean): Target {
    const ctx = new Ctx(this.buf, this.oldpos);
    const target = this.source.gens[this.which](ctx, { first }, this.state);
    target.gen = this;
    this.current = target;
    this.oldpos = { ...ctx.cursor };
    return target;
  }
}

const SEEK_RANGES = "cc cr cb cB lc ac Ac lr rr ll lb ar ab lB Ar aB Ab AB rb al rB Al bb aa bB Aa BB AA".split(" ");
const RANGE_SCORE = new Map(SEEK_RANGES.map((range, i) => [range, SEEK_RANGES.length - i]));

function position(p: Pos, cursor: Pos): [string, number, number] {
  if (p.line === cursor.line) {
    if (p.col === cursor.col) return ["c", 0, 0];
    if (p.col < cursor.col) return ["l", 0, cursor.col - p.col];
    return ["r", 0, p.col - cursor.col];
  }
  if (p.line < cursor.line) return ["a", cursor.line - p.line, -(p.col + 1)];
  return ["b", p.line - cursor.line, p.col + 1];
}

function rangeOf(t: Target, cursor: Pos): [string, number, number] {
  if (t.error !== null) return ["", Infinity, Infinity];
  const [ps, ls, cs] = position(posS(t), cursor);
  const [pe, le, ce] = position(posE(t), cursor);
  return [ps + pe, Math.min(ls, le), Math.min(cs, ce)];
}

function bestTarget(targets: Target[], cursor: Pos): [Target, number] {
  if (targets.length === 1) return [targets[0]!, 0];
  let bestScore = 0;
  let minLines = Infinity;
  let minChars = Infinity;
  let best: [Target, number] | null = null;
  targets.forEach((target, idx) => {
    const [range, lines, chars] = rangeOf(target, cursor);
    const score = RANGE_SCORE.get(range) ?? -1;
    if (
      score > bestScore ||
      (score === bestScore && lines < minLines) ||
      (score === bestScore && lines === minLines && chars < minChars)
    ) {
      bestScore = score;
      minLines = lines;
      minChars = chars;
      best = [target, idx];
    }
  });
  return best ?? [invalid("multigen"), -1];
}

function findRawTarget(buf: VimBuffer, cursor: Pos, trigger: string, which: TargetsWhich, count: number): Target {
  const sources = sourcesFor(trigger);
  if (sources.length === 0) return invalid("failed to find delimiter");
  const whichs: TargetsWhich[] = which === "c" ? (count === 1 ? ["c", "n", "l"] : ["c"]) : [which];
  const gens: Generator[] = [];
  for (const source of sources) for (const w of whichs) gens.push(new Generator(buf, source, w, cursor));

  let current: Target | null = null;
  for (let i = 1; i <= count; i++) {
    const first = i === 1;
    if (first) for (const gen of gens) gen.next(true);
    else current?.gen?.next(false);
    const targets = gens.map((gen) => gen.current);
    const [target] = bestTarget(targets, cursor);
    if (target.error !== null) return target;
    current = target;
  }
  return current ?? invalid("no target");
}

/**
 * Resolve a targets.vim text object (`{modifier}{which?}{trigger}`) at
 * `cursor`. Returns null when targets.vim would abort.
 */
export function resolveTargetsObject(
  text: string,
  cursor: Pos,
  modifier: TargetsModifier,
  which: TargetsWhich,
  trigger: string,
  count: number,
): TargetsResult | null {
  const buf = new VimBuffer(text);
  const raw = findRawTarget(buf, cursor, trigger, which, Math.max(1, count));
  if (stateOf(raw) === "invalid" || !raw.gen) return null;
  const target: Target = { ...raw };
  const source = raw.gen.source;
  const ctx = new Ctx(buf, cursor);
  for (const mod of source.mods[modifier]) mod(ctx, target, source.modArgs);
  const state = stateOf(target);
  if (state === "invalid") return null;
  if (state === "empty") {
    const start = posS(target);
    return { start, end: start, linewise: false, empty: true };
  }
  if (comparePos(posS(target), posE(target)) > 0) return null;
  return { start: posS(target), end: posE(target), linewise: target.linewise, empty: false };
}
