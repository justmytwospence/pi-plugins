// index.ts with servers waiting for their notebook to be opened: the footer lines (an open
// notebook's line unchanged, waiting ones `not open` and linked), and /marimo open.
import { afterEach, expect, test, vi } from "vitest";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import type { Cancellable, Io, StreamEnd } from "../src/core/io.js";

const host = vi.hoisted(() => ({ sessions: {} as Record<string, Record<string, { path: string }>>, spawned: [] as Array<[string, string[]]> }));

vi.mock("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    host.spawned.push([cmd, args]);
    return { on: () => ({ unref: () => undefined }), unref: () => undefined };
  },
}));
vi.mock("../src/core/node-io.js", () => ({
  nodeIo: (): Io => ({
    registryEntries: async () => [2718, 2719].map((port) => ({ port, host: "127.0.0.1" })),
    getJson: async (url: string) => (url.endsWith("/api/sessions") ? host.sessions[new URL(url).port] ?? {} : undefined),
    postJson: async (url: string) => {
      const port = new URL(url).port;
      return { files: [{ path: port === "2718" ? "/w/0_first.py" : "/w/1_second.py", isDirectory: false, isMarimoFile: true }] };
    },
    stream: (): Cancellable<StreamEnd> => ({ done: new Promise(() => undefined), cancel: () => undefined }),
    realpath: async (p: string) => p,
    sleep(ms: number): Cancellable<void> {
      let t: ReturnType<typeof setTimeout> | undefined;
      let wake!: () => void;
      const done = new Promise<void>((r) => { wake = r; t = setTimeout(r, ms); });
      return { done, cancel: () => { clearTimeout(t); wake(); } };
    },
  }),
}));

const { default: piMarimo } = await import("../src/index.js");

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup(select?: (title: string, options: string[]) => string | undefined, mode = "rpc") {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  const statuses = new Map<string, string | undefined>();
  const notes: string[] = [];
  let offered: any;
  const pi = {
    on: (name: string, h: (e: unknown, c: unknown) => unknown) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
    events: { on: () => undefined, emit: (ch: string, d: any) => void (ch === "activity:section" && (offered = d.section)) },
    registerCommand: (_name: string, c: typeof command) => void (command = c),
    appendEntry: () => undefined,
  };
  const ui = {
    setStatus: (key: string, text: string | undefined) => void statuses.set(key, text),
    notify: (text: string) => void notes.push(text),
    select: async (title: string, options: string[]) => select?.(title, options),
    setWidget: () => undefined,
    onTerminalInput: () => () => undefined,
    getEditorText: () => "",
  };
  const ctx = { cwd: "/w", mode, isIdle: () => true, ui, sessionManager: { getBranch: () => [] } };
  piMarimo(pi as never);
  const fire = async (name: string, event: unknown = {}) => { for (const h of handlers.get(name) ?? []) await h(event, ctx); };
  const live = () => [...statuses].filter(([k, v]) => v !== undefined && k.startsWith("marimo") && k !== "marimo-lens").sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  return { fire, statuses, live, notes, section: () => offered, run: (args: string) => command!.handler(args, ctx) };
}

afterEach(() => {
  host.sessions = {};
  host.spawned.length = 0;
  setCapabilityOverrides({});
  vi.unstubAllGlobals();
});

const link = (url: string, text: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

test("a running server whose notebook is open nowhere gets a linked `not open` footer line", async () => {
  setCapabilityOverrides({ hyperlinks: true });
  const x = setup();
  await x.fire("session_start");
  await until(() => x.live().length === 2);
  expect(x.live()).toEqual([
    `marimo: ${link("http://127.0.0.1:2718/", "0_first.py")} · :2718 · not open`,
    `marimo: ${link("http://127.0.0.1:2719/", "1_second.py")} · :2719 · not open`,
  ]);
  await x.fire("session_shutdown");
  expect(x.live()).toEqual([]);
});

test("without terminal hyperlinks the line is the plain shape", async () => {
  setCapabilityOverrides({ hyperlinks: false });
  const x = setup();
  await x.fire("session_start");
  await until(() => x.live().length === 2);
  expect(x.live()[0]).toBe("marimo: 0_first.py · :2718 · not open");
  await x.fire("session_shutdown");
});

test("a notebook opened in a browser leaves the waiting lines (and is not shown until the agent uses it)", async () => {
  setCapabilityOverrides({ hyperlinks: false });
  const x = setup();
  await x.fire("session_start");
  await until(() => x.live().length === 2);
  host.sessions["2718"] = { s1: { path: "/w/0_first.py" } };
  await x.fire("before_agent_start"); // rescans now instead of at the next poll
  await until(() => x.live().length === 1);
  expect(x.live()).toEqual(["marimo: 1_second.py · :2719 · not open"]);
  await x.fire("session_shutdown");
});

test("/marimo open opens the one waiting notebook, or the picked one", async () => {
  setCapabilityOverrides({ hyperlinks: false });
  host.sessions["2718"] = { s1: { path: "/w/0_first.py" } };
  const one = setup();
  await one.fire("session_start");
  await until(() => one.live().length === 1);
  await one.run("open");
  expect(host.spawned).toEqual([[process.platform === "darwin" ? "open" : "xdg-open", ["http://127.0.0.1:2719/"]]]);
  expect(one.notes).toEqual(["marimo: opening 1_second.py"]);
  await one.fire("session_shutdown");

  host.spawned.length = 0;
  host.sessions = {};
  const two = setup((_title, options) => options[0]);
  await two.fire("session_start");
  await until(() => two.live().length === 2);
  await two.run("open");
  expect(host.spawned.map(([, args]) => args)).toEqual([["http://127.0.0.1:2718/"]]);
  await two.fire("session_shutdown");

  host.sessions = { "2718": { s1: { path: "/w/0_first.py" } }, "2719": { s2: { path: "/w/1_second.py" } } };
  const none = setup();
  await none.fire("session_start");
  await none.fire("before_agent_start");
  await until(() => none.live().length === 0);
  host.spawned.length = 0;
  await none.run("open");
  expect(none.notes).toEqual(["marimo: no notebook is waiting to be opened"]);
  expect(host.spawned).toEqual([]);
  await none.fire("session_shutdown");
});

test("in the TUI the footer lines give way to rows under the prompt: waiting servers are rows, and Enter opens them in the browser", async () => {
  setCapabilityOverrides({ hyperlinks: true });
  const x = setup(undefined, "tui");
  await x.fire("session_start");
  await until(() => (x.section()?.pill(Date.now())?.rows?.length ?? 0) === 2);
  const rows = x.section().pill(Date.now()).rows;
  expect(rows.map((r: any) => [r.label, r.detail, r.status])).toEqual([
    ["0_first.py", ":2718 · not open", "done"],
    ["1_second.py", ":2719 · not open", "done"],
  ]);
  // Nothing in the footer.
  expect(x.live()).toEqual([]);
  await x.section().open(rows[1].key, {});
  expect(host.spawned).toEqual([[process.platform === "darwin" ? "open" : "xdg-open", ["http://127.0.0.1:2719/"]]]);
  // A server's row is not stoppable: it is not a run.
  expect(x.section().canStop(rows[1].key)).toBe(false);
  await x.fire("session_shutdown");
});

test("a marimo-pair call at a server whose notebook is open nowhere opens it first, without a browser", async () => {
  setCapabilityOverrides({ hyperlinks: false });
  const sockets: Array<{ url: string }> = [];
  class FakeSocket {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(readonly url: string) {
      sockets.push(this);
      // The server starts the kernel and lists the session.
      queueMicrotask(() => {
        host.sessions[new URL(url).port] = { s_new: { path: new URL(url).port === "2718" ? "/w/0_first.py" : "/w/1_second.py" } };
        this.onmessage?.({ data: '{"op": "kernel-ready", "data": {}}' });
      });
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", FakeSocket);
  const x = setup(undefined, "tui");
  await x.fire("session_start");
  await until(() => (x.section()?.pill(Date.now())?.rows?.length ?? 0) === 2);
  await x.fire("tool_call", { toolCallId: "t1", input: { command: "bash /s/marimo-pair/scripts/execute-code.sh --url http://127.0.0.1:2719 -c 'print(1)'" } });
  // Only the server the call names was opened, through the page's own WebSocket address.
  expect(sockets).toHaveLength(1);
  const url = new URL(sockets[0]!.url);
  expect(url.origin).toBe("ws://127.0.0.1:2719");
  expect(url.pathname).toBe("/ws");
  expect(url.searchParams.get("file")).toBe("/w/1_second.py");
  expect(url.searchParams.get("session_id")).toMatch(/^s_/u);
  expect(host.spawned).toEqual([]);
  // Unrelated calls and calls that name no server open nothing.
  await x.fire("tool_call", { toolCallId: "t2", input: { command: "ls" } });
  expect(sockets).toHaveLength(1);
  await x.fire("session_shutdown");
  vi.unstubAllGlobals();
});

test("Enter on a `not open` row opens the notebook here and shows its view; if it cannot, the browser opens instead", async () => {
  setCapabilityOverrides({ hyperlinks: false });
  class FailingSocket {
    onerror: (() => void) | null = null;
    onmessage = null;
    onclose: (() => void) | null = null;
    constructor() { queueMicrotask(() => this.onerror?.()); }
    close() {}
  }
  vi.stubGlobal("WebSocket", FailingSocket);
  const x = setup(undefined, "tui");
  await x.fire("session_start");
  await until(() => (x.section()?.pill(Date.now())?.rows?.length ?? 0) === 2);
  const rows = x.section().pill(Date.now()).rows;
  await x.section().open(rows[0].key, {});
  expect(host.spawned).toEqual([[process.platform === "darwin" ? "open" : "xdg-open", ["http://127.0.0.1:2718/"]]]);
  await x.fire("session_shutdown");
  vi.unstubAllGlobals();
});
