// GitHub Actions through `gh`. Every failure returns undefined or an empty list: nothing throws.
import { type Exec, tail } from "./exec.ts";

export interface RunInfo {
  databaseId: number;
  name: string;
  workflowName: string;
  status: string;
  conclusion: string;
  url: string;
  event: string;
}

const TIMEOUT = 60_000;

/** The full sha of a commit or ref on GitHub. */
export async function resolveSha(exec: Exec, cwd: string, repo: string, ref: string): Promise<string | undefined> {
  try {
    const r = await exec("gh", ["api", `repos/${repo}/commits/${ref}`, "--jq", ".sha"], cwd, TIMEOUT);
    const sha = r.stdout.trim();
    return r.code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** The workflow runs of one commit. */
export async function listRuns(exec: Exec, cwd: string, repo: string, sha: string): Promise<RunInfo[]> {
  try {
    const r = await exec("gh", ["run", "list", "-R", repo, "--commit", sha, "--json", "databaseId,name,workflowName,status,conclusion,url,event", "--limit", "50"], cwd, TIMEOUT);
    if (r.code !== 0) return [];
    const parsed: unknown = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? (parsed as RunInfo[]) : [];
  } catch {
    return [];
  }
}

/** The end of a run's failed-step logs: the last 60 lines, each clipped. */
export async function failedLog(exec: Exec, cwd: string, repo: string, id: number): Promise<string> {
  try {
    const r = await exec("gh", ["run", "view", String(id), "-R", repo, "--log-failed"], cwd, TIMEOUT);
    return r.code === 0 ? tail(r.stdout, 60) : "";
  } catch {
    return "";
  }
}
