// What the plan workflow lets a session change while it plans: nothing in the repository (no tracked
// file, no new file git would not ignore, no git state), and everything outside it. The plan file and
// its scratch directory (`<plan>.spike/`, for spikes and prototypes) are the places the agent writes.
// Pure: index.ts looks up git, the project and the classifier first.
import path from "node:path";
import { canonicalPath, shown, under } from "./dirs.ts";

export interface PlanScope {
  /** The project's root: the repository that must not change. */
  root: string;
  /** pi-plan-mode's plan file. */
  planFile?: string;
  /** The directory the agent may write scratch files under. */
  scratchDir?: string;
}

/** Whether `file` (canonical, absolute) is the plan file or lies under the scratch directory. */
export function inScratch(file: string, scope: Pick<PlanScope, "planFile" | "scratchDir">): boolean {
  return file === scope.planFile || (scope.scratchDir !== undefined && under(file, scope.scratchDir));
}

/**
 * The writes of a shell call that land in the repository, minus the plan file and scratch directory:
 * `git` for anything in `.git` (the repository's own state: never allowed), `other` for the rest,
 * which are allowed only when git ignores them.
 */
export function repoWriteCandidates(writes: readonly string[], scope: PlanScope): { git: string[]; other: string[] } {
  const git: string[] = [];
  const other: string[] = [];
  const dotGit = path.join(scope.root, ".git");
  for (const written of writes) {
    const file = canonicalPath(written);
    if (inScratch(file, scope)) continue;
    if (file === dotGit || file.startsWith(`${dotGit}${path.sep}`) || path.basename(file) === ".git") git.push(file);
    else if (under(file, scope.root)) other.push(file);
  }
  return { git, other };
}

/** Why a plan-workflow `edit` or `write` was blocked. */
export function planEditBlockReason(planFile?: string, scratchDir?: string): string {
  const may = [planFile ? `the plan file, ${planFile}` : undefined, scratchDir ? `scratch files under ${scratchDir}` : undefined].filter(Boolean);
  return `Plan mode is on: nothing in the repository may be edited until the user approves a plan. You may write ${may.length ? may.join(", and ") : "only outside the repository"}.`;
}

const END = (scratchDir?: string) =>
  `${scratchDir ? ` Write spikes and prototypes under ${scratchDir}.` : ""} If this step must change the repository, put it in the plan; do not work around this block.`;

/** Why a plan-workflow shell call was blocked: the repository files it would write, or the classifier's doubt. */
export function planShellBlockReason(
  tool: string,
  detail: { files?: readonly string[]; unavailable?: boolean },
  scratchDir?: string,
): string {
  if (detail.files?.length) {
    return `Plan mode is on: this ${tool} call would write ${detail.files.map(shown).join(", ")} in the repository, which stays unchanged until the user approves a plan.${END(scratchDir)}`;
  }
  return (
    "Plan mode is on: shell commands that may change the repository (tracked files, new files git would not ignore, or git state) are blocked until the user approves a plan. " +
    (detail.unavailable ? "System 1 could not confirm that this one does not." : "System 1 judged that this one might.") +
    END(scratchDir)
  );
}

/** The hidden notice a session gets when its parent is planning and it inherits the plan scope. */
export function delegatedPlanText(scratchDir?: string): string {
  return `<system-reminder>
The session that started you is planning: its repository must not change until its user approves a plan. Do not edit files in the repository or change its git state; shell commands that might are blocked. ${scratchDir ? `You may write scratch files (spikes, prototypes, notes) under ${scratchDir}.` : "You may write only outside the repository."} Report what you find; your parent decides what goes into the plan.
</system-reminder>`;
}
