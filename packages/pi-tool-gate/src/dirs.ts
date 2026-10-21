// The directory policy: which paths a project's agent may read and write without asking.
//
// The project (its git checkout, and the main checkout of a worktree) is always readable and
// writable. Private roots (`~/Projects`, `~/Documents`, ...) hold other people's work and your
// own: nothing in them outside the project is read or written unasked unless the project grants
// it. Everything else (system and toolchain paths, `~/.config`) is readable, and writable only in
// `alwaysWrite` (temp and cache directories) or a `write` grant. `read: ["*"]` reads anywhere.
// `derived` paths are generated from a source elsewhere: a write to one outside the project is
// held even when a grant covers it, with its `hint` (where to edit instead) passed on verbatim.
// `exemptCommands` (bash.ts) are commands whose paths are not checked at all, such as the one
// that regenerates the derived paths from their source.
import { realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

export interface DirectoriesConfig extends Record<string, unknown> {
  /** Check paths at all. */
  enabled: boolean;
  /** Directories whose contents, outside the project and its grants, are neither read nor written unasked. */
  private: string[];
  /** Extra directories this project may read; `"*"` reads anywhere. */
  read: string[];
  /** Extra directories this project may read and write. */
  write: string[];
  /** Directories every project may write (temp and caches). */
  alwaysWrite: string[];
  /** Paths generated from a source elsewhere: writes to them are held, with the hint as advice. */
  derived: Derived[];
  /** Commands (program and leading words, `make install`) whose paths the policy does not check. */
  exemptCommands: string[];
}

export interface Derived {
  path: string;
  /** Where to make the change instead; shown to the agent verbatim. */
  hint?: string;
}

export const DEFAULT_DIRECTORIES: DirectoriesConfig = {
  enabled: true,
  private: ["~/Projects", "~/Documents", "~/Desktop", "~/Downloads", "~/Library/Mobile Documents"],
  read: [],
  write: [],
  alwaysWrite: [
    "/tmp", "/private/tmp", "/dev", "$TMPDIR",
    "~/.cache", "~/Library/Caches", "~/.npm", "~/.bun", "~/.cargo", "~/.rustup", "~/.pyenv", "~/.local/share", "~/.local/state",
  ],
  derived: [],
  exemptCommands: [],
};

export interface Policy {
  /** The project's own checkouts. */
  project: string[];
  readAnywhere: boolean;
  /** Glob patterns, absolute. */
  private: string[];
  read: string[];
  write: string[];
  alwaysWrite: string[];
  /** Absolute paths, each with its hint. */
  derived: { path: string; hint?: string }[];
  exempt: string[];
}

export type Access = "read" | "write";

export interface Violation {
  access: Access;
  file: string;
  /** The directory a grant for this violation covers: the folder under a private root, or the file's directory. */
  scope: string;
  /** Set for a write to a derived path: its configured hint, or "" when it has none. */
  hint?: string;
}

function expand(pattern: string, base: string): string[] {
  let p = pattern.trim();
  if (!p) return [];
  if (p === "$TMPDIR") {
    const t = tmpdir();
    const out = [t];
    try {
      out.push(realpathSync(t));
    } catch {
      // Not there: the literal is enough.
    }
    return out;
  }
  if (p === "~" || p === "$HOME") p = homedir();
  else if (p.startsWith("~/")) p = path.join(homedir(), p.slice(2));
  else if (p.startsWith("$HOME/")) p = path.join(homedir(), p.slice(6));
  return [path.resolve(base, p).replace(/\/+$/u, "") || "/"];
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`, "u");
}

/** Whether `file` is `pattern` (a path or glob) or lies under it. */
export function under(file: string, pattern: string): boolean {
  if (!/[*?]/u.test(pattern)) return file === pattern || file.startsWith(pattern === "/" ? "/" : `${pattern}/`);
  return globToRegExp(pattern).test(file);
}

/** The policy for a project whose checkouts are `project` (first: where the agent works). */
export function resolvePolicy(config: DirectoriesConfig, project: readonly string[]): Policy {
  const base = project[0] ?? process.cwd();
  const list = (items: unknown) => (Array.isArray(items) ? items.filter((i): i is string => typeof i === "string") : []);
  const read = list(config.read);
  return {
    project: [...new Set(project.map((p) => path.resolve(p)))],
    readAnywhere: read.some((r) => r.trim() === "*"),
    private: list(config.private).flatMap((p) => expand(p, base)),
    read: read.filter((r) => r.trim() !== "*").flatMap((p) => expand(p, base)),
    write: list(config.write).flatMap((p) => expand(p, base)),
    alwaysWrite: list(config.alwaysWrite).flatMap((p) => expand(p, base)),
    derived: (Array.isArray(config.derived) ? config.derived : []).flatMap((d) => {
      const entry = typeof d === "string" ? { path: d } : d && typeof d === "object" && typeof d.path === "string" ? d : undefined;
      if (!entry) return [];
      const hint = typeof entry.hint === "string" && entry.hint.trim() ? entry.hint.trim() : undefined;
      return expand(entry.path, base).map((p) => (hint ? { path: p, hint } : { path: p }));
    }),
    exempt: list(config.exemptCommands).map((c) => c.trim()).filter(Boolean),
  };
}

function granted(policy: Policy, file: string): boolean {
  return [...policy.project, ...policy.write, ...policy.alwaysWrite].some((root) => under(file, root));
}

/** The derived path a file lies under, unless it is inside the project. */
export function derivedOf(policy: Policy, file: string): { path: string; hint?: string } | undefined {
  if (policy.project.some((root) => under(file, root))) return undefined;
  return policy.derived.find((d) => under(file, d.path));
}

export function canWrite(policy: Policy, file: string): boolean {
  return granted(policy, file) && !derivedOf(policy, file);
}

export function canRead(policy: Policy, file: string): boolean {
  if (policy.readAnywhere || granted(policy, file)) return true;
  if (policy.read.some((root) => under(file, root))) return true;
  return !policy.private.some((root) => under(file, root));
}

/**
 * The folder a "allow similar" grant covers: the first folder under a private root (the root
 * itself for a file directly in it, as `~/Downloads/shot.png`), else the file's own directory,
 * except that the filesystem root is never a scope: a write to `/x` covers only `/x`.
 */
export function scopeOf(policy: Policy, file: string, access: Access): string {
  for (const root of policy.private) {
    if (/[*?]/u.test(root) || !under(file, root) || file === root) continue;
    const rest = file.slice(root.length + 1).split("/")[0];
    if (!rest) return root;
    const child = path.join(root, rest);
    return child === file && !looksLikeFolder(file) ? root : child;
  }
  return access === "write" && path.dirname(file) !== file && path.dirname(file) !== "/" ? path.dirname(file) : file;
}

/** An existing directory, or a missing path without an extension (a folder about to be made). */
function looksLikeFolder(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return !path.extname(file);
  }
}

export function violations(policy: Policy, access: { reads: readonly string[]; writes: readonly string[] }): Violation[] {
  const out: Violation[] = [];
  for (const file of access.writes) {
    const derived = derivedOf(policy, file);
    if (derived) out.push({ access: "write", file, scope: scopeOf(policy, file, "write"), hint: derived.hint ?? "" });
    else if (!canWrite(policy, file)) out.push({ access: "write", file, scope: scopeOf(policy, file, "write") });
  }
  for (const file of access.reads) if (!canRead(policy, file)) out.push({ access: "read", file, scope: scopeOf(policy, file, "read") });
  return out;
}

/** `~/x` for paths under home. */
export function shown(file: string): string {
  const home = homedir();
  return file === home ? "~" : file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

export function grantKey(v: Pick<Violation, "access" | "scope">): string {
  return `dir:${v.access}:${v.scope}`;
}

/** One line per policy part, for `/gate`. */
export function describePolicy(policy: Policy): string {
  const join = (items: readonly string[]) => (items.length ? items.map(shown).join(", ") : "none");
  return [
    `Project: ${join(policy.project)}.`,
    `Reads: ${policy.readAnywhere ? "anywhere" : `anywhere outside ${join(policy.private)}, plus ${join(policy.read)}`}.`,
    `Writes: the project, ${join(policy.write)}, and ${join(policy.alwaysWrite)}.`,
    ...(policy.derived.length ? [`Derived (writes held): ${join(policy.derived.map((d) => d.path))}.`] : []),
    ...(policy.exempt.length ? [`Not checked: ${policy.exempt.map((c) => `\`${c}\``).join(", ")}.`] : []),
  ].join("\n");
}
