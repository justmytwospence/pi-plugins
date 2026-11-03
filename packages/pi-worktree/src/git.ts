// Git (and gh) helpers for task worktrees. Everything takes a Run function so it
// works the same inside Pi, after a session switch, and in tests.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join, sep } from "node:path";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }) => Promise<RunResult>;

/** execFile wrapper that never throws: code is the exit status (127 when the binary is missing). */
export const nodeRun: Run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 60_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const err = error as NodeJS.ErrnoException & { code?: number | string };
      const code = typeof err.code === "number" ? err.code : err.code === "ENOENT" ? 127 : 1;
      resolve({ code, stdout: stdout ?? "", stderr: stderr || err.message });
    });
  });

export type Worktree = {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
};

/** Parse `git worktree list --porcelain`; the main checkout comes first. Bare entries are skipped. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").filter(Boolean);
    if (!lines.length || lines.includes("bare")) continue;
    const w: Worktree = { path: "", detached: false, locked: false, prunable: false };
    for (const line of lines) {
      if (line.startsWith("worktree ")) w.path = line.slice(9);
      else if (line.startsWith("HEAD ")) w.head = line.slice(5);
      else if (line.startsWith("branch ")) w.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") w.detached = true;
      else if (line === "locked" || line.startsWith("locked ")) {
        w.locked = true;
        const reason = line.slice(7);
        if (reason) w.lockReason = reason;
      } else if (line === "prunable" || line.startsWith("prunable ")) w.prunable = true;
    }
    if (w.path) out.push(w);
  }
  return out;
}

export async function listWorktrees(run: Run, cwd: string): Promise<Worktree[] | undefined> {
  const res = await run("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
  if (res.code !== 0) return undefined;
  const list = parseWorktrees(res.stdout);
  return list.length ? list : undefined;
}

export const worktreePath = (root: string, branch: string) => join(root, ".worktrees", branch.replaceAll("/", "-"));

/** A checkout this extension may manage: under <root>/.worktrees, not one of pi-subagents' own. */
export const isManaged = (root: string, w: Worktree) =>
  w.path.startsWith(join(root, ".worktrees") + sep) && !basename(w.path).startsWith("subagent-");

export const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

export async function fetchOrigin(run: Run, root: string): Promise<boolean> {
  return (await run("git", ["-C", root, "fetch", "--prune", "origin"], { timeout: 60_000 })).code === 0;
}

/** origin/HEAD (e.g. origin/main), else origin/main, else HEAD. */
export async function defaultBase(run: Run, root: string): Promise<string> {
  const head = await run("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  const main = await run("git", ["-C", root, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]);
  return main.code === 0 ? "origin/main" : "HEAD";
}

export async function branchExists(run: Run, root: string, branch: string): Promise<boolean> {
  return (await run("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

export async function validBranch(run: Run, branch: string): Promise<boolean> {
  return (await run("git", ["check-ref-format", "--branch", branch])).code === 0;
}

export async function isClean(run: Run, path: string): Promise<boolean> {
  const res = await run("git", ["-C", path, "status", "--porcelain"]);
  return res.code === 0 && res.stdout.trim() === "";
}

export const lockReason = (pid: number = process.pid, host: string = hostname()) => `pi-worktree pid ${pid} host ${host}`;

export function parseLockReason(reason?: string): { pid: number; host: string } | undefined {
  const m = /^pi-worktree pid (\d+) host (\S+)$/.exec(reason ?? "");
  return m ? { pid: Number(m[1]), host: m[2] } : undefined;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether a live Pi session (or anything else that locked it) is using the worktree. */
export function inUse(
  w: Worktree,
  host: string = hostname(),
  alive: (pid: number) => boolean = pidAlive,
): { busy: boolean; pid?: number; host?: string } {
  if (!w.locked) return { busy: false };
  const lock = parseLockReason(w.lockReason);
  if (!lock) return { busy: true };
  if (lock.host !== host) return { busy: true, ...lock };
  return { busy: alive(lock.pid), ...lock };
}

/** Merged = a merged pull request whose head is exactly the branch's current commit. */
export async function isMerged(run: Run, root: string, branch: string): Promise<{ merged: boolean; sha?: string; note?: string }> {
  const rev = await run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (rev.code !== 0 || !rev.stdout.trim()) return { merged: false, note: "no such branch" };
  const sha = rev.stdout.trim();
  const gh = await run("gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid", "--limit", "20"], { cwd: root });
  if (gh.code !== 0) {
    const line = gh.stderr.trim().split("\n")[0] || `exit ${gh.code}`;
    return { merged: false, sha, note: `gh could not check pull requests: ${line}` };
  }
  try {
    const prs = JSON.parse(gh.stdout) as Array<{ headRefOid?: string }>;
    return { merged: prs.some((pr) => pr.headRefOid === sha), sha };
  } catch {
    return { merged: false, sha, note: "unreadable gh output" };
  }
}

/** Remove a worktree (never with git's --force) and then its branch. */
export async function removeWorktree(run: Run, root: string, w: Worktree): Promise<{ ok: boolean; error?: string }> {
  if (w.locked) await run("git", ["-C", root, "worktree", "unlock", w.path]);
  const rm = await run("git", ["-C", root, "worktree", "remove", w.path]);
  if (rm.code !== 0) return { ok: false, error: rm.stderr.trim() || `exit ${rm.code}` };
  if (w.branch) {
    const br = await run("git", ["-C", root, "branch", "-D", w.branch]);
    if (br.code !== 0) return { ok: true, error: `branch kept: ${br.stderr.trim() || `exit ${br.code}`}` };
  }
  return { ok: true };
}

/** Fast-forward a clean main checkout that sits on the base branch. */
export async function fastForwardRoot(run: Run, root: string, base: string): Promise<{ updated: boolean; lockfileChanged: boolean }> {
  const none = { updated: false, lockfileChanged: false };
  if (base === "HEAD") return none;
  const branch = await run("git", ["-C", root, "symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch.code !== 0 || branch.stdout.trim() !== base.replace(/^origin\//, "")) return none;
  if (!(await isClean(run, root))) return none;
  const before = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  const ff = await run("git", ["-C", root, "merge", "--ff-only", base]);
  if (ff.code !== 0) return none;
  const after = (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  if (!before || after === before) return none;
  const diff = await run("git", ["-C", root, "diff", "--name-only", before, "HEAD", "--", "package-lock.json"]);
  return { updated: true, lockfileChanged: diff.stdout.trim() !== "" };
}

/** Remove clean, merged, unused managed worktrees other than `exclude`. The caller fetches first. */
export async function pruneMerged(run: Run, root: string, exclude: string): Promise<{ removed: string[]; failed: string[] }> {
  const removed: string[] = [];
  const failed: string[] = [];
  await run("git", ["-C", root, "worktree", "prune"]);
  const list = (await listWorktrees(run, root)) ?? [];
  const skip = real(exclude);
  for (const w of list.slice(1)) {
    if (!isManaged(root, w) || !w.branch || real(w.path) === skip) continue;
    if (inUse(w).busy || !(await isClean(run, w.path))) continue;
    if (!(await isMerged(run, root, w.branch)).merged) continue;
    const res = await removeWorktree(run, root, w);
    if (res.ok) removed.push(w.branch);
    else failed.push(`${w.branch}: ${res.error}`);
  }
  return { removed, failed };
}
