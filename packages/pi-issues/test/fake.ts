import type { Exec, ExecResult } from "../src/exec.ts";

export type Responder = (line: string, cwd: string) => Partial<ExecResult> | string | undefined;

/** A fake Exec: each call's `cmd args...` line goes to the responders in order; the first answer wins. */
export function fakeExec(...responders: Responder[]): Exec & { calls: string[] } {
  const calls: string[] = [];
  const exec = (async (cmd: string, args: string[], cwd: string) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    for (const respond of responders) {
      const answer = respond(line, cwd);
      if (answer === undefined) continue;
      if (typeof answer === "string") return { stdout: answer, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0, ...answer };
    }
    return { stdout: "", stderr: `unexpected: ${line}`, code: 1 };
  }) as Exec & { calls: string[] };
  exec.calls = calls;
  return exec;
}

export const ROOT = "/repo";

export interface RepoOptions {
  defaultBranch?: string;
  rebase?: boolean;
  merge?: boolean;
  squash?: boolean;
}

/** git rev-parse and gh repo view for a main checkout at ROOT. */
export function repo(o: RepoOptions = {}): Responder {
  return (line) => {
    if (line === "git rev-parse --show-toplevel") return `${ROOT}\n`;
    if (line === "git rev-parse --path-format=absolute --git-common-dir") return `${ROOT}/.git\n`;
    if (line.startsWith("gh repo view")) {
      return JSON.stringify({
        nameWithOwner: "me/app",
        defaultBranchRef: { name: o.defaultBranch ?? "dev" },
        rebaseMergeAllowed: o.rebase ?? true,
        mergeCommitAllowed: o.merge ?? true,
        squashMergeAllowed: o.squash ?? true,
      });
    }
    return undefined;
  };
}

export interface FakeIssue {
  number: number;
  title?: string;
  body?: string;
  state?: "OPEN" | "CLOSED";
  status?: string;
  linked?: string[];
  prHeads?: string[];
}

export const STATUSES = [
  { id: "S_backlog", name: "Backlog" },
  { id: "S_todo", name: "Todo" },
  { id: "S_progress", name: "In progress" },
  { id: "S_review", name: "In review" },
  { id: "S_done", name: "Done" },
];

/** GraphQL reads: the issues asked for, and the repository's statuses (none when `statuses` is false). */
export function github(issues: FakeIssue[], statuses = true): Responder {
  return (line) => {
    if (!line.startsWith("gh api graphql")) return undefined;
    if (line.includes("planningStatuses")) {
      return JSON.stringify({ data: { repository: { planningStatuses: statuses ? { nodes: STATUSES } : null } } });
    }
    if (line.includes("setIssueStatus")) return "{}";
    const repository: Record<string, unknown> = {};
    for (const match of line.matchAll(/i(\d+): issue\(number:\d+\)/g)) {
      const n = Number(match[1]);
      const i = issues.find((x) => x.number === n);
      repository[`i${n}`] = i
        ? {
            id: `I_${n}`,
            number: n,
            title: i.title ?? `Issue ${n}`,
            url: `https://github.com/me/app/issues/${n}`,
            body: i.body ?? "",
            state: i.state ?? "OPEN",
            status: i.status ? { name: i.status } : null,
            linkedBranches: { nodes: (i.linked ?? []).map((name) => ({ ref: { name } })) },
            closedByPullRequestsReferences: { nodes: (i.prHeads ?? []).map((headRefName) => ({ headRefName })) },
          }
        : null;
    }
    return JSON.stringify({ data: { repository } });
  };
}
