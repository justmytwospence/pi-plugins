// Downloaded code, and the scripts a shell command runs.
//
// The gate keeps, per session, the files the session downloaded (`curl -o`/`-O`/`> f`, `wget`,
// `gh release download`, `aria2c`), following later `cp`, `mv` and `install` (the copy counts too;
// `mv` moves the mark) and `rm`. It is rebuilt from the branch's finished shell calls when a session
// starts or moves in its tree. Running one (`./f`, `sh f`, `source f`, `python3 f`, `deno run f`, ...)
// is always held. A local script that was not downloaded is shown to the judge by its content.
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  SHELL_TOOLS,
  SUBSTITUTED,
  expandHome,
  extractSubstitutions,
  locatedParts,
  nestedCommands,
  program,
  redirectsAt,
  shellDir,
  unwrapSudo,
  withoutHeredocBodies,
  withoutKeywords,
} from "./bash.ts";
import { shown } from "./dirs.ts";
import { clip } from "./transcript.ts";

/** The files, directories (everything under them) and name patterns this session downloaded. */
export class Downloads {
  private readonly files = new Set<string>();
  private readonly dirs = new Set<string>();
  private readonly globs: { dir: string; re: RegExp }[] = [];

  clone(): Downloads {
    const copy = new Downloads();
    for (const f of this.files) copy.files.add(f);
    for (const d of this.dirs) copy.dirs.add(d);
    copy.globs.push(...this.globs);
    return copy;
  }

  get size(): number {
    return this.files.size + this.dirs.size + this.globs.length;
  }

  /** Whether `file` (absolute) was downloaded: by its path or, when it exists, where it really is. */
  has(file: string): boolean {
    return forms(file).some(
      (f) =>
        this.files.has(f) ||
        [...this.dirs].some((d) => f === d || f.startsWith(`${d}/`)) ||
        this.globs.some((g) => path.dirname(f) === g.dir && g.re.test(path.basename(f))),
    );
  }

  addFile(file: string): void {
    for (const f of forms(file)) this.files.add(f);
  }

  addDir(dir: string): void {
    for (const d of forms(dir)) this.dirs.add(d);
  }

  /** Files in `dir` whose names match a shell pattern (`*.tar.gz`). */
  addGlob(dir: string, pattern: string): void {
    const re = globRe(pattern);
    for (const d of forms(dir)) this.globs.push({ dir: d, re });
  }

  /** `src` was copied (or moved) to `dest`: what was downloaded at or under it is there too. */
  copy(src: string, dest: string, move: boolean): void {
    const from = forms(src);
    const covered = this.has(src);
    let own = false;
    for (const set of [this.files, this.dirs]) {
      for (const entry of [...set]) {
        const base = from.find((s) => entry === s || entry.startsWith(`${s}/`));
        if (base === undefined) continue;
        own = true;
        if (move) set.delete(entry);
        for (const f of forms(dest + entry.slice(base.length))) set.add(f);
      }
    }
    // Under a downloaded directory or matching a pattern, with no mark of its own.
    if (covered && !own) {
      if (isDirectory(dest)) this.addDir(dest);
      else this.addFile(dest);
    }
  }

  /** `target` was removed, with everything under it. */
  remove(target: string): void {
    const gone = forms(target);
    for (const set of [this.files, this.dirs]) {
      for (const entry of [...set]) if (gone.some((t) => entry === t || entry.startsWith(`${t}/`))) set.delete(entry);
    }
  }
}

/** The path, and where it really is (symlinks and `/tmp` -> `/private/tmp` resolved) when that differs. */
function forms(file: string): string[] {
  let real = file;
  try {
    real = realpathSync(file);
  } catch {
    try {
      real = path.join(realpathSync(path.dirname(file)), path.basename(file));
    } catch {
      // Neither exists: the path as given.
    }
  }
  return real === file ? [file] : [file, real];
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** A shell file-name pattern (`*`, `?`, `[...]`) as a regular expression. */
function globRe(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[" && pattern.indexOf("]", i + 2) > i) {
      const end = pattern.indexOf("]", i + 2);
      const body = pattern.slice(i + 1, end).replace(/[\\\]]/gu, "\\$&");
      re += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      i = end;
    } else re += c.replace(/[.+^${}()|[\]\\/-]/gu, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`, "u");
  } catch {
    // A pattern this cannot follow: every name in the directory counts.
    return /^/u;
  }
}

/** A script a command runs: the word that names it, the file, and whether it was downloaded. */
export interface ScriptRun {
  token: string;
  file: string;
  /** Downloaded in this session, or earlier in the same command. */
  downloaded: boolean;
}

/** The program a simple command runs, with the word that named it (`./x` for `x`). */
interface Invocation {
  raw: string;
  name: string;
  args: string[];
}

function invocation(tokens: string[]): Invocation | undefined {
  const p = program(tokens);
  if (!p?.name) return undefined;
  return { raw: tokens[tokens.length - p.args.length - 1] ?? p.name, name: p.name, args: p.args };
}

/** How an interpreter takes its script: the first operand, unless an option says the code comes from elsewhere. */
interface Runner {
  /** Short options after which there is no script file (`-c code`, `-m module`, `-e code`). */
  stops: string;
  /** Short options that take a value. */
  values: string;
  longStops?: readonly string[];
  longValues?: readonly string[];
}

const SHELL_RUNNER: Runner = { stops: "cs", values: "oO", longValues: ["--rcfile", "--init-file"] };
const SCRIPT_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const RUNNERS: Record<string, Runner> = {
  python: { stops: "cm", values: "WX" },
  node: {
    stops: "ep",
    values: "rC",
    longStops: ["--eval", "--print"],
    longValues: ["--require", "--import", "--loader", "--experimental-loader", "--conditions", "--input-type", "--title", "--env-file"],
  },
  ruby: { stops: "e", values: "rICE" },
  perl: { stops: "eE", values: "I" },
  bun: {
    stops: "ep",
    values: "rcdlF",
    longStops: ["--eval", "--print"],
    longValues: ["--cwd", "--config", "--preload", "--define", "--loader", "--tsconfig-override", "--env-file", "--conditions", "--filter", "--port"],
  },
  deno: { stops: "", values: "cL", longValues: ["--config", "--import-map", "--lock", "--cert", "--location", "--seed", "--log-level", "--ext"] },
};

function firstOperand(args: readonly string[], r: Runner): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") return args[i + 1];
    if (a === "-") return undefined;
    if (r === SHELL_RUNNER && (a === "+o" || a === "+O")) {
      i++;
      continue;
    }
    if (!a.startsWith("-") && !(r === SHELL_RUNNER && a.startsWith("+"))) return a;
    if (a.startsWith("--")) {
      const name = a.split("=", 1)[0] as string;
      if (r.longStops?.includes(name)) return undefined;
      if (!a.includes("=") && r.longValues?.includes(name)) i++;
      continue;
    }
    for (let j = 1; j < a.length; j++) {
      const c = a[j] as string;
      if (r.stops.includes(c)) return undefined;
      if (r.values.includes(c)) {
        if (j === a.length - 1) i++;
        break;
      }
    }
  }
  return undefined;
}

/** A word that names a file rather than a package script or subcommand (`bun run build`). */
const fileLike = (word: string) => !word.includes("://") && (word.includes("/") || /\.[A-Za-z0-9]+$/u.test(word));

/** The scripts one simple command runs: `./x`, `bin/x`, `sh x`, `source x`, `python3 x`, `deno run x`, ... */
function scriptsRun(p: Invocation): string[] {
  const { raw, name, args } = p;
  if (raw.includes("/")) return raw.includes(SUBSTITUTED) ? [] : [raw];
  if (name === "source" || name === ".") {
    const file = args[0] === "--" ? args[1] : args[0];
    return file ? [file] : [];
  }
  let file: string | undefined;
  if (SCRIPT_SHELLS.has(name)) file = firstOperand(args, SHELL_RUNNER);
  else if (/^python[0-9.]*$/u.test(name)) file = firstOperand(args, RUNNERS.python as Runner);
  else if (name === "node" || name === "nodejs") file = firstOperand(args, RUNNERS.node as Runner);
  else if (name === "ruby" || name === "perl") file = firstOperand(args, RUNNERS[name] as Runner);
  else if (name === "bun" || name === "deno") {
    // `bun run x.ts`, `bun x.ts`, `deno run x.ts`, `deno x.ts`; not `bun run build` or `deno task x`.
    const runner = RUNNERS[name] as Runner;
    const first = firstOperand(args, runner);
    file = first === "run" ? firstOperand(args.slice(args.indexOf("run") + 1), runner) : first;
    if (file !== undefined && !fileLike(file)) file = undefined;
  }
  return file && !file.includes(SUBSTITUTED) ? [file] : [];
}

/** The last path segment of a URL (no query or fragment), or undefined when it has none. */
function urlName(url: string): string | undefined {
  const bare = url.replace(/[?#].*$/su, "");
  const rest = bare.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/iu, "");
  if (rest === bare && !bare.includes("/")) return undefined;
  return rest.slice(rest.lastIndexOf("/") + 1) || undefined;
}

/** What a download command writes: files (relative to where it runs), directories, name patterns, and whether stdout. */
interface Fetched {
  files: string[];
  dirs: string[];
  patterns: string[];
  stdout: boolean;
}

/** Options' values and operands of a command line, by the command's own option table. */
function parseOptions(
  args: readonly string[],
  shortValues: string,
  longValues: ReadonlySet<string>,
  onOption: (option: string, value: string | undefined) => void,
  onOperand: (operand: string) => void,
): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      for (const rest of args.slice(i + 1)) onOperand(rest);
      return;
    }
    if (!a.startsWith("-") || a === "-") {
      onOperand(a);
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const option = eq < 0 ? a : a.slice(0, eq);
      if (eq >= 0) onOption(option, a.slice(eq + 1));
      else if (longValues.has(option)) onOption(option, args[++i]);
      else onOption(option, undefined);
    } else {
      for (let j = 1; j < a.length; j++) {
        const c = a[j] as string;
        if (shortValues.includes(c)) {
          onOption(`-${c}`, j + 1 < a.length ? a.slice(j + 1) : args[++i]);
          break;
        }
        onOption(`-${c}`, undefined);
      }
    }
  }
}

const CURL_LONG_VALUES = new Set([
  "--output", "--output-dir", "--url", "--header", "--data", "--data-ascii", "--data-binary", "--data-raw", "--data-urlencode",
  "--json", "--request", "--user", "--user-agent", "--referer", "--cookie", "--cookie-jar", "--proxy", "--proxy-user", "--max-time",
  "--connect-timeout", "--retry", "--retry-delay", "--retry-max-time", "--form", "--form-string", "--write-out", "--config", "--cert",
  "--key", "--cacert", "--capath", "--range", "--upload-file", "--continue-at", "--dump-header", "--limit-rate", "--max-filesize",
  "--resolve", "--connect-to", "--interface", "--oauth2-bearer", "--aws-sigv4", "--variable", "--create-file-mode", "--stderr",
  "--trace", "--trace-ascii", "--time-cond", "--max-redirs", "--netrc-file", "--proxy-header", "--unix-socket", "--etag-save",
  "--etag-compare", "--hsts", "--alt-svc", "--proto", "--proto-redir", "--proto-default", "--socks5", "--socks5-hostname",
]);

/** `curl -o f`, `-O` (the URL's name), `--output-dir d`; URLs with no output go to stdout. */
function curlFetch(args: readonly string[]): Fetched {
  const urls: string[] = [];
  /** One per `-o`/`-O`, in order: a file name, or REMOTE for the URL's own name. */
  const outputs: (string | typeof REMOTE)[] = [];
  let remoteAll = false;
  let outDir: string | undefined;
  parseOptions(
    args,
    "AbcCdDEeFHKmoPQrTtuUwxXyYz",
    CURL_LONG_VALUES,
    (option, value) => {
      if ((option === "-o" || option === "--output") && value !== undefined) outputs.push(value);
      else if (option === "-O" || option === "--remote-name") outputs.push(REMOTE);
      else if (option === "--remote-name-all") remoteAll = true;
      else if (option === "--output-dir" && value !== undefined) outDir = value;
      else if (option === "--url" && value !== undefined) urls.push(value);
    },
    (operand) => urls.push(operand),
  );
  const files: string[] = [];
  let stdout = false;
  urls.forEach((url, i) => {
    const output = outputs[i] ?? (remoteAll ? REMOTE : undefined);
    const name = output === REMOTE ? urlName(url) : output;
    if (name === undefined || name === "-") stdout = stdout || output !== REMOTE;
    else files.push(outDir && !path.isAbsolute(name) && !name.startsWith("~") ? path.join(outDir, name) : name);
  });
  if (!urls.length && outputs.some((o) => o !== REMOTE && o !== "-")) {
    for (const o of outputs) if (o !== REMOTE && o !== "-") files.push(o);
  }
  return { files, dirs: [], patterns: [], stdout };
}

const REMOTE = Symbol("remote name");

const WGET_LONG_VALUES = new Set([
  "--output-document", "--directory-prefix", "--output-file", "--append-output", "--input-file", "--user-agent", "--execute",
  "--timeout", "--tries", "--wait", "--quota", "--level", "--accept", "--reject", "--domains", "--exclude-directories",
  "--include-directories", "--base", "--header", "--user", "--password", "--http-user", "--http-password", "--post-data",
  "--post-file", "--body-data", "--body-file", "--method", "--referer", "--load-cookies", "--save-cookies", "--limit-rate",
  "--bind-address", "--dns-timeout", "--connect-timeout", "--read-timeout", "--waitretry", "--ca-certificate", "--certificate",
  "--private-key", "--default-page", "--cut-dirs",
]);

/** `wget url` (the URL's name, else index.html), `-O f` (`-O -`: stdout), `-P dir`. */
function wgetFetch(args: readonly string[]): Fetched {
  const urls: string[] = [];
  let document: string | undefined;
  let prefix: string | undefined;
  parseOptions(
    args,
    "OoaiUeTtwQlARDXIBP",
    WGET_LONG_VALUES,
    (option, value) => {
      if ((option === "-O" || option === "--output-document") && value !== undefined) document = value;
      else if ((option === "-P" || option === "--directory-prefix") && value !== undefined) prefix = value;
    },
    (operand) => urls.push(operand),
  );
  if (document === "-") return { files: [], dirs: [], patterns: [], stdout: true };
  const within = (name: string) => (prefix && !path.isAbsolute(name) ? path.join(prefix, name) : name);
  if (document !== undefined) return { files: [document], dirs: [], patterns: [], stdout: false };
  return { files: urls.map((url) => within(urlName(url) ?? "index.html")), dirs: [], patterns: [], stdout: false };
}

const ARIA2_LONG_VALUES = new Set(["--out", "--dir", "--input-file", "--log", "--split", "--max-connection-per-server", "--user-agent", "--header", "--referer", "--timeout", "--max-tries"]);

/** `aria2c url` (the URL's name), `-o f`, `-d dir`. */
function aria2Fetch(args: readonly string[]): Fetched {
  const urls: string[] = [];
  let out: string | undefined;
  let dir: string | undefined;
  parseOptions(
    args,
    "odisxkjlUtmTM",
    ARIA2_LONG_VALUES,
    (option, value) => {
      if ((option === "-o" || option === "--out") && value !== undefined) out = value;
      else if ((option === "-d" || option === "--dir") && value !== undefined) dir = value;
    },
    (operand) => urls.push(operand),
  );
  const names = out !== undefined ? [out] : urls.flatMap((url) => urlName(url) ?? []);
  return { files: names.map((name) => (dir && !path.isAbsolute(name) ? path.join(dir, name) : name)), dirs: [], patterns: [], stdout: false };
}

/**
 * `gh release download`: `-O f` (`-O -`: stdout), else `-D dir` (everything under it), else each
 * `-p` pattern in the working directory. Without any of them the asset names are unknown.
 */
function ghReleaseFetch(args: readonly string[]): Fetched | undefined {
  const release = args.indexOf("release");
  if (release < 0 || args.slice(release + 1).find((a) => !a.startsWith("-")) !== "download") return undefined;
  const rest = args.slice(args.indexOf("download", release + 1) + 1);
  let output: string | undefined;
  let dir: string | undefined;
  const patterns: string[] = [];
  parseOptions(
    rest,
    "ODpAR",
    new Set(["--output", "--dir", "--pattern", "--archive", "--repo"]),
    (option, value) => {
      if ((option === "-O" || option === "--output") && value !== undefined) output = value;
      else if ((option === "-D" || option === "--dir") && value !== undefined) dir = value;
      else if ((option === "-p" || option === "--pattern") && value !== undefined) patterns.push(value);
    },
    () => undefined,
  );
  if (output === "-") return { files: [], dirs: [], patterns: [], stdout: true };
  if (output !== undefined) return { files: [output], dirs: [], patterns: [], stdout: false };
  if (dir !== undefined) return { files: [], dirs: [dir], patterns: [], stdout: false };
  const literal = patterns.filter((p) => !/[*?[]/u.test(p));
  return { files: literal, dirs: [], patterns: patterns.filter((p) => !literal.includes(p)), stdout: false };
}

const COPY_VALUES: Record<string, ReadonlySet<string>> = {
  cp: new Set(["-S", "--suffix"]),
  mv: new Set(["-S", "--suffix"]),
  install: new Set(["-S", "--suffix", "-m", "--mode", "-o", "--owner", "-g", "--group"]),
};

/** `cp`/`mv`/`install` sources and destination; `intoDir` when the destination is surely a directory. */
function copyOperands(name: string, args: readonly string[]): { sources: string[]; dest: string; intoDir: boolean } | undefined {
  const values = COPY_VALUES[name] ?? new Set<string>();
  const operands: string[] = [];
  let target: string | undefined;
  let noTargetDir = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      operands.push(a);
      continue;
    }
    if (a === "-t" || a === "--target-directory") target = args[++i];
    else if (a.startsWith("--target-directory=")) target = a.slice("--target-directory=".length);
    else if (/^-t./u.test(a)) target = a.slice(2);
    else if (a === "-T" || a === "--no-target-directory") noTargetDir = true;
    else if (name === "install" && (a === "-d" || a === "--directory")) return undefined;
    else if (values.has(a)) i++;
  }
  if (target !== undefined) return { sources: operands, dest: target, intoDir: true };
  if (operands.length < 2) return undefined;
  const dest = operands.pop() as string;
  return { sources: operands, dest, intoDir: !noTargetDir && (operands.length > 1 || dest.endsWith("/")) };
}

/** A redirect token, or the operator before a redirect's separate target. */
const REDIRECT = /^[0-9&]*(>>?|<>?|<)/u;

/**
 * Walk a shell command's simple commands in order, with the directory each runs in (after `cd`),
 * into `$(...)`, backticks, `<(...)`, `>(...)`, `sh -c` and `eval`. Each reports the scripts it
 * runs, then applies what it downloads, copies, moves or removes to `downloads`. A substitution
 * runs before the command around it.
 */
function walk(command: string, cwd: string, downloads: Downloads, onRun: (run: ScriptRun) => void): void {
  const { text, bodies } = extractSubstitutions(withoutHeredocBodies(command));
  const parts = locatedParts(text, cwd);
  const partAt = (at: number) => Math.max(0, parts.findLastIndex((p) => p.start <= at));
  /** Where each part's stdout goes: `> f`, `>> f`, `&> f` (not `2> f`). */
  const stdout = new Map<number, string[]>();
  for (const r of redirectsAt(text)) {
    if (r.target === ">" || !/^(?:1?>|&>)/u.test(text.slice(r.at))) continue;
    const i = partAt(r.at);
    const part = parts[i];
    if (part) stdout.set(i, [...(stdout.get(i) ?? []), path.resolve(part.redirectDir, expandHome(r.target))]);
  }
  if (!parts.length) for (const { body } of bodies) walk(body, cwd, downloads, onRun);
  parts.forEach((part, i) => {
    for (const { body, at } of bodies) if (partAt(at) === i) walk(body, part.dir, downloads, onRun);
    if (!part.cd) visitPart(part.tokens, part.dir, stdout.get(i) ?? [], downloads, onRun);
  });
}

function visitPart(raw: string[], dir: string, stdout: string[], downloads: Downloads, onRun: (run: ScriptRun) => void): void {
  // Redirects (collected by `walk`) are not arguments.
  const words = raw.filter((t, i) => !REDIRECT.test(t) && !/^[0-9&]*(>>?|<>?|<)\|?&?$/u.test(raw[i - 1] ?? ""));
  let p = invocation(withoutKeywords(words));
  if (p && (p.name === "sudo" || p.name === "doas")) {
    const args = p.args;
    const q = unwrapSudo(args);
    p = q?.name ? { raw: args[args.length - q.args.length - 1] ?? q.name, name: q.name, args: q.args } : undefined;
  }
  if (!p) return;
  const resolve = (file: string) => path.resolve(dir, expandHome(file));
  for (const token of scriptsRun(p)) {
    const file = resolve(token);
    onRun({ token, file, downloaded: downloads.has(file) });
  }
  for (const nested of nestedCommands(p)) walk(nested, dir, downloads, onRun);

  const { name, args } = p;
  const fetched =
    name === "curl" ? curlFetch(args)
    : name === "wget" ? wgetFetch(args)
    : name === "aria2c" ? aria2Fetch(args)
    : name === "gh" ? ghReleaseFetch(args)
    : undefined;
  if (fetched) {
    for (const f of fetched.files) downloads.addFile(resolve(f));
    for (const d of fetched.dirs) downloads.addDir(resolve(d));
    for (const pattern of fetched.patterns) downloads.addGlob(dir, pattern);
    if (fetched.stdout) for (const f of stdout) downloads.addFile(f);
    return;
  }
  if (name === "cp" || name === "mv" || name === "install") {
    const c = copyOperands(name, args);
    if (!c) return;
    const dest = resolve(c.dest);
    for (const source of c.sources) {
      const src = resolve(source);
      const target = c.intoDir || isDirectory(dest) ? path.join(dest, path.basename(src)) : dest;
      downloads.copy(src, target, name === "mv");
    }
    return;
  }
  if (name === "rm" || name === "unlink") {
    for (const a of args) if (!a.startsWith("-")) downloads.remove(resolve(a));
  }
}

/**
 * The scripts a shell command runs, in order, each marked when it was downloaded in this session
 * (`downloads`) or earlier in the same command (`curl -o x URL && sh x`).
 */
export function scriptRuns(command: string, cwd: string, downloads: Downloads = new Downloads()): ScriptRun[] {
  const runs: ScriptRun[] = [];
  walk(command, cwd, downloads.clone(), (run) => runs.push(run));
  return runs;
}

/** Why a command is always held for running downloaded code, or []. */
export function downloadedRunReasons(command: string, cwd: string, downloads: Downloads): string[] {
  // One reason per file, named as the command first names it.
  const files = new Map<string, string>();
  for (const run of scriptRuns(command, cwd, downloads)) if (run.downloaded && !files.has(run.file)) files.set(run.file, run.token);
  return [...files.values()].map((token) => `runs ${token}, downloaded in this session`);
}

/** Record what a finished shell command downloaded, copied, moved or removed. */
export function trackCommand(downloads: Downloads, command: string, cwd: string): void {
  walk(command, cwd, downloads, () => undefined);
}

/** Record a finished tool call: `bash`, or `bg_run` in its own directory. Other tools change nothing. */
export function trackCall(downloads: Downloads, tool: string, input: Record<string, unknown>, cwd: string): void {
  if (!SHELL_TOOLS.has(tool)) return;
  trackCommand(downloads, String(input.command ?? ""), shellDir(tool, input, cwd));
}

interface EntryLike {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolCallId?: string;
    isError?: boolean;
    nestedCalls?: { calls?: Array<{ name?: string; arguments?: Record<string, unknown>; status?: string }> };
  };
}

/**
 * Follows a branch entry by entry: every `bash`/`bg_run` call whose result is not an error, and
 * those another tool made (a codemode script's `nestedCalls`), in order.
 */
export class BranchDownloads {
  readonly downloads = new Downloads();
  private readonly calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  add(item: unknown): void {
    const entry = item as EntryLike;
    const m = entry?.type === "message" ? entry.message : undefined;
    if (!m) return;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
        if (block?.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") {
          this.calls.set(block.id, { name: block.name, input: (block.arguments ?? {}) as Record<string, unknown> });
        }
      }
    } else if (m.role === "toolResult") {
      const call = typeof m.toolCallId === "string" ? this.calls.get(m.toolCallId) : undefined;
      if (call && !m.isError) trackCall(this.downloads, call.name, call.input, this.cwd);
      for (const nested of m.nestedCalls?.calls ?? []) {
        if (nested.status === "ok" && nested.name && nested.arguments) trackCall(this.downloads, nested.name, nested.arguments, this.cwd);
      }
    }
  }
}

/** What a branch's finished shell calls downloaded (see `BranchDownloads`). */
export function downloadsOf(branch: readonly unknown[], cwd: string): Downloads {
  const tracker = new BranchDownloads(cwd);
  for (const entry of branch) tracker.add(entry);
  return tracker.downloads;
}

/** The largest script whose content goes to the judge, and how much of it. */
export const SCRIPT_MAX_BYTES = 64 * 1024;
export const SCRIPT_MAX_CHARS = 6_000;

export interface Script {
  /** The file, with `~` for home. */
  path: string;
  content: string;
}

/**
 * The first local script a shell command runs that the judge may read: a regular file of at most
 * 64 KB with no NUL byte in its first 8 KB (not a binary), not downloaded in this session.
 */
export function scriptFor(command: string, cwd: string, downloads: Downloads = new Downloads()): Script | undefined {
  for (const run of scriptRuns(command, cwd, downloads)) {
    if (run.downloaded) continue;
    let content: Buffer;
    try {
      const stat = statSync(run.file);
      if (!stat.isFile() || stat.size > SCRIPT_MAX_BYTES) continue;
      content = readFileSync(run.file);
    } catch {
      continue;
    }
    if (content.subarray(0, 8_192).includes(0)) continue;
    return { path: shown(run.file), content: clip(content.toString("utf8"), SCRIPT_MAX_CHARS) };
  }
  return undefined;
}
