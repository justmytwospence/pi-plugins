// Starting issues: link a branch on GitHub (`gh issue develop`), check it out in the shared
// worktree location (`git worktree add`), set the issues In progress, and write the task for the
// session that works there. Everything after that is GitHub's: a pull request whose body says
// `Closes #N` moves the issue to In review, and its merge into the default branch closes it.
import { suggestBranch } from "./branch.ts";
import { type Exec, run } from "./exec.ts";
import { fetchIssues, fetchStatuses, type Issue, setStatus } from "./github.ts";
import { resolveWorkflow, type Workflow } from "./workflow.ts";

/**
 * A fast-forward push of a pull request's commits to its base marks it merged, and its `Closes`
 * lines close the issues (checked against GitHub on 2026-11-24).
 */
export const PUSH_CLOSES_ISSUES = true;

const STARTED = new Set(["in progress", "in review", "done"]);

export interface StartResult {
  workflow: Workflow;
  issues: Issue[];
  branch: string;
  path: string;
  linked: "created" | "existing";
  worktree: "created" | "existing";
  inProgress: number[];
  statuses: boolean;
  task: string;
}

export async function startIssues(exec: Exec, cwd: string, numbers: number[], branch?: string): Promise<StartResult> {
  const wanted = [...new Set(numbers)];
  if (!wanted.length) throw new Error("issues: give at least one issue number");
  const workflow = await resolveWorkflow(exec, cwd);
  const { root } = workflow;
  const issues = await fetchIssues(exec, root, wanted);
  const statuses = await fetchStatuses(exec, root);
  for (const issue of issues) if (!issue.open) throw new Error(`#${issue.number} is closed; reopen it first`);
  const first = issues[0]!;

  const name = branch?.trim() || suggestBranch(first);
  if ((await exec("git", ["check-ref-format", "--branch", name], root)).code !== 0) throw new Error(`Invalid branch name: ${name}`);

  let linked: StartResult["linked"] = "existing";
  if (!first.linkedBranches.includes(name)) {
    if ((await exec("git", ["ls-remote", "--exit-code", "--heads", "origin", name], root)).code === 0) {
      throw new Error(`Branch ${name} already exists on origin but is not linked to #${first.number}; give another branch name.`);
    }
    await run(exec, "gh", ["issue", "develop", String(first.number), "--base", workflow.base, "--name", name], root);
    linked = "created";
  }

  // The location every harness shares (pi-herdr's spawn opens a worktree found exactly here).
  const path = `${root}/.worktrees/${name.replaceAll("/", "-")}`;
  let worktree: StartResult["worktree"] = "existing";
  const list = await run(exec, "git", ["worktree", "list", "--porcelain"], root);
  if (!list.split("\n").includes(`worktree ${path}`)) {
    await run(exec, "git", ["fetch", "origin", name], root);
    const local = (await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${name}`], root)).code === 0;
    await run(exec, "git", local ? ["worktree", "add", path, name] : ["worktree", "add", "--track", "-b", name, path, `origin/${name}`], root);
    worktree = "created";
  }

  const inProgress: number[] = [];
  const target = statuses.find((s) => s.name.toLowerCase() === "in progress");
  if (target) {
    for (const issue of issues) {
      if (STARTED.has((issue.status ?? "").toLowerCase())) continue;
      await setStatus(exec, root, issue.id, target.id);
      inProgress.push(issue.number);
    }
  }

  const hasStatuses = statuses.length > 0;
  return {
    workflow,
    issues,
    branch: name,
    path,
    linked,
    worktree,
    inProgress,
    statuses: hasStatuses,
    task: renderTask(workflow, issues, name, path, hasStatuses),
  };
}

export function renderTask(wf: Workflow, issues: Issue[], branch: string, path: string, statuses: boolean): string {
  const many = issues.length > 1;
  const s = many ? "s" : "";
  const list = issues.map((i) => `#${i.number} "${i.title}" (${i.url})`).join(" and ");
  const numbers = issues.map((i) => i.number).join(", ");
  // One keyword per issue: GitHub links (and closes) only issues a keyword names.
  const closes = issues.map((i) => `Closes #${i.number}`).join(", ");
  const title = issues[0]!.title.replaceAll('"', '\\"');
  const land =
    wf.land.kind === "push"
      ? `rebase onto origin/${wf.base}, run the checks AGENTS.md requires and tidy the commits, then fast-forward ${wf.base}: \`git push origin ${branch}:${wf.base}\`; GitHub records the pull request as merged.`
      : `run the checks AGENTS.md requires, then \`gh pr merge --${wf.land.method}\`.`;
  const githubCloses = wf.base === wf.defaultBranch && (wf.land.kind === "merge" || PUSH_CLOSES_ISSUES);
  const closing = githubCloses
    ? `Landing in ${wf.base}, the default branch, closes the issue${s}${statuses ? " (status Done)" : ""}.`
    : `GitHub closes issues only for merges into ${wf.defaultBranch}, so after landing ` +
      (statuses
        ? `set the issue${s} to Done with the issue tool (action=status, status=Done).`
        : `close ${many ? "them" : "it"} with \`gh issue close ${numbers}\`.`);
  const lines = [
    `Work on GitHub issue${s} ${list} in this worktree (${path}), on branch \`${branch}\`, which is linked to the issue on GitHub and starts from origin/${wf.base}.`,
    "",
    `1. Read the issue${s} (\`gh issue view <N> --comments\` for ${issues.map((i) => `#${i.number}`).join(", ")}) and this repository's AGENTS.md.`,
    "2. Plan the work, then implement it in small conventional commits with tests.",
    `3. When it is ready for review, push the branch and open a pull request into ${wf.base}: \`gh pr create --base ${wf.base} --title "${title}" --body "${closes}"\`. GitHub links it to the issue${s}${statuses ? ` and moves ${many ? "them" : "it"} to In review` : ""}.`,
    `4. Land it when the user asks, or when it is ready if AGENTS.md says so: ${land}`,
    closing,
  ];
  if (wf.task) lines.push("", wf.task);
  return lines.join("\n");
}

export function startReport(r: StartResult, inHerdr: boolean): string {
  const issues = r.issues.map((i) => `#${i.number} "${i.title}"`).join(", ");
  const progress = r.inProgress.length ? ` In progress: ${r.inProgress.map((n) => `#${n}`).join(", ")}.` : "";
  const next = inHerdr
    ? `Next: start the worktree session with herdr action=spawn where=worktree branch=${r.branch} and the task below as its task (fork=true instead when this conversation holds context the session needs).`
    : `Next: open a Pi session in ${r.path} and give it the task below.`;
  return [
    `${issues} → branch \`${r.branch}\` (${r.linked} link on GitHub, from origin/${r.workflow.base}), worktree ${r.path} (${r.worktree}).${progress}`,
    next,
    "",
    "Task:",
    r.task,
  ].join("\n");
}
