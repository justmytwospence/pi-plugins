import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Child, STARTUP_STATE_TIMEOUT_MS } from "../src/child.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

let proc: EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; exitCode: number | null; kill: ReturnType<typeof vi.fn> };
let sent: Array<Record<string, any>>;
let child: Child;
const response = (event: Record<string, unknown>) => proc.stdout.write(`${JSON.stringify(event)}\n`);
const stateReply = (data: unknown = { sessionFile: "/native/pi-selected.jsonl" }, success = true) => response({ type: "response", command: "get_state", id: sent[0]!.id, success, data });
const start = (onUpdate?: (state: Child["state"]) => void) => (child = new Child({ task: "the task", cwd: process.cwd(), model: "p/m", thinking: "low", sessionDir: "/sessions", invocation: { command: "fake", args: [] }, onUpdate }).start());

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, kill: vi.fn(() => { proc.exitCode = 1; proc.emit("close", null); return true; }) });
  proc.stdin.on("data", (data) => sent.push(JSON.parse(data.toString())));
  vi.mocked(spawn).mockReturnValue(proc as unknown as ChildProcess);
});
afterEach(() => {
  child?.stop();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

test("get_state is correlated before prompting; only Pi's path is captured once", async () => {
  const updates: Array<string | undefined> = [];
  start((s) => updates.push(s.sessionFile)).start();
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(sent).toEqual([{ type: "get_state", id: expect.any(String) }]);
  response({ type: "response", command: "get_state", id: "unrelated", success: true, data: { sessionFile: "/wrong.jsonl" } });
  response({ type: "response", command: "steer", id: sent[0]!.id, success: true, data: { sessionFile: "/wrong.jsonl" } });
  response({ type: "response", command: "get_state", success: true, data: { sessionFile: "/wrong.jsonl" } });
  expect(sent).toHaveLength(1);
  expect(child.state.sessionFile).toBeUndefined();
  stateReply();
  expect(updates).toEqual(["/native/pi-selected.jsonl"]);
  expect(sent[1]).toEqual({ type: "prompt", message: "the task" });
  stateReply({ sessionFile: "/duplicate.jsonl" });
  vi.advanceTimersByTime(STARTUP_STATE_TIMEOUT_MS);
  expect(sent).toHaveLength(2);
  expect(child.state.sessionFile).toBe("/native/pi-selected.jsonl");
  response({ type: "agent_settled" });
  expect((await child.done).status).toBe("done");
});

test.each([undefined, {}, { sessionFile: null }, { sessionFile: 42 }, { sessionFile: "" }, { sessionFile: "  " }])("missing/invalid session metadata (%j) does not prevent a task", (data) => {
  start();
  // Avoid the helper's default data for an omitted response field.
  response({ type: "response", command: "get_state", id: sent[0]!.id, success: true, data });
  expect(child.state.sessionFile).toBeUndefined();
  expect(sent[1]?.type).toBe("prompt");
  expect(child.state.error).toBeUndefined();
});

test("a failed get_state is best-effort metadata, not a failed task", async () => {
  start();
  response({ type: "response", command: "get_state", id: sent[0]!.id, success: false, error: "unknown command", data: { sessionFile: "/not-valid.jsonl" } });
  expect(sent[1]?.type).toBe("prompt");
  expect(child.state.sessionFile).toBeUndefined();
  response({ type: "agent_settled" });
  expect(await child.done).toMatchObject({ status: "done" });
  expect(child.state.error).toBeUndefined();
});

test("a missing state response cannot hang startup; a late reply cannot reprompt", async () => {
  start();
  vi.advanceTimersByTime(STARTUP_STATE_TIMEOUT_MS - 1);
  expect(sent).toHaveLength(1);
  vi.advanceTimersByTime(1);
  expect(sent[1]).toEqual({ type: "prompt", message: "the task" });
  stateReply();
  expect(child.state.sessionFile).toBeUndefined();
  expect(sent).toHaveLength(2);
  response({ type: "agent_settled" });
  expect((await child.done).status).toBe("done");
});

test.each(["response", "timeout"])("stop during startup blocks the late %s and settles even if abort is ignored", async (late) => {
  start();
  child.stop();
  expect(child.steer("too late")).toBe(false);
  if (late === "response") stateReply();
  vi.advanceTimersByTime(STARTUP_STATE_TIMEOUT_MS);
  expect(await child.done).toMatchObject({ status: "stopped" });
  expect(sent.map((c) => c.type)).toEqual(["get_state", "abort"]);
  expect(child.state.sessionFile).toBeUndefined();
  expect(proc.kill).toHaveBeenCalledWith("SIGTERM");
});

test("stopping in the session-path update cannot race a late prompt", async () => {
  start(() => child.stop());
  stateReply();
  response({ type: "agent_settled", aborted: true });
  expect((await child.done).status).toBe("stopped");
  expect(child.state.sessionFile).toBe("/native/pi-selected.jsonl");
  vi.advanceTimersByTime(STARTUP_STATE_TIMEOUT_MS);
  expect(sent.map((c) => c.type)).toEqual(["get_state", "abort"]);
});

test.each(["process", "stdin"])("a %s error during startup settles and clears discovery", async (source) => {
  start();
  (source === "process" ? proc : proc.stdin).emit("error", new Error(source === "stdin" ? "write EPIPE" : "spawn ENOENT"));
  expect(await child.done).toMatchObject({ status: "failed", error: expect.stringMatching(/EPIPE|ENOENT/) });
  stateReply();
  vi.advanceTimersByTime(STARTUP_STATE_TIMEOUT_MS);
  expect(sent.map((c) => c.type)).toEqual(["get_state"]);
  expect(child.state.sessionFile).toBeUndefined();
});

test("an early exit reports diagnostics without waiting for get_state", async () => {
  start();
  proc.stderr.write("startup failed\n");
  proc.exitCode = 2;
  proc.emit("close", 2);
  expect(await child.done).toMatchObject({ status: "failed", error: "pi exited (2): startup failed" });
  vi.advanceTimersByTime(STARTUP_STATE_TIMEOUT_MS);
  expect(sent).toHaveLength(1);
});

test.each(["rejected", "handled"])("a %s prompt finishes after session capture without waiting for agent_settled", async (kind) => {
  start();
  stateReply();
  response({ type: "response", command: "prompt", success: kind === "handled", error: kind === "rejected" ? "invalid prompt" : undefined, data: { disposition: kind } });
  expect(await child.done).toMatchObject({ status: kind === "handled" ? "done" : "failed", sessionFile: "/native/pi-selected.jsonl", ...(kind === "rejected" ? { error: "invalid prompt" } : {}) });
  expect(proc.stdin.writableEnded).toBe(true);
});

test("a cancellation racing a prompt rejection is stopped, not failed", async () => {
  start();
  stateReply();
  child.stop();
  response({ type: "response", command: "prompt", success: false, error: "aborted before prompt" });
  expect(await child.done).toMatchObject({ status: "stopped", sessionFile: "/native/pi-selected.jsonl" });
  expect(child.state.error).toBeUndefined();
});
