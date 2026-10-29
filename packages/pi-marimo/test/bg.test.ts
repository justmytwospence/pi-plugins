import { describe, expect, test } from "vitest";
import { BgBridge, DISCONNECT_GRACE_MS } from "../src/bg.js";
import { withWaitHint } from "../src/index.js";

function bus() {
  const sent: Array<[string, any]> = [];
  return { sent, emit: (channel: string, data: unknown) => void sent.push([channel, data]) };
}

/** A followed notebook, as much of one as the bridge reads. */
function followed(path: string, state: { running?: string; queued?: number; errors?: number; connection?: string } = {}): any {
  return {
    attachment: { path },
    connection: state.connection ?? "connected",
    current: false,
    touchedAt: 0,
    notebook: {
      running: () => (state.running ? { section: [state.running], cell: { name: "_", id: "c1" } } : undefined),
      queued: () => state.queued ?? 0,
      errors: () => Array.from({ length: state.errors ?? 0 }, (_, i) => ({ id: `e${i}` })),
    },
  };
}

describe("pi-bg: busy notebooks as outside work", () => {
  test("running, then done with what the run took", () => {
    const b = bus();
    const bridge = new BgBridge(b, () => []);
    bridge.external([followed("/p/fit.py", { running: "Model fit" })], "/p", 1_000);
    bridge.external([followed("/p/fit.py", { running: "Model fit" })], "/p", 2_000);
    expect(bridge.runningIds()).toEqual(["marimo:fit.py"]);
    bridge.external([followed("/p/fit.py")], "/p", 63_000);
    expect(b.sent).toEqual([
      ["bg:external", { id: "marimo:fit.py", label: "fit.py: Model fit", state: "running" }],
      ["bg:external", { id: "marimo:fit.py", label: "fit.py", state: "done", summary: "ran 1m02s" }],
    ]);
    expect(bridge.runningIds()).toEqual([]);
  });

  test("errors, a disconnect or an unfollowed notebook end it as failed; shared names use the path", () => {
    const b = bus();
    const bridge = new BgBridge(b, () => []);
    const a = followed("/p/a/nb.py", { queued: 2 });
    const c = followed("/p/c/nb.py", { running: "Load" });
    bridge.external([a, c], "/p", 0);
    expect(b.sent.map(([, d]) => d.id)).toEqual(["marimo:a/nb.py", "marimo:c/nb.py"]);
    bridge.external([followed("/p/a/nb.py", { errors: 1 })], "/p", 5_000);
    expect(b.sent.slice(2).map(([, d]) => [d.id, d.state, d.summary])).toEqual([
      ["marimo:a/nb.py", "failed", "ran 5s · 1 error"],
      ["marimo:c/nb.py", "failed", "ran 5s · no longer followed"],
    ]);
  });
});

test("stopping ends every run still reported", () => {
  const b = bus();
  const bridge = new BgBridge(b, () => []);
  bridge.external([followed("/p/fit.py", { running: "Model fit" })], "/p", 0);
  bridge.stopAll(4_000);
  expect(b.sent.at(-1)).toEqual(["bg:external", { id: "marimo:fit.py", label: "fit.py", state: "failed", summary: "ran 4s · pi-marimo stopped following it" }]);
  expect(bridge.runningIds()).toEqual([]);
});

describe("pi-bg: runs survive what is not their end", () => {
  test("a disconnect shorter than the grace (a browser reload) does not end the run", () => {
    const b = bus();
    const bridge = new BgBridge(b, () => []);
    bridge.external([followed("/p/fit.py", { running: "Fit" })], "/p", 0);
    bridge.external([followed("/p/fit.py", { connection: "disconnected" })], "/p", 1_000);
    expect(bridge.needsTick()).toBe(true);
    bridge.external([followed("/p/fit.py", { running: "Fit" })], "/p", 3_000);
    expect(bridge.needsTick()).toBe(false);
    bridge.external([followed("/p/fit.py")], "/p", 10_000);
    expect(b.sent.map(([, d]) => [d.state, d.summary])).toEqual([["running", undefined], ["done", "ran 10s"]]);
  });

  test("a disconnect past the grace ends it as failed; errors from before the run do not count", () => {
    const b = bus();
    const bridge = new BgBridge(b, () => []);
    bridge.external([followed("/p/a.py", { running: "A", errors: 1 }), followed("/p/b.py", { running: "B" })], "/p", 0);
    bridge.external([followed("/p/a.py", { errors: 1 }), followed("/p/b.py", { connection: "disconnected" })], "/p", 1_000);
    bridge.external([followed("/p/a.py", { errors: 1 }), followed("/p/b.py", { connection: "disconnected" })], "/p", 1_000 + DISCONNECT_GRACE_MS);
    expect(b.sent.slice(2).map(([, d]) => [d.id, d.state, d.summary])).toEqual([
      ["marimo:a.py", "done", "ran 1s"],
      ["marimo:b.py", "failed", "ran 9s · disconnected"],
    ]);
  });
});

describe("pi-bg: no second notice for a run a waking job drives", () => {
  test("covered only by a job that will wake the agent and targets that notebook", () => {
    const bridge = new BgBridge(undefined, (command) => (command.includes("fit") ? ["/p/fit.py"] : []));
    bridge.onTasks([{ id: "x", command: "execute-code.sh --url u --file fit.py", origin: "agent", status: "running", willWake: true }]);
    bridge.noteCovered(["/p/fit.py", "/p/prep.py"]);
    expect(bridge.coversAll(["/p/fit.py"])).toBe(true);
    expect(bridge.coversAll(["/p/fit.py", "/p/prep.py"])).toBe(false);
    // Once covered, it stays covered after the job ended (it wakes the agent about the end).
    bridge.onTasks([]);
    expect(bridge.coversAll(["/p/fit.py"])).toBe(true);
    bridge.resetHold();
    expect(bridge.coversAll(["/p/fit.py"])).toBe(false);
    bridge.onTasks([{ id: "y", command: "execute-code.sh --file fit.py", origin: "agent", status: "running", willWake: false }]);
    bridge.noteCovered(["/p/fit.py"]);
    expect(bridge.coversAll(["/p/fit.py"])).toBe(false);
    // The user stops the covering job: it wakes no one, so the hold's own notice is needed again.
    bridge.onTasks([{ id: "z", command: "execute-code.sh --file fit.py", origin: "agent", status: "running", willWake: true }]);
    bridge.noteCovered(["/p/fit.py"]);
    expect(bridge.coversAll(["/p/fit.py"])).toBe(true);
    bridge.onTasks([{ id: "z", command: "execute-code.sh --file fit.py", origin: "agent", status: "killed", willWake: false }]);
    expect(bridge.coversAll(["/p/fit.py"])).toBe(false);
  });
});

describe("the bg_wait hint in the state block", () => {
  const block = "<marimo_notebook_state notebooks=\"1\">\nstate\n</marimo_notebook_state>";
  test("only with pi-bg loaded and a notebook running", () => {
    const listening = { events: { emit: (_c: string, d: any) => d?.reply?.() } } as any;
    const silent = { events: { emit: () => {} } } as any;
    expect(withWaitHint(block, ["marimo:fit.py"], listening)).toBe(
      "<marimo_notebook_state notebooks=\"1\">\nstate\nTo wait for a running notebook inside your turn, call bg_wait with its id: marimo:fit.py.\n</marimo_notebook_state>",
    );
    expect(withWaitHint(block, ["marimo:fit.py"], silent)).toBe(block);
    expect(withWaitHint(block, [], listening)).toBe(block);
  });
});

describe("ids that stay put", () => {
  test("a nested notebook keeps its path id when another of the same name is followed", () => {
    const b = bus();
    const bridge = new BgBridge(b, () => []);
    bridge.external([followed("/p/nb/fit.py", { running: "Fit" })], "/p", 0);
    bridge.external([followed("/p/nb/fit.py"), followed("/p/old/fit.py", { running: "Fit" })], "/p", 1_000);
    expect(b.sent.map(([, d]) => [d.id, d.state])).toEqual([
      ["marimo:nb/fit.py", "running"],
      ["marimo:nb/fit.py", "done"],
      ["marimo:old/fit.py", "running"],
    ]);
    expect(BgBridge.id("/elsewhere/x.py", "/p")).toBe("marimo:/elsewhere/x.py");
  });
});

describe("pi-bg's tasks annotated with the kernel state", () => {
  const nb = (state: Parameters<typeof followed>[1] = {}) => followed("/p/nb/fit.py", state);
  const task = (over: Record<string, unknown>) => ({ id: "t", kind: "service", cwd: "/p", command: "marimo edit --no-token nb/fit.py", status: "running", origin: "agent", willWake: false, ...over });

  test("a server by the notebook it serves, a job by what it targets; only changes are sent", () => {
    const b = bus();
    const bridge = new BgBridge(b, (command) => (command.includes("execute-code") ? ["/p/nb/fit.py"] : []));
    bridge.onTasks([task({}), task({ id: "j", kind: "job", command: "bash execute-code.sh --file nb/fit.py", willWake: true }), task({ id: "other", command: "npm run dev" })]);
    bridge.annotate([nb({ running: "Model fit", errors: 1 })], "/p");
    bridge.annotate([nb({ running: "Model fit", errors: 1 })], "/p");
    expect(b.sent).toEqual([
      ["bg:annotate", { task: "t", by: "pi-marimo", detail: "fit.py: running Model fit · 1 error", wait: ["marimo:nb/fit.py"] }],
      ["bg:annotate", { task: "j", by: "pi-marimo", detail: "fit.py: running Model fit · 1 error", wait: ["marimo:nb/fit.py"] }],
    ]);
    // The notebook is no longer followed: cleared, once.
    bridge.annotate([], "/p");
    bridge.annotate([], "/p");
    expect(b.sent.slice(2)).toEqual([
      ["bg:annotate", { task: "t", by: "pi-marimo" }],
      ["bg:annotate", { task: "j", by: "pi-marimo" }],
    ]);
  });

  test("with notebook rows shown, a server of a followed notebook is represented, busy or idle, and only then", () => {
    const b = bus();
    const bridge = new BgBridge(b, () => [], () => true);
    bridge.onTasks([task({}), task({ id: "other", command: "npm run dev" })]);
    bridge.annotate([nb()], "/p");
    expect(b.sent).toEqual([["bg:annotate", { task: "t", by: "pi-marimo", detail: "fit.py: idle", wait: ["marimo:nb/fit.py"], represented: true }]]);
    expect(bridge.servers("/p/nb/fit.py")).toEqual(["t"]);
    // Not followed any more: the server is an ordinary task again.
    bridge.annotate([], "/p");
    expect(b.sent.at(-1)).toEqual(["bg:annotate", { task: "t", by: "pi-marimo" }]);
    expect(bridge.servers("/p/nb/fit.py")).toEqual([]);
  });

  test("a server's notebook is found from its own directory; queued, idle and disconnected read plainly", () => {
    const b = bus();
    const bridge = new BgBridge(b, () => []);
    bridge.onTasks([task({ cwd: "/p/nb", command: "uvx marimo edit fit.py --headless" })]);
    bridge.annotate([nb({ queued: 2 })], "/p");
    bridge.annotate([nb()], "/p");
    bridge.annotate([nb({ connection: "disconnected" })], "/p");
    expect(b.sent.map(([, d]) => d.detail)).toEqual(["fit.py: 2 queued", "fit.py: idle", "fit.py: disconnected"]);
  });
});
