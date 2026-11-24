// A repository's issue workflow: where work starts, how it lands. Read from GitHub (the default
// branch and the merge methods it allows), overridden by the checkout's optional .pi/issues.json.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Exec, run } from "./exec.ts";

export type MergeMethod = "rebase" | "merge" | "squash";
export type Land = { kind: "push" } | { kind: "merge"; method: MergeMethod };

export interface Workflow {
  /** owner/name. */
  repo: string;
  /** The main checkout, where .worktrees/ lives. */
  root: string;
  defaultBranch: string;
  /** The branch new work starts from and pull requests target. */
  base: string;
  land: Land;
  /** Extra task text for every issue session in this repository. */
  task?: string;
}

export interface Config {
  base?: string;
  land?: "push" | "merge";
  task?: string;
}

export const CONFIG_PATH = ".pi/issues.json";

export function parseConfig(text: string, path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${path}: ${(error as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid ${path}: must be a JSON object`);
  const o = raw as Record<string, unknown>;
  const config: Config = {};
  for (const key of ["base", "task"] as const) {
    if (o[key] === undefined) continue;
    if (typeof o[key] !== "string" || !(o[key] as string).trim()) throw new Error(`Invalid ${path}: ${key} must be a non-empty string`);
    config[key] = o[key] as string;
  }
  if (o.land !== undefined) {
    if (o.land !== "push" && o.land !== "merge") throw new Error(`Invalid ${path}: land must be "push" or "merge"`);
    config.land = o.land;
  }
  return config;
}

interface RepoView {
  nameWithOwner: string;
  defaultBranchRef: { name: string } | null;
  rebaseMergeAllowed: boolean;
  mergeCommitAllowed: boolean;
  squashMergeAllowed: boolean;
}

export async function resolveWorkflow(exec: Exec, cwd: string, read: (path: string) => string | undefined = readIfExists): Promise<Workflow> {
  const toplevel = (await run(exec, "git", ["rev-parse", "--show-toplevel"], cwd)).trim();
  const path = join(toplevel, CONFIG_PATH);
  const text = read(path);
  const config = text === undefined ? {} : parseConfig(text, path);
  const common = (await run(exec, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd)).trim();
  const root = common.replace(/\/\.git\/?$/u, "");
  const view = JSON.parse(
    await run(exec, "gh", ["repo", "view", "--json", "nameWithOwner,defaultBranchRef,rebaseMergeAllowed,mergeCommitAllowed,squashMergeAllowed"], root),
  ) as RepoView;
  const repo = view.nameWithOwner;
  const defaultBranch = view.defaultBranchRef?.name;
  if (!defaultBranch) throw new Error(`${repo} has no default branch`);
  let land: Land;
  if (config.land === "push") land = { kind: "push" };
  else {
    const method = view.rebaseMergeAllowed ? "rebase" : view.mergeCommitAllowed ? "merge" : view.squashMergeAllowed ? "squash" : undefined;
    if (!method) throw new Error(`${repo} allows no merge method; set land in ${CONFIG_PATH}`);
    land = { kind: "merge", method };
  }
  return { repo, root, defaultBranch, base: config.base ?? defaultBranch, land, ...(config.task ? { task: config.task } : {}) };
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
