// Headings a cell renders through mo.md(...), read from its source code.
//
// marimo has no "markdown cell" type: a markdown cell is a Python cell whose
// body is `mo.md("""...""")`. Headings are taken from the string literals passed
// to mo.md, never from Python comments, and fenced code blocks are skipped.

export interface Heading {
  level: number;
  text: string;
}

const CALL = /\bmo\s*\.\s*md\s*\(\s*([rRfFuUbB]{0,2})("""|'''|"|')/g;

/** The string literals passed to mo.md(...) in a cell's code. */
export function mdLiterals(code: string): string[] {
  const out: string[] = [];
  CALL.lastIndex = 0;
  for (let match = CALL.exec(code); match; match = CALL.exec(code)) {
    const prefix = (match[1] ?? "").toLowerCase();
    const quote = match[2] ?? '"';
    const start = match.index + match[0].length;
    const raw = prefix.includes("r");
    let i = start;
    let end = -1;
    while (i < code.length) {
      const ch = code[i];
      if (ch === "\\") { i += 2; continue; }
      if (quote.length === 1 && ch === "\n") break;
      if (code.startsWith(quote, i)) { end = i; break; }
      i++;
    }
    if (end < 0) continue;
    const body = code.slice(start, end);
    out.push(raw ? body : body.replace(/\\(["'\\])/g, "$1").replace(/\\n/g, "\n"));
    CALL.lastIndex = end + quote.length;
  }
  return out;
}

function dedent(text: string): string {
  const lines = text.split("\n");
  let min = Number.POSITIVE_INFINITY;
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    min = Math.min(min, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(min) || min === 0) return text;
  return [lines[0], ...lines.slice(1).map((line) => line.slice(Math.min(min, line.length - line.trimStart().length)))].join("\n");
}

/** Strip inline markdown so a heading reads as plain text. */
export function plainHeading(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, "$2")
    .replace(/\s+#+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function headingsFromMarkdown(markdown: string): Heading[] {
  const headings: Heading[] = [];
  let fence: string | null = null;
  for (const line of dedent(markdown).split("\n")) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = (fenceMatch[1] ?? "`").charAt(0);
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (!heading) continue;
    const text = plainHeading(heading[2] ?? "");
    if (text) headings.push({ level: (heading[1] ?? "#").length, text });
  }
  return headings;
}

export function headingsFromCode(code: string): Heading[] {
  return mdLiterals(code).flatMap(headingsFromMarkdown);
}

/** True when the cell does nothing but render markdown. */
export function isMarkdownCell(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed.startsWith("mo.md(")) return false;
  const literals = mdLiterals(trimmed);
  return literals.length === 1 && /\)\s*$/.test(trimmed);
}

/** The markdown a markdown cell renders, whatever quoting and indentation spell it; undefined for other cells. */
export function markdownText(code: string): string | undefined {
  if (!isMarkdownCell(code)) return undefined;
  return dedent(mdLiterals(code.trim())[0] ?? "").split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

/**
 * The same code, or two spellings of the same markdown. marimo's editor rewrites a markdown cell
 * into its own form (`mo.md("""` on its own line, dedented) as soon as a browser shows it, and
 * posts that as a browser edit, though no one typed anything.
 */
export function sameCode(a: string, b: string): boolean {
  if (a === b) return true;
  const markdown = markdownText(a);
  return markdown !== undefined && markdown === markdownText(b);
}
