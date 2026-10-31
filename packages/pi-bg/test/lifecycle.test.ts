import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskEvent } from "../src/registry.ts";
import piBg from "../src/index.ts";
import { PillView } from "../src/pill.ts";
import { fakeCtx, fakePi } from "./fake.ts";

const { registryMock } = vi.hoisted(() => ({ registryMock: vi.fn() }));
vi.mock("../src/registry.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/registry.ts")>(),
  registry: registryMock,
}));

function fakeRegistry() {
  const tasks = new Map<string, Task>();
  const listeners = new Set<(e: TaskEvent) => void>();
  const off = vi.fn();
  return {
    tasks,
    listeners,
    off,
    cleared: new Set<string>(),
    list: (sid?: string) => [...tasks.values()].filter((t) => !sid || t.sessionId === sid),
    running: (sid?: string) => [...tasks.values()].filter((t) => t.status === "running" && (!sid || t.sessionId === sid)),
    forgetEnded: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    sweep: vi.fn(() => []),
    subscribe: vi.fn((fn: (e: TaskEvent) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
        off();
      };
    }),
    killAll: vi.fn(async () => undefined),
    release: vi.fn(),
  };
}

function job(): Task {
  return {
    id: "job", name: "build", kind: "job", command: "make", cwd: "/tmp", logPath: "/tmp/build.log", sessionId: "test-session",
    startedAt: Date.now(), status: "running", ready: false, keep: false, origin: "agent",
    delivered: false, readyDelivered: false,
  };
}

const STALE = "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession().";

function session(staleMessage = "Extension context has been invalidated") {
  const c = fakeCtx("/tmp");
  let invalid = false;
  const reads = vi.fn();
  const ctx = new Proxy(c.ctx, {
    get(target, key, receiver) {
      reads(key);
      if (invalid) throw new Error(staleMessage);
      return Reflect.get(target, key, receiver);
    },
  });
  const setWidget = c.ctx.ui.setWidget;
  const remove = vi.fn();
  vi.spyOn(c.ctx.ui, "setWidget").mockImplementation((key, widget) => {
    if (!widget && key === "pi-bg-pill") remove();
    return setWidget(key, widget);
  });
  return { ...c, ctx, reads, remove, invalidate: () => { invalid = true; } };
}

let reg: ReturnType<typeof fakeRegistry>;
let f: ReturnType<typeof fakePi>;
const event = async (name: string, reason: string, ctx?: unknown) => {
  for (const h of f.handlers.get(name) ?? []) await h({ reason }, ctx);
};

beforeEach(() => {
  vi.useFakeTimers();
  reg = fakeRegistry();
  registryMock.mockReturnValue(reg);
  f = fakePi();
  piBg(f.pi as any);
});
afterEach(async () => {
  reg.killAll.mockResolvedValue(undefined);
  await event("session_shutdown", "quit");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("session cleanup", () => {
  it("a ctx pi invalidated without a session_shutdown detaches on the next tick instead of crashing", async () => {
    reg.tasks.set("job", job());
    const s = session(STALE);
    await event("session_start", "startup", s.ctx);
    expect(vi.getTimerCount()).toBe(2);
    s.invalidate();
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
    // Detached: the timer and the registry subscription are gone, and holds were released.
    expect(vi.getTimerCount()).toBe(0);
    expect(reg.off).toHaveBeenCalledOnce();
    expect(f.emitted.some((e) => e.channel === "herdr:background" && e.data.active === false)).toBe(true);
    // A later task event is inert too.
    for (const fn of reg.listeners) fn({ type: "end", task: reg.tasks.get("job")! });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an unexpected error from a deferred callback still surfaces", async () => {
    const s = session("boom");
    await event("session_start", "startup", s.ctx);
    s.invalidate();
    expect(() => vi.advanceTimersByTime(1_000)).toThrow(/boom/u);
  });

  it("retires repeated starts before disposing an invalidated UI; saved callbacks stay inert", async () => {
    reg.tasks.set("job", job());
    const intervals = vi.spyOn(globalThis, "setInterval");
    const immediates = vi.spyOn(globalThis, "setImmediate");
    const first = session();
    await event("session_start", "startup", first.ctx);
    const statusTick = intervals.mock.calls[0]![0] as () => void;
    const startupWake = immediates.mock.calls[0]![0] as () => void;
    const taskCallback = reg.subscribe.mock.calls[0]![0];
    first.invalidate();
    first.reads.mockClear();
    let timersAtDisposal: number | undefined;
    first.remove.mockImplementation(() => {
      // Record outside the swallowed disposal error so failed assertions cannot be hidden.
      timersAtDisposal = vi.getTimerCount();
      statusTick();
      startupWake();
      taskCallback({ type: "start", task: reg.tasks.get("job")! });
      throw new Error("widget owner is gone");
    });
    const next = session();
    await expect(event("session_start", "reload", next.ctx)).resolves.toBeUndefined();
    expect(first.remove).toHaveBeenCalledOnce();
    expect(timersAtDisposal).toBe(0);
    expect(first.reads).not.toHaveBeenCalled();
    expect(reg.off).toHaveBeenCalledOnce();
    expect(reg.listeners.size).toBe(1);
    expect(next.widgetLines()).toEqual([" ○ 1 task"]);
    expect(vi.getTimerCount()).toBe(2); // One current status interval and startup immediate.
    first.reads.mockClear();
    next.reads.mockClear();
    statusTick();
    startupWake();
    taskCallback({ type: "start", task: reg.tasks.get("job")! });
    expect(first.reads).not.toHaveBeenCalled();
    expect(next.reads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(next.reads).toHaveBeenCalledWith("hasUI");
    expect(vi.getTimerCount()).toBe(1);
    await event("session_shutdown", "reload");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("finishes all quit cleanup when pill removal and unsubscription throw", async () => {
    reg.tasks.set("job", job());
    const c = session();
    await event("session_start", "startup", c.ctx);
    const guest = {
      id: "guest", title: "guest", entries: () => [], open: async () => {},
      pill: () => ({ label: "1 guest" }), setHosted: vi.fn(),
    };
    f.pi.events.emit("activity:section", { section: guest });
    const saved = reg.subscribe.mock.calls[0]![0];
    reg.off.mockImplementation(() => { throw new Error("unsubscribe failed"); });
    c.remove.mockImplementation(() => { throw new Error("widget removal failed"); });
    c.invalidate();
    c.reads.mockClear();
    await expect(event("session_shutdown", "quit")).resolves.toBeUndefined();
    expect(c.reads).not.toHaveBeenCalled();
    expect(reg.off).toHaveBeenCalledOnce();
    expect(c.remove).toHaveBeenCalledOnce();
    expect(guest.setHosted).toHaveBeenLastCalledWith(false, "bg");
    expect(f.emitted).toContainEqual({ channel: "activity:gone", data: { id: "bg" } });
    expect(f.emitted).toContainEqual({ channel: "herdr:background", data: { active: false, id: "bg:job" } });
    expect(reg.killAll).toHaveBeenCalledWith("session", undefined, "test-session");
    expect(reg.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => saved({ type: "start", task: reg.tasks.get("job")! })).not.toThrow();
    expect(c.reads).not.toHaveBeenCalled();
    await event("session_shutdown", "quit");
    expect(c.remove).toHaveBeenCalledOnce();
    expect(reg.off).toHaveBeenCalledOnce();
    expect(f.emitted.filter((e) => e.channel === "activity:gone")).toHaveLength(1);
  });

  it("aborts pending waits despite failing disposal and preserves running tasks across reload", async () => {
    const task = job();
    reg.tasks.set(task.id, task);
    const c = session();
    await event("session_start", "startup", c.ctx);
    const waiting = f.tools.get("bg_wait").execute("wait", { timeout: 100 }, undefined, undefined, c.ctx);
    c.remove.mockImplementation(() => { throw new Error("widget removal failed"); });
    c.invalidate();
    c.reads.mockClear();
    await event("session_shutdown", "reload");
    expect((await waiting).content[0].text).toContain("Stopped waiting: interrupted.");
    expect(vi.getTimerCount()).toBe(0);
    expect(reg.killAll).not.toHaveBeenCalled();
    expect(reg.release).not.toHaveBeenCalled();
    expect(c.reads).not.toHaveBeenCalled();
    task.status = "done";
    task.endedAt = Date.now();
    task.exitCode = 0;
    const previous = f;
    f = fakePi();
    piBg(f.pi as any); // A real reload replaces the extension factory, retaining registry state.
    const next = session();
    await event("session_start", "reload", next.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(previous.sent).toEqual([]);
    expect(reg.listeners.size).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.message.content).toMatch(/Background job build .* ended: exit 0/u);
    expect(task.delivered).toBe(true);
    expect(c.reads).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.sent).toHaveLength(1);
  });

  it("releases kept-service state even when killing tasks rejects", async () => {
    const c = session();
    await event("session_start", "startup", c.ctx);
    reg.killAll.mockRejectedValueOnce(new Error("kill failed"));
    await expect(event("session_shutdown", "quit")).rejects.toThrow("kill failed");
    expect(reg.release).toHaveBeenCalledOnce();
    expect(reg.off).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("pill cleanup", () => {
  it.each(["widget", "input", "both"])("detaches before failing %s disposal and can bind a fresh UI", (failure) => {
    const c = session();
    const originalInput = c.ctx.ui.onTerminalInput;
    let input!: (data: string) => { consume?: boolean } | undefined;
    const off = vi.fn();
    const inputSubscription = vi.spyOn(c.ctx.ui, "onTerminalInput").mockImplementation((handler) => {
      input = handler;
      const unsubscribe = originalInput(handler);
      return () => {
        const removed = unsubscribe();
        off();
        if (failure !== "widget") throw new Error("input owner is gone");
        return removed;
      };
    });
    const pill = new PillView({ pill: () => ({ label: "work" }), open: vi.fn() }, "pi-bg-pill");
    pill.setUI(c.ctx.ui as any);
    pill.update();
    const savedWidget = c.widgetComponent();
    const savedInput = input;
    pill.handleKey("\x1b[B");
    expect(pill.isSelected).toBe(true);
    c.remove.mockImplementation(() => {
      expect(pill.isSelected).toBe(false);
      expect(savedInput("\x1b[B")).toBeUndefined();
      pill.update();
      if (failure !== "input") throw new Error("widget owner is gone");
    });
    expect(() => pill.dispose()).toThrow(/owner is gone/u);
    expect(off).toHaveBeenCalledOnce();
    expect(() => pill.dispose()).not.toThrow();
    expect(c.remove).toHaveBeenCalledOnce();
    expect(savedInput("\x1b[B")).toBeUndefined();
    expect(savedWidget.render(80)).toEqual([]);
    expect(savedWidget.handleMouse({ type: "click", button: "left" })).toBeUndefined();
    const next = session();
    pill.setUI(next.ctx.ui as any);
    pill.update();
    expect(next.widgetLines()).toEqual([" ○ work"]);
    expect(savedInput("\x1b[B")).toBeUndefined();
    expect(savedWidget.render(80)).toEqual([]);
    expect(next.press("\x1b[B")).toBe(true);
    pill.dispose();
    expect(next.widgets.size).toBe(0);
    // UI identity may survive a restart: old callbacks must not revive on a new binding.
    c.remove.mockReset();
    inputSubscription.mockRestore();
    pill.setUI(c.ctx.ui as any);
    pill.update();
    expect(c.widgetLines()).toEqual([" ○ work"]);
    expect(savedInput("\x1b[B")).toBeUndefined();
    expect(savedWidget.render(80)).toEqual([]);
    expect(savedWidget.handleMouse({ type: "click", button: "left" })).toBeUndefined();
    pill.dispose();
  });
});
