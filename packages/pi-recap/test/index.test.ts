import { afterEach, beforeEach, expect, test, vi } from "vitest";
import piRecap, { LABEL, WIDGET, recapLines } from "../src/index.ts";
import { harness } from "./harness.ts";

const LONG = "I changed the parser so empty lines are skipped.\n\nMore detail on a second line.";
let n = 0;
const user = (text: string) => ({ type: "message", id: `e${n++}`, message: { role: "user", content: text } });
const assistant = (text: string) => ({ type: "message", id: `e${n++}`, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });

function setup(answer = "Fixed the parser; tests pass") {
  const h = harness();
  piRecap(h.pi);
  const branch: any[] = [user("Fix the parser"), assistant(LONG)];
  const complete = vi.fn(async () => ({ stopReason: "stop", content: [{ type: "text", text: answer }] }));
  const modelRegistry = { find: (provider: string, id: string) => ({ provider, id }), hasConfiguredAuth: () => true, complete };
  const ctx = h.ctx({ sessionManager: { getBranch: () => branch, getSessionId: () => "s" }, modelRegistry, waitForIdle: async () => undefined });
  const settle = async (aborted = false) => {
    await h.emit("agent_before_settle", { type: "agent_before_settle" }, ctx);
    await h.emit("agent_settled", { type: "agent_settled", aborted }, ctx);
  };
  const ask = () => {
    let got: Promise<string | undefined> | undefined;
    h.pi.events.emit("recap:summary", { reply: (p: Promise<string | undefined>) => { got = p; } });
    return got;
  };
  return { h, ctx, ui: ctx.ui, branch, complete, settle, ask };
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.PI_RECAP;
  delete process.env.PI_RECAP_DELAY_MS;
});
afterEach(() => vi.useRealTimers());

test("the recap appears after the idle delay, and a new run clears it", async () => {
  const { h, ctx, ui, settle, complete } = setup();
  await h.emit("session_start", {}, ctx);
  await h.emit("agent_start", {}, ctx);
  await settle();
  expect(ui.widgets.has(WIDGET)).toBe(false);
  await vi.advanceTimersByTimeAsync(179_000);
  expect(ui.widgets.has(WIDGET)).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(ui.widgetLines(WIDGET)).toEqual([` ${LABEL}Fixed the parser; tests pass`]);
  expect(complete).toHaveBeenCalledOnce();
  await h.emit("agent_start", {}, ctx);
  expect(ui.widgets.has(WIDGET)).toBe(false);
});

test("pi-herdr's request gets the same memoized text, with one model call", async () => {
  const { h, ctx, settle, complete, ask } = setup();
  await h.emit("session_start", {}, ctx);
  const herdr = ask();
  await settle();
  expect(await herdr).toBe("Fixed the parser; tests pass");
  expect(await ask()).toBe("Fixed the parser; tests pass");
  await vi.advanceTimersByTimeAsync(180_000);
  expect(ctx.ui.widgetLines(WIDGET)?.[0]).toContain("Fixed the parser; tests pass");
  expect(complete).toHaveBeenCalledOnce();
});

test("a new turn gets a new recap", async () => {
  const { h, ctx, branch, complete, ask, settle } = setup();
  await h.emit("session_start", {}, ctx);
  await settle();
  await ask();
  branch.push(user("and the writer"), assistant(LONG));
  await h.emit("agent_start", {}, ctx);
  await settle();
  await ask();
  expect(complete).toHaveBeenCalledTimes(2);
});

test("no recap line after an interrupted run, a short reply already on screen, a new run or PI_RECAP=0", async () => {
  const a = setup();
  await a.h.emit("session_start", {}, a.ctx);
  await a.settle(true);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(a.ui.widgets.has(WIDGET)).toBe(false);

  const b = setup();
  b.branch.push(user("push it"), assistant("Pushed."));
  await b.h.emit("session_start", {}, b.ctx);
  await b.settle();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(b.ui.widgets.has(WIDGET)).toBe(false);
  expect(await b.ask()).toBe("Pushed.");

  const c = setup();
  await c.h.emit("session_start", {}, c.ctx);
  await c.settle();
  await vi.advanceTimersByTimeAsync(60_000);
  await c.h.emit("agent_start", {}, c.ctx);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(c.ui.widgets.has(WIDGET)).toBe(false);

  process.env.PI_RECAP = "0";
  const d = setup();
  await d.h.emit("session_start", {}, d.ctx);
  await d.settle();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(d.ui.widgets.has(WIDGET)).toBe(false);
  expect(await d.ask()).toBe("Fixed the parser; tests pass");
});

test("PI_RECAP_DELAY_MS sets the delay", async () => {
  process.env.PI_RECAP_DELAY_MS = "10000";
  const { h, ctx, ui, settle } = setup();
  await h.emit("session_start", {}, ctx);
  await settle();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(ui.widgets.has(WIDGET)).toBe(true);
});

test("non-interactive sessions stay dormant and answer no requests", async () => {
  const { h, ctx, settle, ask, complete } = setup();
  ctx.mode = "print";
  await h.emit("session_start", {}, ctx);
  await settle();
  expect(ask()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(complete).not.toHaveBeenCalled();
});

test("/recap shows the recap at once, even a short reply, and warns when there is nothing", async () => {
  const { h, ctx, ui, branch } = setup();
  await h.emit("session_start", {}, ctx);
  await h.commands.get("recap").handler("", ctx);
  expect(ui.widgetLines(WIDGET)).toEqual([` ${LABEL}Fixed the parser; tests pass`]);
  branch.push(user("push it"), assistant("Pushed."));
  await h.commands.get("recap").handler("", ctx);
  expect(ui.widgetLines(WIDGET)).toEqual([` ${LABEL}Pushed.`]);
  branch.length = 0;
  await h.commands.get("recap").handler("", ctx);
  expect(ui.widgets.has(WIDGET)).toBe(false);
  expect(ui.notes.at(-1)).toEqual({ message: "Nothing to recap yet", type: "warning" });
});

test("long recaps wrap and line up after the label", () => {
  const lines = recapLines("one two three four five six seven eight nine ten", 30);
  expect(lines[0].startsWith(` ${LABEL}`)).toBe(true);
  expect(lines.length).toBeGreaterThan(1);
  for (const l of lines.slice(1)) expect(l.startsWith(" ".repeat(1 + LABEL.length))).toBe(true);
});
