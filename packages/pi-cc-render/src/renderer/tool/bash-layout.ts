// Lays a long bash command out one step per line. Pure and dependency-free: this exact file is kept
// byte-identical in every package that shows commands (scripts/test-contracts.mjs checks it), so edit
// all copies together.

const HEREDOC = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/u;
const COMPOUND_HEAD = /^\s*(?:for|while|until|if|elif|select|case)\b/u;
const COMPOUND_TAIL = /;\s*(?:then|do)\b/u;

type Quote = "'" | '"' | "`" | undefined;

/** Break opportunities in one physical line: the index where the next step starts, and the operator before it. */
function breakPoints(line: string, state: { quote: Quote }): { at: number; op: string }[] {
  const points: { at: number; op: string }[] = [];
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (state.quote) {
      if (c === "\\" && state.quote !== "'") i++;
      else if (c === state.quote) state.quote = undefined;
      continue;
    }
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      state.quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || /\s/u.test(line[i - 1] as string))) break;
    if (c === "(" || c === "{") depth++;
    else if (c === ")" || c === "}") depth = Math.max(0, depth - 1);
    if (depth) continue;
    let op: string | undefined;
    if (line.startsWith("&&", i) || line.startsWith("||", i)) op = line.slice(i, i + 2);
    else if (c === "|" && line[i - 1] !== ">" && line[i - 1] !== "|") op = line[i + 1] === "&" ? "|&" : "|";
    else if (c === ";" && line[i + 1] !== ";") op = ";";
    if (!op || line[i - 1] === ">" || line[i - 1] === "<") continue;
    let at = i + op.length;
    while (line[at] === " ") at++;
    if (at < line.length) points.push({ at, op });
    i += op.length - 1;
  }
  return points;
}

/**
 * Break after top-level `&&`, `||`, `|` and `;` on every physical line longer than `width`, indenting
 * the continuation steps by two spaces. Only whitespace changes. Heredoc bodies, multi-line strings,
 * lines that open a heredoc, and `for`/`if`/`while` headers (for `;`) are left alone.
 */
export function layoutBash(command: string, width = 80): string {
  const out: string[] = [];
  const state: { quote: Quote } = { quote: undefined };
  let heredoc: { delimiter: string; strip: boolean } | undefined;
  for (const line of command.trim().split("\n")) {
    if (heredoc) {
      out.push(line);
      if ((heredoc.strip ? line.replace(/^\t+/u, "") : line) === heredoc.delimiter) heredoc = undefined;
      continue;
    }
    const startedInQuote = Boolean(state.quote);
    const points = breakPoints(line, state);
    const here = HEREDOC.exec(line);
    if (here) heredoc = { delimiter: (here[1] ?? here[2] ?? here[3]) as string, strip: line.includes("<<-") };
    const compound = COMPOUND_HEAD.test(line) || COMPOUND_TAIL.test(line);
    const usable = points.filter((p) => p.op !== ";" || !compound);
    if (startedInQuote || here || line.length <= width || usable.length === 0) {
      out.push(line);
      continue;
    }
    const indent = /^[ \t]*/u.exec(line)?.[0] ?? "";
    let from = 0;
    let first = true;
    for (const p of usable) {
      out.push(`${first ? "" : `${indent}  `}${line.slice(from, p.at).trim()}`);
      from = p.at;
      first = false;
    }
    out.push(`${indent}  ${line.slice(from).trim()}`);
  }
  return out.join("\n");
}
