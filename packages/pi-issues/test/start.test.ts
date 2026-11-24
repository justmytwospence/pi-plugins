import { describe, expect, it } from "vitest";
import { startIssues } from "../src/start.ts";
import { type FakeIssue, fakeExec, github, repo, ROOT } from "./fake.ts";

/** Branch and worktree state for one start: remote branches, local branches and worktrees that exist. */
function git(o: { remote?: string[]; local?: string[]; worktrees?: string[] } = {}) {
  return (line: string) => {
    if (line.startsWith("git check-ref-format --branch ")) return /\s|\.\.|~|\^|:/.test(line.slice(30)) ? { code: 1 } : "";
    if (line.startsWith("git ls-remote --exit-code --heads origin ")) return (o.remote ?? []).includes(line.split(" ").pop()!) ? "sha\n" : { code: 2 };
    if (line === "git worktree list --porcelain") return [ROOT, ...(o.worktrees ?? [])].map((w) => `worktree ${w}\n`).join("");
    if (line.startsWith("git show-ref --verify --quiet refs/heads/")) return (o.local ?? []).includes(line.slice(41)) ? "" : { code: 1 };
    if (line.startsWith("git fetch origin ") || line.startsWith("git worktree add ") || line.startsWith("gh issue develop ")) return "";
    return undefined;
  };
}

const start = (issues: FakeIssue[], numbers: number[], opts: { branch?: string; statuses?: boolean; git?: Parameters<typeof git>[0] } = {}) => {
  const exec = fakeExec(repo(), git(opts.git), github(issues, opts.statuses ?? true));
  return { exec, result: startIssues(exec, ROOT, numbers, opts.branch) };
};

describe("startIssues", () => {
  it("links a new branch from the base, checks it out in .worktrees and sets In progress", async () => {
    const { exec, result } = start([{ number: 76, title: "Library panel: saved routes", status: "Backlog" }], [76], { branch: "library" });
    const r = await result;
    expect(exec.calls).toContain("gh issue develop 76 --base dev --name library");
    expect(exec.calls).toContain("git fetch origin library");
    expect(exec.calls).toContain(`git worktree add --track -b library ${ROOT}/.worktrees/library origin/library`);
    expect(exec.calls.filter((c) => c.includes("setIssueStatus"))).toEqual([
      expect.stringContaining("issue=I_76 -f status=S_progress"),
    ]);
    expect(r).toMatchObject({ branch: "library", path: `${ROOT}/.worktrees/library`, linked: "created", worktree: "created", inProgress: [76], statuses: true });
  });

  it("reuses a linked branch and its worktree", async () => {
    const { exec, result } = start([{ number: 76, linked: ["library"], status: "In progress" }], [76], { git: { worktrees: [`${ROOT}/.worktrees/library`] } });
    const r = await result;
    expect(r).toMatchObject({ branch: "library", linked: "existing", worktree: "existing", inProgress: [] });
    expect(exec.calls.some((c) => c.startsWith("gh issue develop") || c.startsWith("git worktree add") || c.includes("setIssueStatus"))).toBe(false);
  });

  it("counts an open pull request's branch as linked, and checks out an existing local branch", async () => {
    const { exec, result } = start([{ number: 5, prHeads: ["fix-it"], status: "In review" }], [5], { git: { remote: ["fix-it"], local: ["fix-it"] } });
    const r = await result;
    expect(r.linked).toBe("existing");
    expect(exec.calls).toContain(`git worktree add ${ROOT}/.worktrees/fix-it fix-it`);
    expect(r.inProgress).toEqual([]);
  });

  it("refuses a remote branch that is not linked to the issue", async () => {
    const { result } = start([{ number: 7 }], [7], { branch: "taken", git: { remote: ["taken"] } });
    await expect(result).rejects.toThrow("Branch taken already exists on origin but is not linked to #7; give another branch name.");
  });

  it("refuses a closed issue, a missing one and a bad branch name", async () => {
    await expect(start([{ number: 8, state: "CLOSED" }], [8]).result).rejects.toThrow("#8 is closed; reopen it first");
    await expect(start([], [9]).result).rejects.toThrow("#9 not found in this repository");
    await expect(start([{ number: 10 }], [10], { branch: "bad name" }).result).rejects.toThrow("Invalid branch name: bad name");
    await expect(start([], []).result).rejects.toThrow("issues: give at least one issue number");
  });

  it("sets no status where the repository has none, and says nothing of In review", async () => {
    const { exec, result } = start([{ number: 3 }], [3], { statuses: false });
    const r = await result;
    expect(exec.calls.some((c) => c.includes("setIssueStatus"))).toBe(false);
    expect(r.statuses).toBe(false);
    expect(r.task).not.toContain("In review");
  });

  it("puts a branch with slashes in a dashed directory, and one branch serves several issues", async () => {
    const { exec, result } = start([{ number: 57, status: "Todo" }, { number: 65 }], [57, 65, 57], { branch: "feat/two" });
    const r = await result;
    expect(r.path).toBe(`${ROOT}/.worktrees/feat-two`);
    expect(exec.calls.filter((c) => c.startsWith("gh issue develop"))).toEqual(["gh issue develop 57 --base dev --name feat/two"]);
    expect(r.inProgress).toEqual([57, 65]);
  });
});
