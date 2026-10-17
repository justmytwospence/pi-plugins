// Copy mode's text engine: plain-text search (vim smartcase, regex with a literal fallback),
// word motions, copycat-style presets, thumbs-style hints and quoting. Pure functions over
// plain (ANSI-stripped) lines so they can be tested without a terminal.

export interface Pos {
  row: number;
  col: number;
}

export interface Match {
  row: number;
  start: number;
  end: number;
}

export interface Pattern {
  source: string;
  regex: RegExp;
  /** The query was not a valid regular expression and is matched literally. */
  literal: boolean;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile a search like vim with `smartcase`: case-insensitive unless the query has a capital.
 * `\c` forces insensitive, `\C` sensitive. Invalid regular expressions match literally.
 */
export function compile(query: string): Pattern | undefined {
  let source = query;
  let flags: "i" | "" | undefined;
  if (/\\c/.test(source)) { flags = "i"; source = source.replace(/\\c/g, ""); }
  if (/\\C/.test(source)) { flags = ""; source = source.replace(/\\C/g, ""); }
  if (!source) return undefined;
  const ignoreCase = flags ?? (/[A-Z]/.test(source.replace(/\\[A-Za-z]/g, "")) ? "" : "i");
  try {
    // Empty matches are skipped by findAll.
    return { source, regex: new RegExp(source, `g${ignoreCase}`), literal: false };
  } catch {
    return { source, regex: new RegExp(escape(source), `g${ignoreCase}`), literal: true };
  }
}

/** Every non-empty match of a pattern, in reading order. */
export function findAll(lines: readonly string[], pattern: Pattern, filter?: (text: string) => boolean): Match[] {
  const out: Match[] = [];
  lines.forEach((line, row) => {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    for (let m = regex.exec(line); m; m = regex.exec(line)) {
      if (!m[0]) { regex.lastIndex++; continue; }
      if (!filter || filter(m[0])) out.push({ row, start: m.index, end: m.index + m[0].length });
    }
  });
  return out;
}

const before = (a: Pos, b: Pos) => a.row < b.row || (a.row === b.row && a.col < b.col);

/** The next match after (forward) or before (backward) a position, wrapping around. */
export function nextMatch(matches: readonly Match[], from: Pos, forward: boolean): { index: number; wrapped: boolean } | undefined {
  if (!matches.length) return undefined;
  if (forward) {
    const i = matches.findIndex((m) => before(from, { row: m.row, col: m.start }));
    return i >= 0 ? { index: i, wrapped: false } : { index: 0, wrapped: true };
  }
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    if (before({ row: m.row, col: m.start }, from)) return { index: i, wrapped: false };
  }
  return { index: matches.length - 1, wrapped: true };
}

// --- Word motions -------------------------------------------------------------------------

type Cls = 0 | 1 | 2; // space, punctuation, word
const cls = (ch: string | undefined, big: boolean): Cls => (ch === undefined || /\s/.test(ch) ? 0 : big || /\w/.test(ch) ? 2 : 1);

/** Characters of the text as positions, with a virtual space at each line end so motions cross lines. */
function charAt(lines: readonly string[], p: Pos): string | undefined {
  const line = lines[p.row];
  if (line === undefined) return undefined;
  return p.col < line.length ? line[p.col] : " ";
}
function step(lines: readonly string[], p: Pos, dir: 1 | -1): Pos | undefined {
  if (dir === 1) {
    if (p.col < (lines[p.row]?.length ?? 0)) return { row: p.row, col: p.col + 1 };
    return p.row + 1 < lines.length ? { row: p.row + 1, col: 0 } : undefined;
  }
  if (p.col > 0) return { row: p.row, col: p.col - 1 };
  return p.row > 0 ? { row: p.row - 1, col: lines[p.row - 1]!.length } : undefined;
}
const clampCol = (lines: readonly string[], p: Pos): Pos => ({ row: p.row, col: Math.max(0, Math.min(p.col, Math.max(0, (lines[p.row]?.length ?? 1) - 1))) });

/** vim `w` / `W`: start of the next word. */
export function wordForward(lines: readonly string[], p: Pos, big = false): Pos {
  let cur: Pos | undefined = p;
  const start = cls(charAt(lines, p), big);
  while (cur && start !== 0 && cls(charAt(lines, cur), big) === start) cur = step(lines, cur, 1);
  while (cur && cls(charAt(lines, cur), big) === 0) cur = step(lines, cur, 1);
  return cur ? clampCol(lines, cur) : clampCol(lines, { row: lines.length - 1, col: Infinity });
}

/** vim `b` / `B`: start of the current or previous word. */
export function wordBackward(lines: readonly string[], p: Pos, big = false): Pos {
  let cur = step(lines, p, -1);
  while (cur && cls(charAt(lines, cur), big) === 0) cur = step(lines, cur, -1);
  if (!cur) return { row: 0, col: 0 };
  const c = cls(charAt(lines, cur), big);
  for (let prev = step(lines, cur, -1); prev && prev.row === cur.row && cls(charAt(lines, prev), big) === c; prev = step(lines, cur, -1)) cur = prev;
  return clampCol(lines, cur);
}

/** vim `e` / `E`: end of the current or next word. */
export function wordEnd(lines: readonly string[], p: Pos, big = false): Pos {
  let cur = step(lines, p, 1);
  while (cur && cls(charAt(lines, cur), big) === 0) cur = step(lines, cur, 1);
  if (!cur) return clampCol(lines, { row: lines.length - 1, col: Infinity });
  const c = cls(charAt(lines, cur), big);
  for (let next = step(lines, cur, 1); next && next.row === cur.row && cls(charAt(lines, next), big) === c; next = step(lines, cur, 1)) cur = next;
  return clampCol(lines, cur);
}

/** The word (letters, digits, `_`) under or after the cursor on its line, for `*` and `#`. */
export function wordAt(line: string, col: number): string | undefined {
  const re = /\w+/g;
  for (let m = re.exec(line); m; m = re.exec(line)) if (m.index + m[0].length > col) return m[0];
  return undefined;
}

export const firstNonBlank = (line: string) => Math.max(0, line.search(/\S/));

// --- Presets (copycat) and hints (thumbs) -------------------------------------------------

export type PresetName = "url" | "path" | "hash" | "error";

const URL_RE = String.raw`https?://[^\s<>"'\`)\]]+[^\s<>"'\`)\].,;:!?]`;
const PATH_RE = String.raw`(?:~|\.{1,2})?(?:/[\w.@+-]+)+/?(?::\d+(?::\d+)?)?|[\w.@+-]+(?:/[\w.@+-]+)+(?::\d+(?::\d+)?)?|\b[\w-]+\.[A-Za-z]{1,6}:\d+(?::\d+)?\b`;
const HASH_RE = String.raw`\b[0-9a-f]{7,40}\b`;
const ERROR_RE = String.raw`\S.*\b(?:error|errors|failed|failure|exception|traceback|panic|fatal|denied|cannot|not found)\b.*\S|\S.*\b(?:error|failed|exception|traceback|panic|fatal)\b`;

const isHash = (s: string) => /[a-f]/.test(s) && /\d/.test(s);
const isPath = (s: string) => !/^https?:/.test(s) && !/^\/+$/.test(s) && !/^\d+(\/\d+)+$/.test(s) && s.length > 2;

export const PRESETS: Record<PresetName, { label: string; pattern: Pattern; filter?: (s: string) => boolean }> = {
  url: { label: "URLs", pattern: { source: URL_RE, regex: new RegExp(URL_RE, "g"), literal: false } },
  path: { label: "paths", pattern: { source: PATH_RE, regex: new RegExp(PATH_RE, "g"), literal: false }, filter: isPath },
  hash: { label: "hashes", pattern: { source: HASH_RE, regex: new RegExp(HASH_RE, "g"), literal: false }, filter: isHash },
  error: { label: "errors", pattern: { source: ERROR_RE, regex: new RegExp(ERROR_RE, "gi"), literal: false } },
};

export interface Hint extends Match {
  text: string;
  label: string;
}

const HINT_KEYS = "asdfghjklqwertyuiopzxcvbnm";

/** Labels: single letters while they suffice, else two letters. Lowercase only (uppercase means insert). */
export function hintLabels(count: number): string[] {
  if (count <= HINT_KEYS.length) return [...HINT_KEYS.slice(0, count)];
  const out: string[] = [];
  for (const a of HINT_KEYS) for (const b of HINT_KEYS) { if (out.length < count) out.push(a + b); }
  return out;
}

/** Things worth copying on the given rows: URLs, paths, hashes and quoted strings, deduplicated by text. */
export function findHints(lines: readonly string[], fromRow: number, toRow: number): Hint[] {
  const rows = lines.slice(fromRow, toRow);
  const quoted: Pattern = { source: "", regex: /"[^"\n]{2,200}"|`[^`\n]{2,200}`|'[^'\n]{3,200}'/g, literal: false };
  const found: Match[] = [
    ...findAll(rows, PRESETS.url.pattern),
    ...findAll(rows, PRESETS.path.pattern, isPath),
    ...findAll(rows, PRESETS.hash.pattern, isHash),
    ...findAll(rows, quoted).map((m) => ({ ...m, start: m.start + 1, end: m.end - 1 })),
  ].map((m) => ({ ...m, row: m.row + fromRow }));
  // Earlier position first; drop matches inside a longer one already taken.
  found.sort((a, b) => a.row - b.row || a.start - b.start || b.end - a.end);
  const kept: Match[] = [];
  for (const m of found) if (!kept.some((k) => k.row === m.row && m.start < k.end && k.start < m.end)) kept.push(m);
  const seen = new Map<string, Match>();
  for (const m of kept) {
    const text = lines[m.row]!.slice(m.start, m.end);
    if (!seen.has(text)) seen.set(text, m);
  }
  const unique = [...seen.entries()];
  const labels = hintLabels(unique.length);
  return unique.map(([text, m], i) => ({ ...m, text, label: labels[i]! }));
}

/** Text as a Markdown quote for the prompt. */
export function quote(text: string): string {
  return `${text.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
}

/** Text between two positions (inclusive), line-wise or character-wise, with trailing spaces trimmed per line. */
export function extract(lines: readonly string[], a: Pos, b: Pos, linewise: boolean): string {
  const [s, e] = before(b, a) ? [b, a] : [a, b];
  const out: string[] = [];
  for (let row = s.row; row <= e.row; row++) {
    const line = lines[row] ?? "";
    if (linewise) out.push(line);
    else out.push(line.slice(row === s.row ? s.col : 0, row === e.row ? e.col + 1 : undefined));
  }
  const trimmed = out.map((l) => l.replace(/\s+$/u, ""));
  // Whole lines lose the indentation they share (Pi pads the transcript by a column).
  if (linewise) {
    const indent = Math.min(...trimmed.filter((l) => l).map((l) => l.length - l.trimStart().length));
    if (Number.isFinite(indent) && indent > 0) for (let i = 0; i < trimmed.length; i++) trimmed[i] = trimmed[i]!.slice(indent);
  }
  return trimmed.join("\n").replace(/^\n+|\n+$/g, "");
}
