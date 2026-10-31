import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ProjectContext = { cwd: string; root: string; main: string; isGit: boolean };

const discoveryOverrides = [
  "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

/** Negative evidence only: never infer a checkout from filesystem metadata. */
function verifyNonGit(launch: string): void {
  if (discoveryOverrides.some(key => process.env[key] !== undefined)) {
    throw new Error("Git discovery environment override");
  }
  const exists = (file: string) => {
    try { lstatSync(file); return true; } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
  };
  for (let dir = launch; ; dir = path.dirname(dir)) {
    if (exists(path.join(dir, ".git"))) throw new Error("Unresolved Git metadata");
    if (exists(path.join(dir, "HEAD")) &&
        ["objects", "refs", "config"].some(name => exists(path.join(dir, name)))) {
      throw new Error("Apparent bare Git metadata");
    }
    if (path.dirname(dir) === dir) break;
  }
}

function parseMainWorktreeNul(output: string): string {
  const end = output.indexOf("\0\0");
  if (end < 0) throw new Error("Missing main checkout metadata");
  const fields = output.slice(0, end).split("\0");
  const first = fields[0];
  if (!first?.startsWith("worktree ") || fields.includes("bare") ||
      fields.slice(1).some(field => field.startsWith("worktree "))) {
    throw new Error("Invalid or bare main checkout metadata");
  }
  const mainPath = first.slice("worktree ".length);
  if (!path.isAbsolute(mainPath)) throw new Error("Invalid main checkout path");
  return mainPath;
}

function parseMainWorktreeLegacy(output: string): string {
  // Old Git writes raw, unquoted paths. Validate the WHOLE listing, but do not
  // mistake this grammar for proof of path boundaries: a path can forge records.
  if (!output.endsWith("\n\n")) throw new Error("Incomplete legacy worktree listing");
  const records = output.slice(0, -2).split("\n\n");
  let mainPath = "";
  const paths = new Set<string>();
  for (const record of records) {
    const fields = record.split("\n");
    const candidate = fields[0]?.startsWith("worktree ") ? fields[0].slice(9) : "";
    if (fields.length !== 3 || !path.isAbsolute(candidate) || paths.has(candidate) || /[\x00-\x1f\x7f]/u.test(candidate) ||
        !/^HEAD (?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u.test(fields[1]!) ||
        !(fields[2] === "detached" || /^branch refs\/[^\s\x00-\x1f\x7f]+$/u.test(fields[2]!))) {
      throw new Error("Invalid or ambiguous legacy worktree listing");
    }
    paths.add(candidate);
    if (!mainPath) mainPath = candidate;
  }
  return mainPath;
}

/** Shared policy belongs to the active checkout; local approvals belong to its main checkout. */
export async function resolveProject(cwd: string, exec: ExtensionAPI["exec"]): Promise<ProjectContext> {
  try {
    const launch = realpathSync(cwd);
    // Control the diagnostic locale, not the user's Git discovery configuration.
    const identified = await exec("env", ["LC_ALL=C", "git", "-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 2_000 });
    if (identified.killed || identified.code !== 0) {
      if (identified.killed || identified.code !== 128 || identified.stdout !== "" ||
          !/^fatal: not a git repository \(or any of the parent directories\): \.git\n?$/u.test(identified.stderr)) {
        throw new Error("Git discovery failed");
      }
      verifyNonGit(launch);
      return { cwd: launch, root: launch, main: launch, isGit: false };
    }
    // Query paths separately: line splitting or trimming corrupts valid Git path names.
    const git = async (dir: string, args: string[]) => {
      const out = await exec("git", ["-C", dir, ...args], { timeout: 2_000 });
      if (out.killed || out.code !== 0) throw new Error("Git metadata lookup failed");
      return out.stdout;
    };
    const canonicalOutputPath = (output: string, dir: string, allowRelative = false) => {
      // Git appends exactly one LF; any preceding whitespace belongs to the path.
      if (!output.endsWith("\n")) throw new Error("Invalid Git path metadata");
      const value = output.slice(0, -1);
      if (!value || value.includes("\0") || (!allowRelative && !path.isAbsolute(value))) {
        throw new Error("Invalid Git path metadata");
      }
      return realpathSync(path.resolve(dir, value));
    };
    const root = canonicalOutputPath(identified.stdout, launch);
    const gitDir = canonicalOutputPath(await git(cwd, ["rev-parse", "--absolute-git-dir"]), launch);
    const commonDir = canonicalOutputPath(await git(cwd, ["rev-parse", "--git-common-dir"]), launch, true);
    if (gitDir === commonDir) return { cwd: launch, root, main: root, isGit: true };

    // Keep raw status/stderr: only Git's specific old-version diagnostic permits
    // a retry. A timeout, malformed successful output or any other error must deny.
    const list = (nul: boolean) => exec("env", ["LC_ALL=C", "git", "-C", cwd, "worktree", "list", "--porcelain", ...(nul ? ["-z"] : [])], { timeout: 2_000 });
    let listing = await list(true);
    const legacy = !listing.killed && listing.code === 129 &&
      /^error: unknown switch `z'\n(?:usage: [\s\S]*)?$/u.test(listing.stderr);
    if (legacy) listing = await list(false);
    if (listing.killed || listing.code !== 0) throw new Error("Git metadata lookup failed");
    const mainPath = legacy ? parseMainWorktreeLegacy(listing.stdout) : parseMainWorktreeNul(listing.stdout);
    if (legacy) {
      // Raw newline injection can mimic even a complete valid listing. Only a
      // canonical main/.git directory (not a gitfile or symlink) proves the main
      // boundary independently of those lines. Separate git dirs/submodules do
      // not have that proof on old Git; never infer a checkout from their names.
      const candidate = realpathSync(mainPath);
      const metadata = path.join(candidate, ".git");
      if (commonDir !== metadata || !lstatSync(metadata).isDirectory()) {
        throw new Error("Unprovable legacy main checkout boundary");
      }
    }
    const verify = async (candidate: string) => {
      const main = realpathSync(candidate);
      if (canonicalOutputPath(await git(main, ["rev-parse", "--show-toplevel"]), main) !== main ||
          canonicalOutputPath(await git(main, ["rev-parse", "--absolute-git-dir"]), main) !== commonDir ||
          canonicalOutputPath(await git(main, ["rev-parse", "--git-common-dir"]), main, true) !== commonDir) {
        throw new Error("Main checkout does not identify the same Git common directory");
      }
      return main;
    };
    let main: string;
    try {
      main = await verify(mainPath);
    } catch (cause) {
      if (realpathSync(mainPath) !== commonDir) throw cause;
      // Only repository-owned configuration can map administrative metadata back
      // to its checkout. In particular, global core.worktree is not evidence.
      const config = async (scope: "local" | "worktree", key: string, boolean = false) => {
        const out = await exec("git", ["--git-dir", commonDir, "config", `--${scope}`, ...(boolean ? ["--type=bool"] : []), "--null", "--get", key], { timeout: 2_000 });
        if (out.code === 1) return undefined;
        if (out.code !== 0 || !out.stdout.endsWith("\0")) throw new Error("Invalid repository configuration");
        return out.stdout.slice(0, -1);
      };
      const enabled = await config("local", "extensions.worktreeConfig", true);
      const worktree = enabled === "true"
        ? await config("worktree", "core.worktree") : undefined;
      const mapping = worktree ?? await config("local", "core.worktree");
      if (!mapping || mapping.includes("\0")) throw new Error("Missing main checkout mapping");
      main = await verify(path.resolve(commonDir, mapping));
    }
    return { cwd: launch, root, main, isGit: true };
  } catch (cause) {
    throw new Error("Policy resolution failed: cannot resolve Git main checkout", { cause });
  }
}

/** Low-to-high precedence JSON project scopes; never inherit the main checkout's shared policy. */
export function projectFiles(project: ProjectContext): string[] {
  return [
    path.join(project.root, ".agents", "tool-gate.json"),
    path.join(project.root, ".pi", "tool-gate.json"),
    projectSaveFile(project),
  ];
}

export function projectSaveFile(project: ProjectContext, persistence: "local" | "shared" = "local"): string {
  return persistence === "shared"
    ? path.join(project.root, ".pi", "tool-gate.json")
    : path.join(project.main, ".pi", "tool-gate.local.json");
}
