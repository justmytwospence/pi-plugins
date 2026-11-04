// Optional contract for tools whose calls read or change something depending on their input, such
// as an `action` parameter (herdr list vs send, subagent status vs run). A static `readOnlyHint`
// cannot say that, so the tool's owner answers on `pi-plugins.read-only-call.v1`, synchronously,
// for its own tool, and permission extensions (pi-tool-gate's chat and plan workflows and its
// approvals, Sidebar's guard) ask before falling back to the hint. No import either way: each
// package keeps an identical copy of this file. Absent owners leave the answer undefined.

export const READ_ONLY_CALL_CHANNEL = "pi-plugins.read-only-call.v1";

export interface ReadOnlyCallRequest {
  version: 1;
  tool: string;
  /** A shallow copy of the call's input: owners read it, never change it. */
  input: Record<string, unknown>;
  /** The owner's answer: true when the call only reads, false when it may change something. */
  readOnly?: boolean;
}

interface Bus {
  on(channel: string, handler: (data: unknown) => unknown): unknown;
  emit(channel: string, data: unknown): void;
}

/**
 * Owner side: answer for `tool` with `reads(input)`. Answer only from the input, synchronously and
 * without side effects. Any owner saying false wins; a throwing predicate counts as false.
 */
export function declareReadOnlyCalls(events: Bus | undefined, tool: string, reads: (input: Record<string, unknown>) => boolean): void {
  events?.on(READ_ONLY_CALL_CHANNEL, (data: unknown) => {
    const request = data as Partial<ReadOnlyCallRequest> | undefined;
    if (request?.version !== 1 || request.tool !== tool || !request.input || typeof request.input !== "object") return;
    let verdict: boolean;
    try { verdict = reads(request.input) === true; } catch { verdict = false; }
    request.readOnly = request.readOnly !== false && verdict;
  });
}

/** Asker side: whether the owner of `tool` says this call only reads; undefined when none answers. */
export function askReadOnlyCall(events: Bus | undefined, tool: string, input: unknown): boolean | undefined {
  if (!events) return undefined;
  const request: ReadOnlyCallRequest = { version: 1, tool, input: input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {} };
  try { events.emit(READ_ONLY_CALL_CHANNEL, request); } catch { return undefined; }
  return typeof request.readOnly === "boolean" ? request.readOnly : undefined;
}
