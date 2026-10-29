// One subagent run as the extension and its UI see it.
import path from "node:path";
import type { Child, ChildState, Usage } from "./child.ts";
import type { Conversation } from "./conversation.ts";
import type { ChoiceSource, Resolved, Tier } from "./pick.ts";

export interface Run {
  id: string;
  agent: string;
  task: string;
  /** Short task name; optional for records from before labels existed. */
  label?: string;
  model: string;
  thinking: string;
  byJev: Resolved["byJev"];
  /** Where the model and thinking came from; absent on records from before it was kept. */
  source?: ChoiceSource;
  /** The quota pressure (0..1) Jev's model or effort pick was made under, when above 0. */
  pressure?: number;
  tier?: Tier;
  /** Why the pick differs from Jev's answer (the Haiku guard). */
  note?: string;
  cwd: string;
  async: boolean;
  state: ChildState;
  /** Set while the child process runs. */
  child?: Child;
  /** The agent's turn limit, if it has one. */
  maxTurns?: number;
  /** The child's conversation; outlives the process. */
  conversation: Conversation;
  outputPath: string;
  /** How the child reaches the runtime that owns the run now; set while the child runs. */
  link?: RunLink;
}

/**
 * The child's callbacks go through this instead of closures over one runtime: a `/reload` clears
 * them in the old runtime (whose pi.* calls throw from then on) and the runtime that adopts the run
 * sets its own (handoff.ts).
 */
export interface RunLink {
  /** The child's state changed. */
  update?: () => void;
  /** The child ended and its output is saved. */
  ended?: () => void;
  /** The child ended while no runtime owned the run: the adopting runtime still owes its final record. */
  missedEnd?: boolean;
  /** The record carrying the child's session file has been written. */
  sessionRecorded?: boolean;
  /** Settles once the child has ended and its output is saved. */
  done: Promise<void>;
}

/** Tokens to show for a run: input, output and cache writes. Cache reads re-count the same prefix every turn. */
export function displayTokens(usage: Usage): number {
  return usage.input + usage.output + usage.cacheWrite;
}

/** `messages.jsonl` beside the run's `output.md`. */
export function transcriptPath(outputPath: string): string {
  return path.join(path.dirname(outputPath), "messages.jsonl");
}
