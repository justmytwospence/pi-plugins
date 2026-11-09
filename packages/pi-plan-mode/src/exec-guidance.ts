// Exec guidance placement. The guidance is request-local (never a session entry), but it must
// not move: appending it at the tail of every request changes the prompt prefix each time, which
// defeats the provider's prompt cache (the whole conversation is re-billed on every request) and
// makes Anthropic drop replayed thinking blocks bound to the old prefix. Each guidance text is
// therefore anchored where it first appeared and re-inserted there on later requests, so the
// conversation stays append-only. A new text (a phase change) is anchored at the current tail.

export const EXEC_GUIDANCE_TYPE = "plan-mode-exec-guidance";

/** Where one guidance text was first inserted: after `count` messages, the last stamped `ts`. */
export interface GuidanceAnchor {
  text: string;
  count: number;
  ts: number | undefined;
  timestamp: number;
}

interface MessageLike {
  timestamp?: number;
}

const stamp = (message: unknown) => (message as MessageLike | undefined)?.timestamp;

const guidanceMessage = (anchor: GuidanceAnchor) => ({
  role: "custom" as const,
  customType: EXEC_GUIDANCE_TYPE,
  content: anchor.text,
  display: false,
  timestamp: anchor.timestamp,
});

/**
 * The request messages with every still-valid guidance anchor re-inserted, and the anchors to keep.
 * Anchors whose position no longer matches the history (compaction, tree navigation) are dropped;
 * when the current text has no valid anchor it gets one at the tail. Never mutates `messages`.
 */
export function placeGuidance<T>(
  messages: readonly T[],
  text: string,
  anchors: readonly GuidanceAnchor[],
  now: number,
): { messages: T[]; anchors: GuidanceAnchor[] } {
  const valid = anchors.filter(
    (anchor) =>
      anchor.count <= messages.length && (anchor.count === 0 || stamp(messages[anchor.count - 1]) === anchor.ts),
  );
  if (valid.at(-1)?.text !== text) {
    valid.push({ text, count: messages.length, ts: stamp(messages.at(-1)), timestamp: now });
  }
  const out: T[] = [];
  let next = 0;
  for (let i = 0; i <= messages.length; i++) {
    while (next < valid.length && valid[next]!.count === i) out.push(guidanceMessage(valid[next++]!) as T);
    if (i < messages.length) out.push(messages[i]!);
  }
  return { messages: out, anchors: valid };
}
