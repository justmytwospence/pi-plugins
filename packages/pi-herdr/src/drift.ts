// Base drift and branch overlap for a crew (crew.ts), from git alone and only on events.
//
// A worktree session's drift: how far its branch is behind `origin/<base>` (its PR's base, else
// the remote's default branch), which of the files it changed also changed upstream since they
// split, and, with git 2.38 or later, whether a rebase would conflict (`git merge-tree
// --write-tree`, which touches neither the checkout nor the index). Siblings' overlap: the files
// two crew branches both change, and whether merging them would conflict.
//
// Nothing here polls. RefWatcher watches the shared git directory's refs (any fetch, pull, commit,
// rebase or push in any checkout changes them), and the callers recompute on its events and on
// their own turns ending.
import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./core/children.ts";

export interface Drift {
  base: string;
  /** Commits on `origin/<base>` that the branch does not have. */
  behind: number;
  /** The sha of `origin/<base>` it was computed against. */
  upstreamSha?: string;
  /** `git log --oneline` of the newest of those commits (at most 5). */
  upstream: string[];
  /** Files changed both on the branch and upstream since their merge base. */
  overlap: string[];
  /** Files a rebase would conflict in; undefined when git cannot tell (older than 2.38). */
  conflicts?: string[];
}

const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

let mergeTreeSupport: Promise<boolean> | undefined;
/** Whether `git merge-tree --write-tree` exists (git 2.38 or later); checked once per process. */
export function gitSupportsMergeTree(exec: Exec, cwd: string): Promise<boolean> {
  mergeTreeSupport ??= exec("git", ["--version"], cwd).then((r) => {
    const m = /(\d+)\.(\d+)/u.exec(r.stdout);
    return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 38));
  }, () => false);
  return mergeTreeSupport;
}
/** Tests: forget the cached answer. */
export function resetMergeTreeSupport(): void {
  mergeTreeSupport = undefined;
}

/** The remote's default branch (`origin/HEAD`), or undefined. */
export async function defaultBase(exec: Exec, cwd: string): Promise<string | undefined> {
  const r = await exec("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
  return r.code === 0 ? r.stdout.trim().replace(/^origin\//u, "") || undefined : undefined;
}

/** The checkout's current branch, or undefined when detached. */
export async function currentBranch(exec: Exec, cwd: string): Promise<string | undefined> {
  const r = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

/** Files a merge of `a` and `b` would conflict in, `[]` when clean, undefined when git cannot tell. */
export async function mergeConflicts(exec: Exec, cwd: string, a: string, b: string): Promise<string[] | undefined> {
  if (!(await gitSupportsMergeTree(exec, cwd))) return undefined;
  const r = await exec("git", ["merge-tree", "--write-tree", "--name-only", "--no-messages", a, b], cwd);
  if (r.code === 0) return [];
  if (r.code !== 1) return undefined;
  // The first line is the tree's id; the rest name the conflicted files.
  const out = [...new Set(lines(r.stdout).slice(1))];
  return out.length ? out : undefined;
}

/** How `HEAD` in `cwd` stands against `origin/<base>`, or undefined when that ref does not exist. */
export async function computeDrift(exec: Exec, cwd: string, base: string): Promise<Drift | undefined> {
  const ref = `refs/remotes/origin/${base}`;
  const sha = await exec("git", ["rev-parse", "--verify", "--quiet", ref], cwd);
  if (sha.code !== 0) return undefined;
  const upstreamSha = sha.stdout.trim();
  const count = await exec("git", ["rev-list", "--count", `HEAD..${ref}`], cwd);
  if (count.code !== 0) return undefined;
  const behind = Number(count.stdout.trim()) || 0;
  if (!behind) return { base, behind: 0, upstreamSha, upstream: [], overlap: [] };
  const mb = await exec("git", ["merge-base", "HEAD", ref], cwd);
  if (mb.code !== 0) return { base, behind, upstreamSha, upstream: [], overlap: [] };
  const fork = mb.stdout.trim();
  const [ours, theirs, log] = await Promise.all([
    exec("git", ["diff", "--name-only", fork, "HEAD"], cwd),
    exec("git", ["diff", "--name-only", fork, ref], cwd),
    exec("git", ["log", "--oneline", "--no-decorate", "-5", `HEAD..${ref}`], cwd),
  ]);
  const mine = new Set(lines(ours.stdout));
  const overlap = lines(theirs.stdout).filter((f) => mine.has(f));
  const conflicts = overlap.length ? await mergeConflicts(exec, cwd, "HEAD", ref) : [];
  return { base, behind, upstreamSha, upstream: lines(log.stdout), overlap, ...(conflicts ? { conflicts } : {}) };
}

/** The `drift` workspace token: `↓3 develop`, `↓3 develop · 2 overlap`, `↓3 develop ✗ conflict`; undefined when not behind. */
export function driftToken(d: Drift | undefined): string | undefined {
  if (!d?.behind) return undefined;
  const head = `↓${d.behind} ${d.base}`;
  if (d.conflicts?.length) return `${head} ✗ conflict`;
  return d.overlap.length ? `${head} · ${d.overlap.length} overlap` : head;
}

/** Whether drift is worth telling the session about (it touches the same files), not only showing. */
export const driftMatters = (d: Drift | undefined): boolean => !!d?.behind && (d.overlap.length > 0 || !!d.conflicts?.length);

const fileList = (files: string[], max = 8) => files.slice(0, max).join(", ") + (files.length > max ? `, and ${files.length - max} more` : "");

/** The passive note a worktree session gets when its base moved under files it changed. */
export function driftNote(d: Drift): string {
  const parts = [
    `[Base drift, from pi-herdr, not the user: origin/${d.base} moved ${d.behind} commit${d.behind === 1 ? "" : "s"} ahead of this branch since they split]`,
  ];
  if (d.upstream.length) parts.push(`Newest upstream commits:\n${d.upstream.map((l) => `- ${l}`).join("\n")}`);
  if (d.conflicts?.length) parts.push(`A rebase onto origin/${d.base} would conflict in: ${fileList(d.conflicts)}.`);
  if (d.overlap.length) parts.push(`Files this branch changed that also changed upstream: ${fileList(d.overlap)}.`);
  parts.push("Rebase only if the user or a directive says so; mention this drift when it bears on what you are doing.");
  return parts.join("\n\n");
}

export interface BranchFiles {
  label: string;
  branch: string;
  base: string;
}

export interface Overlap {
  a: string;
  b: string;
  files: string[];
  /** Files merging the two would conflict in; undefined when git cannot tell. */
  conflicts?: string[];
}

/** Pairs of branches that change the same files since their bases, with a conflict prediction. */
export async function siblingOverlaps(exec: Exec, cwd: string, branches: BranchFiles[]): Promise<Overlap[]> {
  const changed = await Promise.all(branches.map(async (b) => {
    const r = await exec("git", ["diff", "--name-only", `refs/remotes/origin/${b.base}...refs/heads/${b.branch}`], cwd);
    return { ...b, files: r.code === 0 ? new Set(lines(r.stdout)) : new Set<string>() };
  }));
  const out: Overlap[] = [];
  for (let i = 0; i < changed.length; i++) {
    for (let j = i + 1; j < changed.length; j++) {
      const a = changed[i]!;
      const b = changed[j]!;
      const files = [...a.files].filter((f) => b.files.has(f)).sort();
      if (!files.length) continue;
      const conflicts = await mergeConflicts(exec, cwd, `refs/heads/${a.branch}`, `refs/heads/${b.branch}`);
      out.push({ a: a.label, b: b.label, files, ...(conflicts ? { conflicts } : {}) });
    }
  }
  return out;
}

/** One overlap's line in a crew update or the board. */
export function overlapLine(o: Overlap): string {
  const what = o.conflicts?.length ? `would conflict in ${fileList(o.conflicts, 3)}` : `${o.files.length} shared file${o.files.length === 1 ? "" : "s"} (${fileList(o.files, 3)})`;
  return `- overlap: ${o.a} ↔ ${o.b}: ${what}`;
}

export interface RefWatcherOptions {
  /** The shared git directory (`git rev-parse --git-common-dir`). */
  common: string;
  /** Which refs matter: remote-tracking refs (a fetch), local branches (a commit or rebase), or both. */
  kinds: Array<"remotes" | "heads">;
  debounceMs?: number;
  onChange(): void;
}

/**
 * Calls `onChange` once per burst of ref changes in a git directory: loose refs under `refs/` and
 * `packed-refs` (where `git pack-refs` and some fetches put them). Lock files are ignored. A watch
 * that errors (its directory removed) is re-armed a few seconds later.
 */
export class RefWatcher {
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rearm: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly opts: RefWatcherOptions;

  constructor(opts: RefWatcherOptions) {
    this.opts = opts;
    this.arm();
  }

  private relevant(name: string | null | undefined, scope: "refs" | "root"): boolean {
    if (!name) return true;
    const n = name.replaceAll("\\", "/");
    if (n.endsWith(".lock")) return false;
    if (scope === "root") return n === "packed-refs";
    return this.opts.kinds.some((k) => n === k || n.startsWith(`${k}/`));
  }

  private fire(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closed) this.opts.onChange();
    }, this.opts.debounceMs ?? 2_000);
    this.timer.unref?.();
  }

  private arm(): void {
    if (this.closed) return;
    const add = (path: string, recursive: boolean, scope: "refs" | "root") => {
      try {
        const w = watch(path, { recursive, persistent: false }, (_event, name) => {
          if (this.relevant(name == null ? undefined : String(name), scope)) this.fire();
        });
        w.on("error", () => this.retry());
        this.watchers.push(w);
      } catch {
        this.retry();
      }
    };
    add(join(this.opts.common, "refs"), true, "refs");
    add(this.opts.common, false, "root");
  }

  private retry(): void {
    if (this.closed || this.rearm) return;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    this.rearm = setTimeout(() => {
      this.rearm = undefined;
      this.arm();
    }, 5_000);
    this.rearm.unref?.();
  }

  close(): void {
    this.closed = true;
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.rearm) clearTimeout(this.rearm);
    this.timer = this.rearm = undefined;
  }
}
