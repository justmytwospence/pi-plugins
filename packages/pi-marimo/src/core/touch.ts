// Which notebooks an agent's tool call works in, read from its marimo-pair
// commands, so each agent session can keep the notebook it works in current
// even while another session (or the user) works in a different one.
//
// marimo-pair runs `execute-code.sh --url URL [--file PATH | --session ID]` or
// `marimo pair execute --url URL [--file FILE] [--session ID]`. A tool call may
// hold several (one bash command, a codemode script), in any quoting.

export interface PairTarget {
  url?: string;
  file?: string;
  session?: string;
  /** A flag's value is a shell variable or substitution, so the target is only partly known. */
  unresolved?: boolean;
}

const CALL = /execute-code\.sh|marimo\s+pair\s+execute/g;

/** A flag's value; `$` when it is a shell variable or substitution, which cannot be resolved here. */
function flag(segment: string, name: string): string | undefined {
  const match = new RegExp(`--${name}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|([^\\s"'\\\\;|&)]+))`).exec(segment);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.includes("$") ? "$" : value;
}

/** The notebooks the marimo-pair calls in a tool call's text target, in order. */
export function pairTargets(raw: string): PairTarget[] {
  // Tool input arrives as JSON too, with its quotes escaped.
  const text = raw.replace(/\\"/g, '"');
  const starts: number[] = [];
  CALL.lastIndex = 0;
  for (let m = CALL.exec(text); m; m = CALL.exec(text)) starts.push(m.index);
  return starts.map((start, i) => {
    const segment = text.slice(start, starts[i + 1] ?? text.length).split(/\n|\\n/)[0] ?? "";
    const target: PairTarget = {};
    const url = flag(segment, "url");
    const file = flag(segment, "file");
    const session = flag(segment, "session");
    if (url && url !== "$") target.url = url;
    if (file && file !== "$") target.file = file;
    if (session && session !== "$") target.session = session;
    if (url === "$" || file === "$" || session === "$") target.unresolved = true;
    return target;
  });
}

/** One server, however it is written (localhost or 127.0.0.1, a trailing slash). */
export function sameServer(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, "").replace("://localhost", "://127.0.0.1").replace("://[::1]", "://127.0.0.1");
  return norm(a) === norm(b);
}
