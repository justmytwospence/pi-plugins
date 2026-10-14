import { afterEach, beforeEach, expect, it, vi } from "vitest";
import piBg from "../src/index.ts";
import { WORKING_MESSAGE_EVENT } from "../src/working-message.ts";
import { fakeCtx, fakePi } from "./fake.ts";

const { registryMock } = vi.hoisted(() => ({ registryMock: vi.fn() }));
vi.mock("../src/registry.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/registry.ts")>(), registry: registryMock,
}));

let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  registryMock.mockReturnValue({
    tasks: new Map(), list: () => [], running: () => [], sweep: () => [],
    subscribe: () => () => {}, forgetEnded() {}, attach() {}, detach() {}, release() {}, killAll: async () => {},
  });
});
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
});

async function setup() {
  const f = fakePi();
  const c = fakeCtx("/tmp");
  Object.assign(f.pi, {
    getThinkingLevel: () => "high", getSessionName: () => "", getCommands: () => [], getAllTools: () => [],
    appendEntry() {},
  });
  Object.assign(c.ctx, {
    model: { provider: "test", id: "test", contextWindow: 1000 },
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => undefined,
  });
  Object.assign(c.ctx.sessionManager, { getBranch: () => [], getEntries: () => [] });
  Object.assign(c.ctx.ui, {
    theme: c.theme, setFooter() {}, getEditorComponent: () => undefined, setEditorComponent() {},
  });
  piBg(f.pi as never);
  // Runtime-only sibling integration; keep this component's TypeScript root independent.
  const footerPath = new URL("../../pi-status-footer/src/index.ts", import.meta.url).href;
  const { default: statusFooter } = await import(footerPath);
  statusFooter(f.pi as never);
  const event = async (name: string) => {
    for (const handler of f.handlers.get(name) ?? []) await handler({ type: name, reason: "reload" }, c.ctx);
  };
  cleanup = () => event("session_shutdown");
  await event("session_start");
  await event("turn_start");
  const running = (id: string) => f.pi.events.emit("bg:external", { id, label: id, state: "running" });
  const finish = (id: string) => f.pi.events.emit("bg:external", { id, label: id, state: "done" });
  const wait = (id: string, timeout = 30, signal?: AbortSignal) =>
    f.tools.get("bg_wait").execute("wait-id", { id, timeout }, signal, undefined, c.ctx);
  return { ...f, ...c, event, running, finish, wait };
}

it("both plugins keep Waiting on visible across timer ticks, then resume Working", async () => {
  const h = await setup();
  h.running("build");
  const pending = h.wait("build");
  await vi.advanceTimersByTimeAsync(6_000);
  expect(h.working.length).toBeGreaterThan(2);
  expect(h.working.every((message) => message?.startsWith("Waiting on build"))).toBe(true);
  h.finish("build");
  await pending;
  expect(h.working.at(-1)).toMatch(/^Working/);
  expect(h.emitted.filter((e) => e.channel === WORKING_MESSAGE_EVENT && !e.data.message)).toHaveLength(1);
});

it("overlapping waits preserve the newest owner and ignore stale releases", async () => {
  const h = await setup();
  h.running("older"); h.running("newer");
  const older = h.wait("older");
  const newer = h.wait("newer");
  await vi.advanceTimersByTimeAsync(4_000);
  expect(h.working.slice(2).every((message) => message?.startsWith("Waiting on newer"))).toBe(true);
  h.finish("older");
  await older;
  expect(h.working.at(-1)).toMatch(/^Waiting on newer/);
  h.pi.events.emit(WORKING_MESSAGE_EVENT, { owner: "stale-owner" });
  expect(h.working.at(-1)).toMatch(/^Waiting on newer/);
  h.finish("newer");
  await newer;
  expect(h.working.at(-1)).toMatch(/^Working/);
});

it("releases a claim when a waiting-message update throws", async () => {
  const h = await setup();
  h.running("build");
  const pending = h.wait("build");
  const original = h.ctx.ui.setWorkingMessage;
  let fail = true;
  h.ctx.ui.setWorkingMessage = (message) => {
    if (fail) { fail = false; throw new Error("retiring UI"); }
    return original(message);
  };
  await vi.advanceTimersByTimeAsync(1_000);
  await pending;
  expect(h.emitted.some((e) => e.channel === WORKING_MESSAGE_EVENT && !e.data.message)).toBe(true);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(h.working.at(-1)).toMatch(/^Working/);
});

it.each(["timeout", "abort", "message", "reload"])("releases ownership on %s", async (ending) => {
  const h = await setup();
  h.running("build");
  const abort = new AbortController();
  const pending = h.wait("build", ending === "timeout" ? 1 : 30, abort.signal);
  if (ending === "abort") abort.abort();
  if (ending === "message") h.state.pending = true;
  if (ending === "reload") await h.event("session_shutdown");
  else await vi.advanceTimersByTimeAsync(1_000);
  await pending;
  expect(h.emitted.some((e) => e.channel === WORKING_MESSAGE_EVENT && !e.data.message)).toBe(true);
  if (ending === "reload") await h.event("session_start");
  h.state.pending = false;
  await h.event("turn_start");
  await vi.advanceTimersByTimeAsync(4_000);
  expect(h.working.at(-1)).toMatch(/^Working/);
});
