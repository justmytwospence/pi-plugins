// GitHub reads and the one write we make ourselves (an issue's status), through `gh`.
import { type Exec, run } from "./exec.ts";

export interface Issue {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string;
  open: boolean;
  status?: string;
  /**
   * Branches linked to the issue: its Development branches, then the head branches of its open
   * pull requests (GitHub drops the branch link once a pull request from it links the issue).
   */
  linkedBranches: string[];
}

export interface Status {
  id: string;
  name: string;
}

/** `-F owner=… -F name=…` for a repository, or gh's placeholders for the one at `cwd`. */
function repoFields(repo?: string): string[] {
  if (!repo) return ["-F", "owner={owner}", "-F", "name={repo}"];
  const [owner, name, extra] = repo.split("/");
  if (!owner || !name || extra !== undefined) throw new Error(`repo must be owner/name, not "${repo}"`);
  return ["-F", `owner=${owner}`, "-F", `name=${name}`];
}

const REPO_QUERY = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){";

interface RawIssue {
  id: string;
  number: number;
  title: string;
  url: string;
  body: string;
  state: string;
  status: { name: string } | null;
  linkedBranches: { nodes: { ref: { name: string } | null }[] };
  closedByPullRequestsReferences: { nodes: { headRefName: string }[] };
}

export async function fetchIssues(exec: Exec, root: string, numbers: number[], repo?: string): Promise<Issue[]> {
  for (const n of numbers) if (!Number.isInteger(n) || n < 1) throw new Error(`Not an issue number: ${n}`);
  const fields =
    "id number title url body state status{name} linkedBranches(first:10){nodes{ref{name}}} " +
    "closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{headRefName}}";
  const query = REPO_QUERY + numbers.map((n) => `i${n}: issue(number:${n}){${fields}}`).join(" ") + "}}";
  const out = JSON.parse(await run(exec, "gh", ["api", "graphql", ...repoFields(repo), "-f", `query=${query}`], root));
  const data = out?.data?.repository as Record<string, RawIssue | null> | undefined;
  return numbers.map((n) => {
    const raw = data?.[`i${n}`];
    if (!raw) throw new Error(`#${n} not found in ${repo ?? "this repository"}`);
    const branches = [
      ...raw.linkedBranches.nodes.map((node) => node.ref?.name).filter((name): name is string => !!name),
      ...raw.closedByPullRequestsReferences.nodes.map((node) => node.headRefName),
    ];
    return {
      id: raw.id,
      number: raw.number,
      title: raw.title,
      url: raw.url,
      body: raw.body ?? "",
      open: raw.state === "OPEN",
      ...(raw.status?.name ? { status: raw.status.name } : {}),
      linkedBranches: [...new Set(branches)],
    };
  });
}

/** The repository's issue statuses; empty when it has none (or they cannot be read). */
export async function fetchStatuses(exec: Exec, root: string, repo?: string): Promise<Status[]> {
  const query = REPO_QUERY + "planningStatuses(first:20){nodes{id name}}}}";
  const r = await exec("gh", ["api", "graphql", ...repoFields(repo), "-f", `query=${query}`], root);
  if (r.code !== 0) return [];
  try {
    const nodes = JSON.parse(r.stdout)?.data?.repository?.planningStatuses?.nodes;
    return Array.isArray(nodes) ? nodes.filter((s: Status) => s?.id && s?.name) : [];
  } catch {
    return [];
  }
}

export async function setStatus(exec: Exec, root: string, issueId: string, statusId: string): Promise<void> {
  const query = "mutation($issue:ID!,$status:ID!){setIssueStatus(input:{issueId:$issue,statusId:$status}){issue{number}}}";
  await run(exec, "gh", ["api", "graphql", "-f", `query=${query}`, "-f", `issue=${issueId}`, "-f", `status=${statusId}`], root);
}

export interface IssueSummary {
  number: number;
  title: string;
  milestone?: string;
}

export async function listOpenIssues(exec: Exec, cwd: string): Promise<IssueSummary[]> {
  const out = await run(exec, "gh", ["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title,milestone"], cwd);
  return (JSON.parse(out) as { number: number; title: string; milestone: { title: string } | null }[]).map((i) => ({
    number: i.number,
    title: i.title,
    ...(i.milestone?.title ? { milestone: i.milestone.title } : {}),
  }));
}
