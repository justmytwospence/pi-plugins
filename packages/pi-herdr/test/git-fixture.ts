// A real git fixture for drift and crew tests: a bare origin, a main checkout cloned from it, and
// worktrees, plus an Exec that runs git for real.
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../src/core/children.ts";

export const realExec: Exec = async (cmd, args, cwd) => {
  try {
    return { code: 0, stdout: execFileSync(cmd, args, { cwd, stdio: "pipe" }).toString(), stderr: "" };
  } catch (e: any) {
    return { code: typeof e.status === "number" ? e.status : 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? e.message) };
  }
};

/** origin (bare), a main checkout cloned from it, and worktrees `a` and `b` branched from main. */
export function remoteRepo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "drift-")));
  const origin = join(dir, "origin.git");
  const root = join(dir, "repo");
  const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" }).toString();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  execFileSync("git", ["clone", "-q", origin, root], { stdio: "pipe" });
  writeFileSync(join(root, "shared.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(root, "other.txt"), "x\n");
  sh(root, "add", ".");
  sh(root, "commit", "-q", "-m", "init");
  sh(root, "push", "-q", "origin", "main");
  sh(root, "remote", "set-head", "origin", "main");
  const a = join(root, ".worktrees/a");
  const b = join(root, ".worktrees/b");
  sh(root, "worktree", "add", "-q", a, "-b", "a");
  sh(root, "worktree", "add", "-q", b, "-b", "b");
  /** A commit on origin/main from a scratch clone, then a fetch into the repo. */
  const upstream = (file: string, text: string, msg = `upstream ${file}`, fetch = true) => {
    const scratch = join(dir, `scratch-${Math.random().toString(36).slice(2)}`);
    execFileSync("git", ["clone", "-q", origin, scratch], { stdio: "pipe" });
    writeFileSync(join(scratch, file), text);
    sh(scratch, "commit", "-qam", msg);
    sh(scratch, "push", "-q", "origin", "main");
    if (fetch) sh(root, "fetch", "-q", "origin");
  };
  const commit = (cwd: string, file: string, text: string) => {
    writeFileSync(join(cwd, file), text);
    sh(cwd, "commit", "-qam", `edit ${file}`);
  };
  return { dir, root, a, b, common: join(root, ".git"), upstream, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
