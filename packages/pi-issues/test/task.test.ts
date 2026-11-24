import { describe, expect, it } from "vitest";
import type { Issue } from "../src/github.ts";
import { renderTask, type StartResult, startReport } from "../src/start.ts";
import type { Workflow } from "../src/workflow.ts";

const issue = (number: number, title = `Issue ${number}`): Issue => ({
  id: `I_${number}`,
  number,
  title,
  url: `https://github.com/me/app/issues/${number}`,
  body: "",
  open: true,
  linkedBranches: [],
});
const wf = (o: Partial<Workflow> = {}): Workflow => ({ repo: "me/app", root: "/repo", defaultBranch: "dev", base: "dev", land: { kind: "push" }, ...o });
const PATH = "/repo/.worktrees/library";

describe("renderTask", () => {
  it("lands by fast-forward push and lets GitHub close the issue", () => {
    const task = renderTask(wf(), [issue(76, "Library panel")], "library", PATH, true);
    expect(task).toBe(
      [
        'Work on GitHub issue #76 "Library panel" (https://github.com/me/app/issues/76) in this worktree (/repo/.worktrees/library), on branch `library`, which is linked to the issue on GitHub and starts from origin/dev.',
        "",
        "1. Read the issue (`gh issue view <N> --comments` for #76) and this repository's AGENTS.md.",
        "2. Plan the work, then implement it in small conventional commits with tests.",
        '3. When it is ready for review, push the branch and open a pull request into dev: `gh pr create --base dev --title "Library panel" --body "Closes #76"`. GitHub links it to the issue and moves it to In review.',
        "4. Land it when the user asks, or when it is ready if AGENTS.md says so: rebase onto origin/dev, run the checks AGENTS.md requires and tidy the commits, then fast-forward dev: `git push origin library:dev`; GitHub records the pull request as merged.",
        "Landing in dev, the default branch, closes the issue (status Done).",
      ].join("\n"),
    );
  });

  it("merges with the repository's method", () => {
    const task = renderTask(wf({ defaultBranch: "main", base: "main", land: { kind: "merge", method: "squash" } }), [issue(1)], "x", PATH, true);
    expect(task).toContain("4. Land it when the user asks, or when it is ready if AGENTS.md says so: run the checks AGENTS.md requires, then `gh pr merge --squash`.");
    expect(task).toContain("Landing in main, the default branch, closes the issue (status Done).");
  });

  it("closes issues itself when the base is not the default branch", () => {
    const withStatuses = renderTask(wf({ base: "next" }), [issue(1), issue(2)], "x", PATH, true);
    expect(withStatuses).toContain("GitHub closes issues only for merges into dev, so after landing set the issues to Done with the issue tool (action=status, status=Done).");
    const without = renderTask(wf({ base: "next" }), [issue(1), issue(2)], "x", PATH, false);
    expect(without).toContain("so after landing close them with `gh issue close 1, 2`.");
    expect(without).not.toContain("In review");
  });

  it("names every issue in the pull request and appends the repository's task text", () => {
    const task = renderTask(wf({ task: "Run one e2e at a time." }), [issue(57), issue(65)], "x", PATH, true);
    expect(task).toContain('--body "Closes #57, Closes #65"');
    expect(task).toContain("GitHub links it to the issues and moves them to In review.");
    expect(task).toContain("closes the issues (status Done).");
    expect(task.endsWith("\n\nRun one e2e at a time.")).toBe(true);
  });
});

describe("startReport", () => {
  const result: StartResult = {
    workflow: wf(),
    issues: [issue(76, "Library panel")],
    branch: "library",
    path: PATH,
    linked: "created",
    worktree: "created",
    inProgress: [76],
    statuses: true,
    task: "THE TASK",
  };

  it("tells the agent to spawn the herdr worktree session", () => {
    expect(startReport(result, true)).toBe(
      [
        '#76 "Library panel" → branch `library` (created link on GitHub, from origin/dev), worktree /repo/.worktrees/library (created). In progress: #76.',
        "Next: start the worktree session with herdr action=spawn where=worktree branch=library and the task below as its task (fork=true instead when this conversation holds context the session needs).",
        "",
        "Task:",
        "THE TASK",
      ].join("\n"),
    );
  });

  it("outside herdr, points at the checkout", () => {
    expect(startReport({ ...result, inProgress: [] }, false)).toContain("(created).\nNext: open a Pi session in /repo/.worktrees/library and give it the task below.");
  });
});
