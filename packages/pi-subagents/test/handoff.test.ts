// Runs across a session end: a /reload hands running children to the next runtime of the same
// session (handoff.ts), any other end stops them after a final record, and records that still say
// running afterwards read as lost, can be read, and can be resumed.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Child } from "../src/child.ts";
import { transcriptWriter } from "../src/conversation.ts";
import { ADOPT_TIMEOUT_MS, adopt, isParked } from "../src/handoff.ts";
import subagents, { RESUME_FOOTER, RESUME_HEADING, recordedRun, recordedStatus, resumeTask } from "../src/index.ts";
import { harness } from "./harness.ts";
import { fakeUI } from "./ui-helpers.ts";
import { FAMILY_CHANNEL, type PreparedAgent } from "../src/family-contract.ts";

const explicit = { agent: "general", model: "p/m", thinking: "low" };
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const macrotask = () => new Promise((resolve) => setImmediate(resolve));

let sessions = 0;
const keys: string[] = [];
afterEach(() => {
  // Nothing parked by one test may reach another.
  for (const key of keys.splice(0)) adopt(key);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** One pi session; `runtime()` loads the extension into it, as pi does at startup and at each /reload. */
function session() {
  const agentDir = mkdtempSync(path.join(tmpdir(), "subagents-handoff-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const cwd = mkdtempSync(path.join(tmpdir(), "subagents-handoff-cwd-"));
  const file = path.join(agentDir, `session-${++sessions}.jsonl`);
  keys.push(file);
  const entries: Array<{ customType: string; data: any }> = [];
  const children: Child[] = [];
  vi.spyOn(Child.prototype, "start").mockImplementation(function (this: Child) {
    children.push(this);
    return this;
  });
  const stop = vi.spyOn(Child.prototype, "stop");
  const sessionManager = { getBranch: () => entries.map((e) => ({ type: "custom", ...e })), getSessionFile: () => file, getSessionId: () => `id-${sessions}` };
  const records = (id: string) => entries.filter((e) => e.customType === "subagents:run" && e.data.id === id).map((e) => e.data);

  async function runtime(prepared?: PreparedAgent) {
    const h = harness();
    let tool: any;
    /** pi.* calls made after this runtime's session_shutdown: pi would throw on each. */
    const stale: string[] = [];
    let ended = false;
    const events: Array<{ name: string; data: any }> = [];
    h.pi.registerTool = (t: any) => { if (t.name === "subagent") tool = t; };
    h.pi.appendEntry = (customType: string, data: unknown) => { if (ended) stale.push(`appendEntry ${customType}`); else entries.push({ customType, data }); };
    const send = h.pi.sendMessage;
    h.pi.sendMessage = (message: any, opts: any) => { if (ended) stale.push("sendMessage"); else send(message, opts); };
    h.pi.events = { emit: (name: string, data: any) => { if (ended) stale.push(`emit ${name}`); else {
      events.push({ name, data });
      if (name === FAMILY_CHANNEL && prepared) data.service = { prepare: async () => prepared };
    } }, on: () => () => undefined };
    subagents(h.pi);
    const ui = fakeUI();
    const ctx = h.ctx({ cwd, ui, model: { provider: "p", id: "m" }, isIdle: () => true, sessionManager });
    await h.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    const run = (params: any, signal?: AbortSignal) => tool.execute("call", params, signal, undefined, ctx);
    const shutdown = async (reason?: string) => {
      await h.emit("session_shutdown", { type: "session_shutdown", ...(reason ? { reason } : {}) }, ctx);
      ended = true;
    };
    return { h, ctx, ui, run, shutdown, stale, events, tool };
  }
  return { agentDir, cwd, file, entries, children, stop, records, runtime };
}

test.each(["after adoption", "while parked"])("a reload hands a running async run to the next runtime; its result (due %s) is delivered once, by it", async (when) => {
  const s = session();
  const first = await s.runtime();
  const started = await first.run({ ...explicit, task: "survive the reload", async: true });
  const id = started.details.runs[0].id;
  expect(s.children).toHaveLength(1);

  await first.shutdown("reload");
  expect(s.stop).not.toHaveBeenCalled();
  expect(s.children[0]!.state.status).toBe("running");
  expect(isParked(id)).toBe(true);
  // The old runtime let go of its herdr hold while it still could; the new one holds its own.
  expect(first.events.filter((e) => e.name === "herdr:background").map((e) => e.data.active)).toEqual([true, false]);
  // Parked, its record still saying running does not read as lost.
  expect(recordedStatus({ id, status: "running" })).toBe("running");

  s.children[0]!.state.output = "Survived";
  if (when === "while parked") {
    (s.children[0] as any).finish("done");
    await tick();
  }
  const second = await s.runtime();
  expect(isParked(id)).toBe(false);
  if (when === "after adoption") {
    // Live in the new runtime: status and steer reach the child.
    const status = await second.run({ action: "status", id });
    expect(JSON.parse(status.content[0].text)).toMatchObject({ id, status: "running" });
    await second.run({ action: "steer", id, message: "carry on" });
    expect(second.events.some((e) => e.name === "bg:external" && e.data.id === `subagent:${id}` && e.data.state === "running")).toBe(true);
    (s.children[0] as any).finish("done");
    await tick();
  }
  await macrotask();
  expect(second.h.messages).toHaveLength(1);
  expect(second.h.messages[0].message.content).toMatch(/^Subagent "survive the reload" finished after/u);
  expect(second.h.messages[0].message.content).toContain("Survived");
  await second.h.emit("agent_settled", {}, second.ctx);
  expect(second.h.messages).toHaveLength(1);
  expect(first.h.messages).toHaveLength(0);
  expect(first.stale).toEqual([]);
  // The new runtime recorded how it ended, and pi-bg hears of it there.
  expect(s.records(id).at(-1)).toMatchObject({ status: "done" });
  expect(second.events.some((e) => e.name === "bg:external" && e.data.id === `subagent:${id}` && e.data.state === "done")).toBe(true);
  await second.shutdown("quit");
});

test.each(["parked", "adopted"])("family IDs and observation survive reload and finish while %s without stale calls", async (when) => {
  const s = session();
  const prepared: PreparedAgent = {
    agentId: "member-uuid", membership: { version: 1, familyId: "family-uuid", agentId: "member-uuid" },
    observer: () => undefined, extensions: ["/observer.ts"], env: {}, finish: vi.fn(), dispose: vi.fn(),
  };
  const first = await s.runtime(prepared);
  const result = await first.run({ ...explicit, task: "keep observation", async: true });
  const id = result.details.runs[0].id;
  expect(s.records(id).at(-1)).toMatchObject({ familyId: "family-uuid", agentId: "member-uuid" });
  await first.shutdown("reload");
  expect(prepared.dispose).not.toHaveBeenCalled();
  if (when === "parked") { (s.children[0] as any).finish("done"); await tick(); }
  // The replacement has no prepare service: adoption must not reserve a second identity.
  const second = await s.runtime();
  if (when === "adopted") { (s.children[0] as any).finish("done"); await tick(); }
  await macrotask();
  expect(s.children).toHaveLength(1);
  expect(s.records(id).at(-1)).toMatchObject({ familyId: "family-uuid", agentId: "member-uuid", status: "done" });
  expect(recordedRun(s.records(id).at(-1))).toMatchObject({ familyId: "family-uuid", agentId: "member-uuid" });
  expect(prepared.finish).toHaveBeenCalledTimes(1);
  expect(prepared.finish).toHaveBeenCalledWith("done", undefined);
  expect(prepared.dispose).toHaveBeenCalledTimes(1);
  expect(first.stale).toEqual([]);
  await second.shutdown("quit");
});

test("a foreground call running at a reload returns, and its result arrives as a message in the next runtime", async () => {
  const s = session();
  const first = await s.runtime();
  const call = first.run({ ...explicit, task: "in the foreground" });
  await vi.waitFor(() => expect(s.children).toHaveLength(1));
  await first.shutdown("reload");
  const returned = await call;
  expect(returned.content[0].text).toMatch(/^The session reloaded while this single ran: \w+ \(in the foreground/u);
  expect(s.stop).not.toHaveBeenCalled();
  const second = await s.runtime();
  s.children[0]!.state.output = "Foreground answer";
  (s.children[0] as any).finish("done");
  await tick();
  await macrotask();
  expect(second.h.messages).toHaveLength(1);
  expect(second.h.messages[0].message.content).toContain("Foreground answer");
  expect(first.h.messages).toHaveLength(0);
  expect(first.stale).toEqual([]);
  await second.shutdown("quit");
});

test("a parallel call keeps its unread members together across a reload and notes what never started", async () => {
  const s = session();
  const first = await s.runtime();
  mkdirSync(path.join(s.cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(s.cwd, ".pi", "pi-subagents.json"), JSON.stringify({ concurrency: 1 }));
  await first.run({ tasks: ["first member", "second member", "third member"].map((task) => ({ ...explicit, task })), async: true });
  expect(s.children).toHaveLength(1);
  (s.children[0] as any).finish("done");
  await vi.waitFor(() => expect(s.children).toHaveLength(2));
  await first.shutdown("reload");
  const second = await s.runtime();
  (s.children[1] as any).finish("done");
  await tick();
  await macrotask();
  expect(second.h.messages).toHaveLength(1);
  const content = second.h.messages[0].message.content;
  expect(content).toMatch(/^2 subagents \(parallel\) finished: first member, second member:/u);
  expect(content).toMatch(/\[1 queued task never started: the session reloaded first\.\]$/u);
  expect(s.children).toHaveLength(2);
  expect(first.stale).toEqual([]);
  await second.shutdown("quit");
});

test.each([["new", "stopped: session replaced (/new)"], ["resume", "stopped: session replaced (/resume)"], ["fork", "stopped: session replaced (/fork)"], ["quit", "stopped: pi quit"]])("a %s shutdown stops running children after recording that it did", async (reason, error) => {
  const s = session();
  const first = await s.runtime();
  const started = await first.run({ ...explicit, task: "replaced", async: true });
  const id = started.details.runs[0].id;
  await first.shutdown(reason);
  expect(s.stop).toHaveBeenCalled();
  expect(s.children[0]!.state.status).toBe("stopped");
  expect(isParked(id)).toBe(false);
  expect(s.records(id).at(-1)).toMatchObject({ status: "stopped", error });
  await tick();
  expect(first.stale).toEqual([]);
  // The next runtime reads the run as stopped, not lost, and can say why.
  const next = await s.runtime();
  const status = await next.run({ action: "status", id });
  expect(status.content[0].text).toContain(`"status": "stopped"`);
  expect(status.content[0].text).toContain(error);
  expect(status.content[0].text).toContain(`action=resume with id ${id}`);
  await next.shutdown("quit");
});

/** A record of a run from an earlier process, with its saved files. */
function oldRun(s: ReturnType<typeof session>, over: Record<string, unknown> = {}) {
  const id = `old${Math.random().toString(36).slice(2, 7)}`;
  const outputPath = path.join(s.agentDir, "subagents", id, "output.md");
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const data = { id, agent: "general", task: "Fix the flaky test", label: "Flaky test", model: "p/m", thinking: "low", byJev: { agent: false, model: false, thinking: false }, status: "running", turns: 3, tokens: 100, cost: 0, seconds: 20, outputPath, async: true, cwd: s.cwd, ...over };
  s.entries.push({ customType: "subagents:run", data });
  return data as typeof data & { id: string; outputPath: string };
}

test("a record still saying running that no runtime owns reads as lost; status, result, steer and stop on recorded runs", async () => {
  const s = session();
  const lost = oldRun(s);
  const save = transcriptWriter(path.join(path.dirname(lost.outputPath), "messages.jsonl"));
  save({ role: "user", content: [{ type: "text", text: lost.task }] });
  save({ role: "assistant", content: [{ type: "text", text: "Found the race in setup()" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] });
  const done = oldRun(s, { status: "done", task: "Summarize the log", label: "Summary" });
  writeFileSync(done.outputPath, "The log is clean.");
  const rt = await s.runtime();

  const list = await rt.run({ action: "status" });
  expect(list.content[0].text).toContain(`${lost.id}  lost    Flaky test · general`);
  expect(list.content[0].text).toContain(`${done.id}  done    Summary · general`);
  const status = await rt.run({ action: "status", id: lost.id });
  expect(status.content[0].text).toContain(`"status": "lost"`);
  expect(status.content[0].text).toContain("[Lost:");
  // No output.md: the conversation's last assistant text, with a note.
  const result = await rt.run({ action: "result", id: lost.id });
  expect(result.content[0].text).toMatch(/^\[Flaky test · general · lost\]\n\nFound the race in setup\(\)/u);
  expect(result.content[0].text).toContain(`action=resume with id ${lost.id} continues it`);
  const read = await rt.run({ action: "result", id: done.id.slice(0, 6) });
  expect(read.content[0].text).toBe("[Summary · general · done]\n\nThe log is clean.");
  await expect(rt.run({ action: "steer", id: lost.id, message: "go on" })).rejects.toThrow(/not running in this session \(lost\).*action=resume/u);
  await expect(rt.run({ action: "stop", id: done.id })).rejects.toThrow(/not running in this session \(done\)/u);
  await rt.shutdown("quit");
});

test("resumeTask: the task, what the run did, and where to pick up", () => {
  const task = "Fix the flaky test";
  const text = resumeTask(task, [
    { role: "user", content: [{ type: "text", text: task }] },
    { role: "assistant", content: [{ type: "text", text: "Looking at setup()" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test" } }] },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "1 failed" }] },
  ] as any);
  expect(text).toBe(`${task}\n\n${RESUME_HEADING}\n\nassistant: Looking at setup()\ntool: bash: npm test\ntool result (bash): 1 failed\n\n${RESUME_FOOTER}`);
  expect(RESUME_HEADING).toBe("You were interrupted before finishing. What you already did:");
  expect(resumeTask(task, [])).toContain("(nothing was recorded)");
});

test("resume starts a new run with the same agent, model, thinking, folder and mode, given what the old one did", async () => {
  const s = session();
  const lost = oldRun(s, { async: true });
  const save = transcriptWriter(path.join(path.dirname(lost.outputPath), "messages.jsonl"));
  save({ role: "user", content: [{ type: "text", text: lost.task }] });
  save({ role: "assistant", content: [{ type: "text", text: "Found the race in setup()" }] });
  const done = oldRun(s, { status: "done" });
  const rt = await s.runtime();
  const resumed = await rt.run({ action: "resume", id: lost.id });
  expect(resumed.content[0].text).toMatch(/^Started single in the background: \w+ \(Flaky test \(resumed\) · general, p\/m, low\)/u);
  expect(s.children).toHaveLength(1);
  const options = (s.children[0] as any).options;
  expect(options).toMatchObject({ cwd: s.cwd, model: "p/m", thinking: "low" });
  expect(options.task).toBe(`${lost.task}\n\n${RESUME_HEADING}\n\nassistant: Found the race in setup()\n\n${RESUME_FOOTER}`);
  expect(resumed.details.runs[0]).toMatchObject({ label: "Flaky test (resumed)", agent: "general" });
  await expect(rt.run({ action: "resume", id: done.id })).rejects.toThrow(/is done; only a stopped or lost run can be resumed/u);
  await expect(rt.run({ action: "resume", id: resumed.details.runs[0].id })).rejects.toThrow(/still running/u);
  await rt.shutdown("quit");
});

test("a parked run nobody adopts within 30 seconds is stopped, and then reads as lost", async () => {
  const s = session();
  const first = await s.runtime();
  const started = await first.run({ ...explicit, task: "orphaned", async: true });
  const id = started.details.runs[0].id;
  vi.useFakeTimers();
  await first.shutdown("reload");
  vi.advanceTimersByTime(ADOPT_TIMEOUT_MS - 1);
  expect(s.children[0]!.state.status).toBe("running");
  expect(isParked(id)).toBe(true);
  vi.advanceTimersByTime(1);
  expect(s.stop).toHaveBeenCalledTimes(1);
  expect(s.children[0]!.state.status).toBe("stopped");
  expect(isParked(id)).toBe(false);
  expect(recordedStatus({ id, status: "running" })).toBe("lost");
  vi.useRealTimers();
  await tick();
  expect(first.stale).toEqual([]);
});
