import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import piBg from "../src/index.ts";
import type { Task } from "../src/registry.ts";
import { fakeCtx, fakePi } from "./fake.ts";

const { registryMock } = vi.hoisted(() => ({ registryMock: vi.fn() }));
vi.mock("../src/registry.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/registry.ts")>(),
  registry: registryMock,
}));

function task(id: string, status: Task["status"]): Task {
  return {
    id, name: id, kind: "job", command: "make " + id, cwd: "/tmp", logPath: "/tmp/x.log", sessionId: "test-session",
    startedAt: Date.now(), endedAt: status === "running" ? undefined : Date.now(), status, ready: false, keep: false, origin: "agent",
    delivered: false, readyDelivered: false,
  } as Task;
}

let f: ReturnType<typeof fakePi>;
const tasks = new Map<string, Task>();

beforeEach(async () => {
  vi.useFakeTimers();
  tasks.clear();
  registryMock.mockReturnValue({
    tasks,
    cleared: new Set<string>(),
    list: () => [...tasks.values()],
    running: () => [...tasks.values()].filter((t) => t.status === "running"),
    forgetEnded: vi.fn(), attach: vi.fn(), detach: vi.fn(), sweep: vi.fn(() => []),
    subscribe: vi.fn(() => () => {}),
    killAll: vi.fn(async () => undefined), release: vi.fn(),
  });
  f = fakePi();
  piBg(f.pi as any);
  const c = fakeCtx("/tmp");
  for (const h of f.handlers.get("session_start") ?? []) await h({ reason: "startup" }, c.ctx);
});
afterEach(async () => {
  for (const h of f.handlers.get("session_shutdown") ?? []) await h({ reason: "quit" }, undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const ask = async (name: string, args: string, probe: boolean) => {
  const req: any = { version: 1, name, args, probe };
  f.pi.events.emit("switchyard.web-command.v1", req);
  return { req, view: probe ? undefined : await req.view };
};

describe("tasks web view", () => {
  it("accepts only the bare command", async () => {
    expect((await ask("tasks", "", true)).req.accept).toBe(true);
    expect((await ask("bg", "", true)).req.accept).toBe(true);
    expect((await ask("tasks", "kill 1", true)).req.accept).toBeUndefined();
    expect((await ask("stop", "", true)).req.accept).toBeUndefined();
  });

  it("lists tasks with stop and clear actions", async () => {
    tasks.set("a", task("a", "running"));
    tasks.set("b", task("b", "done"));
    const { view } = await ask("tasks", "", false);
    expect(view.title).toBe("Background tasks");
    expect(view.body.t).toBe("section");
    expect(view.actions).toEqual([
      { label: "Stop a", command: "/tasks kill a", tone: "danger" },
      { label: "Clear ended", command: "/tasks clear", tone: "danger" },
    ]);
  });

  it("says when there are none", async () => {
    const { view } = await ask("tasks", "", false);
    expect(view.body).toEqual({ t: "text", text: "No background tasks." });
  });
});
