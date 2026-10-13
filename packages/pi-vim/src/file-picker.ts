/**
 * Insert-mode `Ctrl-X Ctrl-F`: a fuzzy file finder that inserts an `@path`
 * mention, like Pi's `@` autocomplete but able to reach outside the project.
 *
 * The query is `[dir/]term`. Without a directory part the project (cwd) is
 * searched; a query starting with `/`, `~/`, `./` or `../` searches below the
 * directory up to its last slash, so `~/Downloads/inv` finds invoices there.
 * Each directory segment is itself matched fuzzily when no directory has that
 * exact name, so `~/dl/inv` also works (dl -> Downloads).
 * Tab on a directory descends into it.
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

export type PickerTheme = { fg(color: string, text: string): string; bold(text: string): string };

/** Entries below `root`, relative, directories ending in `/`. */
export type Lister = (root: string, project: boolean) => Promise<string[]>;

const MAX_RESULTS = 20000;
const OUTSIDE_DEPTH = 5;
const VISIBLE = 12;

/** Subdirectory names of `dir` (empty when unreadable). */
export type SubdirReader = (dir: string) => string[];

export const readSubdirs: SubdirReader = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name))))
      .map((e) => e.name);
  } catch {
    return [];
  }
};

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directory a typed segment means: the exact name if it exists, else the
 * shortest case-insensitive prefix match, else the best fuzzy match.
 */
export function matchSegment(segment: string, names: string[]): string | undefined {
  if (names.includes(segment)) return segment;
  const lower = segment.toLowerCase();
  const prefixed = names.filter((n) => n.toLowerCase().startsWith(lower));
  if (prefixed.length) return prefixed.sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  // Hidden directories only when the segment asks for them.
  const visible = segment.startsWith(".") ? names : names.filter((n) => !n.startsWith("."));
  return fuzzyFilter(visible, segment, (n) => n)[0];
}

/**
 * Split a query into the directory to search and the fuzzy term. `prefix` is
 * the resolved directory as the user would write it (`~/dl/` -> `~/Downloads/`);
 * `root` is undefined when a segment matches nothing.
 */
export function parseQuery(
  query: string,
  cwd: string,
  home = homedir(),
  subdirs: SubdirReader = readSubdirs,
): { root: string | undefined; prefix: string; term: string } {
  const explicit = query.startsWith("/") || query === "~" || query.startsWith("~/") || query.startsWith("./") || query.startsWith("../");
  if (!explicit) return { root: cwd, prefix: "", term: query };
  if (query === "~") return { root: home, prefix: "~", term: "" };
  const cut = query.lastIndexOf("/") + 1;
  const term = query.slice(cut);
  const segments = query.slice(0, cut - 1).split("/");
  // The first segment anchors the walk: "" is the filesystem root.
  const first = segments.shift() ?? "";
  let root = first === "" ? "/" : first === "~" ? home : resolve(cwd, first);
  let prefix = first + "/";
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      root = resolve(root, "..");
      prefix += "../";
      continue;
    }
    const name = matchSegment(segment, subdirs(root));
    if (name === undefined) return { root: undefined, prefix: query.slice(0, cut), term };
    root = join(root, name);
    prefix += name + "/";
  }
  return { root, prefix, term };
}

/** How a chosen absolute path is written: cwd-relative inside the project, `~/` under home, else absolute. */
export function displayPath(abs: string, cwd: string, home = homedir()): string {
  const dir = abs.endsWith(sep) ? sep : "";
  const rel = relative(cwd, abs);
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel + dir;
  if (abs === home || abs.startsWith(home + sep)) return "~" + abs.slice(home.length);
  return abs;
}

/** The text inserted for a path, quoted the way Pi's autocomplete quotes spaces. */
export function mention(path: string): string {
  return /\s/.test(path) ? `@"${path}" ` : `@${path} `;
}

/** List with `fd` (respects .gitignore); fall back to one directory level. */
export const defaultLister: Lister = (root, project) =>
  new Promise((done) => {
    const args = ["--hidden", "--exclude", ".git", "--max-results", String(MAX_RESULTS), "--strip-cwd-prefix", "--type", "f", "--type", "d"];
    if (!project) args.push("--max-depth", String(OUTSIDE_DEPTH));
    const out: string[] = [];
    let buffer = "";
    let child;
    try {
      child = spawn("fd", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return done(listOneLevel(root));
    }
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      out.push(...lines);
    });
    child.on("error", () => done(listOneLevel(root)));
    child.on("close", () => {
      if (buffer) out.push(buffer);
      done(out.filter(Boolean));
    });
  });

function listOneLevel(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
  } catch {
    return [];
  }
}

export class FilePicker implements Component, Focusable {
  focused = true;
  private input = new Input({ prompt: "file: " });
  private cache = new Map<string, Promise<string[]> | string[]>();
  private matches: { label: string; abs: string }[] = [];
  private selected = 0;
  private loading = false;
  private noDirectory = false;

  constructor(
    private readonly cwd: string,
    private readonly theme: PickerTheme,
    private readonly requestRender: () => void,
    private readonly done: (text: string | undefined) => void,
    private readonly lister: Lister = defaultLister,
    private readonly subdirs: SubdirReader = readSubdirs,
  ) {
    this.refresh();
  }

  private refresh(): void {
    const query = this.input.getValue();
    const { root, prefix, term } = parseQuery(query, this.cwd, homedir(), this.subdirs);
    this.noDirectory = root === undefined;
    if (root === undefined) {
      this.loading = false;
      this.matches = [];
      return;
    }
    const cached = this.cache.get(root);
    if (Array.isArray(cached)) {
      this.apply(cached, root, prefix, term);
      return;
    }
    this.loading = true;
    const pending = cached ?? this.lister(root, root === this.cwd);
    this.cache.set(root, pending);
    void pending.then((entries) => {
      this.cache.set(root, entries);
      if (this.input.getValue() !== query) return;
      this.loading = false;
      this.apply(entries, root, prefix, term);
      this.requestRender();
    });
  }

  private apply(entries: string[], root: string, prefix: string, term: string): void {
    this.loading = false;
    const filtered = term ? fuzzyFilter(entries, term, (e) => e) : entries;
    this.matches = filtered.slice(0, 500).map((e) => ({
      label: prefix + e,
      abs: join(root, e) + (e.endsWith("/") ? sep : ""),
    }));
    this.selected = 0;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(undefined);
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p") || matchesKey(data, "ctrl+k")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+j")) {
      this.selected = Math.min(this.matches.length - 1, this.selected + 1);
    } else if (matchesKey(data, "enter")) {
      const entry = this.matches[this.selected];
      if (entry) this.done(mention(displayPath(entry.abs, this.cwd)));
      return;
    } else if (matchesKey(data, "tab")) {
      const entry = this.matches[this.selected];
      if (!entry) return;
      // Descend into a directory (or complete a file), keeping the query explicit.
      const shown = displayPath(entry.abs, this.cwd);
      this.input.setValue(/^(\/|~|\.\.?\/)/.test(shown) ? shown : `./${shown}`);
      this.refresh();
    } else {
      const before = this.input.getValue();
      this.input.handleInput(data);
      if (this.input.getValue() !== before) this.refresh();
    }
    this.requestRender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): string[] {
    const t = this.theme;
    this.input.focused = this.focused;
    const lines = [t.fg("border", "─".repeat(width)), ...this.input.render(width)];
    const start = Math.max(0, Math.min(this.selected - Math.floor(VISIBLE / 2), this.matches.length - VISIBLE));
    for (const [i, entry] of this.matches.slice(start, start + VISIBLE).entries()) {
      const chosen = start + i === this.selected;
      const text = truncateToWidth(`${chosen ? "> " : "  "}${entry.label}`, width);
      lines.push(chosen ? t.fg("accent", text) : entry.label.endsWith("/") ? t.fg("muted", text) : text);
    }
    const status = this.loading
      ? "searching..."
      : this.matches.length ? `${this.selected + 1}/${this.matches.length}` : this.noDirectory ? "no matching directory" : "no matches";
    lines.push(t.fg("dim", truncateToWidth(`${status}  enter insert  tab descend  ~/ / ../ search elsewhere  esc cancel`, width)));
    return lines;
  }
}
