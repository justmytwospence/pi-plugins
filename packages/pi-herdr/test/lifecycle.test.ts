// index.ts end to end with a fake pi and a fake herdr (test/core/fake.ts): no socket, no pane.
// Children are a read-only activity source; records come back from the current branch only;
// replies wait for pi to be idle and are delivered once; nothing calls pi after shutdown.
import { afterEach, expect, test, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_CHANGED, ACTIVITY_GONE, ACTIVITY_HOST, ACTIVITY_SECTION, type ActivitySection } from "../src/activity.ts";
import { ChildrenActivity } from "../src/children-activity.ts";
import { Children, type ChildRecord } from "../src/core/children.ts";
import piHerdr from "../src/index.ts";
import { fakeCall } from "./core/fake.ts";

afterEach(() => vi.unstubAllEnvs());

const SESSION = "/sessions/child.jsonl";

/** A herdr with the parent pane and one child pane whose agent state the test sets. */
function herdr() {
  const state = { agent_status: "idle", completion_seq: 1, state_change_seq: 1, interactive_ready: true, agent_session: { kind: "path", value: SESSION }, gone: false };
  const f = fakeCall({
    "pane.get": (p) => ({ result: { pane: { pane_id: p.pane_id, workspace_id: "w1" } } }),
    "agent.list": () => ({ result: { agents: [] } }),
    "tab.create": () => ({ result: { root_pane: { pane_id: "w1:p2" } } }),
    "agent.start": () => ({ result: {} }),
    "agent.get": () => (state.gone ? { error: { code: "not_found", message: "no agent" } } : { result: { agent: { ...state } } }),
    "agent.prompt": () => ({ result: {} }),
    "agent.read": () => ({ result: { read: { text: "typing away" } } }),
    "agent.send_keys": () => ({ result: {} }),
    "pane.close": () => ({ result: {} }),
  });
  return { f, state };
}

/** A fake pi: handlers, a working event bus, recorded entries and messages. */
function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const emitted: Array<[string, any]> = [];
  const entries: Array<{ customType: string; data: any }> = [];
  const messages: any[] = [];
  let tool: any;
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    events: {
      emit: (channel: string, data: unknown) => {
        emitted.push([channel, data]);
        for (const fn of listeners.get(channel) ?? []) fn(data);
      },
      on: (channel: string, fn: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
        return () => undefined;
      },
    },
    registerTool: (t: unknown) => void (tool = t),
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
    sendMessage: (message: unknown, options: unknown) => void messages.push({ message, options }),
    getActiveTools: () => [],
    setActiveTools: () => undefined,
    getThinkingLevel: () => "medium",
    getSessionName: () => undefined,
  };
  const emit = async (event: string, payload: any, ctx: any) => {
    const results: unknown[] = [];
    for (const h of handlers.get(event) ?? []) results.push(await h(payload, ctx));
    return results;
  };
  return { pi: pi as unknown as ExtensionAPI, emit, emitted, entries, messages, tool: () => tool };
}

function ctxOf(branch: unknown[], idle = true) {
  const customs: Array<{ component: any; close: () => void }> = [];
  const ui = {
    notify: () => undefined,
    custom: (factory: (tui: any, theme: any, kb: unknown, done: (r: unknown) => void) => any) =>
      new Promise<void>((resolve) => {
        const entry = { component: undefined as any, close: () => undefined };
        entry.close = () => {
          entry.component.dispose?.();
          resolve();
        };
        entry.component = factory({ requestRender: () => undefined, terminal: { rows: 30 } }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, undefined, entry.close);
        customs.push(entry);
      }),
  };
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    ui,
    customs,
    model: { provider: "p", id: "m" },
    isIdle: () => idle,
    sessionManager: { getBranch: () => branch, getEntries: () => [...branch, ...offBranch] },
  };
}
/** Entries pi would return from getEntries but that are not on the current branch. */
const offBranch: unknown[] = [];

function inHerdr() {
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_SOCKET_PATH", "/nonexistent/herdr.sock");
  vi.stubEnv("HERDR_PANE_ID", "w1:p1");
  vi.stubEnv("PI_HERDR_PR", "0");
}

test("custom starts update identity without requiring a user prompt", async () => {
  const p = fakePi();
  piHerdr(p.pi);
  const ctx = ctxOf([]);
  await p.emit("before_agent_start", { messageType: "custom", message: { content: "Child finished" } }, ctx);
  await p.emit("before_agent_start", { messageType: "user", prompt: "Review auth" }, ctx);
  await p.emit("session_shutdown", {}, ctx);
});

test("message_end gives tool calls without a summary an intent, only in a live TUI session", async () => {
  inHerdr();
  const { f } = herdr();
  const p = fakePi();
  piHerdr(p.pi, { call: f.call, exec: async () => ({ code: 0, stdout: "", stderr: "" }), pollMs: 60_000 });
  const message = { role: "assistant", content: [{ type: "toolCall", id: "1", name: "subagent", arguments: { task: "Audit it", label: "Audit" } }] };
  const ctx = ctxOf([]);
  expect(await p.emit("message_end", { type: "message_end", message }, ctx)).toEqual([undefined]);
  await p.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  const [result] = (await p.emit("message_end", { type: "message_end", message }, ctx)) as Array<{ message: any } | undefined>;
  expect(result?.message.content[0]).toMatchObject({ name: "subagent", intent: "Audit" });
  await p.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
});

test("the summary token: cleared as a run starts, set before settling, and a blocked dialog's question", async () => {
  inHerdr();
  const { f } = herdr();
  const p = fakePi();
  piHerdr(p.pi, { call: f.call, exec: async () => ({ code: 0, stdout: "", stderr: "" }), pollMs: 60_000 });
  const branch: any[] = [];
  const ctx = { ...ctxOf(branch), modelRegistry: { find: () => ({ id: "haiku" }), hasConfiguredAuth: () => true, complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Fixed the parser" }] }) } };
  await p.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  const summaries = () => f.of("pane.report_metadata").map((l) => l.params.tokens).filter((t) => t && "summary" in t).map((t) => t.summary?.value ?? t.summary);

  branch.push({ type: "message", message: { role: "user", content: "Fix it" } });
  branch.push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_user_question", arguments: { questions: [{ header: "Fix", question: "Which fix?" }] } }] } });
  await p.emit("agent_start", {}, ctx);
  p.pi.events.emit("herdr:blocked", { active: true, label: "Fix" });
  p.pi.events.emit("herdr:blocked", { active: false });
  branch.push({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Fixed it.\n\nDetails follow at length." }] } });
  await p.emit("agent_before_settle", { type: "agent_before_settle" }, ctx);
  expect(summaries()).toEqual(["Which fix?", "Fixed the parser"]);

  await p.emit("agent_start", {}, ctx);
  expect(summaries()).toEqual(["Which fix?", "Fixed the parser", null]);
  await p.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
});

test("with pi-recap answering recap:summary, a settled turn's summary token is its recap, with no model call of its own", async () => {
  inHerdr();
  const { f } = herdr();
  const p = fakePi();
  piHerdr(p.pi, { call: f.call, exec: async () => ({ code: 0, stdout: "", stderr: "" }), pollMs: 60_000 });
  p.pi.events.on("recap:summary", (e: any) => e.reply(Promise.resolve("Recap from pi-recap")));
  const complete = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: "own summary" }] }));
  const branch: any[] = [
    { type: "message", message: { role: "user", content: "Fix it" } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Fixed it.\n\nDetails follow at length." }] } },
  ];
  const ctx = { ...ctxOf(branch), modelRegistry: { find: () => ({ id: "haiku" }), hasConfiguredAuth: () => true, complete } };
  await p.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  await p.emit("agent_before_settle", { type: "agent_before_settle" }, ctx);
  const summaries = f.of("pane.report_metadata").map((l) => l.params.tokens).filter((t) => t && "summary" in t).map((t) => t.summary?.value ?? t.summary);
  expect(summaries).toEqual(["Recap from pi-recap"]);
  expect(complete).not.toHaveBeenCalled();
  await p.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
});

test("children are a read-only activity source: entries, details without touching the pane, interrupt only while awaited, never close", async () => {
  const { f, state } = herdr();
  const changes: string[] = [];
  const children = new Children({
    call: f.call,
    agent: { kind: "pi", args: () => [], reply: async () => "done" },
    selfPane: "w1:p1",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    persist: (rec) => activity.observe(rec),
    deliver: () => undefined,
    hold: () => undefined,
    pollMs: 60_000,
    readyPollMs: 1,
  });
  let now = 1_000;
  const activity = new ChildrenActivity(children, { changed: () => void changes.push("changed"), now: () => now });
  const section = activity.section;
  expect(section.entries(now)).toEqual([]);
  expect(section.pill?.(now)).toBeUndefined();
  const rec = await children.spawn({ task: "Review the auth module", cwd: "/repo" });
  now += 65_000;
  expect(section.entries(now)).toEqual([expect.objectContaining({ key: rec.name, label: rec.name, status: "running", stats: "turn · 1:05", detail: expect.stringContaining("tab · pane w1:p2 · Review the auth module") })]);
  expect(section.pill?.(now)).toEqual({ label: "1 child" });
  expect(section.canStop?.(rec.name)).toBe(true);
  // x: Escape in its pane, nothing else; the pane is never closed from here.
  section.stop?.(rec.name);
  await new Promise((r) => setTimeout(r, 0));
  expect(f.of("agent.send_keys")).toHaveLength(1);
  expect(f.of("pane.close")).toHaveLength(0);
  // Dismiss does nothing while awaited.
  section.dismiss?.(rec.name);
  expect(section.entries(now)).toHaveLength(1);
  // Details: the record and what read says; no focus, no pane call.
  const customs: any[] = [];
  const ui = {
    custom: (factory: any) =>
      new Promise<void>((resolve) => {
        const c = factory({ requestRender: () => undefined, terminal: { rows: 30 } }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, undefined, () => resolve());
        customs.push(c);
      }),
  };
  const opened = section.open(rec.name, ui);
  await new Promise((r) => setTimeout(r, 5));
  const text = customs[0].render(80).join("\n");
  expect(text).toContain(`herdr child ${rec.name} · read-only`);
  expect(text).toContain("Review the auth module");
  expect(text).toContain("reply pending");
  expect(customs[0][Symbol.for("pi-plugins.input-context.v1")]()).toBe("viewer");
  expect(f.log.map((c) => c.method).filter((m) => /focus|close/u.test(m))).toEqual([]);
  customs[0].handleInput("\x1b");
  await opened;
  // The turn ends: the row is done, and can be dismissed; stop no longer applies.
  state.completion_seq = 2;
  await children.tick();
  now += 1_000;
  expect(section.entries(now)[0]).toMatchObject({ status: "done", stats: "replied · 0:01 ago" });
  expect(section.canStop?.(rec.name)).toBe(false);
  expect(section.pill?.(now)).toBeUndefined();
  section.dismiss?.(rec.name);
  expect(section.entries(now)).toEqual([]);
  expect(changes.length).toBeGreaterThan(0);
  // Hosts are tracked by id.
  section.setHosted?.(true, "subagents");
  section.setHosted?.(true, "bg");
  section.setHosted?.(false, "bg");
  expect(activity.hosted).toBe(true);
  section.setHosted?.(false, "subagents");
  expect(activity.hosted).toBe(false);
});

test("the section is offered at a TUI session start and on activity:host, withdrawn at shutdown; records come from the branch only", async () => {
  inHerdr();
  const { f, state } = herdr();
  const p = fakePi();
  piHerdr(p.pi, { call: f.call, exec: async () => ({ code: 0, stdout: "", stderr: "" }), pollMs: 60_000 });
  const onBranch: ChildRecord = { name: "kept", paneId: "w1:p2", where: "tab", cwd: "/repo", task: "keep going", createdAt: 1, awaiting: false };
  const abandoned: ChildRecord = { name: "lost", paneId: "w1:p9", where: "tab", cwd: "/repo", task: "another history", createdAt: 1, awaiting: true, baseline: { completionSeq: 1 } };
  offBranch.push({ type: "custom", customType: "pi-herdr:child", data: abandoned });
  const ctx = ctxOf([{ type: "custom", customType: "pi-herdr:child", data: onBranch }]);
  await p.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  const offered = p.emitted.filter(([c]) => c === ACTIVITY_SECTION).map(([, d]) => d.section as ActivitySection);
  expect(offered.map((s) => s.id)).toEqual(["herdr"]);
  expect(offered[0]?.entries(Date.now()).map((e) => e.key)).toEqual(["kept"]);
  // No hold for the abandoned branch's awaited child: it is not this conversation's.
  expect(p.emitted.filter(([c]) => c === "herdr:background")).toEqual([]);
  p.pi.events.emit(ACTIVITY_HOST, { host: "subagents", priority: 20 });
  expect(p.emitted.filter(([c]) => c === ACTIVITY_SECTION)).toHaveLength(2);
  // The tool's list shows only the branch's child.
  expect(await p.tool().execute("t", { action: "list" }, undefined, undefined, ctx)).toMatchObject({ content: [{ text: expect.stringContaining("kept") }] });
  expect(JSON.stringify(await p.tool().execute("t", { action: "list" }, undefined, undefined, ctx))).not.toContain("lost");
  await p.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
  expect(p.emitted.some(([c, d]) => c === ACTIVITY_GONE && d.id === "herdr")).toBe(true);
  void state;
  offBranch.length = 0;
});

test("a reply waits for pi to be idle, is delivered once per awaited turn, and nothing reaches pi after shutdown", async () => {
  inHerdr();
  const { f, state } = herdr();
  const p = fakePi();
  // A fast poll, so the restored record's turn is found without waiting for the real 2 s loop.
  piHerdr(p.pi, { call: f.call, exec: async () => ({ code: 0, stdout: "", stderr: "" }), pollMs: 5 });
  // The child's session file: a reply for the restored record.
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const file = path.join(mkdtempSync(path.join(tmpdir(), "herdr-child-")), "child.jsonl");
  writeFileSync(file, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Finished: all green." }] } })}\n`);
  state.agent_session = { kind: "path", value: file };
  const awaited: ChildRecord = { name: "worker", paneId: "w1:p2", where: "tab", cwd: "/repo", task: "run it", createdAt: 1, awaiting: true, baseline: { completionSeq: 1, stateSeq: 1 }, session: file };
  let idle = false;
  const ctx = { ...ctxOf([{ type: "custom", customType: "pi-herdr:child", data: awaited }]), isIdle: () => idle };
  await p.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  expect(p.emitted.filter(([c, d]) => c === "herdr:background" && d.active)).toHaveLength(1);
  expect(p.emitted.some(([c]) => c === ACTIVITY_CHANGED)).toBe(true);
  // The turn completes while pi is busy: the poll finds it, saves the record, and owes the reply.
  state.completion_seq = 2;
  await until(() => p.entries.some((e) => e.data?.name === "worker" && e.data.awaiting === false));
  expect(p.messages).toHaveLength(0);
  expect(p.emitted.filter(([c, d]) => c === "herdr:background" && !d.active)).toHaveLength(1);
  // Idle: the owed reply goes out once; a settle later does not repeat it.
  idle = true;
  await p.emit("agent_settled", { type: "agent_settled" }, ctx);
  expect(p.messages).toHaveLength(1);
  expect(p.messages[0].message.content).toContain("Finished: all green.");
  expect(p.messages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
  await p.emit("agent_settled", { type: "agent_settled" }, ctx);
  expect(p.messages).toHaveLength(1);
  // The same awaited turn restored with this branch's durable receipt is not delivered twice.
  const stillAwaiting = { type: "custom", customType: "pi-herdr:child", data: awaited };
  const restoredBranch = [stillAwaiting, ...p.entries.filter((e) => e.customType === "pi-herdr:delivered").map((e) => ({ type: "custom", ...e }))];
  expect(restoredBranch).toHaveLength(2);
  await p.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
  await p.emit("session_start", { type: "session_start", reason: "reload" }, { ...ctx, sessionManager: { getBranch: () => restoredBranch, getEntries: () => restoredBranch } });
  await until(() => p.emitted.filter(([c, d]) => c === "herdr:background" && !d.active).length >= 2);
  await p.emit("agent_settled", { type: "agent_settled" }, ctx);
  expect(p.messages).toHaveLength(1);
  // After shutdown pi is stale: a late poll or settle calls nothing (an unhandled rejection would fail this test).
  await p.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
  const stale = () => {
    throw new Error("This extension ctx is stale");
  };
  p.pi.appendEntry = stale as never;
  p.pi.sendMessage = stale as never;
  p.pi.events.emit = stale as never;
  await p.emit("agent_settled", { type: "agent_settled" }, ctx);
  await new Promise((r) => setTimeout(r, 30));
  expect(p.messages).toHaveLength(1);
});

async function until(check: () => boolean, ms = 2_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
