// Reading what `git push` printed: which GitHub repository, which branches moved from where to where.

export interface PushedRef {
  /** `owner/name` on GitHub. */
  repo: string;
  oldSha?: string;
  /** A commit sha, or (a new branch) the local ref pushed, to be resolved to a sha later. */
  newSha: string;
  branch: string;
  forced: boolean;
}

const PUSH_COMMAND = /(^|[;&|(`\n])\s*(?:\w+=\S*\s+)*git(\s+-C\s+\S+)?(\s+-c\s+\S+)*\s+push\b/;

/** Whether a shell command line runs `git push` (anywhere in a list, pipeline or subshell). */
export function isPushCommand(command: string): boolean {
  return PUSH_COMMAND.test(command);
}

const REMOTE_URL = /^(?:git@github\.com:|https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/;

/** `owner/name` for a GitHub remote URL (scp, https or ssh form), else undefined. */
export function githubRepo(url: string): string | undefined {
  return REMOTE_URL.exec(url.trim())?.[1];
}

/** The refs a `git push` moved, from its output; empty for another host or when nothing moved. */
export function parsePushOutput(text: string): PushedRef[] {
  const refs: PushedRef[] = [];
  let repo: string | undefined;
  for (const line of text.split("\n")) {
    const to = /^To\s+(\S+)/.exec(line);
    if (to) {
      repo = githubRepo(to[1]!);
      continue;
    }
    if (!repo) continue;
    const moved = /^\s*([+ ]?)\s*([0-9a-f]{7,40})(\.\.\.?)([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/.exec(line);
    if (moved) {
      refs.push({ repo, oldSha: moved[2]!, newSha: moved[4]!, branch: moved[6]!.replace(/^refs\/heads\//, ""), forced: moved[1] === "+" || moved[3] === "..." });
      continue;
    }
    const created = /^\s*\*\s+\[new branch\]\s+(\S+)\s+->\s+(\S+)/.exec(line);
    if (created) refs.push({ repo, newSha: created[1]!, branch: created[2]!.replace(/^refs\/heads\//, ""), forced: false });
  }
  return refs;
}
