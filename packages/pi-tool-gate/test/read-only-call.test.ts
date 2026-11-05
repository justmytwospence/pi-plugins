import { expect, test } from "vitest";
import { askReadOnlyCall, declareReadOnlyCalls, READ_ONLY_CALL_CHANNEL } from "../src/read-only-call.ts";
import { onlyReads, planCall, DEFAULT_CONFIG } from "../src/index.ts";

function bus() {
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  return {
    on: (channel: string, listener: (data: unknown) => void) => { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); },
    emit: (channel: string, data: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(data); },
  };
}

test("an owner answers for its own tool only; no owner leaves the answer undefined", () => {
  const events = bus();
  declareReadOnlyCalls(events, "herdr", input => input.action === "list");
  expect(askReadOnlyCall(events, "herdr", { action: "list" })).toBe(true);
  expect(askReadOnlyCall(events, "herdr", { action: "send" })).toBe(false);
  expect(askReadOnlyCall(events, "subagent", { action: "status" })).toBeUndefined();
  expect(askReadOnlyCall(undefined, "herdr", { action: "list" })).toBeUndefined();
});

test("any owner's no wins, a throwing predicate is a no, and owners cannot change the call's input", () => {
  const events = bus();
  const input: Record<string, unknown> = { action: "list" };
  declareReadOnlyCalls(events, "t", seen => { seen.action = "send"; return true; });
  expect(askReadOnlyCall(events, "t", input)).toBe(true);
  expect(input.action).toBe("list");
  declareReadOnlyCalls(events, "t", () => { throw new Error("x"); });
  expect(askReadOnlyCall(events, "t", input)).toBe(false);
  const other = bus();
  declareReadOnlyCalls(other, "t", () => false);
  declareReadOnlyCalls(other, "t", () => true);
  expect(askReadOnlyCall(other, "t", {})).toBe(false);
});

test("malformed requests get no answer", () => {
  const events = bus();
  declareReadOnlyCalls(events, "t", () => true);
  const request: Record<string, unknown> = { version: 2, tool: "t", input: {} };
  events.emit(READ_ONLY_CALL_CHANNEL, request);
  expect(request.readOnly).toBeUndefined();
});

test("the owner's answer decides reads for chat and plan and skips judgment, over a static hint", () => {
  const owner = (tool: string, input: Record<string, unknown>) => (tool === "herdr" ? input.action === "list" : undefined);
  const hinted = () => ({ readOnlyHint: true });
  expect(onlyReads("herdr", { action: "list" }, DEFAULT_CONFIG, undefined, owner)).toBe(true);
  expect(onlyReads("herdr", { action: "send" }, DEFAULT_CONFIG, undefined, owner)).toBe(false);
  expect(onlyReads("herdr", { action: "send" }, DEFAULT_CONFIG, hinted, owner)).toBe(false);
  expect(onlyReads("other", {}, DEFAULT_CONFIG, hinted, owner)).toBe(true);
  expect(planCall("herdr", { action: "list" }, "/tmp", { config: DEFAULT_CONFIG, readOnlyCall: owner })).toEqual({ kind: "allow", why: "read-only hint" });
  expect(planCall("herdr", { action: "send" }, "/tmp", { config: DEFAULT_CONFIG, readOnlyCall: owner }).kind).toBe("judge");
});

test("subagent runs and judged reads count as reads for workflows and approvals alike", () => {
  expect(onlyReads("subagent", { task: "x" }, DEFAULT_CONFIG, undefined, undefined, true)).toBe(true);
  expect(onlyReads("subagent", { task: "x" }, DEFAULT_CONFIG, undefined, undefined, false)).toBe(false);
  expect(onlyReads("subagent", { task: "x", worktree: true }, DEFAULT_CONFIG, undefined, undefined, true)).toBe(false);
  expect(planCall("subagent", { task: "x" }, "/tmp", { config: DEFAULT_CONFIG, chatChildren: true })).toEqual({ kind: "allow", why: "chat subagent" });
  expect(planCall("subagent", { task: "x" }, "/tmp", { config: DEFAULT_CONFIG }).kind).toBe("judge");
  const config = { ...DEFAULT_CONFIG, directories: { ...DEFAULT_CONFIG.directories, enabled: false } };
  const judged = planCall("bash", { command: "python3 -c 'print(1)'" }, "/tmp", { config, judgedRead: true });
  expect(judged).toEqual({ kind: "allow", why: "judged read" });
  expect(planCall("bash", { command: "python3 -c 'print(1)'" }, "/tmp", { config }).kind).toBe("judge");
});
