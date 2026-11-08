import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SETTINGS_CYCLE_IDLE_MS, settingsCycles } from "../src/settings-cycle.ts";
const I = SETTINGS_CYCLE_IDLE_MS;
import { settingsCycles as otherCopy } from "../../pi-tool-gate/src/settings-cycle.ts";

function host(mode = "tui") {
  const handlers = new Map(), listeners = new Map(), renderers = new Map(), entries = [], notices = [];
  let session = "session", draft = "newer draft";
  const pi = {
    events: {
      on(name, fn) { const list = listeners.get(name) ?? []; list.push(fn); listeners.set(name, list); return () => list.splice(list.indexOf(fn), 1); },
      emit(name, data) { for (const fn of [...(listeners.get(name) ?? [])]) fn(data); },
    },
    on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); return () => list.splice(list.indexOf(fn), 1); },
    registerEntryRenderer(name, fn) { if (renderers.has(name)) throw Error("duplicate renderer"); renderers.set(name, fn); },
    appendEntry(customType, data) { entries.push({ type: "custom", id: String(entries.length + 1), customType, data: structuredClone(data) }); },
    getThinkingLevel() { return "medium"; },
  };
  const ctx = { mode, hasUI: mode === "tui", model: { id: "model", provider: "provider" },
    sessionManager: { getSessionId: () => session, getSessionFile: () => `${session}.jsonl`, getBranch: () => entries, getLeafId: () => entries.at(-1)?.id ?? null },
    ui: { notify: (...args) => notices.push(args), getEditorText: () => draft, setEditorText: value => { draft = value; } },
  };
  const emit = async (name, event = {}) => { let result; for (const fn of handlers.get(name) ?? []) { result = await fn({ type: name, ...event }, ctx); if (result?.action === "handled") break; } return result; };
  return { pi, ctx, emit, handlers, entries, renderers, notices, set session(value) { session = value; }, get draft() { return draft; } };
}
function transportHost() {
  const h = host(), stdin = new EventEmitter(), exitSource = new EventEmitter(), writes = [], hooks = new Set(), microtasks = [];
  const editor = {}, terminal = { kittyProtocolActive: true, write: data => writes.push(data), stop() {}, drainInput() {}, start() {} };
  let factory = () => editor, focus = editor, overlay = false;
  const tui = { terminal, getFocusedComponent: () => focus, hasOverlay: () => overlay };
  Object.assign(h.ctx.ui, {
    getEditorComponent: () => factory,
    setEditorComponent: next => { factory = next; next(tui, {}, {}); },
    onTerminalInput: hook => { hooks.add(hook); return () => hooks.delete(hook); },
  });
  return Object.assign(h, {
    writes, terminal, stdin, exitSource, hooks,
    inputPorts: { stdin, exitSource, isInputTTY: () => true, isOutputTTY: () => true,
      writeSync: data => writes.push(data), queueMicrotask: run => microtasks.push(run), createEditor: () => editor },
    raw(data, action = () => {}) {
      for (const hook of [...hooks]) hook(data);
      const result = action();
      while (microtasks.length) microtasks.shift()();
      return result;
    },
    reply(flags) { stdin.emit("data", `\x1b[?${flags}u`); },
    blur() { focus = {}; },
    overlay(value) { overlay = value; },
  });
}
function control(key, initial, values, log = []) {
  let value = initial, failure, valid = true, current = true, apply = undefined;
  const owner = {};
  const change = { key, owner, read: () => value, next: v => values[(values.indexOf(v) + 1) % values.length],
    format: v => String(v), validate: () => valid ? undefined : "invalid", current: () => current,
    apply: async (v, targets) => { log.push(key); if (apply) return apply(v, targets); if (failure) throw Error(failure); value = v; return true; },
  };
  return { change, get value() { return value; }, set value(v) { value = v; }, set valid(v) { valid = v; }, set current(v) { current = v; }, set failure(v) { failure = v; }, set apply(v) { apply = v; } };
}
const anchors = h => h.entries.filter(e => e.customType === "settings:cycle");
const states = h => h.entries.filter(e => e.customType === "settings:cycle-state");
const last = h => states(h).at(-1)?.data;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("settings cycle coordinator", () => {
  it.each([false, true])("restores inert legacy history (mixed: %s)", async mixed => {
    const h = host(); settingsCycles(h.pi);
    const auto = { key: "auto-effort", baseline: false, target: true, actual: true, label: "on" };
    const workflow = { key: "workflow", baseline: "work", target: "plan", actual: "plan", label: "plan" };
    h.pi.appendEntry("settings:cycle", { version: 1, id: "legacy", phase: "applied", settings: mixed ? [workflow, auto] : [auto] });
    await h.emit("session_start");
    const component = h.renderers.get("settings:cycle")(h.entries[0], {}, { fg: (_color, text) => text });
    expect(component.render(120)[0]).toBe(mixed ? "Settings · Workflow plan · Auto on" : "Settings · Auto on");
    expect(h.entries).toHaveLength(1);
  });
  it("rejects retired settings even for untyped callers", async () => {
    const h = host(), cycles = settingsCycles(h.pi), retired = control("auto-effort", false, [false, true]);
    expect(await cycles.stage(h.ctx, retired.change)).toBe(false);
    expect(retired.value).toBe(false); expect(h.entries).toHaveLength(0);
  });
  it("shares a trailing deadline, pending targets and a single visible anchor", async () => {
    const h = host(), cycles = settingsCycles(h.pi), workflow = control("workflow", "work", ["work", "plan", "linked"]), approvals = control("approvals", "ask", ["ask", "auto"]);
    const a = cycles.stage(h.ctx, workflow.change);
    await vi.advanceTimersByTimeAsync(I - 1);
    expect(workflow.value).toBe("work");
    const b = cycles.stage(h.ctx, workflow.change), c = cycles.stage(h.ctx, approvals.change);
    expect(anchors(h)).toHaveLength(1); expect(states(h).length).toBeGreaterThanOrEqual(2);
    expect(cycles.snapshot().settings.find(s => s.key === "workflow").target).toBe("linked");
    await vi.advanceTimersByTimeAsync(I - 1); expect(workflow.value).toBe("work");
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all([a, b, c])).toEqual([true, true, true]);
    expect(workflow.value).toBe("linked"); expect(approvals.value).toBe("auto"); expect(last(h).phase).toBe("applied");
  });
  it("resets the idle deadline only for accepted stages", async () => {
    expect(SETTINGS_CYCLE_IDLE_MS).toBe(400);
    const h = host(), cycles = settingsCycles(h.pi), workflow = control("workflow", "work", ["work", "plan"]), approvals = control("approvals", "ask", ["ask", "auto"]);
    const first = cycles.stage(h.ctx, workflow.change);
    await vi.advanceTimersByTimeAsync(I - 1);
    expect(cycles.snapshot().phase).toBe("pending");
    approvals.valid = false;
    expect(await cycles.stage(h.ctx, approvals.change)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await first).toBe(true);
    const second = cycles.stage(h.ctx, workflow.change);
    await vi.advanceTimersByTimeAsync(I - 1);
    approvals.valid = true;
    expect(cycles.stage(h.ctx, approvals.change)).toBe(second);
    await vi.advanceTimersByTimeAsync(I - 1);
    expect(workflow.value).toBe("plan");
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toBe(true);
    expect(workflow.value).toBe("work");
  });
  it("round trips without setters and settles every caller", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], c = control("workflow", "work", ["work", "plan"], calls);
    const a = cycles.stage(h.ctx, c.change), b = cycles.stage(h.ctx, c.change);
    await vi.advanceTimersByTimeAsync(I);
    expect(await Promise.all([a, b])).toEqual([true, true]); expect(calls).toEqual([]); expect(last(h).phase).toBe("unchanged");
  });
  it("validates all settings before applying, and applies in safety order", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [];
    const controls = [control("approvals", "ask", ["ask", "auto"], calls), control("reasoning", "low", ["low", "high"], calls), control("workflow", "work", ["work", "plan"], calls)];
    const first = controls.map(c => cycles.stage(h.ctx, c.change)); controls[0].valid = false; await vi.advanceTimersByTimeAsync(I);
    expect(await Promise.all(first)).toEqual([false, false, false]); expect(calls).toEqual([]);
    controls[0].valid = true;
    const second = controls.map(c => cycles.stage(h.ctx, c.change)); await vi.advanceTimersByTimeAsync(I);
    expect(await Promise.all(second)).toEqual([true, true, true]); expect(calls).toEqual(["workflow", "reasoning", "approvals"]);
  });
  it("reports partial application and refuses staging during an async commit", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [];
    const workflow = control("workflow", "work", ["work", "plan"], calls), approvals = control("approvals", "ask", ["ask", "auto"], calls);
    let release; workflow.apply = async v => { await new Promise(resolve => { release = resolve; }); workflow.value = v; return true; };
    approvals.failure = "failed";
    const a = cycles.stage(h.ctx, workflow.change), b = cycles.stage(h.ctx, approvals.change);
    await vi.advanceTimersByTimeAsync(I);
    expect(cycles.snapshot().phase).toBe("applying");
    expect(await cycles.stage(h.ctx, workflow.change)).toBe(false);
    release(); expect(await Promise.all([a, b])).toEqual([false, false]);
    expect(last(h).phase).toBe("partial"); expect(last(h).settings.find(s => s.key === "workflow").actual).toBe("plan"); expect(last(h).settings.find(s => s.key === "approvals").actual).toBe("ask");
  });
  it("flushes on input, blocks failures without touching the newer draft", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    let p = cycles.stage(h.ctx, c.change); expect(await h.emit("input", { text: "hello", source: "interactive" })).not.toEqual({ action: "handled" });
    expect(await p).toBe(true); expect(c.value).toBe("plan");
    p = cycles.stage(h.ctx, c.change); c.valid = false;
    expect(await h.emit("input", { text: "failed prompt", source: "interactive" })).toEqual({ action: "handled" });
    expect(await p).toBe(false); expect(h.draft).toBe("newer draft"); expect(last(h).reason).toMatch(/message not sent/); expect(last(h).reason).toMatch(/prompt history/);
  });
  it.each(["session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "ui_prompt_start", "before_agent_start"])("cancels pending work on %s", async event => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const p = cycles.stage(h.ctx, c.change); await h.emit(event); await vi.advanceTimersByTimeAsync(I);
    expect(await p).toBe(false); expect(c.value).toBe("work");
  });
  it("fences completion after shutdown and never appends into the next session", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]); let release;
    c.apply = async () => { await new Promise(resolve => { release = resolve; }); return true; };
    const p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); await h.emit("session_shutdown");
    const count = h.entries.length; h.session = "next"; release(); expect(await p).toBe(false); expect(h.entries).toHaveLength(count);
  });
  it("cancels stale baselines and guard failures", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("reasoning", "low", ["low", "high"]);
    let p = cycles.stage(h.ctx, c.change); c.value = "external"; await h.emit("thinking_level_select", { level: "external" }); expect(await p).toBe(false);
    c.value = "low"; const remove = cycles.addGuard(() => "not focused"); p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(false); remove();
  });
  it("settles a conflicting owner before starting its replacement", async () => {
    const h = host(), cycles = settingsCycles(h.pi), a = control("workflow", "work", ["work", "plan"]), b = control("workflow", "work", ["work", "linked"]);
    const first = cycles.stage(h.ctx, a.change), second = cycles.stage(h.ctx, b.change);
    expect(await first).toBe(false); await vi.advanceTimersByTimeAsync(I);
    expect(await second).toBe(true); expect(a.value).toBe("work"); expect(b.value).toBe("linked"); expect(anchors(h)).toHaveLength(2);
  });
  it("provides only net-changed targets to setters", async () => {
    const h = host(), cycles = settingsCycles(h.pi), workflow = control("workflow", "work", ["work", "plan"]), reasoning = control("reasoning", "low", ["low", "high"]); let targets;
    workflow.apply = async (value, finalTargets) => { targets = finalTargets; workflow.value = value; return true; };
    const requests = [cycles.stage(h.ctx, workflow.change), cycles.stage(h.ctx, reasoning.change), cycles.stage(h.ctx, reasoning.change)];
    await vi.advanceTimersByTimeAsync(I); expect(await Promise.all(requests)).toEqual([true, true, true]); expect(targets).toEqual({ workflow: "plan" });
  });
  it("finishes a cancelled in-flight setter before blocking a later input", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]); let release;
    c.apply = async () => { await new Promise(resolve => { release = resolve; }); return true; };
    const p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); cycles.cancel("dialog");
    let finished = false; const input = h.emit("input", { source: "interactive", text: "hello" }).then(result => { finished = true; return result; });
    await Promise.resolve(); expect(finished).toBe(false); release(); expect(await input).toEqual({ action: "handled" }); expect(await p).toBe(false);
  });
  it("publishes cancellation when an owner becomes stale in the same branch", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const p = cycles.stage(h.ctx, c.change); c.current = false; await vi.advanceTimersByTimeAsync(I);
    expect(await p).toBe(false); expect(last(h).phase).toBe("cancelled");
  });
  it("does not resume a commit cancelled reentrantly by a guard", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], c = control("workflow", "work", ["work", "plan"], calls);
    cycles.addGuard(() => { cycles.cancel("guard cancelled"); }); const p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I);
    expect(await p).toBe(false); expect(calls).toEqual([]); expect(last(h).phase).toBe("cancelled");
  });
  it("settles cancellation and fences later applications while a setter is running", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], a = control("workflow", "work", ["work", "plan"], calls), b = control("approvals", "ask", ["ask", "auto"], calls); let release;
    a.apply = async () => { await new Promise(resolve => { release = resolve; }); return true; };
    const first = cycles.stage(h.ctx, a.change), second = cycles.stage(h.ctx, b.change);
    await vi.advanceTimersByTimeAsync(I); cycles.cancel("navigation"); release();
    expect(await Promise.all([first, second])).toEqual([false, false]); expect(calls).toEqual(["workflow"]);
  });
  it("handles reentrant staging from a synchronous preview listener", async () => {
    const h = host(), cycles = settingsCycles(h.pi), a = control("workflow", "work", ["work", "plan"]), b = control("approvals", "ask", ["ask", "auto"]); let other;
    h.pi.events.on("pi-plugins.settings-cycle.v1", event => { if (event.type === "changed" && !other) { other = true; other = cycles.stage(h.ctx, b.change); } });
    const first = cycles.stage(h.ctx, a.change); await vi.advanceTimersByTimeAsync(I);
    expect(await Promise.all([first, other])).toEqual([true, true]); expect(anchors(h)).toHaveLength(1); expect(a.value).toBe("plan"); expect(b.value).toBe("auto");
  });
  it("cancels a changed model but ignores delayed same-model events", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const p = cycles.stage(h.ctx, c.change); await h.emit("model_select"); expect(cycles.snapshot().phase).toBe("pending");
    h.ctx.model = { provider: "provider", id: "new" }; await h.emit("model_select"); expect(await p).toBe(false); expect(c.value).toBe("work");
  });
  it("settles asynchronous setter rejection without applying later settings", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], a = control("workflow", "work", ["work", "plan"], calls), b = control("approvals", "ask", ["ask", "auto"], calls);
    a.apply = async () => { throw Error("activation failed"); };
    const first = cycles.stage(h.ctx, a.change), second = cycles.stage(h.ctx, b.change); await vi.advanceTimersByTimeAsync(I);
    expect(await Promise.all([first, second])).toEqual([false, false]); expect(calls).toEqual(["workflow"]); expect(last(h).phase).toBe("failed"); expect(last(h).reason).toMatch(/activation failed/);
  });
  it("does not expose mutable journal state through snapshots or notifications", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    h.pi.events.on("pi-plugins.settings-cycle.v1", event => { if (event.type === "changed") event.snapshot.settings[0].target = "corrupt"; });
    const p = cycles.stage(h.ctx, c.change); const snapshot = cycles.snapshot(); snapshot.settings[0].target = "corrupt again";
    expect(cycles.snapshot().settings[0].target).toBe("plan"); expect(anchors(h)[0].data.settings[0].target).toBe("plan");
    await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(true); expect(c.value).toBe("plan");
  });
  it("cancels shortcut-context previews on the current model from a later event context", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], c = control("approvals", "auto", ["auto", "yolo"], calls);
    const shortcut = { ...h.ctx, model: { ...h.ctx.model } };
    const p = cycles.stage(shortcut, c.change);
    h.ctx.model = { ...h.ctx.model, id: "different-model" };
    expect(shortcut.model.id).toBe("model", "native shortcut contexts retain their old model snapshot");
    await h.emit("model_select");
    await vi.advanceTimersByTimeAsync(I);
    expect(await p).toBe(false);
    expect(calls).toEqual([]);
    expect(c.value).toBe("auto");
    expect(cycles.snapshot().phase).toBe("cancelled");
    expect(cycles.snapshot().reason).toBe("model changed");
  });
  it("keeps labels and multiline provider errors on one sanitized terminal row", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    c.change.format = () => "plan\n\x1b[2Jinjected\tlabel";
    c.failure = "failed\n\x1b[2Jdetails";
    const p = cycles.stage(h.ctx, c.change);
    const component = h.renderers.get("settings:cycle")(anchors(h)[0], {}, { fg: (_color, text) => text });
    expect(component.render(120)).toHaveLength(1);
    expect(component.render(120)[0]).not.toMatch(/[\n\t\x1b]/);
    await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(false);
    expect(component.render(120)[0]).not.toMatch(/[\n\t\x1b]/);
  });
  it("settles safely when the journal fails during staging, committing or failed input diagnostics", async () => {
    for (const phase of ["stage", "commit", "input"]) {
      const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
      if (phase === "stage") h.pi.appendEntry = () => { throw Error("journal unavailable"); };
      const p = cycles.stage(h.ctx, c.change);
      if (phase !== "stage") h.pi.appendEntry = () => { throw Error("journal unavailable"); };
      if (phase === "commit") await vi.advanceTimersByTimeAsync(I);
      if (phase === "input") expect(await h.emit("input", { source: "interactive" })).toEqual({ action: "handled" });
      expect(await p).toBe(false);
      expect(c.value).toBe("work");
      expect(vi.getTimerCount()).toBe(0);
    }
  });
  it("discovers one coordinator across copies but isolates separate buses", () => {
    const a = host(), b = host(); expect(settingsCycles(a.pi)).toBe(otherCopy(a.pi)); expect(settingsCycles(a.pi)).not.toBe(settingsCycles(b.pi)); expect(a.renderers.size).toBe(1);
  });
  for (const mode of ["rpc", "tui"]) it(`applies immediately without journal or timer without UI (${mode})`, async () => {
    const h = host(mode), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    h.ctx.hasUI = false;
    expect(await cycles.stage(h.ctx, c.change)).toBe(true); expect(c.value).toBe("plan"); expect(h.entries).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });
  it("holds proven keyboard batches without a timer and commits once on final modifier release", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), calls = [], c = control("workflow", "work", ["work", "plan"], calls);
    await h.emit("session_start");
    expect(h.hooks.size).toBe(1);
    const p = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    expect(cycles.inputStatus()).toMatchObject({ mode: "negotiating", modifiers: ["ctrl"] });
    expect(h.writes).toEqual(["\x1b[?u"]);
    h.reply(7); expect(h.writes).toEqual(["\x1b[?u", "\x1b[>31u", "\x1b[?u"]);
    h.reply(31);
    expect(cycles.inputStatus()).toMatchObject({ mode: "negotiating", reason: "unconfirmed" });
    h.raw("\x1b[112;5:3u"); // Ordinary-key release proves Ctrl is still held.
    expect(cycles.inputStatus()).toEqual({ mode: "modifier-release", modifiers: ["ctrl"] });
    await vi.advanceTimersByTimeAsync(I - 1); expect(c.value).toBe("work");
    c.change.validate = () => { expect(h.writes.at(-1)).toBe("\x1b[<u"); };
    h.raw("\x1b[57442;1:3u");
    expect(await p).toBe(true); expect(c.value).toBe("plan"); expect(calls).toEqual(["workflow"]); expect(last(h).launchedBy).toBe("release");
    h.raw("\x1b[57442;1:3u"); await cycles.flush();
    expect(calls).toEqual(["workflow"]); expect(vi.getTimerCount()).toBe(0);
    expect(h.writes.filter(value => value === "\x1b[<u")).toHaveLength(1);
    expect(cycles.inputStatus()).toEqual({ mode: "idle", modifiers: [] });
  });
  it("commits a proven hold at the idle deadline when the terminal never reports its release", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), c = control("workflow", "work", ["work", "plan"]);
    await h.emit("session_start");
    const p = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    h.reply(7); h.reply(31); h.raw("\x1b[112;5:3u");
    expect(cycles.inputStatus().mode).toBe("modifier-release");
    await vi.advanceTimersByTimeAsync(I - 1); expect(c.value).toBe("work");
    await vi.advanceTimersByTimeAsync(1); expect(await p).toBe(true); expect(c.value).toBe("plan");
    expect(last(h).launchedBy).toBe("timer");
    expect(h.writes.at(-1)).toBe("\x1b[<u");
  });
  it.each(["full", "partial", "missing"])("keeps the original activation deadline on %s capability replies and unrelated traffic", async kind => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), c = control("workflow", "work", ["work", "plan"]);
    await h.emit("session_start");
    const p = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    await vi.advanceTimersByTimeAsync(I - 100);
    if (kind !== "missing") { h.reply(7); h.reply(kind === "full" ? 31 : 7); }
    await vi.advanceTimersByTimeAsync(99);
    h.raw("\x1b[<35;4;4M"); h.raw("\x1b]0;title\x07");
    expect(c.value).toBe("work");
    await vi.advanceTimersByTimeAsync(1); expect(await p).toBe(true); expect(c.value).toBe("plan");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reuses one live row across release, pointer timer and unchanged keyboard batches", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), calls = [], c = control("workflow", "work", ["work", "plan"], calls);
    await h.emit("session_start");
    const first = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    h.reply(7); h.reply(31); h.raw("\x1b[112;5:3u"); h.raw("\x1b[57442;1:3u");
    expect(await first).toBe(true);
    const anchor = structuredClone(anchors(h)[0]);
    const second = cycles.stage(h.ctx, c.change, { kind: "pointer" });
    expect(second).not.toBe(first); expect(cycles.snapshot().settings[0].baseline).toBe("plan");
    await vi.advanceTimersByTimeAsync(I); expect(await second).toBe(true);
    const third = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    h.reply(7); h.reply(31);
    h.raw("\x1b[112;5:2u", () => expect(cycles.stage(h.ctx, c.change)).toBe(third));
    await vi.advanceTimersByTimeAsync(3000); expect(calls).toEqual(["workflow", "workflow"]);
    h.raw("\x1b[57442;1:3u"); expect(await third).toBe(true);
    expect(last(h).phase).toBe("unchanged"); expect(anchors(h)).toEqual([anchor]);
    expect(calls).toEqual(["workflow", "workflow"]);
  });
  it("reconciles timer mode against the most recent accepted activation rather than the late reply", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), workflow = control("workflow", "work", ["work", "plan"]), approvals = control("approvals", "ask", ["ask", "auto"]);
    await h.emit("session_start");
    const p = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, workflow.change));
    await vi.advanceTimersByTimeAsync(I / 2);
    h.raw("\x1b[97;5:1u", () => expect(cycles.stage(h.ctx, approvals.change)).toBe(p));
    await vi.advanceTimersByTimeAsync(I / 2); h.reply(7); h.reply(7);
    await vi.advanceTimersByTimeAsync(199); expect(workflow.value).toBe("work");
    await vi.advanceTimersByTimeAsync(1); expect(await p).toBe(true); expect(approvals.value).toBe("auto");
  });
  it.each(["pointer", "programmatic"])("switches a proven hold to %s fallback without inheriting keyboard modifiers", async kind => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), c = control("workflow", "work", ["work", "plan", "linked"]);
    await h.emit("session_start");
    const p = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    h.reply(7); h.reply(31); h.raw("\x1b[112;5:3u");
    expect(c.value).toBe("work");
    expect(cycles.withTrigger({ kind }, () => cycles.stage(h.ctx, c.change))).toBe(p);
    expect(cycles.captureTrigger()).toBeUndefined();
    expect(cycles.inputStatus()).toEqual({ mode: "timer", modifiers: [], reason: kind });
    expect(h.writes.at(-1)).toBe("\x1b[<u");
    h.raw("\x1b[57442;1:3u");
    await vi.advanceTimersByTimeAsync(I - 1); expect(c.value).toBe("work");
    await vi.advanceTimersByTimeAsync(1); expect(await p).toBe(true); expect(c.value).toBe("linked");
  });
  it("keeps a newer reentrant pointer activation instead of restoring its outer keyboard trigger", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), workflow = control("workflow", "work", ["work", "plan"]), approvals = control("approvals", "ask", ["ask", "auto"]); let nested;
    await h.emit("session_start");
    h.pi.events.on("pi-plugins.settings-cycle.v1", event => {
      if (event.snapshot?.phase === "pending" && !nested) { nested = true; nested = cycles.stage(h.ctx, approvals.change, { kind: "pointer" }); }
    });
    const p = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, workflow.change));
    expect(nested).toBe(p); expect(cycles.inputStatus()).toEqual({ mode: "timer", modifiers: [], reason: "pointer" });
    expect(h.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(true); expect(approvals.value).toBe("auto");
  });
  it("disposes the live input binding and deadline on shutdown, then binds a fresh session once", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), c = control("workflow", "work", ["work", "plan"]);
    expect(otherCopy(h.pi, { inputPorts: { isInputTTY() { throw Error("discovered options must not construct another adapter"); } } })).toBe(cycles);
    await h.emit("session_start");
    const p = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    h.reply(7); h.reply(31); h.raw("\x1b[112;5:3u");
    await h.emit("session_shutdown"); expect(await p).toBe(false);
    expect(h.writes.at(-1)).toBe("\x1b[<u"); expect(h.stdin.listenerCount("data")).toBe(0);
    expect(h.exitSource.listenerCount("exit")).toBe(0); expect(h.hooks.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
    await h.emit("session_start"); expect(h.hooks.size).toBe(1);
    const next = cycles.stage(h.ctx, c.change, { kind: "pointer" });
    h.raw("\x1b[57442;1:3u");
    await vi.advanceTimersByTimeAsync(I - 1); expect(c.value).toBe("work");
    await vi.advanceTimersByTimeAsync(1); expect(await next).toBe(true); expect(anchors(h)).toHaveLength(2);
    await h.emit("session_shutdown");
  });
  it("starts a fresh keyboard handshake after pointer staging in the same transaction", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), c = control("workflow", "work", ["work", "plan", "linked"]);
    await h.emit("session_start");
    const p = cycles.stage(h.ctx, c.change, { kind: "pointer" });
    await vi.advanceTimersByTimeAsync(I / 2);
    h.raw("\x1b[112;5:1u", () => expect(cycles.stage(h.ctx, c.change)).toBe(p));
    h.reply(7); h.reply(31); h.raw("\x1b[112;5:3u");
    expect(cycles.inputStatus().mode).toBe("modifier-release");
    await vi.advanceTimersByTimeAsync(I - 1); expect(c.value).toBe("work");
    h.raw("\x1b[57442;1:3u"); expect(await p).toBe(true); expect(c.value).toBe("linked");
  });
  it("finishes release before the handshake and ignores late acknowledgements", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), c = control("workflow", "work", ["work", "plan"]);
    await h.emit("session_start");
    const p = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    h.raw("\x1b[57442;1:3u"); expect(await p).toBe(true);
    const count = h.entries.length;
    h.reply(7); h.reply(31); await vi.advanceTimersByTimeAsync(3000);
    expect(h.entries).toHaveLength(count); expect(h.writes).toEqual(["\x1b[?u"]); expect(cycles.inputStatus().mode).toBe("idle");
  });
  it("retains release evidence across delayed staging but rejects a token from a retired session", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), c = control("workflow", "work", ["work", "plan"]); let trigger;
    await h.emit("session_start");
    h.raw("\x1b[112;5:1u", () => { trigger = cycles.captureTrigger(); });
    expect(trigger.kind).toBe("keyboard"); expect(cycles.captureTrigger()).toBeUndefined();
    h.raw("\x1b[57442;1:3u");
    expect(await cycles.stage(h.ctx, c.change, trigger)).toBe(true); expect(h.writes).toEqual([]);
    await h.emit("session_shutdown"); await h.emit("session_start");
    const p = cycles.stage(h.ctx, c.change, trigger);
    expect(cycles.inputStatus()).toMatchObject({ mode: "timer", reason: "unavailable" });
    await vi.advanceTimersByTimeAsync(I - 1); expect(c.value).toBe("plan");
    await vi.advanceTimersByTimeAsync(1); expect(await p).toBe(true); expect(h.writes).toEqual([]);
  });
  it("closes a leased frame before cancellation publications and fences simultaneous submit/release", async () => {
    const h = transportHost(), cycles = settingsCycles(h.pi, { inputPorts: h.inputPorts }), calls = [], c = control("workflow", "work", ["work", "plan"], calls);
    await h.emit("session_start");
    const p = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    h.reply(7); h.reply(31); h.raw("\x1b[112;5:3u");
    h.pi.events.on("pi-plugins.settings-cycle.v1", event => { if (event.snapshot?.phase === "cancelled") expect(h.writes.at(-1)).toBe("\x1b[<u"); });
    cycles.cancel("explicit selection"); expect(await p).toBe(false);
    const next = h.raw("\x1b[112;5:1u", () => cycles.stage(h.ctx, c.change));
    h.reply(7); h.reply(31); h.raw("\x1b[112;5:3u");
    const input = h.emit("input", { source: "interactive" });
    h.raw("\x1b[57442;1:3u");
    expect(await input).toBeUndefined(); expect(await next).toBe(true); expect(calls).toEqual(["workflow"]);
    expect(anchors(h)).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });
  it("reuses the original component across five completed batches with fresh promises and baselines", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], c = control("workflow", "work", ["work", "plan", "linked", "review", "test", "done"], calls);
    let previous, component, original, rowId;
    for (const [baseline, target] of [["work", "plan"], ["plan", "linked"], ["linked", "review"], ["review", "test"], ["test", "done"]]) {
      const p = cycles.stage(h.ctx, c.change);
      expect(p).not.toBe(previous);
      previous = p;
      if (!component) {
        rowId = anchors(h)[0].data.id;
        original = structuredClone(anchors(h)[0]);
        component = h.renderers.get("settings:cycle")(anchors(h)[0], {}, { fg: (_color, text) => text });
      }
      expect(cycles.snapshot()).toMatchObject({ id: rowId, phase: "pending", settings: [{ baseline, target }] });
      expect(component.render(120)[0]).toMatch(new RegExp(`pending.*${target}`));
      await vi.advanceTimersByTimeAsync(I);
      expect(await p).toBe(true);
      expect(c.value).toBe(target);
      expect(component.render(120)[0]).toBe(`Settings · Workflow ${target}`);
      expect(anchors(h)).toEqual([original]);
      await vi.advanceTimersByTimeAsync(1500);
    }
    expect(calls).toEqual(Array(5).fill("workflow"));
    expect(h.entries.every(entry => entry.data.version === 1)).toBe(true);
  });
  it("shows only the latest batch, including unchanged round trips, without reusing an old baseline", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], workflow = control("workflow", "work", ["work", "plan"], calls), reasoning = control("reasoning", "low", ["low", "high"], calls);
    const first = cycles.stage(h.ctx, workflow.change);
    await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    const rowId = last(h).id;
    const p = cycles.stage(h.ctx, reasoning.change);
    expect(cycles.stage(h.ctx, reasoning.change)).toBe(p);
    await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(true);
    expect(last(h)).toMatchObject({ id: rowId, phase: "unchanged", settings: [{ key: "reasoning", baseline: "low", actual: "low", target: "low" }] });
    expect(last(h).settings).toHaveLength(1); expect(calls).toEqual(["workflow"]); expect(workflow.value).toBe("plan");
    expect(anchors(h)).toHaveLength(1);
    const component = h.renderers.get("settings:cycle")(anchors(h)[0], {}, { fg: (_color, text) => text });
    expect(component.render(120)).toEqual(["Settings unchanged"]);
    const next = cycles.stage(h.ctx, workflow.change);
    expect(cycles.snapshot().settings[0].baseline).toBe("plan");
    await vi.advanceTimersByTimeAsync(I); expect(await next).toBe(true);
    expect(workflow.value).toBe("work"); expect(anchors(h)).toHaveLength(1);
  });
  it.each(["input", "ui_prompt_start", "session_before_switch", "session_before_fork", "session_before_tree", "session_before_compact", "before_agent_start", "message_start", "session_tree"])("seals an already settled row on %s", async event => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    const oldId = last(h).id;
    const component = h.renderers.get("settings:cycle")(anchors(h)[0], {}, { fg: (_color, text) => text });
    await h.emit(event, { source: "interactive" });
    const next = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await next).toBe(true);
    expect(anchors(h)).toHaveLength(2); expect(last(h).id).not.toBe(oldId);
    expect(component.render(120)).toEqual(["Settings · Workflow plan"]);
  });
  it("does not apply when its native row anchor leaves the current branch", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], c = control("workflow", "work", ["work", "plan"], calls);
    const p = cycles.stage(h.ctx, c.change);
    h.entries.splice(0);
    await vi.advanceTimersByTimeAsync(I);
    expect(await p).toBe(false); expect(calls).toEqual([]); expect(h.entries).toEqual([]);
  });
  it("seals explicit cancellation even with no pending transaction", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(true);
    cycles.cancel("explicit selection");
    const next = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await next).toBe(true);
    expect(anchors(h)).toHaveLength(2);
  });
  it("starts a new row for a conflicting owner after successful settlement", async () => {
    const h = host(), cycles = settingsCycles(h.pi), a = control("workflow", "work", ["work", "plan"]), b = control("workflow", "plan", ["plan", "linked"]);
    const first = cycles.stage(h.ctx, a.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    const second = cycles.stage(h.ctx, b.change); await vi.advanceTimersByTimeAsync(I); expect(await second).toBe(true);
    expect(anchors(h)).toHaveLength(2);
  });
  it.each(["tool-gate:workflow", "tool-gate:approvals", "tool-gate:flow", "tool-gate:chat-notice", "plan-mode:inline", "tool-gate:phase-effort"])("allows own setting persistence during a setter: %s", async customType => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    c.apply = async value => { h.pi.appendEntry(customType, {}); c.value = value; return true; };
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    const second = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await second).toBe(true);
    expect(anchors(h)).toHaveLength(1);
  });
  it.each(["model_change", "thinking_level_change"])("allows native %s records inside a setter only", async type => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    c.apply = async value => {
      h.entries.push({ type, id: String(h.entries.length + 1) });
      await h.emit(type === "model_change" ? "model_select" : "thinking_level_select");
      c.value = value; return true;
    };
    let p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(true);
    p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(true);
    expect(anchors(h)).toHaveLength(1);
    c.apply = undefined;
    const remove = cycles.addGuard(() => { h.entries.push({ type, id: String(h.entries.length + 1) }); });
    p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(true); remove();
    p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await p).toBe(true);
    expect(anchors(h)).toHaveLength(2);
  });
  it.each(["custom", "message", "custom_message", "compaction"])("seals on unrelated %s records inside asynchronous application", async type => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    c.apply = async value => { await Promise.resolve(); h.entries.push({ type, customType: "other:output", id: String(h.entries.length + 1) }); c.value = value; return true; };
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    c.apply = undefined;
    const next = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await next).toBe(true);
    expect(anchors(h)).toHaveLength(2);
  });
  it.each([true, false])("checks records appended by final publication listeners (setting-owned: %s)", async owned => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    h.pi.events.on("pi-plugins.settings-cycle.v1", event => { if (event.snapshot?.phase === "applied") h.pi.appendEntry(owned ? "tool-gate:phase-effort" : "unrelated:output", {}); });
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    const second = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await second).toBe(true);
    expect(anchors(h)).toHaveLength(owned ? 1 : 2);
  });
  it("does not allow an external cycle-state record to impersonate a coordinator publication", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    c.apply = async value => { h.pi.appendEntry("settings:cycle-state", cycles.snapshot()); c.value = value; return true; };
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    const next = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await next).toBe(true);
    expect(anchors(h)).toHaveLength(2);
  });
  it("seals on message_start while an asynchronous setter has not persisted its output", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]); let release;
    c.apply = async value => { await new Promise(resolve => { release = resolve; }); c.value = value; return true; };
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I);
    await h.emit("message_start"); release(); expect(await first).toBe(true);
    c.apply = undefined;
    const next = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await next).toBe(true);
    expect(anchors(h)).toHaveLength(2);
  });
  it.each(["custom", "message", "model_change", "thinking_level_change"])("requires the exact checkpoint when an external %s arrives between batches", async type => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    h.entries.push({ type, customType: "tool-gate:workflow", id: String(h.entries.length + 1) });
    const next = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await next).toBe(true);
    expect(anchors(h)).toHaveLength(2);
  });
  it("seals a failed reused row before a successful retry", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    c.failure = "failed";
    const failed = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await failed).toBe(false);
    expect(anchors(h)).toHaveLength(1); expect(last(h).phase).toBe("failed");
    const component = h.renderers.get("settings:cycle")(anchors(h)[0], {}, { fg: (_color, text) => text });
    c.failure = undefined;
    const retry = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await retry).toBe(true);
    expect(anchors(h)).toHaveLength(2); expect(component.render(120)[0]).toMatch(/not applied.*failed/);
  });
  it("never reopens restored successful history for live editing", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    const recorded = structuredClone(h.entries);
    await h.emit("session_shutdown"); await h.emit("session_start");
    expect(h.entries).toEqual(recorded); expect(vi.getTimerCount()).toBe(0);
    const next = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await next).toBe(true);
    expect(anchors(h)).toHaveLength(2); expect(h.entries.slice(0, recorded.length)).toEqual(recorded);
  });
  it("seals a row when final journal persistence fails even after the setter succeeded", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]), append = h.pi.appendEntry;
    const first = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await first).toBe(true);
    h.pi.appendEntry = (type, data) => { if (data.phase === "applied") throw Error("disk full"); append(type, data); };
    const failed = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await failed).toBe(false);
    expect(c.value).toBe("work"); expect(vi.getTimerCount()).toBe(0);
    h.pi.appendEntry = append;
    const retry = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); expect(await retry).toBe(true);
    expect(anchors(h)).toHaveLength(2);
  });
  it("reconstructs an unconfirmed applying snapshot as interrupted without changing records", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]); let release;
    c.apply = async () => { await new Promise(resolve => { release = resolve; }); return true; };
    const p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(I); const recorded = structuredClone(h.entries);
    await h.emit("session_shutdown"); release(); expect(await p).toBe(false);
    h.entries.splice(0, h.entries.length, ...recorded); await h.emit("session_start");
    const component = h.renderers.get("settings:cycle")(anchors(h)[0], {}, { fg: (_color, text) => text });
    expect(component.render(120).join("")).toMatch(/Settings interrupted.*check current settings/); expect(h.entries).toEqual(recorded);
  });
  it("redraws the original anchor with current snapshots and reconstructs interrupted branches", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const p = cycles.stage(h.ctx, c.change), anchor = anchors(h)[0], original = structuredClone(h.entries);
    const theme = { fg: (_color, text) => text }; const component = h.renderers.get("settings:cycle")(anchor, {}, theme);
    expect(component.render(120).join("")).toMatch(/pending.*plan/i); expect(visibleWidth(component.render(12)[0])).toBeLessThanOrEqual(12);
    cycles.cancel("test"); expect(await p).toBe(false); expect(component.render(120).join("")).toMatch(/cancelled/i);
    h.entries.splice(0, h.entries.length, ...original); await h.emit("session_tree");
    expect(component.render(120).join("")).toMatch(/cancelled.*interrupted/i); expect(h.entries).toEqual(original);
  });
});
