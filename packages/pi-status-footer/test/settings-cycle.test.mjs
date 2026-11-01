import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { settingsCycles } from "../src/settings-cycle.ts";
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
  it("shares a trailing deadline, pending targets and a single visible anchor", async () => {
    const h = host(), cycles = settingsCycles(h.pi), workflow = control("workflow", "work", ["work", "plan", "linked"]), auto = control("auto-effort", false, [false, true]);
    const a = cycles.stage(h.ctx, workflow.change);
    await vi.advanceTimersByTimeAsync(399);
    expect(workflow.value).toBe("work");
    const b = cycles.stage(h.ctx, workflow.change), c = cycles.stage(h.ctx, auto.change);
    expect(anchors(h)).toHaveLength(1); expect(states(h).length).toBeGreaterThanOrEqual(2);
    expect(cycles.snapshot().settings.find(s => s.key === "workflow").target).toBe("linked");
    await vi.advanceTimersByTimeAsync(399); expect(workflow.value).toBe("work");
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.all([a, b, c])).toEqual([true, true, true]);
    expect(workflow.value).toBe("linked"); expect(auto.value).toBe(true); expect(last(h).phase).toBe("applied");
  });
  it("round trips without setters and settles every caller", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], c = control("workflow", "work", ["work", "plan"], calls);
    const a = cycles.stage(h.ctx, c.change), b = cycles.stage(h.ctx, c.change);
    await vi.advanceTimersByTimeAsync(400);
    expect(await Promise.all([a, b])).toEqual([true, true]); expect(calls).toEqual([]); expect(last(h).phase).toBe("unchanged");
  });
  it("validates all settings before applying, and applies in safety order", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [];
    const controls = [control("approvals", "ask", ["ask", "auto"], calls), control("reasoning", "low", ["low", "high"], calls), control("auto-effort", false, [false, true], calls), control("workflow", "work", ["work", "plan"], calls)];
    const first = controls.map(c => cycles.stage(h.ctx, c.change)); controls[0].valid = false; await vi.advanceTimersByTimeAsync(400);
    expect(await Promise.all(first)).toEqual([false, false, false, false]); expect(calls).toEqual([]);
    controls[0].valid = true;
    const second = controls.map(c => cycles.stage(h.ctx, c.change)); await vi.advanceTimersByTimeAsync(400);
    expect(await Promise.all(second)).toEqual([true, true, true, true]); expect(calls).toEqual(["workflow", "auto-effort", "reasoning", "approvals"]);
  });
  it("reports partial application and refuses staging during an async commit", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [];
    const workflow = control("workflow", "work", ["work", "plan"], calls), approvals = control("approvals", "ask", ["ask", "auto"], calls);
    let release; workflow.apply = async v => { await new Promise(resolve => { release = resolve; }); workflow.value = v; return true; };
    approvals.failure = "failed";
    const a = cycles.stage(h.ctx, workflow.change), b = cycles.stage(h.ctx, approvals.change);
    await vi.advanceTimersByTimeAsync(400);
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
    const p = cycles.stage(h.ctx, c.change); await h.emit(event); await vi.advanceTimersByTimeAsync(500);
    expect(await p).toBe(false); expect(c.value).toBe("work");
  });
  it("fences completion after shutdown and never appends into the next session", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]); let release;
    c.apply = async () => { await new Promise(resolve => { release = resolve; }); return true; };
    const p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(400); await h.emit("session_shutdown");
    const count = h.entries.length; h.session = "next"; release(); expect(await p).toBe(false); expect(h.entries).toHaveLength(count);
  });
  it("cancels stale baselines and guard failures", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("reasoning", "low", ["low", "high"]);
    let p = cycles.stage(h.ctx, c.change); c.value = "external"; await h.emit("thinking_level_select", { level: "external" }); expect(await p).toBe(false);
    c.value = "low"; const remove = cycles.addGuard(() => "not focused"); p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(400); expect(await p).toBe(false); remove();
  });
  it("settles a conflicting owner before starting its replacement", async () => {
    const h = host(), cycles = settingsCycles(h.pi), a = control("workflow", "work", ["work", "plan"]), b = control("workflow", "work", ["work", "linked"]);
    const first = cycles.stage(h.ctx, a.change), second = cycles.stage(h.ctx, b.change);
    expect(await first).toBe(false); await vi.advanceTimersByTimeAsync(400);
    expect(await second).toBe(true); expect(a.value).toBe("work"); expect(b.value).toBe("linked"); expect(anchors(h)).toHaveLength(2);
  });
  it("provides only net-changed targets to setters", async () => {
    const h = host(), cycles = settingsCycles(h.pi), auto = control("auto-effort", true, [true, false]), reasoning = control("reasoning", "low", ["low", "high"]); let targets;
    auto.apply = async (value, finalTargets) => { targets = finalTargets; auto.value = value; return true; };
    const requests = [cycles.stage(h.ctx, auto.change), cycles.stage(h.ctx, reasoning.change), cycles.stage(h.ctx, reasoning.change)];
    await vi.advanceTimersByTimeAsync(400); expect(await Promise.all(requests)).toEqual([true, true, true]); expect(targets).toEqual({ "auto-effort": false });
  });
  it("finishes a cancelled in-flight setter before blocking a later input", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]); let release;
    c.apply = async () => { await new Promise(resolve => { release = resolve; }); return true; };
    const p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(400); cycles.cancel("dialog");
    let finished = false; const input = h.emit("input", { source: "interactive", text: "hello" }).then(result => { finished = true; return result; });
    await Promise.resolve(); expect(finished).toBe(false); release(); expect(await input).toEqual({ action: "handled" }); expect(await p).toBe(false);
  });
  it("publishes cancellation when an owner becomes stale in the same branch", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    const p = cycles.stage(h.ctx, c.change); c.current = false; await vi.advanceTimersByTimeAsync(400);
    expect(await p).toBe(false); expect(last(h).phase).toBe("cancelled");
  });
  it("does not resume a commit cancelled reentrantly by a guard", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], c = control("workflow", "work", ["work", "plan"], calls);
    cycles.addGuard(() => { cycles.cancel("guard cancelled"); }); const p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(400);
    expect(await p).toBe(false); expect(calls).toEqual([]); expect(last(h).phase).toBe("cancelled");
  });
  it("settles cancellation and fences later applications while a setter is running", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], a = control("workflow", "work", ["work", "plan"], calls), b = control("approvals", "ask", ["ask", "auto"], calls); let release;
    a.apply = async () => { await new Promise(resolve => { release = resolve; }); return true; };
    const first = cycles.stage(h.ctx, a.change), second = cycles.stage(h.ctx, b.change);
    await vi.advanceTimersByTimeAsync(400); cycles.cancel("navigation"); release();
    expect(await Promise.all([first, second])).toEqual([false, false]); expect(calls).toEqual(["workflow"]);
  });
  it("handles reentrant staging from a synchronous preview listener", async () => {
    const h = host(), cycles = settingsCycles(h.pi), a = control("workflow", "work", ["work", "plan"]), b = control("approvals", "ask", ["ask", "auto"]); let other;
    h.pi.events.on("pi-plugins.settings-cycle.v1", event => { if (event.type === "changed" && !other) { other = true; other = cycles.stage(h.ctx, b.change); } });
    const first = cycles.stage(h.ctx, a.change); await vi.advanceTimersByTimeAsync(400);
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
    const first = cycles.stage(h.ctx, a.change), second = cycles.stage(h.ctx, b.change); await vi.advanceTimersByTimeAsync(400);
    expect(await Promise.all([first, second])).toEqual([false, false]); expect(calls).toEqual(["workflow"]); expect(last(h).phase).toBe("failed"); expect(last(h).reason).toMatch(/activation failed/);
  });
  it("does not expose mutable journal state through snapshots or notifications", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
    h.pi.events.on("pi-plugins.settings-cycle.v1", event => { if (event.type === "changed") event.snapshot.settings[0].target = "corrupt"; });
    const p = cycles.stage(h.ctx, c.change); const snapshot = cycles.snapshot(); snapshot.settings[0].target = "corrupt again";
    expect(cycles.snapshot().settings[0].target).toBe("plan"); expect(anchors(h)[0].data.settings[0].target).toBe("plan");
    await vi.advanceTimersByTimeAsync(400); expect(await p).toBe(true); expect(c.value).toBe("plan");
  });
  it("cancels shortcut-context previews on the current model from a later event context", async () => {
    const h = host(), cycles = settingsCycles(h.pi), calls = [], c = control("approvals", "auto", ["auto", "yolo"], calls);
    const shortcut = { ...h.ctx, model: { ...h.ctx.model } };
    const p = cycles.stage(shortcut, c.change);
    h.ctx.model = { ...h.ctx.model, id: "different-model" };
    expect(shortcut.model.id).toBe("model", "native shortcut contexts retain their old model snapshot");
    await h.emit("model_select");
    await vi.advanceTimersByTimeAsync(400);
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
    await vi.advanceTimersByTimeAsync(400); expect(await p).toBe(false);
    expect(component.render(120)[0]).not.toMatch(/[\n\t\x1b]/);
  });
  it("settles safely when the journal fails during staging, committing or failed input diagnostics", async () => {
    for (const phase of ["stage", "commit", "input"]) {
      const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]);
      if (phase === "stage") h.pi.appendEntry = () => { throw Error("journal unavailable"); };
      const p = cycles.stage(h.ctx, c.change);
      if (phase !== "stage") h.pi.appendEntry = () => { throw Error("journal unavailable"); };
      if (phase === "commit") await vi.advanceTimersByTimeAsync(400);
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
  it("reconstructs an unconfirmed applying snapshot as interrupted without changing records", async () => {
    const h = host(), cycles = settingsCycles(h.pi), c = control("workflow", "work", ["work", "plan"]); let release;
    c.apply = async () => { await new Promise(resolve => { release = resolve; }); return true; };
    const p = cycles.stage(h.ctx, c.change); await vi.advanceTimersByTimeAsync(400); const recorded = structuredClone(h.entries);
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
