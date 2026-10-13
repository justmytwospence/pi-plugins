/**
 * Insert-mode `Ctrl-X Ctrl-F`: a fuzzy file finder that inserts an `@path`
 * mention, like Pi's `@` autocomplete but able to reach outside the project.
 *
 * The query is `[dir/]term`. Without a directory part the project (cwd) is
 * searched; a query starting with `/`, `~/`, `./` or `../` searches below the
 * directory up to its last slash, so `~/Downloads/inv` finds invoices there.
 * Tab on a directory descends into it.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
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

/** Split a query into the directory to search and the fuzzy term. */
export function parseQuery(query: string, cwd: string, home = homedir()): { root: string; prefix: string; term: string } {
  const explicit = query.startsWith("/") || query === "~" || query.startsWith("~/") || query.startsWith("./") || query.startsWith("../");
  if (!explicit) return { root: cwd, prefix: "", term: query };
  const cut = query === "~" ? query.length : query.lastIndexOf("/") + 1;
  const prefix = query.slice(0, cut);
  const expanded = prefix.startsWith("~") ? home + prefix.slice(1) : prefix;
  return { root: resolve(cwd, expanded || "/"), prefix, term: query.slice(cut) };
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
  private matches: string[] = [];
  private selected = 0;
  private loading = false;

  constructor(
    private readonly cwd: string,
    private readonly theme: PickerTheme,
    private readonly requestRender: () => void,
    private readonly done: (text: string | undefined) => void,
    private readonly lister: Lister = defaultLister,
  ) {
    this.refresh();
  }

  private refresh(): void {
    const query = this.input.getValue();
    const { root, prefix, term } = parseQuery(query, this.cwd);
    const cached = this.cache.get(root);
    if (Array.isArray(cached)) {
      this.apply(cached, prefix, term);
      return;
    }
    this.loading = true;
    const pending = cached ?? this.lister(root, root === this.cwd);
    this.cache.set(root, pending);
    void pending.then((entries) => {
      this.cache.set(root, entries);
      if (this.input.getValue() !== query) return;
      this.loading = false;
      this.apply(entries, prefix, term);
      this.requestRender();
    });
  }

  private apply(entries: string[], prefix: string, term: string): void {
    this.loading = false;
    const filtered = term ? fuzzyFilter(entries, term, (e) => e) : entries;
    this.matches = filtered.slice(0, 500).map((e) => prefix + e);
    this.selected = 0;
  }

  private absolute(entry: string): string {
    const { root, prefix } = parseQuery(entry, this.cwd);
    const abs = join(root, entry.slice(prefix.length));
    return entry.endsWith("/") ? abs + sep : abs;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) return this.done(undefined);
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p") || matchesKey(data, "ctrl+k")) {
      this.selected = Math.max(0, this.selected - 1);
    } else if (matchesKey(data, "down") || matchesKey(data, "ctrl+n") || matchesKey(data, "ctrl+j")) {
      this.selected = Math.min(this.matches.length - 1, this.selected + 1);
    } else if (matchesKey(data, "enter")) {
      const entry = this.matches[this.selected];
      if (entry) this.done(mention(displayPath(this.absolute(entry), this.cwd)));
      return;
    } else if (matchesKey(data, "tab")) {
      const entry = this.matches[this.selected];
      if (!entry) return;
      // Descend into a directory (or complete a file), keeping the query explicit.
      const shown = displayPath(this.absolute(entry), this.cwd);
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
      const text = truncateToWidth(`${chosen ? "> " : "  "}${entry}`, width);
      lines.push(chosen ? t.fg("accent", text) : entry.endsWith("/") ? t.fg("muted", text) : text);
    }
    const status = this.loading
      ? "searching..."
      : this.matches.length ? `${this.selected + 1}/${this.matches.length}` : "no matches";
    lines.push(t.fg("dim", truncateToWidth(`${status}  enter insert  tab descend  ~/ / ../ search elsewhere  esc cancel`, width)));
    return lines;
  }
}
