// One of Sidebar's two writes (see github-issues.ts for the other): Slack drafts. A draft is visible only to the user until they send it, so
// Sidebar may create one (`slackcli messages draft`) and discard one it created in this thread
// (`slackcli messages delete-draft <id>`), the way main does with the slackcli and slack-voice
// skills. Everything else about Slack that writes (send, send-draft, schedule, someone else's
// draft) still goes through the read-only guard and is refused there.
//
// The parser below accepts only the plain shapes a draft takes, and refuses anything it does not
// understand: assignments of literal text, `printf`/`echo` (or a quoted heredoc) feeding
// `slackcli messages draft --message-file -`, and `&&` or `;` between such statements.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { tokenize } from "./shell-words.ts";

export interface SlackDraftCommand {
  /** How many drafts the command creates. */
  drafts: number;
  /** The draft IDs it deletes. */
  deletes: string[];
}

const DRAFT_VALUES = new Set(["--recipient-id", "--message", "--message-file", "--thread-ts", "--permalink", "--workspace"]);
const DRAFT_FLAGS = new Set(["--json", "--dry-run"]);
const DELETE_VALUES = new Set(["--workspace"]);
const DELETE_FLAGS = new Set(["--yes", "--json", "--dry-run"]);
const FEEDERS = new Set(["printf", "echo"]);

/** The options after `messages <sub>`; undefined when one is unknown or malformed. */
function options(args: string[], values: Set<string>, flags: Set<string>): { opts: Map<string, string>; positional: string[] } | undefined {
  const opts = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (flags.has(name) && eq < 0) {
      opts.set(name, "");
      continue;
    }
    if (!values.has(name)) return undefined;
    if (eq > 0) opts.set(name, arg.slice(eq + 1));
    else {
      const value = args[i + 1];
      if (value === undefined) return undefined;
      opts.set(name, value);
      i += 1;
    }
  }
  return { opts, positional };
}

/** One `slackcli` stage: a draft, a delete of `id`, or undefined for anything else. */
function slackStage(words: string[]): { draft: true } | { delete: string } | undefined {
  if (words[0] !== "slackcli") return undefined;
  let i = 1;
  while (words[i] === "-v" || words[i] === "--verbose") i += 1;
  if (words[i] !== "messages") return undefined;
  const sub = words[i + 1];
  const rest = words.slice(i + 2);
  if (sub === "draft") {
    const parsed = options(rest, DRAFT_VALUES, DRAFT_FLAGS);
    if (!parsed || parsed.positional.length > 0) return undefined;
    const file = parsed.opts.get("--message-file");
    // The text comes from the command itself, never from a file Sidebar could otherwise only read.
    if (file !== undefined && file !== "-") return undefined;
    if (!parsed.opts.has("--message") && file === undefined) return undefined;
    return { draft: true };
  }
  if (sub === "delete-draft") {
    const parsed = options(rest, DELETE_VALUES, DELETE_FLAGS);
    if (!parsed || parsed.positional.length !== 1) return undefined;
    return { delete: parsed.positional[0]! };
  }
  return undefined;
}

/**
 * What a shell command does with Slack drafts, when that is all it does (besides assigning text);
 * undefined for any other command, including one that sends, schedules or reads.
 */
export function parseSlackDraftCommand(command: string): SlackDraftCommand | undefined {
  if (!command.includes("slackcli")) return undefined;
  const statements = tokenize(command.trim());
  if (!statements) return undefined;
  const result: SlackDraftCommand = { drafts: 0, deletes: [] };
  for (const pipeline of statements) {
    const first = pipeline[0]!;
    if (pipeline.length === 1 && first.words.every((w) => w.assign !== undefined)) continue;
    if (pipeline.some((stage) => stage.words.some((w) => w.assign !== undefined))) return undefined;
    if (pipeline.length > 2) return undefined;
    const last = pipeline[pipeline.length - 1]!;
    const action = slackStage(last.words.map((w) => w.text));
    if (!action) return undefined;
    if (pipeline.length === 2) {
      if (!("draft" in action) || last.stdin !== undefined) return undefined;
      const feeder = first.words[0]?.text ?? "";
      if (!FEEDERS.has(feeder) && !(feeder === "cat" && first.words.length === 1 && first.stdin !== undefined)) return undefined;
      if (FEEDERS.has(feeder) && first.stdin !== undefined) return undefined;
    } else if (last.stdin !== undefined && !("draft" in action)) return undefined;
    if ("draft" in action) result.drafts += 1;
    else result.deletes.push(action.delete);
  }
  return result.drafts + result.deletes.length > 0 ? result : undefined;
}

/** The draft IDs a successful tool result reports (`--json` output, or an ID in plain output). */
function draftIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(/"draft_id"\s*:\s*"([^"\s]+)"/g)) ids.add(match[1]!);
  for (const match of text.matchAll(/\bDr[A-Za-z0-9]{6,}\b/g)) ids.add(match[0]);
  return [...ids];
}

/** Drafts Sidebar created in this thread: IDs reported by its own successful draft commands. */
export function draftsCreated(messages: readonly AgentMessage[]): Set<string> {
  const calls = new Set<string>();
  const created = new Set<string>();
  for (const message of messages) {
    const m = message as { role?: string; content?: unknown; toolCallId?: string; isError?: boolean };
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const block of m.content as { type?: string; id?: string; name?: string; arguments?: { command?: unknown } }[]) {
        if (block?.type !== "toolCall" || block.name !== "bash" || typeof block.id !== "string") continue;
        const command = block.arguments?.command;
        if (typeof command === "string" && (parseSlackDraftCommand(command)?.drafts ?? 0) > 0) calls.add(block.id);
      }
    } else if (m.role === "toolResult" && m.toolCallId && calls.has(m.toolCallId) && m.isError !== true) {
      const text = Array.isArray(m.content)
        ? (m.content as { type?: string; text?: string }[]).map((b) => (b?.type === "text" ? b.text ?? "" : "")).join("\n")
        : typeof m.content === "string" ? m.content : "";
      for (const id of draftIds(text)) created.add(id);
    }
  }
  return created;
}
