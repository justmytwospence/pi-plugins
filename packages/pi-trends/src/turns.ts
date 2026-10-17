// Reconstructs per-turn statistics from session entries. A turn starts at a user message and
// runs until the next one; it covers every assistant message and tool result in between.

export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface TurnStat {
  /** 1-based turn number along the current branch. */
  index: number;
  startedAt: number;
  durationMs: number;
  /** Tokens in context after the turn's last assistant response (input + cache + output). */
  contextTokens: number;
  contextWindow: number;
  /** 0-100, or undefined when the context window is unknown. */
  contextPercent: number | undefined;
  /** Thinking level in effect for the turn's last response. */
  effort: string;
  model: string | undefined;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  toolCalls: number;
  /** A compaction happened since the previous turn. */
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
  const turns: TurnStat[] = [];
  const firstChange = (entries as LooseEntry[]).find((entry) => entry?.type === "thinking_level_change");
  let effort = firstChange?.thinkingLevel ?? options.initialEffort ?? "off";
  let pendingCompaction = false;
  let current: TurnStat | undefined;
  let lastTime = 0;

  const close = () => {
    if (current) current.durationMs = Math.max(0, lastTime - current.startedAt);
  };

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
      close();
      current = {
        index: turns.length + 1,
        startedAt: at,
        durationMs: 0,
        contextTokens: 0,
        contextWindow: 0,
        contextPercent: undefined,
        effort,
        model: undefined,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        toolCalls: 0,
        compacted: pendingCompaction,
      };
      pendingCompaction = false;
      turns.push(current);
      lastTime = at;
      continue;
    }
    if (!current) continue;
    lastTime = Math.max(lastTime, at);
    if (message.role !== "assistant") continue;

    const usage = message.usage ?? {};
    const input = usage.input ?? 0;
    const output = usage.output ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    current.input += input;
    current.output += output;
    current.cacheRead += cacheRead;
    current.cacheWrite += cacheWrite;
    current.cost += usage.cost?.total ?? 0;
    current.effort = effort;
    if (Array.isArray(message.content)) {
      current.toolCalls += message.content.filter((part) => (part as { type?: string })?.type === "toolCall").length;
    }
    const tokens = input + cacheRead + cacheWrite + output;
    if (tokens > 0) {
      current.contextTokens = tokens;
      if (message.provider && message.model) {
        current.model = `${message.provider}/${message.model}`;
        const window = options.contextWindow?.(message.provider, message.model);
        if (window && window > 0) current.contextWindow = window;
      }
      current.contextPercent = current.contextWindow > 0 ? (tokens / current.contextWindow) * 100 : undefined;
    }
  }
  close();
  return turns;
}

export function effortRank(level: string): number {
  const rank = (EFFORT_LEVELS as readonly string[]).indexOf(level);
  return rank < 0 ? 0 : rank;
}
