// Sidebar's one write: Slack drafts. A draft is visible only to the user until they send it, so
// Sidebar may create one (`slackcli messages draft`) and discard one it created in this thread
// (`slackcli messages delete-draft <id>`), the way main does with the slackcli and slack-voice
// skills. Everything else about Slack that writes (send, send-draft, schedule, someone else's
// draft) still goes through the read-only guard and is refused there.
//
// The parser below accepts only the plain shapes a draft takes, and refuses anything it does not
// understand: assignments of literal text, `printf`/`echo` (or a quoted heredoc) feeding
// `slackcli messages draft --message-file -`, and `&&` or `;` between such statements.
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SlackDraftCommand {
  /** How many drafts the command creates. */
  drafts: number;
  /** The draft IDs it deletes. */
  deletes: string[];
}

type Word = { text: string; assign?: string };
type Stage = { words: Word[]; stdin?: string };

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DRAFT_VALUES = new Set(["--recipient-id", "--message", "--message-file", "--thread-ts", "--permalink", "--workspace"]);
const DRAFT_FLAGS = new Set(["--json", "--dry-run"]);
const DELETE_VALUES = new Set(["--workspace"]);
const DELETE_FLAGS = new Set(["--yes", "--json", "--dry-run"]);
const FEEDERS = new Set(["printf", "echo"]);

/** Statements of pipelines of words, or undefined when the command uses anything beyond plain words. */
function tokenize(command: string): Stage[][] | undefined {
  const statements: Stage[][] = [];
  let pipeline: Stage[] = [];
  let stage: Stage = { words: [] };
  let word: Word | undefined;
  let quoted = false;
  let pendingHeredoc: { stage: Stage; delimiter: string; literal: boolean; strip: boolean } | undefined;
  const variables = new Map<string, string>();

  const endWord = () => {
    if (word) stage.words.push(word);
    word = undefined;
    quoted = false;
  };
  const endStage = (): boolean => {
    endWord();
    if (stage.words.length === 0) return false;
    pipeline.push(stage);
    stage = { words: [] };
    return true;
  };
  const endStatement = (): boolean => {
    if (!endStage()) return pipeline.length === 0 && stage.words.length === 0;
    statements.push(pipeline);
    // A statement made only of assignments sets them for the statements after it.
    const only = pipeline.length === 1 && pipeline[0]!.words.every((w) => w.assign !== undefined);
    if (only) for (const w of pipeline[0]!.words) variables.set(w.assign!, w.text);
    pipeline = [];
    return true;
  };
  const append = (text: string) => {
    word ??= { text: "" };
    word.text += text;
  };
  const expand = (source: string, at: number): { value: string; next: number } | undefined => {
    const braced = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(source.slice(at));
    const bare = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(at));
    const match = braced ?? bare;
    if (!match) return undefined;
    const value = variables.get(match[1]!);
    return value === undefined ? undefined : { value, next: at + match[0].length };
  };

  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return undefined;
      append(command.slice(i + 1, end));
      quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      word ??= { text: "" };
      quoted = true;
      i += 1;
      for (;;) {
        if (i >= command.length) return undefined;
        const d = command[i]!;
        if (d === '"') { i += 1; break; }
        if (d === "`") return undefined;
        if (d === "\\") {
          const next = command[i + 1];
          if (next === undefined) return undefined;
          if (next === "\n") { i += 2; continue; }
          word.text += '"\\$`'.includes(next) ? next : `\\${next}`;
          i += 2;
          continue;
        }
        if (d === "$") {
          const expanded = expand(command, i);
          if (!expanded) return undefined;
          word.text += expanded.value;
          i = expanded.next;
          continue;
        }
        word.text += d;
        i += 1;
      }
      continue;
    }
    if (c === "\\") {
      const next = command[i + 1];
      if (next === undefined) return undefined;
      if (next !== "\n") append(next);
      i += 2;
      continue;
    }
    if (c === " " || c === "\t") { endWord(); i += 1; continue; }
    if (c === "\n") {
      endWord();
      if (pendingHeredoc) {
        const { stage: target, delimiter, literal, strip } = pendingHeredoc;
        pendingHeredoc = undefined;
        const lines: string[] = [];
        let pos = i + 1;
        for (;;) {
          if (pos > command.length) return undefined;
          const end = command.indexOf("\n", pos);
          const raw = command.slice(pos, end < 0 ? command.length : end);
          const line = strip ? raw.replace(/^\t+/, "") : raw;
          pos = end < 0 ? command.length + 1 : end + 1;
          if (line === delimiter) break;
          if (end < 0) return undefined;
          lines.push(line);
        }
        const body = lines.join("\n");
        if (!literal && /[$`\\]/.test(body)) return undefined;
        target.stdin = `${body}\n`;
        i = pos - 1;
      }
      if (!endStatement()) return undefined;
      i += 1;
      continue;
    }
    if (c === "|") {
      if (command[i + 1] === "|") return undefined;
      if (!endStage()) return undefined;
      i += 1;
      continue;
    }
    if (c === ";" || (c === "&" && command[i + 1] === "&")) {
      if (pendingHeredoc) return undefined;
      if (!endStatement()) return undefined;
      i += c === ";" ? 1 : 2;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      if (pendingHeredoc) return undefined;
      endWord();
      let pos = i + 2;
      const strip = command[pos] === "-";
      if (strip) pos += 1;
      while (command[pos] === " " || command[pos] === "\t") pos += 1;
      const q = command[pos];
      let delimiter: string;
      let literal = false;
      if (q === "'" || q === '"') {
        const end = command.indexOf(q, pos + 1);
        if (end < 0) return undefined;
        delimiter = command.slice(pos + 1, end);
        literal = true;
        pos = end + 1;
      } else {
        const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(command.slice(pos));
        if (!match) return undefined;
        delimiter = match[0];
        pos += delimiter.length;
      }
      if (!NAME.test(delimiter)) return undefined;
      pendingHeredoc = { stage, delimiter, literal, strip };
      i = pos;
      continue;
    }
    if (c === "$") {
      // Unquoted expansions split into words; keep to literal text and quoted variables.
      return undefined;
    }
    if (`&<>()\`{}*?[]#~!`.includes(c)) return undefined;
    if (c === "=" && word && !quoted && word.assign === undefined && NAME.test(word.text) && stage.words.length === 0) {
      word.assign = word.text;
      word.text = "";
      i += 1;
      continue;
    }
    append(c);
    i += 1;
  }
  if (pendingHeredoc) return undefined;
  if (!endStatement()) return undefined;
  return statements.length > 0 ? statements : undefined;
}

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
