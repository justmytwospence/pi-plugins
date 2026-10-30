import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { emptyUsage } from "../src/child.ts";
import { FleetView, SUCCESS_HINT_MS, fleetRoster, renderFleet } from "../src/ui/fleet.ts";
import { KEY, fakeRun, fakeUI, normalFocus, piCustom, plain } from "./ui-helpers.ts";

beforeAll(() => initTheme("dark"));
afterEach(() => vi.useRealTimers());

const names = (roster: ReturnType<typeof fleetRoster>) => roster.map((e) => (e.kind === "main" ? "main" : e.kind === "run" ? e.run.agent : e.kind === "row" ? e.row.label : e.pill.label));

test("the roster: main, running and viewed runs earliest first, failures until the next message or x; then pills", () => {
  const now = 100_000;
  const late = fakeRun({ agent: "late", state: { startedAt: 50 } });
  const early = fakeRun({ agent: "early", state: { startedAt: 10 } });
  const done = fakeRun({ agent: "done", state: { status: "done", startedAt: 20, endedAt: now - 1 } });
  const failed = fakeRun({ agent: "failed", state: { status: "failed", startedAt: 30, endedAt: now - 60_000 } });
  // A success leaves at once (Claude Code); a failure stays while it ended after the last message.
  expect(names(fleetRoster([late, early, done, failed], now))).toEqual(["main", "early", "late"]);
  expect(names(fleetRoster([late, early, done, failed], now, undefined, [], 0))).toEqual(["main", "early", "failed", "late"]);
  expect(names(fleetRoster([late, early, done, failed], now, undefined, [], 0, new Set([failed.id])))).toEqual(["main", "early", "late"]);
  expect(names(fleetRoster([late, early, done, failed], now, `run:${done.id}`))).toEqual(["main", "early", "done", "late"]);
  // Pills end the list; with no runs there is no main row.
  const tasks = { id: "bg", title: "tasks", entries: () => [], open: async () => undefined, pill: () => ({ label: "2 tasks" }) };
  expect(names(fleetRoster([early], now, undefined, [tasks]))).toEqual(["main", "early", "2 tasks"]);
  expect(names(fleetRoster([done], now, undefined, [tasks]))).toEqual(["2 tasks"]);
  expect(fleetRoster([done], now)).toEqual([]);
});

test("rows: the selection, stats flush right, a status icon once finished, and scrolling", () => {
  const usage = { ...emptyUsage(), input: 13_100 };
  const a = fakeRun({ agent: "scout", state: { startedAt: 0, usage } });
  const b = fakeRun({ agent: "reviewer", task: "Review the diff", state: { status: "failed", startedAt: 5_000, endedAt: 57_000 } });
  const roster = fleetRoster([a, b], 60_000, undefined, [], 0);
  const idle = renderFleet({ roster, selected: 0, active: false, now: 60_000, width: 100, theme: plain });
  expect(idle).toHaveLength(4);
  expect(idle[0]).toBe(" ○ main");
  expect(idle[1]).toMatch(/^ ○ Find where the config is loaded {2}scout {2}claude-haiku-5 · low +1m00s · ↓ 13\.1k tokens$/u);
  expect(idle[2]).toMatch(/^ ○ Review the diff {2}reviewer {2}claude-haiku-5 · low +✗ 52s · ↓ 0 tokens$/u);
  expect(idle[3]).toBe("");
  expect(idle.slice(1, 3).map(visibleWidth)).toEqual([100, 100]);
  const active = renderFleet({ roster, selected: 2, active: true, now: 60_000, width: 100, theme: plain });
  expect(active[0]).toContain("j/k select · l/enter view · x dismiss · h/esc back");
  expect(active[1]).toBe(" ○ main");
  expect(active[3]).toMatch(/^ ● Review the diff {2}reviewer/u);
  // A pill, and the note after a success.
  const tasks = { id: "bg", title: "tasks", entries: () => [], open: async () => undefined, pill: () => ({ label: "2 tasks", alert: "1 failed" }) };
  const withPill = fleetRoster([a], 60_000, undefined, [tasks]);
  expect(renderFleet({ roster: withPill, selected: 1, active: true, now: 60_000, width: 80, theme: plain, note: "/tasks to see subagents" }).slice(-3)).toEqual([
    " ○ 2 tasks · 1 failed",
    " /tasks to see subagents",
    "",
  ]);
  expect(renderFleet({ roster: fleetRoster([], 0, undefined, [tasks]), selected: 0, active: false, now: 0, width: 80, theme: plain })).toEqual([" ○ 2 tasks · 1 failed", ""]);

  const many = fleetRoster(Array.from({ length: 8 }, (_, i) => fakeRun({ agent: `a${i}`, label: `Task ${i}`, state: { startedAt: i } })), 0);
  const top = renderFleet({ roster: many, selected: 0, active: true, now: 0, width: 60, theme: plain });
  expect(top.at(-2)?.trim()).toBe("↓ 3 more");
  const bottom = renderFleet({ roster: many, selected: 8, active: true, now: 0, width: 60, theme: plain });
  expect(bottom[2]?.trim()).toBe("↑ 3 more");
  expect(bottom.some((l) => l.includes("● Task 7  a7"))).toBe(true);
  expect(renderFleet({ roster: [], selected: 0, active: false, now: 0, width: 60, theme: plain })).toEqual([]);
});

test.each([46, 120])("long fleet tasks use the full %i columns without wrapping, keeping status and stats", (width) => {
  const run = fakeRun({ task: "Find config ".repeat(40), state: { status: "failed", startedAt: 0, endedAt: 60_000 } });
  const lines = renderFleet({ roster: fleetRoster([run], 60_000, undefined, [], 0), selected: 0, active: false, now: 60_000, width, theme: plain });
  expect(lines).toHaveLength(4); // main, truncated task, stats, footer spacer
  expect(lines[1]?.replace(/\x1b\[[0-9;]*m/gu, "")).toBe(` ○ ${run.task}`.slice(0, width - 3) + "...");
  expect(visibleWidth(lines[1]!)).toBe(width);
  expect(lines[2]?.trim()).toBe("✗ 1m00s · ↓ 0 tokens");
  expect(visibleWidth(lines[2]!)).toBe(width);
});

test.each([46, 120])("unicode and styled fleet activity tasks do not wrap at %i columns", (width) => {
  const label = "界e\u0301🚀 ".repeat(60);
  const row = { key: "task", label, detail: "worker", status: "stopped" as const, stats: "12s", startedAt: 0 };
  const section = { id: "bg", title: "tasks", entries: () => [row], open: async () => undefined, pill: () => ({ label: "", rows: [row] }) };
  const theme = { ...plain, fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m` };
  const frame = { roster: fleetRoster([], 0, undefined, [section]), selected: 0, active: false, now: 0, width, theme };
  for (const custom of [false, true]) {
    const lines = renderFleet(custom ? { ...frame, roster: [{ kind: "row", section, row: { ...row, line: () => theme.fg("dim", label) } }] } : frame);
    expect(lines).toHaveLength(3); // truncated task, status/stats, spacer
    expect(visibleWidth(lines[0]!)).toBeGreaterThanOrEqual(width - 1);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines[0]).toContain("...");
    expect(lines[1]).toContain("■");
    if (!custom) expect(lines[1]).toContain("12s");
  }
});

function setup() {
  const ui = fakeUI();
  normalFocus(ui);
  const runs = [fakeRun({ agent: "scout", label: "Find config", child: {} as never, state: { startedAt: Date.now() } }), fakeRun({ agent: "worker", label: "Fix config", child: {} as never, state: { startedAt: Date.now() + 1 } })];
  let enabled = true;
  const steered: string[] = [];
  const stopped: string[] = [];
  const fleet = new FleetView({ runs: () => runs, enabled: () => enabled, actions: (run) => ({ steer: (m) => steered.push(m) > 0, stop: () => void stopped.push(run.agent) }) });
  fleet.setUI(ui);
  fleet.update();
  return { ui, runs, fleet, steered, stopped, disable: () => (enabled = false) };
}

const autoCallbacks = () => ({ onDismiss: vi.fn(), onInteraction: vi.fn(), onRejected: vi.fn() });
const settled = async () => { await Promise.resolve(); await Promise.resolve(); };

test("auto-open requires enabled fleet, known main focus, empty draft and no owned viewer", async () => {
  const { ui, fleet, runs, disable } = setup();
  const callbacks = autoCallbacks();
  ui.editorText = " ";
  expect(fleet.autoOpen(runs[0]!, callbacks)).toBe(false);
  expect(ui.editorText).toBe(" ");
  ui.editorText = "";
  for (const focus of [undefined, { handleInput() {} }, { getText() {}, setText() {}, [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded", [Symbol.for("pi-plugins.input-context.v1")]: () => "editor" }]) {
    ui.tui.focused = focus;
    expect(fleet.autoOpen(runs[0]!, callbacks)).toBe(false);
  }
  normalFocus(ui);
  const manual = fleet.show(ui, runs[0]!);
  expect(fleet.autoOpen(runs[1]!, callbacks)).toBe(false);
  fleet.closeAutoView(runs[0]!.id);
  expect(ui.customs).toHaveLength(1);
  ui.customs[0]!.component.handleInput(KEY.escape);
  await manual;
  disable();
  expect(fleet.autoOpen(runs[0]!, callbacks)).toBe(false);
  fleet.dispose();
});

test("a fleet-owned pill dialog blocks auto-open, including before its promise starts", async () => {
  const ui = fakeUI();
  normalFocus(ui);
  let close = () => {};
  const run = fakeRun();
  const fleet = new FleetView({ runs: () => [], enabled: () => true, actions: () => ({}), sections: () => [{
    id: "tasks", title: "tasks", entries: () => [], open: async () => {}, pill: () => ({ label: "tasks" }),
    openDialog: () => new Promise<void>((resolve) => { close = resolve; }),
  }] });
  fleet.setUI(ui);
  fleet.update();
  ui.press(KEY.down);
  ui.press(KEY.enter);
  expect(fleet.autoOpen(run, autoCallbacks())).toBe(false);
  await settled();
  expect(fleet.autoOpen(run, autoCallbacks())).toBe(false);
  close();
  await settled();
  fleet.dispose();
});

test("rebinding closes the old view and its late callback leaves the new binding intact", async () => {
  const { ui, fleet, runs } = setup();
  const old = autoCallbacks();
  fleet.autoOpen(runs[0]!, old);
  const next = fakeUI();
  normalFocus(next);
  fleet.setUI(next);
  fleet.update();
  expect(ui.customs).toHaveLength(0);
  expect(ui.widgets.size).toBe(0);
  expect(ui.inputHandlers.size).toBe(0);
  expect(fleet.autoOpen(runs[1]!, autoCallbacks())).toBe(true);
  await settled();
  expect(next.customs).toHaveLength(1);
  expect(old.onDismiss).not.toHaveBeenCalled();
  fleet.dispose();
  await settled();
  expect(next.widgets.size).toBe(0);
  expect(next.customs).toHaveLength(0);
});

test("untouched completion closes only the matching auto-view, idempotently, without dismissal", async () => {
  const { ui, fleet, runs } = setup();
  const callbacks = autoCallbacks();
  expect(fleet.autoOpen(runs[0]!, callbacks)).toBe(true);
  expect(fleet.autoOpen(runs[0]!, callbacks)).toBe(false);
  fleet.closeAutoView(runs[1]!.id);
  expect(ui.customs).toHaveLength(1);
  runs[0]!.state.status = "done";
  fleet.closeAutoView(runs[0]!.id);
  fleet.closeAutoView(runs[0]!.id);
  await settled();
  expect(ui.customs).toHaveLength(0);
  expect(callbacks.onDismiss).not.toHaveBeenCalled();
  expect(callbacks.onInteraction).not.toHaveBeenCalled();
  fleet.dispose();
});

test.each([KEY.up, "a", "\t"])("input %j makes an auto-view user-owned; closing notifies the coordinator", async (key) => {
  const { ui, fleet, runs } = setup();
  const callbacks = autoCallbacks();
  expect(fleet.autoOpen(runs[0]!, callbacks)).toBe(true);
  ui.customs[0]!.component.handleInput(key);
  fleet.closeAutoView(runs[0]!.id);
  fleet.closeAutoView(runs[1]!.id);
  expect(ui.customs).toHaveLength(1);
  expect(callbacks.onInteraction).toHaveBeenCalledTimes(1);
  ui.customs[0]!.component.handleInput(KEY.escape);
  // Reservation survives until the user-close callback reaches the coordinator.
  expect(fleet.autoOpen(runs[0]!, callbacks)).toBe(false);
  await settled();
  expect(callbacks.onDismiss).toHaveBeenCalledTimes(1);
  fleet.dispose();
});

test("Esc after switching an auto-view dismisses the currently viewed run", async () => {
  const { ui, fleet, runs } = setup();
  const callbacks = autoCallbacks();
  fleet.autoOpen(runs[0]!, callbacks);
  ui.customs[0]!.component.handleInput("\t");
  ui.customs[0]!.component.handleInput(KEY.escape);
  await settled();
  expect(callbacks.onDismiss).toHaveBeenCalledExactlyOnceWith(runs[1]!.id);
  fleet.dispose();
});

test("Esc immediately dismisses an auto-view and stale close cannot clear its replacement", async () => {
  const { ui, fleet, runs } = setup();
  const callbacks = autoCallbacks();
  fleet.autoOpen(runs[0]!, callbacks);
  ui.customs[0]!.component.handleInput(KEY.escape);
  await settled();
  expect(callbacks.onInteraction).toHaveBeenCalledTimes(1);
  expect(callbacks.onDismiss).toHaveBeenCalledTimes(1);
  fleet.autoOpen(runs[0]!, autoCallbacks());
  fleet.closeAutoView(runs[0]!.id);
  fleet.autoOpen(runs[1]!, autoCallbacks());
  await settled();
  expect(ui.customs).toHaveLength(1);
  expect(fleet.autoOpen(runs[0]!, callbacks)).toBe(false);
  fleet.closeAutoView(runs[1]!.id);
  fleet.dispose();
});

test.each(["completion", "rebind", "dispose", "draft", "dialog"])("pending auto-open is safe after %s", async (reason) => {
  vi.useFakeTimers();
  const { ui, fleet, runs } = setup();
  const baselineTimers = vi.getTimerCount();
  let open = () => {};
  let constructed: { dispose: ReturnType<typeof vi.spyOn> } | undefined;
  const custom = piCustom(ui);
  ui.custom = (factory, options) => new Promise((resolve, reject) => {
    open = () => {
      custom((...args) => {
        const created = factory(...args);
        constructed = { dispose: vi.spyOn(created, "dispose") };
        return created;
      }, options).then(resolve, reject);
    };
  });
  const callbacks = autoCallbacks();
  expect(fleet.autoOpen(runs[0]!, callbacks)).toBe(true);
  expect(fleet.autoOpen(runs[1]!, callbacks)).toBe(false);
  if (reason === "completion") fleet.closeAutoView(runs[0]!.id);
  if (reason === "rebind") fleet.setUI(fakeUI());
  if (reason === "dispose") fleet.dispose();
  if (reason === "draft") ui.editorText = "new draft";
  if (reason === "dialog") ui.tui.focused = { handleInput() {} };
  open();
  await settled();
  await settled();
  expect(ui.customs).toHaveLength(0);
  expect(constructed!.dispose).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(reason === "dispose" ? 0 : baselineTimers);
  expect(callbacks.onDismiss).not.toHaveBeenCalled();
  expect(callbacks.onInteraction).not.toHaveBeenCalled();
  if (reason === "draft") expect(ui.editorText).toBe("new draft");
  fleet.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

test("Tab routing selects and cycles tasks through main without draft replacement", () => {
  const { ui, fleet, runs } = setup();
  ui.editorText = "keep this draft";
  expect(fleet.tab(true)).toBe(false);
  expect(fleet.tab()).toBe(true);
  expect(ui.render("subagents-fleet")[2]).toMatch(/● Find config/u);
  expect(ui.press("\t")).toBe(true);
  expect(ui.render("subagents-fleet")[3]).toMatch(/● Fix config/u);
  expect(ui.press("\t")).toBe(true);
  expect(ui.render("subagents-fleet")[1]).toMatch(/^ ● main/u);
  expect(ui.press("\t")).toBe(true);
  expect(ui.render("subagents-fleet")[2]).toMatch(/● Find config/u);
  expect(ui.editorText).toBe("keep this draft");
  expect(ui.press(KEY.escape)).toBe(true);
  expect(fleet.tab(true)).toBe(false);
  runs.length = 0; fleet.update();
  expect(fleet.tab()).toBe(false);
  fleet.dispose();
});

test("↓ at an empty prompt enters the list; arrows select; Esc or ↑ past main leaves", () => {
  const { ui, fleet } = setup();
  expect(ui.widgets.get("subagents-fleet")?.placement).toBe("belowEditor");
  ui.editorText = "draft";
  expect(ui.press(KEY.down)).toBe(false);
  ui.editorText = "";
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toContain("j/k select");
  expect(ui.render("subagents-fleet")[2]).toMatch(/● Find config {2}scout/u);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[3]).toMatch(/● Fix config {2}worker/u);
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.render("subagents-fleet")[1]).toMatch(/^ ● main/u);
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toBe(" ◉ main");
  expect(ui.press(KEY.up)).toBe(false);
  // ← also enters; Esc leaves; typing leaves and reaches the editor.
  expect(ui.press(KEY.left)).toBe(true);
  expect(ui.press(KEY.escape)).toBe(true);
  expect(ui.press(KEY.escape)).toBe(false);
  expect(ui.press(KEY.left)).toBe(true);
  expect(ui.press("a")).toBe(false);
  expect(ui.render("subagents-fleet")[0]).toBe(" ◉ main");
  // A dialog has the keyboard: hands off.
  ui.tui.focused = { handleInput: () => undefined };
  expect(ui.press(KEY.down)).toBe(false);
  ui.tui.focused = { getText: () => "", setText: () => undefined };
  expect(ui.press(KEY.down)).toBe(true);
  fleet.dispose();
});

test("Ctrl+J/Ctrl+K stay the editor's until the list is selected, then cycle it through main", () => {
  const { ui, fleet, runs } = setup();
  ui.editorText = "draft";
  // From the prompt the keys are the editor's.
  expect(ui.press("\n")).toBe(false);
  expect(ui.press("\x0b")).toBe(false);
  // Selected (here with ↓ at the prompt's end), they cycle the rows.
  ui.editorText = "";
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[2]).toMatch(/● Find config/u);
  expect(ui.press("\n")).toBe(true);
  expect(ui.render("subagents-fleet")[3]).toMatch(/● Fix config/u);
  expect(ui.press("\n")).toBe(true);
  expect(ui.render("subagents-fleet")[1]).toMatch(/^ ● main/u);
  expect(ui.press("\x0b")).toBe(true);
  expect(ui.render("subagents-fleet")[3]).toMatch(/● Fix config/u);
  expect(ui.press(KEY.escape)).toBe(true);
  expect(ui.press("\n")).toBe(false);
  // A dialog has the keyboard, or there is no list: the keys stay the editor's.
  ui.tui.focused = { handleInput: () => undefined };
  expect(ui.press("\n")).toBe(false);
  ui.tui.focused = { getText: () => "", setText: () => undefined };
  runs.length = 0; fleet.update();
  expect(ui.press("\n")).toBe(false);
  fleet.dispose();
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  expect(ui.inputHandlers.size).toBe(0);
});

test("Enter opens the viewer, which owns the keys; closing it returns to the same row", async () => {
  const { ui, fleet, steered, runs } = setup();
  ui.press(KEY.down);
  ui.press(KEY.down);
  ui.press(KEY.enter);
  expect(ui.customs).toHaveLength(1);
  const viewer = ui.customs[0]!.component;
  // The run finishes while viewed; the viewer and its row stay.
  runs[1]!.state = { ...runs[1]!.state, status: "done", endedAt: Date.now() - 1 };
  runs[1]!.child = undefined;
  expect(ui.press(KEY.down)).toBe(false);
  viewer.render(80);
  viewer.handleInput(KEY.enter);
  expect(steered).toEqual([]);
  viewer.handleInput(KEY.escape);
  await Promise.resolve();
  await Promise.resolve();
  expect(ui.customs).toHaveLength(0);
  // Back in the list; the finished run has now dropped out, so the selection clamps.
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.render("subagents-fleet")[1]).toMatch(/^ ● main/u);
  ui.press(KEY.down);
  ui.press(KEY.enter);
  ui.customs[0]!.component.handleInput(KEY.enter);
  for (const ch of "hi") ui.customs[0]!.component.handleInput(ch);
  ui.customs[0]!.component.handleInput(KEY.enter);
  expect(steered).toEqual(["hi"]);
  fleet.dispose();
  expect(ui.customs).toHaveLength(0);
});

test("x twice stops the selected run; any other key disarms; x on main goes to the editor", () => {
  const { ui, fleet, stopped } = setup();
  ui.press(KEY.down);
  expect(ui.render("subagents-fleet")[0]).toContain("l/enter view · x stop · h/esc back");
  expect(ui.press("x")).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toContain("x again to stop Find config");
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press("x")).toBe(true);
  expect(stopped).toEqual([]);
  expect(ui.press("x")).toBe(true);
  expect(stopped).toEqual(["worker"]);
  ui.press(KEY.up);
  ui.press(KEY.up);
  expect(ui.press("x")).toBe(false);
  fleet.dispose();
});

test("stop arming follows the row: if it leaves, the second x does not stop the row that took its place", () => {
  const { ui, runs, fleet, stopped } = setup();
  ui.press(KEY.down);
  expect(ui.press("x")).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toContain("x again to stop Find config");
  // scout ends (a success leaves the list); worker moves up under the cursor.
  runs[0]!.state = { ...runs[0]!.state, status: "done", endedAt: Date.now() };
  fleet.update();
  expect(ui.render("subagents-fleet")[0]).not.toContain("x again");
  expect(ui.press("x")).toBe(true);
  expect(stopped).toEqual([]);
  expect(ui.render("subagents-fleet")[0]).toContain("x again to stop Fix config");
  fleet.dispose();
});

test("stop confirmation cannot survive replacing the child under the same stable row", () => {
  const { ui, runs, fleet, stopped } = setup();
  ui.press(KEY.down);
  expect(ui.press("x")).toBe(true);
  runs[0]!.child = {} as never;
  expect(ui.render("subagents-fleet")[0]).not.toContain("x again");
  expect(ui.press("x")).toBe(true);
  expect(stopped).toEqual([]);
  expect(ui.press("x")).toBe(true);
  expect(stopped).toEqual(["scout"]);
  fleet.dispose();
});

test("a success leaves at once with a note for 30 s; a failure stays until x; disabled, it never shows", () => {
  vi.useFakeTimers({ now: 1_000 });
  const ui = fakeUI();
  normalFocus(ui);
  const runs = [fakeRun({ agent: "scout", child: {} as never, state: { startedAt: 0 } }), fakeRun({ agent: "worker", child: {} as never, state: { startedAt: 1 } })];
  let enabled = true;
  const dismissed = new Set<string>();
  const note = (now: number) => {
    const latest = Math.max(0, ...runs.filter((r) => r.state.status === "done").map((r) => r.state.endedAt ?? 0));
    return latest && now - latest < SUCCESS_HINT_MS ? "/tasks to see subagents" : undefined;
  };
  const fleet = new FleetView({ runs: () => runs, enabled: () => enabled, actions: () => ({}), dismissedAt: () => 0, dismissed: () => dismissed, dismiss: (id) => void dismissed.add(id), note });
  fleet.setUI(ui);
  fleet.update();
  runs[0]!.state = { ...runs[0]!.state, status: "done", endedAt: Date.now() };
  runs[1]!.state = { ...runs[1]!.state, status: "failed", endedAt: Date.now() };
  vi.advanceTimersByTime(300);
  const lines = ui.render("subagents-fleet");
  expect(lines.some((l) => l.includes("scout"))).toBe(false);
  expect(lines.some((l) => l.includes("worker"))).toBe(true);
  expect(lines.at(-2)).toBe(" /tasks to see subagents");
  // x on the failed run dismisses it; the note alone stays until its 30 s are up.
  ui.press(KEY.down);
  expect(ui.render("subagents-fleet")[0]).toContain("x dismiss");
  expect(ui.press("x")).toBe(true);
  expect(ui.render("subagents-fleet")).toEqual([" /tasks to see subagents", ""]);
  vi.advanceTimersByTime(SUCCESS_HINT_MS);
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  expect(ui.press(KEY.down)).toBe(false);
  runs.push({ ...runs[0]!, id: "new", state: { ...runs[0]!.state, status: "running", endedAt: undefined } } as never);
  enabled = false;
  fleet.update();
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  expect(ui.press(KEY.down)).toBe(false);
  fleet.dispose();
});

test("a pill: ↓ selects it when there are no runs; Enter opens its dialog, which owns the keys", async () => {
  const ui = fakeUI();
  let opened = 0;
  let close: () => void = () => undefined;
  const tasks = {
    id: "bg",
    title: "tasks",
    entries: () => [],
    open: async () => undefined,
    pill: () => ({ label: "2 tasks" }),
    openDialog: () => {
      opened++;
      return new Promise<void>((resolve) => {
        close = resolve;
      });
    },
  };
  const fleet = new FleetView({ runs: () => [], enabled: () => true, actions: () => ({}), sections: () => [tasks] });
  fleet.setUI(ui);
  fleet.update();
  expect(ui.render("subagents-fleet")).toEqual([" ○ 2 tasks", ""]);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toMatch(/^ ● 2 tasks +enter view · esc back$/u);
  expect(ui.press(KEY.enter)).toBe(true);
  await Promise.resolve();
  expect(opened).toBe(1);
  expect(ui.press(KEY.down)).toBe(false);
  close();
  await new Promise((r) => setTimeout(r, 0));
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press(KEY.escape)).toBe(true);
  fleet.dispose();
});

test("pill rows (notebooks): listed above the label, selected and opened like runs, x twice stops a running one", async () => {
  const ui = fakeUI();
  const opened: string[] = [];
  const stopped: string[] = [];
  const rows = [
    { key: "a", label: "a.py", detail: ":2718 · idle", status: "done" as const, stats: "", startedAt: 0 },
    { key: "b", label: "b.py", detail: ":2719 · running Fit", status: "running" as const, stats: "0:12", startedAt: 0, stopToken: "t" },
  ];
  const notebooks = {
    id: "marimo",
    title: "notebooks",
    entries: () => rows,
    open: async (key: string) => void opened.push(key),
    stop: (key: string) => void stopped.push(key),
    pill: () => ({ label: "", rows }),
  };
  const roster = fleetRoster([], 0, undefined, [notebooks]);
  expect(names(roster)).toEqual(["a.py", "b.py"]);
  const fleet = new FleetView({ runs: () => [], enabled: () => true, actions: () => ({}), sections: () => [notebooks] });
  fleet.setUI(ui);
  fleet.update();
  const idle = ui.render("subagents-fleet");
  expect(idle).toHaveLength(3);
  expect(idle[0]).toMatch(/^ ○ a\.py {2}:2718 · idle/u);
  expect(idle[1]).toMatch(/^ ○ b\.py {2}:2719 · running Fit +0:12$/u);
  expect(ui.press(KEY.down)).toBe(true);
    expect(ui.render("subagents-fleet")[0]).toMatch(/^ ● a\.py/u);
  expect(ui.render("subagents-fleet")).toHaveLength(3);
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[1]).toMatch(/^ ● b\.py/u);
  expect(ui.press(KEY.enter)).toBe(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(opened).toEqual(["b"]);
  // Back out of the view: the same row is selected again.
  expect(ui.render("subagents-fleet")[1]).toMatch(/^ ● b\.py/u);
  expect(ui.press(KEY.up)).toBe(true);
  expect(ui.render("subagents-fleet")[0]).toMatch(/^ ● a\.py/u);
  fleet.dispose();
});

test("↓ leaves a draft for the list once the cursor is at its end; vim's j does in normal mode; hjkl move, open and go back", () => {
  const { ui, fleet } = setup();
  const editor = { text: "a draft", cursor: { line: 0, col: 3 }, mode: "insert", historyIndex: -1 };
  ui.tui.focused = {
    getText: () => editor.text,
    setText: () => undefined,
    getLines: () => editor.text.split("\n"),
    getCursor: () => editor.cursor,
    historyIndex: -1,
    getMode: () => editor.mode,
    [Symbol.for("pi-plugins.editor-mode.v1")]: () => ({ state: editor.mode, mode: editor.mode, pending: "", ex: null, autocomplete: false }),
  };
  ui.editorText = editor.text;
  // Mid-line: the editor moves the cursor first.
  expect(ui.press(KEY.down)).toBe(false);
  editor.cursor = { line: 0, col: 7 };
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.render("subagents-fleet")[2]).toMatch(/● Find config {2}scout/u);
  // Escape goes back; insert-mode h remains typing; ← with a draft stays in the editor.
  expect(ui.press(KEY.escape)).toBe(true);
  expect(ui.press(KEY.left)).toBe(false);
  // vim: j in insert mode is typing; in normal mode at the last character it enters.
  expect(ui.press("j")).toBe(false);
  editor.mode = "normal";
  editor.cursor = { line: 0, col: 6 };
  expect(ui.press("j")).toBe(true);
  expect(ui.press("j")).toBe(true);
  expect(ui.render("subagents-fleet")[3]).toMatch(/● Fix config {2}worker/u);
  expect(ui.press("k")).toBe(true);
  expect(ui.render("subagents-fleet")[2]).toMatch(/● Find config {2}scout/u);
  expect(ui.press("l")).toBe(true);
  expect(ui.customs).toHaveLength(1);
  fleet.dispose();
});

test("Tab in a subagent's session switches to the next one; back in main, the list is on the last one shown", async () => {
  const { ui, fleet, runs, steered } = setup();
  ui.press(KEY.down);
  ui.press(KEY.enter);
  const view = ui.customs[0]!.component;
  expect(view.current).toBe(runs[0]);
  view.handleInput("\t");
  expect(view.current).toBe(runs[1]);
  // One overlay, not one per session.
  expect(ui.customs).toHaveLength(1);
  for (const ch of "go") view.handleInput(ch);
  view.handleInput(KEY.enter);
  expect(steered).toEqual(["go"]);
  view.handleInput(KEY.escape);
  await Promise.resolve();
  await Promise.resolve();
  expect(ui.customs).toHaveLength(0);
  expect(ui.render("subagents-fleet").join("\n")).toMatch(/● Fix config/u);
  fleet.dispose();
});
