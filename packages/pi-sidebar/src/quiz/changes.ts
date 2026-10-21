// What main changed while quiz mode was on: files that differ from the commit quiz mode started at
// (committed or not, plus new untracked files), and which of them changed again since the last
// question. Only reads git and file metadata.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import type { QuizChanges } from "./prompt.ts";

const TIMEOUT_MS = 3_000;
const MAX_FILES = 500;

export type Git = (args: string[], cwd: string) => Promise<string | undefined>;

export const git: Git = (args, cwd) =>
  new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });

export async function repoRoot(cwd: string, run: Git = git): Promise<string> {
  return (await run(["rev-parse", "--show-toplevel"], cwd))?.trim() || cwd;
}

export async function headCommit(cwd: string, run: Git = git): Promise<string | undefined> {
  return (await run(["rev-parse", "--verify", "-q", "HEAD"], cwd))?.trim() || undefined;
}

const lines = (text: string | undefined) => (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);

/** Files that differ from `base` now: tracked changes (committed since, staged or not) and new files. */
export async function changedFiles(root: string, base: string | undefined, run: Git = git): Promise<string[]> {
  const tracked = base ? lines(await run(["diff", "--name-only", base], root)) : lines(await run(["diff", "--name-only", "HEAD"], root));
  const untracked = lines(await run(["ls-files", "--others", "--exclude-standard"], root));
  return [...new Set([...tracked, ...untracked])].sort().slice(0, MAX_FILES);
}

export type Signatures = Record<string, string>;

/** Size and modification time per file (a removed file reads as "gone"). */
export function signatures(root: string, files: readonly string[]): Signatures {
  const out: Signatures = {};
  for (const file of files) {
    try {
      const s = statSync(path.join(root, file));
      out[file] = `${s.size}:${Math.round(s.mtimeMs)}`;
    } catch {
      out[file] = "gone";
    }
  }
  return out;
}

/** The changes for the next question, measured against the signatures taken at the last one. */
export async function quizChanges(root: string, base: string | undefined, last: Signatures, run: Git = git): Promise<{ changes: QuizChanges; now: Signatures }> {
  const files = await changedFiles(root, base, run);
  const now = signatures(root, files);
  const sinceLast = files.filter((file) => last[file] !== now[file]);
  return { changes: { ...(base ? { base } : {}), files, sinceLast }, now };
}
