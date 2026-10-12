// index.ts wired up end to end: the real watcher on a fake marimo server (a recorded /sse stream),
// pi's events and pi-bg's on a fake bus. Covers the kernel hold's "finished" notice being left out
// when a waking pi-bg job drives the run (and coming back when that job is stopped), the busy
// notebook reported as outside work, and pi-bg's tasks annotated with the kernel state.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Cancellable, Io, StreamEnd } from "../src/core/io.js";

const CWD = "/w";
const SERVER = "http://127.0.0.1:2799";

/** A marimo server with one session (`/w/nb.py`) whose /sse stream the test feeds. */
const server = vi.hoisted(() => ({ feeds: [] as Array<(text: string) => void> }));

vi.mock("../src/core/node-io.js", () => ({
  nodeIo: (): Io => ({
    registryEntries: async () => [{ port: 2799, host: "127.0.0.1" }],
    getJson: async (url: string) => (url.endsWith("/api/sessions") ? { s1: { path: `${CWD}/nb.py` } } : undefined),
    stream(_url: string, _headers: Record<string, string>, onText: (text: string) => void): Cancellable<StreamEnd> {
      let end!: (e: StreamEnd) => void;
      const done = new Promise<StreamEnd>((r) => (end = r));
      server.feeds.push(onText);
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

function setup() {
  const handlers = new Map<string, Array<(e: unknown, c: unknown) => unknown>>();
  const listeners = new Map<string, Array<(d: unknown) => void>>();
  const sent: Array<[string, any]> = [];
  const pi = {
    on: (name: string, h: (e: unknown, c: unknown) => unknown) => void handlers.set(name, [...(handlers.get(name) ?? []), h]),
    events: {
      on: (ch: string, h: (d: unknown) => void) => void listeners.set(ch, [...(listeners.get(ch) ?? []), h]),
      emit: (ch: string, d: unknown) => {
        sent.push([ch, d]);
        for (const h of listeners.get(ch) ?? []) h(d);
      },
    },
    registerCommand: () => undefined,
    appendEntry: () => undefined,
  };
  const widgets = new Map<string, any>();
  const customs: any[] = [];
  const ui = {
    setStatus: () => undefined,
    notify: () => undefined,
    setWidget: (key: string, w: unknown) => void (w ? widgets.set(key, w) : widgets.delete(key)),
    onTerminalInput: () => () => undefined,
    getEditorText: () => "",
    custom: (factory: any, options: unknown) => {
      const view = factory({ requestRender: () => undefined, terminal: { rows: 30 } }, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, {}, () => undefined);
      customs.push({ view, options });
      return Promise.resolve();
    },
  };
  const ctx = { cwd: CWD, mode: "tui", isIdle: () => true, ui, sessionManager: { getBranch: () => [] } };
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
  return { pi, fire, sent, of, widgets, customs, pillText, ui };
}

const pair = `bash .agents/skills/marimo-pair/scripts/execute-code.sh --url ${SERVER} --file nb.py - <<'PY'\nfit()\nPY`;
const job = (status: string) => ({ id: "j1", kind: "job", cwd: CWD, command: pair, status, origin: "agent", willWake: status === "running" });
const serverTask = { id: "s1", kind: "service", cwd: CWD, command: "uv run marimo edit --no-token nb.py", status: "running", origin: "agent", willWake: false };

beforeEach(() => {
  server.feeds.length = 0;
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
  expect(notes).toContainEqual({ task: "j1", by: "pi-marimo", detail: "nb.py: running Slow model fit · 1 queued", wait: ["marimo:nb.py"] });
  expect(notes).toContainEqual({ task: "s1", by: "pi-marimo", detail: "nb.py: running Slow model fit · 1 queued", wait: ["marimo:nb.py"] });
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
  expect(entries).toEqual([expect.objectContaining({ key: JSON.stringify([SERVER, `${CWD}/nb.py`]), label: "nb.py", status: "running", detail: "running Slow model fit · 1 queued" })]);
  // Alone, its own pill; hosted (by pi-bg, then pi-subagents too), none; the last host leaving brings it back.
  await until(() => /1 notebook/u.test(x.pillText() ?? ""));
  section.setHosted(true, "pi-bg");
  expect(x.widgets.size).toBe(0);
  section.setHosted(true);
  section.setHosted(false, "pi-bg");
  expect(x.widgets.size).toBe(0);
  x.pi.events.emit("activity:gone", { id: "subagents" });
  await until(() => /1 notebook/u.test(x.pillText() ?? ""));
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
  // The run ends with an error: failed in the pill until the user's next message.
  server.feeds.at(-1)!(rest);
  await until(() => /failed/u.test(x.pillText() ?? ""));
  expect(section.entries(Date.now())[0]).toMatchObject({ status: "failed", stats: expect.stringMatching(/^ran \d+s · 1 error/u) });
  await x.fire("input", { source: "interactive" });
  await until(() => x.widgets.size === 0 || !/failed/u.test(x.pillText() ?? ""));
  expect(section.entries(Date.now())[0]).toMatchObject({ status: "done" });
  await x.fire("session_shutdown");
  expect(x.of("activity:gone")).toEqual([{ id: "subagents" }, { id: "marimo" }]);
  const offered = x.of("activity:section").length;
  x.pi.events.emit("activity:host", {});
  expect(x.of("activity:section")).toHaveLength(offered);
  vi.unstubAllGlobals();
});
