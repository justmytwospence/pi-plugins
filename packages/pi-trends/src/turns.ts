// Reconstructs per-call statistics from session entries: one point per assistant response (one
// model request), grouped into prompts by the user messages between them.

export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface TurnStat {
  /** 1-based model-call number along the current branch. */
  index: number;
  /** 1-based user prompt this call answers. */
  prompt: number;
  /** First call after its user prompt. */
  promptStart: boolean;
  startedAt: number;
  /** Request duration plus the tool calls it made, until their last result. */
  durationMs: number;
  /** Tokens in context after this response (input + cache + output). */
  contextTokens: number;
  contextWindow: number;
  /** 0-100, or undefined when the context window is unknown. */
  contextPercent: number | undefined;
  /** Thinking level in effect for this call. */
  effort: string;
  model: string | undefined;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  toolCalls: number;
  /** A compaction happened since the previous call. */
  compacted: boolean;
}

export interface CollectOptions {
  /** Context window for a provider/model pair. */
  contextWindow?: (provider: string, model: string) => number | undefined;
  /** Used for turns before any thinking_level_change entry. */
  initialEffort?: string;
}

interface LooseEntry {
  type: string;
  timestamp?: string;
  thinkingLevel?: string;
  provider?: string;
  modelId?: string;
  message?: {
    role?: string;
    content?: unknown;
    provider?: string;
    model?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
    timestamp?: number;
  };
}

const time = (entry: LooseEntry): number => {
  const parsed = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : (entry.message?.timestamp ?? 0);
};

export function collectTurns(entries: readonly unknown[], options: CollectOptions = {}): TurnStat[] {
  const calls: TurnStat[] = [];
  const firstChange = (entries as LooseEntry[]).find((entry) => entry?.type === "thinking_level_change");
  let effort = firstChange?.thinkingLevel ?? options.initialEffort ?? "off";
  let pendingCompaction = false;
  let prompt = 0;
  let promptStart = false;
  let lastMessageAt = 0;
  let current: TurnStat | undefined;

  for (const raw of entries) {
    const entry = raw as LooseEntry;
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "thinking_level_change" && entry.thinkingLevel) {
      effort = entry.thinkingLevel;
      continue;
    }
    if (entry.type === "compaction") {
      pendingCompaction = true;
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message = entry.message;
    const at = time(entry);

    if (message.role === "user") {
      prompt++;
      promptStart = true;
      current = undefined;
      lastMessageAt = at;
      continue;
    }
    if (message.role !== "assistant") {
      // Tool results extend the call that requested them.
      if (current) current.durationMs = Math.max(current.durationMs, at - current.startedAt);
      lastMessageAt = at;
      continue;
    }
    if (prompt === 0) continue;

    const usage = message.usage ?? {};
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const startedAt = lastMessageAt || at;
    const toolCalls = Array.isArray(message.content)
      ? message.content.filter((part) => (part as { type?: string })?.type === "toolCall").length
      : 0;
    const model = message.provider && message.model ? `${message.provider}/${message.model}` : undefined;
    const contextWindow = (message.provider && message.model && options.contextWindow?.(message.provider, message.model)) || 0;
    const contextTokens = input + cacheRead + cacheWrite + output;
    current = {
      index: calls.length + 1,
      prompt,
      promptStart,
      startedAt,
      durationMs: Math.max(0, at - startedAt),
      contextTokens,
      contextWindow,
      contextPercent: contextWindow > 0 && contextTokens > 0 ? (contextTokens / contextWindow) * 100 : undefined,
      effort,
      model,
      input,
      output,
      cacheRead,
      cacheWrite,
      cost: usage.cost?.total ?? 0,
      toolCalls,
      compacted: pendingCompaction,
    };
    calls.push(current);
    pendingCompaction = false;
    promptStart = false;
    lastMessageAt = at;
  }
  return calls;
}

export function effortRank(level: string): number {
  const rank = (EFFORT_LEVELS as readonly string[]).indexOf(level);
  return rank < 0 ? 0 : rank;
}
