// Sidebar's GitHub issue writes: `gh issue create`, `gh issue comment` and `gh issue edit`. Unlike a
// Slack draft, an issue or comment is public the moment it is written, so each one runs only after
// the user approves it in a confirm dialog showing the repository, the action and the text
// (guard.ts asks; child.ts shows the dialog). Closing, reopening, deleting, transferring, locking,
// pinning and `gh api` writes are not covered and stay refused by the read-only guard.
//
// The parser accepts only the plain shapes such a command takes, so the dialog can show exactly
// what will be written: literal text (or variables assigned earlier in the same command) passed
// with --body, or piped into --body-file - from `printf '%s'`, `echo`, or a quoted heredoc. One
// write per command, with nothing else chained in.
import { type Stage, tokenize } from "./shell-words.ts";

export type GithubIssueAction = "create" | "comment" | "edit";

export interface GithubIssueWrite {
  action: GithubIssueAction;
  /** `--repo`/`-R`; undefined means the repository of the working directory. */
  repo?: string;
  /** The issue number or URL (comment and edit). */
  issue?: string;
  title?: string;
  body?: string;
  /** Other changes, as `--option value` pairs, in the order given. */
  options: [string, string][];
}

const ALIASES: Record<string, string> = { "-R": "--repo", "-t": "--title", "-b": "--body", "-F": "--body-file", "-l": "--label", "-a": "--assignee", "-m": "--milestone", "-p": "--project" };
const COMMON = ["--repo", "--body", "--body-file"];
const VALUES: Record<GithubIssueAction, Set<string>> = {
  create: new Set([...COMMON, "--title", "--label", "--assignee", "--milestone", "--project"]),
  comment: new Set(COMMON),
  edit: new Set([...COMMON, "--title", "--add-label", "--remove-label", "--add-assignee", "--remove-assignee", "--milestone", "--add-project", "--remove-project"]),
};
const REPO = /^(?:[\w.-]+\/)?[\w.-]+\/[\w.-]+$/;
const ISSUE = /^(?:\d+|https:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/issues\/\d+)$/;
const WRITE_MENTION = /\bgh\b[^\n|;&]*\bissue\s+(?:create|new|comment|edit)\b/;

/** Whether a command looks like a GitHub issue write, parsed or not. */
export function mentionsGithubIssueWrite(command: string): boolean {
  return WRITE_MENTION.test(command);
}

/** The text a feeder stage writes to the pipe, or undefined for anything but the plain shapes. */
function feederText(stage: Stage): string | undefined {
  const [name, ...args] = stage.words.map((w) => w.text);
  if (name === "cat") return args.length === 0 ? stage.stdin : undefined;
  if (stage.stdin !== undefined) return undefined;
  if (name === "echo") return args.length > 0 && !args[0]!.startsWith("-") ? `${args.join(" ")}\n` : undefined;
  if (name === "printf") {
    const [format, ...rest] = args;
    if (format === undefined || format.startsWith("-")) return undefined;
    if ((format === "%s" || format === "%s\\n") && rest.length === 1) return rest[0]! + (format === "%s" ? "" : "\n");
    if (rest.length === 0 && !format.includes("%")) {
      return format.replace(/\\(.)/g, (_, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c === "\\" ? "\\" : `\\${c}`));
    }
  }
  return undefined;
}

/** The parsed `gh issue <action>` stage, given the text piped into it; undefined when not a plain one. */
function issueStage(stage: Stage, piped: string | undefined): GithubIssueWrite | undefined {
  if (stage.words.some((w) => w.assign !== undefined)) return undefined;
  const words = stage.words.map((w) => w.text);
  if (words[0] !== "gh" || words[1] !== "issue") return undefined;
  const sub = words[2];
  const action: GithubIssueAction | undefined = sub === "create" || sub === "new" ? "create" : sub === "comment" || sub === "edit" ? sub : undefined;
  if (!action) return undefined;
  const allowed = VALUES[action];
  const write: GithubIssueWrite = { action, options: [] };
  const positional: string[] = [];
  let bodyFile: string | undefined;
  const args = words.slice(3);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const raw = eq > 0 ? arg.slice(0, eq) : arg;
    const name = ALIASES[raw] ?? raw;
    if (!allowed.has(name)) return undefined;
    let value: string;
    if (eq > 0) value = arg.slice(eq + 1);
    else {
      const next = args[i + 1];
      if (next === undefined) return undefined;
      value = next;
      i += 1;
    }
    if (name === "--repo") {
      if (write.repo !== undefined || !REPO.test(value)) return undefined;
      write.repo = value;
    } else if (name === "--title") {
      if (write.title !== undefined) return undefined;
      write.title = value;
    } else if (name === "--body") {
      if (write.body !== undefined || bodyFile !== undefined) return undefined;
      write.body = value;
    } else if (name === "--body-file") {
      // The text comes from the command itself, never from a file Sidebar could otherwise only read.
      if (value !== "-" || write.body !== undefined || bodyFile !== undefined) return undefined;
      bodyFile = value;
    } else write.options.push([name, value]);
  }
  const stdin = stage.stdin ?? piped;
  if (bodyFile !== undefined) {
    if (stdin === undefined) return undefined;
    write.body = stdin;
  } else if (stdin !== undefined) return undefined;
  if (action === "create") {
    // Without both, gh prompts interactively, which a tool call cannot answer.
    if (positional.length > 0 || write.title === undefined || write.body === undefined) return undefined;
  } else {
    if (positional.length !== 1 || !ISSUE.test(positional[0]!)) return undefined;
    write.issue = positional[0]!;
    if (action === "comment" && write.body === undefined) return undefined;
    if (action === "edit" && write.title === undefined && write.body === undefined && write.options.length === 0) return undefined;
  }
  return write;
}

/**
 * The GitHub issue write a shell command makes, when that is all it does (besides assigning
 * literal text); undefined for any other command, including one that reads, closes or deletes.
 */
export function parseGithubIssueCommand(command: string): GithubIssueWrite | undefined {
  if (!command.includes("gh")) return undefined;
  const statements = tokenize(command.trim());
  if (!statements) return undefined;
  let write: GithubIssueWrite | undefined;
  for (const pipeline of statements) {
    const first = pipeline[0]!;
    if (pipeline.length === 1 && first.words.every((w) => w.assign !== undefined)) continue;
    if (write || pipeline.length > 2) return undefined;
    if (pipeline.length === 2) {
      if (first.words.some((w) => w.assign !== undefined)) return undefined;
      const text = feederText(first);
      if (text === undefined || pipeline[1]!.stdin !== undefined) return undefined;
      write = issueStage(pipeline[1]!, text);
    } else write = issueStage(first, undefined);
    if (!write) return undefined;
  }
  return write;
}

const VERBS: Record<GithubIssueAction, string> = { create: "Create an issue", comment: "Comment on issue", edit: "Edit issue" };

/** The confirm dialog's title and message for a write: everything it will change, in full. */
export function describeGithubIssueWrite(write: GithubIssueWrite, cwd: string): { title: string; message: string } {
  const where = write.repo ?? `the repository of ${cwd}`;
  const target = write.issue ? ` ${write.issue.startsWith("http") ? write.issue : `#${write.issue}`}` : "";
  const title = `Sidebar: ${VERBS[write.action]}${target}${write.issue?.startsWith("http") ? "" : ` in ${where}`}?`;
  const lines: string[] = [];
  if (write.title !== undefined) lines.push(`Title: ${write.title}`);
  for (const [name, value] of write.options) lines.push(`${name.replace(/^--/, "")}: ${value}`);
  if (write.body !== undefined) {
    if (lines.length > 0) lines.push("");
    lines.push(write.body.replace(/\n$/, ""));
  }
  return { title, message: lines.join("\n") };
}
