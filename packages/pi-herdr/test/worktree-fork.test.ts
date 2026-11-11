// spawn where=worktree fork=true: herdr creates the checkout from origin's default branch, this
// conversation continues there as a child, and the parent hears when herdr removes the checkout.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import piHerdr from "../src/index.ts";
import { FORK_BOUNDARY } from "../src/fork-session.ts";
import type { HerdrEvent } from "../src/events.ts";
import { relocatingHerdr } from "./relocation-fixture.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function inHerdr() {
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_SOCKET_PATH", "/nonexistent/herdr.sock");
  vi.stubEnv("HERDR_PANE_ID", "w1:p1");
  vi.stubEnv("PI_HERDR_PR", "0");
}

function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const messages: Array<{ message: any; options: any }> = [];
  let tool: any;
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    events: {
      emit: (channel: string, data: unknown) => { for (const fn of listeners.get(channel) ?? []) fn(data); },
      on: (channel: string, fn: (data: unknown) => void) => {
        listeners.set(channel, [...(listeners.get(channel) ?? []), fn]);
        return () => undefined;
      },
    },
    registerTool: (t: unknown) => void (tool = t),
    appendEntry: () => undefined,
    sendMessage: (message: unknown, options: unknown) => void messages.push({ message, options }),
    getActiveTools: () => [],
    setActiveTools: () => undefined,
    getThinkingLevel: () => "medium",
    getSessionName: () => undefined,
  };
  const emit = async (event: string, payload: any, ctx: any) => {
    for (const h of handlers.get(event) ?? []) await h(payload, ctx);
  };
  return { pi: pi as unknown as ExtensionAPI, emit, messages, tool: () => tool };
}

/** A saved conversation: Pi only persists a session file once an assistant message exists. */
function conversation() {
  const dir = mkdtempSync(join(tmpdir(), "pi-herdr-fork-spawn-"));
  dirs.push(dir);
  const manager = SessionManager.create("/repo", dir);
  manager.appendMessage({ role: "user", content: "Let's add a retry to the login flow", timestamp: 1 });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "Sure; I'd start in auth.ts." }], api: "anthropic-messages", provider: "anthropic", model: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: 2,
  });
  const ctx = {
    mode: "tui", hasUI: true, cwd: "/repo", model: { provider: "p", id: "m" }, isIdle: () => true,
    ui: { notify: () => undefined, custom: () => new Promise<void>(() => undefined) },
    sessionManager: {
      getBranch: () => manager.getBranch(),
      getEntries: () => manager.getEntries(),
      getSessionFile: () => manager.getSessionFile(),
      getLeafId: () => manager.getLeafId(),
      getSessionDir: () => dir,
    },
  };
  return { dir, manager, ctx };
}

/** exec for git: the repo is /repo, origin/HEAD is origin/dev, no worktree exists yet. */
function git(log: string[][]) {
  return async (cmd: string, args: string[]) => {
    log.push([cmd, ...args]);
    if (args.includes("--git-common-dir")) return { code: 0, stdout: "/repo/.git\n", stderr: "" };
    if (args[0] === "worktree") return { code: 0, stdout: "worktree /repo\n", stderr: "" };
    if (args.includes("symbolic-ref")) return { code: 0, stdout: "origin/dev\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

function world() {
  inHerdr();
  const x = relocatingHerdr({
    "worktree.create": () => ({ result: { already_open: false, workspace: { workspace_id: "w9" }, root_pane: { pane_id: "w9:p1" } } }),
    "agent.get": (params) => ({ result: { agent: { pane_id: params.target, agent_status: "idle", interactive_ready: true, state_change_seq: 1 } } }),
    "agent.start": () => ({ result: {} }),
    "agent.prompt": () => ({ result: {} }),
  });
  const execs: string[][] = [];
  const p = fakePi();
  const c = conversation();
  let onEvent: ((e: HerdrEvent) => void) | undefined;
  let closed = 0;
  const watch = (cb: (e: HerdrEvent) => void) => { onEvent = cb; return { close: () => { closed++; } }; };
  piHerdr(p.pi, { call: x.f.call, subscribeLocation: x.subscribe, subscribeWorktrees: watch, exec: git(execs) });
  return { x, p, c, execs, event: (e: HerdrEvent) => onEvent?.(e), closed: () => closed };
}

test("fork needs where=worktree, and a saved conversation", async () => {
  const w = world();
  await w.p.emit("session_start", {}, w.c.ctx);
  try {
    await expect(w.p.tool().execute("1", { action: "spawn", task: "go", fork: true }, undefined, undefined, w.c.ctx)).rejects.toThrow("fork needs where=worktree.");
    const unsaved = { ...w.c.ctx, sessionManager: { ...w.c.ctx.sessionManager, getSessionFile: () => undefined } };
    await expect(w.p.tool().execute("2", { action: "spawn", task: "go", where: "worktree", branch: "b", fork: true }, undefined, undefined, unsaved)).rejects.toThrow("not saved yet");
    expect(w.x.f.of("worktree.create")).toEqual([]);
  } finally {
    await w.p.emit("session_shutdown", {}, w.c.ctx);
  }
});

test("fork=true creates the checkout from origin's default branch and continues this conversation in it", async () => {
  const w = world();
  await w.p.emit("session_start", {}, w.c.ctx);
  try {
    const res = await w.p.tool().execute("1", { action: "spawn", name: "retry", task: "Implement the retry now", where: "worktree", branch: "retry", fork: true }, undefined, undefined, w.c.ctx);
    expect(w.x.f.of("worktree.create")[0]!.params).toMatchObject({ cwd: "/repo", branch: "retry", path: "/repo/.worktrees/retry", base: "origin/dev" });
    expect(w.execs).toContainEqual(["git", "-C", "/repo/.worktrees/retry", "branch", "--unset-upstream"]);
    expect(w.execs.findIndex((e) => e.includes("fetch"))).toBeLessThan(w.execs.findIndex((e) => e.includes("--unset-upstream")));
    const args: string[] = w.x.f.of("agent.start")[0]!.params.args;
    const file = args[args.indexOf("--session") + 1]!;
    expect(file).toBeTruthy();
    const forked = SessionManager.open(file);
    expect(forked.getHeader()).toMatchObject({ cwd: "/repo/.worktrees/retry" });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("Let's add a retry to the login flow");
    expect(text).toContain(FORK_BOUNDARY);
    expect(w.x.f.of("agent.prompt").at(-1)!.params.text).toContain("continues the parent's conversation");
    expect(w.x.f.of("agent.prompt").at(-1)!.params.text).toContain("Implement the retry now");
    expect(w.x.f.of("pane.close")).toEqual([]);
    expect(res.content[0].text).toContain("Continuing this conversation in worktree retry (/repo/.worktrees/retry)");
    expect(res.content[0].text).toContain("This session stays in the main checkout");
  } finally {
    await w.p.emit("session_shutdown", {}, w.c.ctx);
  }
});

test("a plain worktree spawn starts no fork and a new checkout still starts from the default branch", async () => {
  const w = world();
  await w.p.emit("session_start", {}, w.c.ctx);
  try {
    await w.p.tool().execute("1", { action: "spawn", task: "Do it", where: "worktree", branch: "plain" }, undefined, undefined, w.c.ctx);
    expect(w.x.f.of("worktree.create")[0]!.params).toMatchObject({ base: "origin/dev" });
    expect(w.x.f.of("agent.start")[0]!.params.args).not.toContain("--session");
    expect(w.x.f.of("agent.prompt").at(-1)!.params.text).not.toContain("continues the parent's conversation");
  } finally {
    await w.p.emit("session_shutdown", {}, w.c.ctx);
  }
});

test("herdr removing a child's checkout closes the child and tells the parent once, with its next prompt", async () => {
  const w = world();
  await w.p.emit("session_start", {}, w.c.ctx);
  try {
    await w.p.tool().execute("1", { action: "spawn", name: "retry", task: "Go", where: "worktree", branch: "retry", fork: true }, undefined, undefined, w.c.ctx);
    w.event({ event: "worktree_removed", data: { worktree: { path: "/repo/.worktrees/other" } } });
    w.event({ event: "workspace_updated", data: { worktree: { path: "/repo/.worktrees/retry" } } });
    expect(w.p.messages).toEqual([]);
    w.event({ event: "worktree_removed", data: { worktree: { path: "/repo/.worktrees/retry", branch: "retry" } } });
    expect(w.p.messages).toHaveLength(1);
    expect(w.p.messages[0]!.message).toMatchObject({ customType: "herdr-worktree", display: true });
    expect(w.p.messages[0]!.message.content).toBe("[herdr] retry's worktree retry was removed with its space (/repo/.worktrees/retry); its pane is closed.");
    expect(w.p.messages[0]!.options).toEqual({ deliverAs: "nextTurn" });
    // Once: a repeat finds no open child, and the watch is closed with the last one.
    w.event({ event: "worktree_removed", data: { worktree: { path: "/repo/.worktrees/retry" } } });
    expect(w.p.messages).toHaveLength(1);
    expect(w.closed()).toBe(1);
  } finally {
    await w.p.emit("session_shutdown", {}, w.c.ctx);
  }
});
