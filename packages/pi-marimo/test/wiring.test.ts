// index.ts wired up end to end: the real watcher on a fake marimo server (a recorded /sse stream),
// pi's events and pi-bg's on a fake bus. Covers the kernel hold's "finished" notice being left out
// when a waking pi-bg job drives the run (and coming back when that job is stopped), the busy
// notebook reported as outside work, and pi-bg's tasks annotated with the kernel state.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Cancellable, Io, StreamEnd } from "../src/core/io.js";

const CWD = "/w";
const SERVER = "http://127.0.0.1:2799";

/** A marimo server with one session (`/w/nb.py`, unless a test adds more) whose /sse streams the test feeds. */
const server = vi.hoisted(() => ({ feeds: [] as Array<(text: string) => void>, urls: [] as string[], sessions: {} as Record<string, { path: string }> }));

vi.mock("../src/core/node-io.js", () => ({
  nodeIo: (): Io => ({
    registryEntries: async () => [{ port: 2799, host: "127.0.0.1" }],
    getJson: async (url: string) => (url.endsWith("/api/sessions") ? server.sessions : undefined),
    stream(url: string, _headers: Record<string, string>, onText: (text: string) => void): Cancellable<StreamEnd> {
      let end!: (e: StreamEnd) => void;
      const done = new Promise<StreamEnd>((r) => (end = r));
      server.feeds.push(onText);
      server.urls.push(url);
      return { done, cancel: () => end({ ok: true }) };
    },
    realpath: async (p: string) => p,
    sleep(ms: number): Cancellable<void> {
      let t: ReturnType<typeof setTimeout> | undefined;
      let wake!: () => void;
      const done = new Promise<void>((r) => {
        wake = r;
        t = setTimeout(r, ms);
      });
      return { done, cancel: () => { clearTimeout(t); wake(); } };
    },
  }),
}));

const { default: piMarimo } = await import("../src/index.js");

/** The recorded run, split where the slow cell starts running. */
const events = readFileSync(new URL("./fixtures/kiosk-run.sse", import.meta.url), "utf8").split(/\n\n/u).filter(Boolean);
const startsAt = events.findIndex((e) => {
  const m = JSON.parse(e.replace(/^data: /u, ""));
  return m.op === "cell-op" && m.data.cell_id === "lEQa" && m.data.status === "running";
});
const untilRunning = events.slice(0, startsAt + 1).map((e) => `${e}\n\n`).join("");
const rest = events.slice(startsAt + 1).map((e) => `${e}\n\n`).join("");

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function setup(branch: unknown[] = [], mode = "tui") {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  const listeners = new Map<string, Array<(d: unknown) => void>>();
  const sent: Array<[string, any]> = [];
  const entries: Array<{ type: string; customType: string; data: any }> = [];
  const statuses = new Map<string, string | undefined>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notes: Array<[string, string | undefined]> = [];
  const pi = {
    on: (name: string, h: (e: unknown, c: unknown) => unknown) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
    events: {
      on: (ch: string, h: (d: unknown) => void) => void listeners.set(ch, [...(listeners.get(ch) ?? []), h]),
      emit: (ch: string, d: unknown) => {
        sent.push([ch, d]);
        for (const h of listeners.get(ch) ?? []) h(d);
      },
    },
    registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => void commands.set(name, spec),
    registerEntryRenderer: () => undefined,
    registerTool: () => undefined,
    appendEntry: () => undefined,
    appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data }),
  };
  const widgets = new Map<string, any>();
  const customs: any[] = [];
  const ui = {
    setStatus: (key: string, text: string | undefined) => void statuses.set(key, text),
    notify: (message: string, type?: string) => void notes.push([message, type]),
    setWidget: (key: string, w: unknown) => void (w ? widgets.set(key, w) : widgets.delete(key)),
    onTerminalInput: () => () => undefined,
    getEditorText: () => "",
    custom: (factory: any, options: unknown) => {
      const view = factory({ requestRender: () => undefined, terminal: { rows: 30 } }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, () => undefined);
      customs.push({ view, options });
      return Promise.resolve();
    },
  };
  const ctx = { cwd: CWD, mode, isIdle: () => true, ui, sessionManager: { getBranch: () => branch } };
  piMarimo(pi as never);
  const fire = async (name: string, event: unknown = {}) => {
    for (const h of handlers.get(name) ?? []) await h(event, ctx);
  };
  const of = (ch: string) => sent.filter(([c]) => c === ch).map(([, d]) => d);
  /** The pill widget's text, as pi would draw it. */
  const pillText = () => {
    const w = widgets.get("pi-marimo-pill") ?? [...widgets.values()][0];
    return w ? w({ requestRender: () => undefined }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }).render(80).join("\n") : undefined;
  };
  /** Runs `/name args` as pi would. */
  const command = (name: string, args: string) => commands.get(name)!.handler(args, ctx);
  return { pi, fire, sent, of, widgets, customs, pillText, ui, entries, statuses, handlers, command, notes };
}

const pair = `bash .agents/skills/marimo-pair/scripts/execute-code.sh --url ${SERVER} --file nb.py - <<'PY'\nfit()\nPY`;
const job = (status: string) => ({ id: "j1", name: "fit", kind: "job", cwd: CWD, command: pair, status, origin: "agent", willWake: status === "running" });
const serverTask = { id: "s1", kind: "service", cwd: CWD, command: "uv run marimo edit --no-token nb.py", status: "running", origin: "agent", willWake: false };

beforeEach(() => {
  server.feeds.length = 0;
  server.urls.length = 0;
  server.sessions = { s1: { path: `${CWD}/nb.py` } };
});
afterEach(async () => {
  vi.useRealTimers();
});

async function startRun(x: ReturnType<typeof setup>) {
  await x.fire("session_start");
  await until(() => server.feeds.length > 0);
  server.feeds.at(-1)!(untilRunning);
  await until(() => x.of("bg:external").some((d) => d.state === "running"));
  // The agent drives the run from a pi-bg job, and a pi-bg service serves the notebook.
  await x.fire("agent_start");
  await x.fire("tool_call", { input: { command: pair } });
  x.pi.events.emit("bg:tasks", { tasks: [job("running"), serverTask] });
  await x.fire("agent_settled");
}

test("a run a waking pi-bg job drives: held in herdr, reported as outside work, tasks annotated, no second notice", async () => {
  const x = setup();
  await startRun(x);
  expect(x.of("bg:external")[0]).toEqual({ id: "marimo:nb.py", label: "nb.py: Slow model fit", state: "running" });
  expect(x.of("herdr:token").at(-1)).toEqual({ key: "marimo", value: "nb.py: Slow model fit" });
  const notes = x.of("bg:annotate");
  // The job keeps the notebook busy: its notebook row stands for it. The server's row stands for it too.
  expect(notes).toContainEqual({ task: "j1", by: "pi-marimo", detail: "nb.py: running Slow model fit · 1 queued", wait: ["marimo:nb.py"], represented: true });
  expect(notes).toContainEqual({ task: "s1", by: "pi-marimo", detail: "nb.py: running Slow model fit · 1 queued", wait: ["marimo:nb.py"], represented: true });
  const count = notes.length;
  // Unchanged state sends nothing new.
  x.pi.events.emit("bg:tasks", { tasks: [job("running"), serverTask] });
  expect(x.of("bg:annotate")).toHaveLength(count);

  server.feeds.at(-1)!(rest);
  await until(() => x.of("bg:external").some((d) => d.state !== "running"));
  expect(x.of("bg:external").at(-1)).toMatchObject({ id: "marimo:nb.py", state: "failed", summary: expect.stringMatching(/1 error/u) });
  await until(() => x.of("herdr:token").at(-1)?.value === undefined);
  // The job's wake-up reports the end: herdr gets no "finished" notification.
  expect(x.of("herdr:notify")).toEqual([]);
  await until(() => x.of("bg:annotate").some((d) => d.task === "s1" && /idle/u.test(d.detail ?? "")));
  expect(x.of("bg:annotate").at(-1)).toMatchObject({ detail: "nb.py: idle · 1 error" });
  await x.fire("session_shutdown");
});

test("stopping a job that drives a run interrupts the kernel it was running cells in", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => '<html data-token="tok123">' };
  });
  const x = setup();
  await startRun(x);
  // Another task stopping touches nothing.
  x.pi.events.emit("bg:killed", { id: "s1" });
  x.pi.events.emit("bg:killed", { id: "j1" });
  await until(() => calls.some((u) => u.endsWith("/api/kernel/interrupt")));
  expect(calls.filter((u) => u.endsWith("/api/kernel/interrupt"))).toHaveLength(1);
  await x.fire("session_shutdown");
  vi.unstubAllGlobals();
});

test("a stopped covering job brings the notice back", async () => {
  const x = setup();
  await startRun(x);
  x.pi.events.emit("bg:tasks", { tasks: [job("killed"), serverTask] });
  // The job ended: its annotation is dropped, the server's stays.
  server.feeds.at(-1)!(rest);
  await until(() => x.of("herdr:notify").length > 0);
  expect(x.of("herdr:notify")[0]).toMatchObject({ title: "nb.py finished", sound: "done" });
  await x.fire("session_shutdown");
});

test("the notebooks as background work: a source for the hosts, its own pill alone, a full-screen view with interrupt", async () => {
  const calls: Array<[string, any]> = [];
  vi.stubGlobal("fetch", async (url: string, init?: any) => {
    calls.push([url, init]);
    return { ok: true, status: 200, text: async () => '<html data-token="tok123">' };
  });
  const x = setup();
  await startRun(x);
  // Offered to hosts.
  const section = x.of("activity:section")[0]?.section;
  expect(section).toMatchObject({ id: "marimo", title: "notebooks", noun: "notebook" });
  const entries = section.entries(Date.now());
  expect(entries).toEqual([expect.objectContaining({ key: JSON.stringify([SERVER, `${CWD}/nb.py`]), label: "nb.py", status: "running", detail: "running Slow model fit · 1 queued · bg fit · server s1" })]);
  // Alone, its own pill; hosted (by pi-bg, then pi-subagents too), none; the last host leaving brings it back.
  await until(() => /○ nb\.py:2799 · running Data loading › Slow model fit/u.test(x.pillText() ?? ""));
  section.setHosted(true, "pi-bg");
  expect([...x.widgets.keys()].filter((k) => k !== "pi-marimo-tui").length).toBe(0);
  section.setHosted(true);
  section.setHosted(false, "pi-bg");
  expect([...x.widgets.keys()].filter((k) => k !== "pi-marimo-tui").length).toBe(0);
  x.pi.events.emit("activity:gone", { id: "subagents" });
  await until(() => /○ nb\.py/u.test(x.pillText() ?? ""));
  // The rows are the pill's: a host draws them and opens a row with the section's open(key).
  expect(section.pill(Date.now())).toMatchObject({ label: "", rows: [{ key: entries[0].key, label: "nb.py", status: "running" }] });
  // In the TUI the notebooks are rows under the prompt, not footer lines.
  expect([...x.statuses].filter(([k, v]) => v !== undefined && k.startsWith("marimo") && k !== "marimo-lens")).toEqual([]);
  // The view: the outline, the running cell, and x twice interrupts the kernel.
  await section.open(entries[0].key, x.ui);
  const view = x.customs.at(-1)?.view;
  expect(x.customs.at(-1)?.options).toMatchObject({ overlay: true, overlayOptions: { width: "100%" } });
  const screen = view.render(100).join("\n");
  expect(screen).toMatch(/◀ esc · Notebook nb\.py · not your main session/u);
  expect(screen).toMatch(/Data loading[\s\S]*Slow model fit[\s\S]*● lEQa {2}→ y {2}running/u);
  view.handleInput("x");
  expect(view.render(100).join("\n")).toMatch(/x again to interrupt/u);
  view.handleInput("x");
  await until(() => calls.some(([u]) => u.endsWith("/api/kernel/interrupt")));
  const post = calls.find(([u]) => u.endsWith("/api/kernel/interrupt"))?.[1];
  expect(post.headers).toMatchObject({ "Marimo-Session-Id": "s1", "Marimo-Server-Token": "tok123" });
  view.dispose();
  // The run ends with an error: its row reads failed until the user's next message.
  server.feeds.at(-1)!(rest);
  await until(() => /nb\.py.*✗/u.test(x.pillText() ?? ""));
  expect(section.entries(Date.now())[0]).toMatchObject({ status: "failed", stats: expect.stringMatching(/^ran \d+s · 1 error/u) });
  await x.fire("input", { source: "interactive" });
  await until(() => !/✗/u.test(x.pillText() ?? ""));
  // Idle, nothing failed: the row stays, to select and open the notebook.
  expect(x.pillText()).toMatch(/○ nb\.py:2799 · 1 error: Slow model fit/u);
  expect(section.entries(Date.now())[0]).toMatchObject({ status: "done" });
  await x.fire("session_shutdown");
  expect(x.of("activity:gone")).toEqual([{ id: "subagents" }, { id: "marimo" }]);
  const offered = x.of("activity:section").length;
  x.pi.events.emit("activity:host", {});
  expect(x.of("activity:section")).toHaveLength(offered);
  vi.unstubAllGlobals();
});

test("session scope: a notebook open under the cwd gets no footer until this session works in it, and stays after resuming", async () => {
  const x = setup([], "rpc");
  await x.fire("session_start");
  await until(() => server.feeds.length > 0);
  server.feeds.at(-1)!(untilRunning);
  await until(() => x.of("bg:external").some((d) => d.state === "running"));
  // Another session's notebook: no footer, only a mention in the turn's context.
  expect(x.statuses.get("marimo")).toBeUndefined();
  await x.fire("before_agent_start");
  const [context] = x.handlers.get("context")!;
  const placed = (await context!({ messages: [{ role: "user", timestamp: 1 }] }, undefined)) as { messages: Array<{ content?: string }> };
  expect(placed.messages[1]?.content).toMatch(/^Other marimo notebooks open under this directory, not used in this session.*\/w\/nb\.py$/u);

  // The agent works in it: footer, and saved with the session.
  await x.fire("tool_call", { input: { command: pair } });
  await until(() => /nb\.py/u.test(x.statuses.get("marimo") ?? ""));
  expect(x.entries).toContainEqual({ type: "custom", customType: "pi-marimo", data: { engaged: ["/w/nb.py"] } });
  await x.fire("session_shutdown");

  // Resumed: shown without another touch.
  const y = setup(x.entries, "rpc");
  await y.fire("session_start");
  await until(() => server.feeds.length > 1);
  server.feeds.at(-1)!(untilRunning);
  await until(() => /nb\.py/u.test(y.statuses.get("marimo") ?? ""));
  await y.fire("session_shutdown");
});

test("several notebooks at once: a footer line each, in file order, recent ones in full in context, ambiguous calls flagged", async () => {
  server.sessions = { s1: { path: `${CWD}/nb.py` }, s2: { path: `${CWD}/prep.py` } };
  const x = setup([], "rpc");
  await x.fire("session_start");
  await until(() => server.feeds.length === 2);
  for (const feed of server.feeds) feed(untilRunning);
  // The agent works in prep.py last, so it is current, but the lines stay in file order.
  await x.fire("tool_call", { input: { command: pair } });
  await new Promise((r) => setTimeout(r, 5));
  await x.fire("tool_call", { input: { command: pair.replace("nb.py", "prep.py") } });
  await until(() => /prep\.py/u.test(x.statuses.get("marimo-2") ?? ""));
  expect(x.statuses.get("marimo")).toMatch(/^marimo: nb\.py · :2799 · running Data loading › Slow model fit \(\w+\) · 1 queued$/u);
  expect(x.statuses.get("marimo-2")).toMatch(/^marimo: prep\.py · :2799 · running /u);
  await x.fire("before_agent_start");
  const [context] = x.handlers.get("context")!;
  const placed = (await context!({ messages: [{ role: "user", timestamp: 1 }] }, undefined)) as { messages: Array<{ content?: string }> };
  const block = placed.messages[1]?.content ?? "";
  expect(block).toMatch(/=== \/w\/prep\.py \(current;[\s\S]*=== \/w\/nb\.py \(also followed;/u);
  expect(block).toContain("each is shown in full");
  // Both list their code cells, not just the ones that need attention.
  expect(block.match(/ {2}Hbol: defines mo, time\n/gu)).toHaveLength(2);
  expect(block).toContain(`marimo-pair: --url ${SERVER} --file /w/nb.py`);

  // A call naming only the server could mean either: its result says so, with each notebook's flags,
  // and a codemode script's nested call gets the note on the script's result.
  const [toolResult] = x.handlers.get("tool_result")!;
  const vague = `bash .agents/skills/marimo-pair/scripts/execute-code.sh --url ${SERVER} - <<'PY'\nx\nPY`;
  await x.fire("tool_call", { toolCallId: "t1", input: { command: vague } });
  const result = (await toolResult!({ toolCallId: "t1", content: [{ type: "text", text: "ok" }] }, undefined)) as { content: Array<{ text: string }> };
  expect(result.content[0]!.text).toBe("ok");
  expect(result.content[1]!.text).toMatch(/could mean any of 2 followed notebooks[\s\S]*nb\.py: --url http:\/\/127\.0\.0\.1:2799 --file \/w\/nb\.py\n {2}prep\.py: /u);
  await x.fire("tool_call", { toolCallId: "c1/1", parentToolCallId: "c1", input: { command: vague } });
  expect(await toolResult!({ toolCallId: "c1/1", content: [] }, undefined)).toBeUndefined();
  expect((await toolResult!({ toolCallId: "c1", content: [] }, undefined) as { content: unknown[] }).content).toHaveLength(1);
  // A clear call gets nothing.
  await x.fire("tool_call", { toolCallId: "t2", input: { command: pair } });
  expect(await toolResult!({ toolCallId: "t2", content: [] }, undefined)).toBeUndefined();

  // After three prompts without work in prep.py, it drops to an outline; nb.py, worked in just now, stays in full.
  for (let i = 0; i < 3; i++) await x.fire("before_agent_start");
  const later = ((await context!({ messages: [{ role: "user", timestamp: 1 }] }, undefined)) as { messages: Array<{ content?: string }> }).messages[1]?.content ?? "";
  expect(later).toMatch(/=== \/w\/nb\.py \(current;/u);
  expect(later.match(/ {2}Hbol: defines mo, time\n/gu)).toHaveLength(1);
  expect(later).toContain("the others are outlines");
  await x.fire("session_shutdown");
  expect(x.statuses.get("marimo")).toBeUndefined();
  expect(x.statuses.get("marimo-2")).toBeUndefined();
});

test("/marimo names its subcommands when given one it does not know", async () => {
  const x = setup([], "rpc");
  await x.fire("session_start");
  await x.command("marimo", "bogus thing");
  expect(x.notes.at(-1)).toEqual([expect.stringMatching(/^marimo: unknown subcommand "bogus"\. Use one of: view, .*inspect, or \/marimo alone to pick notebooks\.$/u), "warning"]);
  await x.fire("session_shutdown");
});

test("marimo.json context: false keeps the notebooks out of the model's context", async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-marimo-wiring-"));
  mkdirSync(join(dir, "agent"));
  writeFileSync(join(dir, "agent", "marimo.json"), JSON.stringify({ context: false }));
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, xdg: process.env.XDG_CONFIG_HOME };
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  try {
    const x = setup([], "rpc");
    await x.fire("session_start");
    await until(() => server.feeds.length > 0);
    server.feeds.at(-1)!(untilRunning);
    await x.fire("tool_call", { input: { command: pair } });
    await x.fire("before_agent_start");
    const [context] = x.handlers.get("context")!;
    expect(await context!({ messages: [{ role: "user", timestamp: 1 }] }, undefined)).toBeUndefined();
    await x.fire("session_shutdown");
  } finally {
    if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agent;
    if (saved.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = saved.xdg;
  }
});

test("the agent's changes show in the view until the user's next prompt", async () => {
  const x = setup();
  await x.fire("session_start");
  await until(() => server.feeds.length > 0);
  server.feeds.at(-1)!(untilRunning);
  await x.fire("tool_call", { input: { command: pair } });
  const section = x.of("activity:section")[0]?.section;
  await until(() => section.entries(Date.now()).length > 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 5_000);
  const tx = { op: "notebook-document-transaction", data: { op: "notebook-document-transaction", transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "PKri", code: "z = y / 1" }] } } };
  server.feeds.at(-1)!(`data: ${JSON.stringify(tx)}\n\n`);
  vi.useRealTimers();
  await section.open(section.entries(Date.now())[0].key, x.ui);
  const view = x.customs.at(-1)?.view;
  await until(() => /PKri .*changed by the agent/u.test(view.render(120).join("\n")));
  expect(view.render(120).join("\n")).toContain("agent: 1 changed");
  await x.fire("before_agent_start");
  expect(view.render(120).join("\n")).not.toContain("changed by the agent");
  view.dispose();
  await x.fire("session_shutdown");
});
