// Request-local guidance placement. The mode guidance is never a session message, but it must not
// move: appending it at the tail of every request and dropping the previous copy changes the prompt
// prefix each time, which defeats the provider's prompt cache (the whole conversation is re-billed on
// every request). Each guidance text is therefore anchored where it first appeared and re-inserted
// there on later requests, so the conversation stays append-only. A new text (a settings change) is
// anchored at the current tail. Anchors are persisted as custom entries (never sent to the model) so
// a reload keeps the same positions.

export const GUIDANCE_ANCHOR_ENTRY = "tool-gate:guidance-anchor";

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

const guidanceMessage = (anchor: GuidanceAnchor, customType: string) => ({
  role: "custom" as const,
  customType,
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
  customType: string,
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
    while (next < valid.length && valid[next]!.count === i) out.push(guidanceMessage(valid[next++]!, customType) as T);
    if (i < messages.length) out.push(messages[i]!);
  }
  return { messages: out, anchors: valid };
}

/** The anchors saved on a branch, in order; entries of another type or a bad shape are ignored. */
export function restoreAnchors(entries: readonly unknown[]): GuidanceAnchor[] {
  const anchors: GuidanceAnchor[] = [];
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: Partial<GuidanceAnchor> } | undefined;
    if (entry?.type !== "custom" || entry.customType !== GUIDANCE_ANCHOR_ENTRY) continue;
    const data = entry.data;
    if (!data || typeof data.text !== "string" || typeof data.count !== "number" || typeof data.timestamp !== "number") continue;
    if (data.ts !== undefined && data.ts !== null && typeof data.ts !== "number") continue;
    anchors.push({ text: data.text, count: data.count, ts: data.ts ?? undefined, timestamp: data.timestamp });
  }
  return anchors;
}
