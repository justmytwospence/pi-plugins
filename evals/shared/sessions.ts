// A sampler of real Pi sessions for replay evals, shared by the packages' evals. Node builtins only,
// no imports from any package.
//
// Sessions are the JSONL files Pi writes under `$PI_CODING_AGENT_DIR/sessions` (default
// `~/.pi/agent/sessions`), one directory per working directory. Anything under a directory named
// `subagents` is skipped: those are children of another session, not conversations with a user.
//
// Environment (each also an option of `sampleSessions`):
//   EVAL_RECENT       how many of the newest session files (by mtime) to consider (default 50)
//   EVAL_MIN_PROMPTS  keep sessions whose current branch has at least this many user messages (5)
//   EVAL_MIN_TOOLS    ... and at least this many toolResult messages (30)
//   EVAL_SAMPLE       how many of the qualifying sessions to take, after a seeded shuffle (20)
//   EVAL_SEED         integer seed of the shuffle (default random); always printed
import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** One line of a session file after the header: a message, a custom entry, a level change, ... */
export interface SessionEntry {
  type?: string;
  id?: string;
  parentId?: string | null;
  [key: string]: unknown;
}

export interface Session {
  /** Absolute path of the JSONL file. */
  file: string;
  /** The working directory from the session header (else the project directory's name). */
  cwd: string;
  /** Every entry of the file in file order, header excluded, unparseable lines skipped. */
  entries: SessionEntry[];
}

export interface SampleOptions {
  /** Sessions directory (default `$PI_CODING_AGENT_DIR/sessions`, else `~/.pi/agent/sessions`). */
  dir?: string;
  recent?: number;
  minPrompts?: number;
  minTools?: number;
  sample?: number;
  seed?: number;
  /** Environment to read the EVAL_* variables from (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Where the summary line goes (default `console.log`). */
  log?: (line: string) => void;
}

export interface Sample {
  seed: number;
  sessions: Session[];
}

/** `$PI_CODING_AGENT_DIR/sessions`, else `~/.pi/agent/sessions`. */
export function sessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"), "sessions");
}

/** Every `*.jsonl` under `dir` outside any `subagents` directory, newest first by mtime (ties by path). */
export function listSessionFiles(dir: string): Array<{ file: string; mtimeMs: number }> {
  const found: Array<{ file: string; mtimeMs: number }> = [];
  const walk = (current: string) => {
    let names: Dirent[];
    try {
      names = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "subagents") walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          found.push({ file: full, mtimeMs: statSync(full).mtimeMs });
        } catch {
          // Removed between the listing and the stat.
        }
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
}

/** A session file parsed line by line; undefined when it cannot be read. */
export function readSession(file: string): Session | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const entries: SessionEntry[] = [];
  let cwd: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as SessionEntry;
    if (entry.type === "session") {
      if (cwd === undefined && typeof entry.cwd === "string") cwd = entry.cwd;
      continue;
    }
    entries.push(entry);
  }
  return { file, cwd: cwd ?? path.basename(path.dirname(file)), entries };
}

/**
 * The current branch: from the last entry that has an id, follow `parentId` up to the root, and
 * return the path root first. Pi appends each new entry as a child of the leaf, so the last entry
 * of the file is the leaf. A session without ids or parent links (an old linear one) is its file
 * order. A parent missing from the file ends the path there; a cycle cannot loop.
 */
export function branchOf(entries: readonly SessionEntry[]): SessionEntry[] {
  const withId = entries.filter((e) => typeof e.id === "string");
  if (!withId.length || !entries.some((e) => "parentId" in e)) return [...entries];
  const byId = new Map<string, SessionEntry>();
  for (const entry of withId) byId.set(entry.id as string, entry);
  const chain: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = withId.at(-1);
  while (current && !seen.has(current.id as string)) {
    seen.add(current.id as string);
    chain.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

/** A deterministic PRNG (mulberry32): the same seed gives the same sequence of numbers in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A copy of `items` in the order the seed gives (Fisher-Yates). */
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const random = prng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const count = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
};

const roleOf = (entry: SessionEntry) => (entry.type === "message" ? (entry.message as { role?: unknown } | undefined)?.role : undefined);

/**
 * The sessions to replay: the newest `recent` files, those whose current branch has at least
 * `minPrompts` user messages and `minTools` tool results, shuffled by the seed, the first `sample`.
 */
export function sampleSessions(options: SampleOptions = {}): Sample {
  const env = options.env ?? process.env;
  const recent = options.recent ?? count(env.EVAL_RECENT, 50);
  const minPrompts = options.minPrompts ?? count(env.EVAL_MIN_PROMPTS, 5);
  const minTools = options.minTools ?? count(env.EVAL_MIN_TOOLS, 30);
  const take = options.sample ?? count(env.EVAL_SAMPLE, 20);
  const seed = options.seed ?? (env.EVAL_SEED?.trim() && Number.isInteger(Number(env.EVAL_SEED)) ? Number(env.EVAL_SEED) : Math.floor(Math.random() * 2 ** 32));
  const dir = options.dir ?? sessionsDir(env);

  const files = listSessionFiles(dir).slice(0, recent);
  const qualifying: Session[] = [];
  for (const { file } of files) {
    const session = readSession(file);
    if (!session) continue;
    const { prompts, toolResults } = summarizeSession(session);
    if (prompts >= minPrompts && toolResults >= minTools) qualifying.push(session);
  }
  const sessions = shuffle(qualifying, seed).slice(0, take);
  (options.log ?? console.log)(
    `sessions: EVAL_SEED=${seed}; ${sessions.length} sampled of ${qualifying.length} qualifying (>= ${minPrompts} prompts, >= ${minTools} tool results) among the newest ${files.length} in ${dir}`,
  );
  return { seed, sessions };
}

export interface SessionSummary {
  file: string;
  cwd: string;
  /** User messages on the current branch. */
  prompts: number;
  /** toolResult messages on the current branch. */
  toolResults: number;
}

/** A session's size as the sampler counted it, for the dry run. */
export function summarizeSession(session: Session): SessionSummary {
  const branch = branchOf(session.entries);
  return {
    file: session.file,
    cwd: session.cwd,
    prompts: branch.filter((e) => roleOf(e) === "user").length,
    toolResults: branch.filter((e) => roleOf(e) === "toolResult").length,
  };
}
