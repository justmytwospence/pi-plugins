// The turn's end with async calls running: pi-subagents keeps the turn open (so Herdr, tmux and Pi
// show it working) and delivers the result into the same run; with pi-bg present it only publishes
// each call as `settle` outside work and pi-bg does the waiting.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { Child } from "../src/child.ts";
import subagents from "../src/index.ts";
import { WORKING_MESSAGE_EVENT } from "../src/working-message.ts";
import { harness } from "./harness.ts";
import { fakeUI } from "./ui-helpers.ts";

const explicit = { agent: "general", model: "p/m", thinking: "low" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function runtime(options: { bg?: boolean; mode?: string } = {}) {
  vi.stubEnv("PI_CODING_AGENT_DIR", mkdtempSync(path.join(tmpdir(), "subagents-settle-")));
  const cwd = mkdtempSync(path.join(tmpdir(), "subagents-settle-cwd-"));
  const children: Child[] = [];
  vi.spyOn(Child.prototype, "start").mockImplementation(function (this: Child) {
    children.push(this);
    return this;
  });
  const h = harness();
  let tool: any;
  h.pi.registerTool = (t: any) => { if (t.name === "subagent") tool = t; };
  const events: Array<{ name: string; data: any }> = [];
  const listeners = new Map<string, Array<(data: any) => void>>();
  h.pi.events = {
    emit: (name: string, data: any) => {
      events.push({ name, data });
      if (name === "bg:probe" && options.bg) data.reply?.();
      for (const fn of listeners.get(name) ?? []) fn(data);
    },
    on: (name: string, fn: (data: any) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); return () => undefined; },
  };
  subagents(h.pi);
  const working: Array<string | undefined> = [];
  const visible: boolean[] = [];
  const ui = Object.assign(fakeUI(), {
    setWorkingMessage: (m?: string) => { working.push(m); },
    setWorkingVisible: (v: boolean) => { visible.push(v); },
  });
  const state = { idle: false, pending: false };
  const ctx = h.ctx({ cwd, ui, mode: options.mode ?? "tui", model: { provider: "p", id: "m" }, isIdle: () => state.idle, hasPendingMessages: () => state.pending });
  await h.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  const run = (params: any) => tool.execute("call", params, undefined, undefined, ctx);
  /** Like Pi's emitBoundary: each handler sees the entries and continue proposed so far. */
  const boundary = async (over: Record<string, unknown> = {}) => {
    let entries: any[] = [];
    let cont = false;
    for (const handler of h.handlers.get("agent_before_settle") ?? []) {
      const r = (await handler({ type: "agent_before_settle", outcome: "completed", entries, continue: cont, context: { canContinue: false }, ...over }, ctx)) as any;
      if (r?.entries !== undefined) entries = r.entries;
      if (r?.continue !== undefined) cont = r.continue;
    }
    return { entries, continue: cont };
  };
  const settled = async () => { for (const handler of h.handlers.get("agent_settled") ?? []) await handler({ type: "agent_settled" }, ctx); };
  const finish = async (index = 0) => { (children[index] as any).finish("done"); await tick(); };
  const shutdown = () => h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
  return { h, ui, ctx, state, run, boundary, settled, finish, shutdown, events, working, visible, children };
}

test("keeps the turn open until the async call ends, then continues the run with its result", async () => {
  const rt = await runtime();
  await rt.run({ ...explicit, task: "audit thing", async: true });
  setTimeout(() => void rt.finish(), 50);
  const r = await rt.boundary();
  expect(r.continue).toBe(true);
  expect(r.entries).toHaveLength(1);
  expect(r.entries[0].type).toBe("custom_message");
  expect(r.entries[0].customType).toBe("subagent-result");
  expect(r.entries[0].content).toMatch(/^Subagent "audit thing" finished after/u);
  const waits = rt.events.filter((e) => e.name === "herdr:waiting").map((e) => e.data);
  expect(waits).toEqual([{ active: true, label: 'subagent "audit thing"', id: waits[0].id }, { active: false, id: waits[0].id }]);
  const claims = rt.events.filter((e) => e.name === WORKING_MESSAGE_EVENT).map((e) => e.data);
  expect(claims[0].message).toBe('Waiting on subagent "audit thing"…');
  expect(claims.at(-1)).toEqual({ owner: claims[0].owner });
  expect(rt.visible).toEqual([true]);
  rt.state.idle = true;
  await rt.settled();
  expect(rt.visible).toEqual([true, false, true]);
  // Delivered in the run: no message follows.
  expect(rt.h.messages).toEqual([]);
  await rt.shutdown();
});

test("keeps entries proposed by earlier handlers", async () => {
  const rt = await runtime();
  await rt.run({ ...explicit, task: "keep entries", async: true });
  setTimeout(() => void rt.finish(), 50);
  const prev = { type: "custom_message", customType: "other", content: "earlier", display: true };
  const r = await rt.boundary({ entries: [prev] });
  expect(r.entries).toHaveLength(2);
  expect(r.entries[0]).toBe(prev);
  expect(r.continue).toBe(true);
  await rt.shutdown();
});

test("does not wait with nothing running, after an abort, with queued messages, outside the TUI, or with pi-bg loaded", async () => {
  const none = await runtime();
  expect(await none.boundary()).toEqual({ entries: [], continue: false });
  await none.run({ ...explicit, task: "still running", async: true });
  expect((await none.boundary({ outcome: "aborted" })).continue).toBe(false);
  none.state.pending = true;
  expect((await none.boundary()).continue).toBe(false);
  expect(none.events.some((e) => e.name === "herdr:waiting")).toBe(false);
  await none.shutdown();

  const rpc = await runtime({ mode: "rpc" });
  await rpc.run({ ...explicit, task: "headless", async: true });
  expect((await rpc.boundary()).continue).toBe(false);
  await rpc.shutdown();

  const withBg = await runtime({ bg: true });
  await withBg.run({ ...explicit, task: "bg waits", async: true });
  const started = Date.now();
  expect((await withBg.boundary()).continue).toBe(false);
  expect(Date.now() - started).toBeLessThan(200);
  expect(withBg.events.some((e) => e.name === "herdr:waiting")).toBe(false);
  await withBg.shutdown();
});

test("Esc ends the wait; the result then arrives as a message, once", async () => {
  const rt = await runtime();
  await rt.run({ ...explicit, task: "interrupted", async: true });
  setTimeout(() => rt.ui.press("\x1b"), 50);
  expect((await rt.boundary()).continue).toBe(false);
  rt.state.idle = true;
  await rt.settled();
  expect(rt.h.messages).toHaveLength(0);
  await rt.finish();
  expect(rt.h.messages).toHaveLength(1);
  expect(rt.h.messages[0].message.content).toMatch(/^Subagent "interrupted" finished after/u);
  await rt.settled();
  expect(rt.h.messages).toHaveLength(1);
  await rt.shutdown();
});

test.each([false, true])("a result due during the turn goes into the run at the boundary (pi-bg present: %s)", async (bg) => {
  const rt = await runtime({ bg });
  await rt.run({ ...explicit, task: "due early", async: true });
  await rt.finish();
  expect(rt.h.messages).toEqual([]);
  const r = await rt.boundary();
  expect(r.continue).toBe(true);
  expect(r.entries).toHaveLength(1);
  expect(r.entries[0].content).toMatch(/^Subagent "due early" finished after/u);
  rt.state.idle = true;
  await rt.settled();
  expect(rt.h.messages).toEqual([]);
  await rt.shutdown();
});

test("with pi-bg present each call is settle outside work, and consuming it suppresses the message", async () => {
  const rt = await runtime({ bg: true });
  await rt.run({ ...explicit, task: "published", async: true });
  const running = rt.events.find((e) => e.name === "bg:external" && /^subagent-call:\d+$/u.test(e.data.id));
  expect(running?.data).toMatchObject({ state: "running", settle: true, label: 'subagent "published"' });
  await rt.finish();
  const done = rt.events.filter((e) => e.name === "bg:external" && e.data.id === running!.data.id).at(-1)!.data;
  expect(done).toMatchObject({ state: "done", settle: true });
  expect(done.result).toMatch(/^Subagent "published" finished after/u);
  rt.h.pi.events.emit("bg:external-consumed", { id: running!.data.id });
  rt.state.idle = true;
  await rt.settled();
  expect(rt.h.messages).toEqual([]);
  await rt.shutdown();
});
