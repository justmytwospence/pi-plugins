// Actual sibling components, deterministic time and socket fixtures; never connects to Herdr.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChildDetails, ChildrenActivity } from "../src/children-activity.ts";
import { INPUT_CONTEXT, stableKey, stopKey, type ActivitySection } from "../src/activity.ts";
import { Children, type ChildRecord } from "../src/core/children.ts";
import { fakeCall } from "./core/fake.ts";

// Runtime-only sibling imports keep standalone pi-herdr's typecheck independent of sibling deps.
const dialogPath = new URL("../../pi-bg/src/dialog.ts", import.meta.url).pathname;
const fleetPath = new URL("../../pi-subagents/src/ui/fleet.ts", import.meta.url).pathname;
const { TasksDialog, dialogRows } = await import(dialogPath);
const { FleetView, fleetRoster } = await import(fleetPath);
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => `[${t}]` };
const record = (name = "child", awaiting = true): ChildRecord => ({ name, paneId: "w1:p2", where: "tab", cwd: "/repo", task: "Review auth", createdAt: 1_000, awaiting, baseline: { completionSeq: 1 } });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
const drain = () => vi.advanceTimersByTimeAsync(0);

function detailsUI(rows = 30) {
  const overlays: any[] = [];
  let focused: unknown = undefined;
  const tui = { terminal: { rows }, requestRender: vi.fn(), getFocusedComponent: () => focused };
  const ui = {
    custom: (factory: any) => new Promise<void>((resolve) => {
      const done = () => { focused = undefined; component.dispose?.(); resolve(); };
      const component = factory(tui, theme, undefined, done);
      overlays.push(component);
      focused = component;
    }),
  };
  return { tui, ui, overlays, focus: (component: unknown) => { focused = component; } };
}

function childrenFixture() {
  const state = { status: "working", seq: 1, failStop: false };
  const f = fakeCall({
    "agent.get": () => ({ result: { agent: { agent_status: state.status, completion_seq: state.seq, agent_session: { value: "/fixture/session" } } } }),
    "agent.read": () => ({ result: { read: { text: "Working screen" } } }),
    "agent.send_keys": () => state.failStop ? Promise.reject(new Error("fixture stop rejection")) : { result: {} },
  });
  const children = new Children({ call: f.call, selfPane: "w1:p1", agent: { kind: "pi", args: () => [], reply: async () => "Finished reply" }, exec: async () => ({ code: 0, stdout: "", stderr: "" }), persist: () => activity.observe(children.get("child")), deliver: () => undefined, hold: () => undefined, pollMs: 60_000 });
  const changed = vi.fn();
  const activity = new ChildrenActivity(children, { changed });
  children.restore([record()]);
  activity.restored();
  return { state, f, children, activity, changed, get section() { return activity.section; } };
}

test("legacy host calls use subagents identity and explicit host releases do not erase another host", () => {
  const x = childrenFixture();
  x.section.setHosted?.(true);
  x.section.setHosted?.(true, "bg");
  x.section.setHosted?.(false, "subagents");
  expect(x.activity.hosted).toBe(true);
  x.section.setHosted?.(false, "bg");
  expect(x.activity.hosted).toBe(false);
  x.section.setHosted?.(true, "subagents");
  x.section.setHosted?.(false);
  expect(x.activity.hosted).toBe(false);
  x.children.shutdown();
});

test("actual pi-bg /tasks lists children, opens read-only details, awaits interrupt and only dismisses ended rows", async () => {
  const x = childrenFixture();
  const d = detailsUI();
  const shell: ActivitySection = { id: "bg", title: "shells", noun: "shell", entries: () => [{ key: "shell", label: "shell", detail: "build", status: "running", stats: "0:01", startedAt: 2_000 }], open: async () => undefined };
  let selected: any;
  const dialog = new TasksDialog(d.tui, theme, { sections: () => [shell, x.section], ownId: "bg", canFollow: true }, (result: any) => { selected = result; dialog.dispose(); });
  expect(dialogRows([shell, x.section], 1_000).map((r: any) => [r.section.noun, r.entry.key])).toEqual([["child", "child"], ["shell", "shell"]]);
  expect(dialog.render(100).join("\n")).toContain("child child");
  // Rerun and follow belong to the shell source only, never the child pane.
  dialog.handleInput("r"); dialog.handleInput("f");
  expect(selected).toBeUndefined();
  dialog.handleInput("x");
  expect(x.f.of("agent.send_keys")).toHaveLength(0);
  dialog.handleInput("x");
  await drain();
  expect(x.f.of("agent.send_keys").map((c) => c.params)).toEqual([{ target: "w1:p2", keys: ["esc"] }]);
  expect(x.children.get("child").awaiting).toBe(true);
  dialog.handleInput("\r");
  expect(selected).toMatchObject({ kind: "open", section: x.section, key: "child" });
  const opened = selected.section.open(selected.key, d.ui);
  await drain();
  expect(d.overlays[0].render(100).join("\n")).toContain("Working screen");
  expect(d.overlays[0][INPUT_CONTEXT]()).toBe("viewer");
  d.overlays[0].handleInput("\x1b");
  await opened;
  x.state.status = "idle"; x.state.seq = 2;
  await x.children.tick();
  const ended = new TasksDialog(d.tui, theme, { sections: () => [x.section], ownId: "bg", canFollow: true }, () => undefined);
  expect(ended.render(100).join("\n")).toContain("x dismiss");
  ended.handleInput("x");
  expect(x.section.entries(1_000)).toEqual([]);
  expect(x.f.of("agent.send_keys")).toHaveLength(1);
  expect(x.f.log.filter((c) => /focus|close|split|create/u.test(c.method))).toEqual([]);
  ended.dispose(); x.children.shutdown();
});

test("actual pi-bg xx confirmation follows an awaited turn, not its stable child row, across a new send", async () => {
  const x = childrenFixture(); const d = detailsUI();
  const dialog = new TasksDialog(d.tui, theme, { sections: () => [x.section], ownId: "bg", canFollow: false }, () => undefined);
  const before = x.section.entries(1_000)[0];
  expect(before.stopToken).toBeTruthy();
  expect(x.section.entries(1_000)[0].stopToken).toBe(before.stopToken);
  dialog.handleInput("x");
  expect(dialog.render(100).join("\n")).toContain("x again to stop child");
  x.changed.mockClear();
  await vi.advanceTimersByTimeAsync(2_000);
  await x.children.send("child", "new task in the same pane");
  const after = x.section.entries(3_000)[0];
  expect(stableKey(x.section.id, after.key)).toBe(stableKey(x.section.id, before.key));
  expect(stopKey(x.section.id, after)).not.toBe(stopKey(x.section.id, before));
  expect(after.stopToken).toBe(x.children.get("child").turnId);
  expect(after.stats).toBe("turn · 0:00");
  expect(x.changed).toHaveBeenCalled();
  // This second x only arms the replacement turn; a third is required to interrupt it.
  dialog.handleInput("x"); await drain();
  expect(x.f.of("agent.send_keys")).toHaveLength(0);
  expect(dialog.render(100).join("\n")).toContain("x again to stop child");
  dialog.handleInput("x"); await drain();
  expect(x.f.of("agent.send_keys")).toHaveLength(1);
  const token = after.stopToken;
  await x.children.send("child", "third task");
  expect(x.section.entries(3_000)[0].stopToken).not.toBe(token);
  x.state.status = "idle"; x.state.seq = 2; await x.children.tick();
  expect(x.section.entries(3_000)[0].stopToken).toBeUndefined();
  expect(x.f.of("pane.close")).toHaveLength(0);
  dialog.dispose(); x.children.shutdown();
});

test("actual pi-bg xx also disarms when a legacy restored child is replaced under the same row key", async () => {
  const x = childrenFixture(); const d = detailsUI();
  const oldSection = x.section;
  const dialog = new TasksDialog(d.tui, theme, { sections: () => [x.section], ownId: "bg", canFollow: false }, () => undefined);
  const before = oldSection.entries(1_000)[0];
  dialog.handleInput("x");
  x.children.shutdown();
  x.children.restore([{ ...record(), paneId: "w9:p9" }]);
  x.activity.restored();
  const after = x.section.entries(1_000)[0];
  expect(x.section).not.toBe(oldSection);
  expect(oldSection.entries(1_000)).toEqual([]);
  expect(oldSection.canStop?.("child")).toBe(false);
  await oldSection.stop?.("child");
  await oldSection.open("child", d.ui);
  await oldSection.openDialog?.(d.ui);
  expect(d.overlays).toEqual([]);
  expect(after.key).toBe(before.key);
  expect(after.stopToken).not.toBe(before.stopToken);
  dialog.handleInput("x"); await drain();
  expect(x.f.of("agent.send_keys")).toHaveLength(0);
  dialog.handleInput("x"); await drain();
  expect(x.f.of("agent.send_keys")[0].params.target).toBe("w9:p9");
  dialog.dispose(); x.children.shutdown();
});

test("actual pi-bg input callback catches an asynchronous child interrupt or dismiss rejection", async () => {
  const x = childrenFixture();
  x.state.failStop = true;
  const d = detailsUI();
  const dialog = new TasksDialog(d.tui, theme, { sections: () => [x.section], ownId: "bg", canFollow: false }, () => undefined);
  dialog.handleInput("x"); dialog.handleInput("x");
  await drain(); // Vitest would fail on any unhandled rejection here.
  expect(x.f.of("agent.send_keys")).toHaveLength(1);
  // Direct callers still get the rejection and can report the error themselves.
  await expect(x.section.stop?.("child")).rejects.toThrow("fixture stop rejection");
  x.state.status = "idle"; x.state.seq = 2;
  await x.children.tick();
  const failingDismiss: ActivitySection = { ...x.section, dismiss: () => Promise.reject(new Error("fixture dismiss rejection")) };
  const ended = new TasksDialog(d.tui, theme, { sections: () => [failingDismiss], ownId: "bg", canFollow: false }, () => undefined);
  ended.handleInput("x");
  await drain();
  expect(ended.render(100).join("\n")).toContain("child");
  ended.dispose(); dialog.dispose(); x.children.shutdown();
});

test("actual pi-subagents FleetView opens a child pill without focusing its pane and yields to viewers and filters", async () => {
  const x = childrenFixture();
  const d = detailsUI();
  let widget: any;
  let input: any;
  const ui = { ...d.ui, theme, getEditorText: () => "", onTerminalInput: (fn: any) => { input = fn; return () => { input = undefined; }; }, setWidget: (_key: string, factory: any) => { widget = factory?.(d.tui, theme); } };
  const fleet = new FleetView({ runs: () => [], enabled: () => true, actions: () => ({}), sections: () => [x.section] });
  fleet.setUI(ui); fleet.update();
  expect(fleetRoster([], 1_000, undefined, [x.section])).toMatchObject([{ kind: "pill", pill: { label: "1 child" } }]);
  expect(widget.render(100).join("\n")).toContain("1 child");
  expect(input("\x1b[B")).toEqual({ consume: true });
  expect(input("\r")).toEqual({ consume: true });
  await drain();
  expect(d.overlays).toHaveLength(1);
  expect(d.overlays[0].render(100).join("\n")).toContain("read-only");
  expect(input("\x04")).toBeUndefined(); // The detail viewer owns Ctrl-D.
  expect(input("x")).toBeUndefined();
  d.overlays[0].handleInput("\x1b");
  await drain();
  d.focus({ [INPUT_CONTEXT]: () => "filter" });
  expect(input("\x1b[B")).toBeUndefined();
  expect(input("\x15")).toBeUndefined(); // Native delete-to-line-start.
  expect(input("\x04")).toBeUndefined(); // Native delete-forward.
  expect(x.f.log.filter((c) => /focus|close|send_keys/u.test(c.method))).toEqual([]);
  fleet.dispose(); x.children.shutdown();
});

test.each([30, 14, 8])("child details use half the rendered viewport at %i rows, full Page keys, bounded scrolling and no pane mutations", async (rows) => {
  const d = detailsUI(rows);
  const component = new ChildDetails(d.tui, theme, { record: () => record(), read: async () => Array.from({ length: 100 }, (_, n) => `line-${n}`).join("\n") }, vi.fn());
  await drain();
  expect(component.render(80)).toHaveLength(rows);
  const half = Math.max(1, Math.floor((rows - 7) / 2));
  component.handleInput("\x04"); component.render(80);
  expect((component as any).scroll).toBe(half);
  component.handleInput("\x15"); component.render(80);
  expect((component as any).scroll).toBe(0);
  component.handleInput("\x1b[6~"); component.render(80);
  expect((component as any).scroll).toBe(rows - 7);
  component.handleInput("\x1b[F"); component.render(80);
  const bottom = (component as any).scroll;
  for (let n = 0; n < 10; n++) component.handleInput("\x04");
  component.handleInput("\x15"); component.render(80);
  expect((component as any).scroll).toBe(bottom - half);
  component.dispose();
});

test("read-only details discard late reads after close and out-of-order rereads", async () => {
  const d = detailsUI();
  const reads: Array<(value: string) => void> = [];
  const done = vi.fn();
  const component = new ChildDetails(d.tui, theme, { record: () => record(), read: () => new Promise<string>((resolve) => reads.push(resolve)) }, done);
  component.handleInput("r");
  reads[1]("newer screen"); await drain();
  reads[0]("older screen"); await drain();
  expect(component.render(100).join("\n")).toContain("newer screen");
  expect(component.render(100).join("\n")).not.toContain("older screen");
  component.handleInput("r");
  component.handleInput("\x1b");
  d.tui.requestRender.mockClear();
  reads[2]("late screen"); await drain();
  expect(done).toHaveBeenCalledTimes(1);
  expect(d.tui.requestRender).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("a read-only child detail never retargets a same-name record on another branch", async () => {
  let current = true;
  const rec = record();
  const read = vi.fn(async () => "screen");
  const records = new Map([[rec.name, rec]]);
  const activity = new ChildrenActivity({ records, read, interrupt: vi.fn() }, { changed: vi.fn(), isCurrent: () => current });
  const d = detailsUI();
  const opened = activity.section.open("child", d.ui);
  await drain();
  records.set("child", { ...rec, paneId: "w9:p9" });
  d.overlays[0].handleInput("r");
  await drain();
  expect(read).toHaveBeenCalledTimes(1);
  expect(d.overlays[0].render(100).join("\n")).toContain("no longer known");
  current = false;
  expect(activity.section.canStop?.("child")).toBe(false);
  expect(activity.section.entries(1_000)).toEqual([]);
  await activity.section.stop?.("child");
  d.overlays[0].handleInput("\x1b");
  await opened;
  expect(vi.getTimerCount()).toBe(0);
});

test.each(["restore", "shutdown/restart"])("retained sections and open details stay generation-scoped after %s, even when the record object is reused", async (transition) => {
  const rec = record();
  const records = new Map([[rec.name, rec]]);
  const read = vi.fn(async () => "original screen");
  const interrupt = vi.fn(async () => "interrupted");
  const changed = vi.fn();
  const activity = new ChildrenActivity({ records, read, interrupt }, { changed });
  activity.restored();
  const old = activity.section;
  const d = detailsUI();
  const opened = old.open("child", d.ui);
  await drain();
  old.setHosted?.(true, "bg");
  if (transition === "shutdown/restart") {
    activity.dispose();
    expect(activity.available).toBe(false);
    expect(old.entries(1_000)).toEqual([]);
    expect(activity.hosted).toBe(false);
  }
  // Keep the very same record: a details view must be scoped to generation, not just identity.
  activity.restored();
  const fresh = activity.section;
  expect(fresh).not.toBe(old);
  expect(activity.available).toBe(true);
  expect(activity.hosted).toBe(false);
  old.setHosted?.(true, "bg");
  expect(activity.hosted).toBe(false);
  fresh.setHosted?.(true, "bg");
  old.setHosted?.(false, "bg");
  expect(activity.hosted).toBe(true);
  expect(old.entries(1_000)).toEqual([]);
  expect(old.pill?.(1_000)).toBeUndefined();
  expect(old.canStop?.("child")).toBe(false);
  await old.stop?.("child");
  await old.open("child", d.ui);
  await old.openDialog?.(d.ui);
  expect(d.overlays).toHaveLength(1);
  expect(interrupt).not.toHaveBeenCalled();
  d.overlays[0].handleInput("r");
  await drain();
  expect(read).toHaveBeenCalledTimes(1);
  expect(d.overlays[0].render(100).join("\n")).toContain("no longer known");
  expect(fresh.canStop?.("child")).toBe(true);
  await fresh.stop?.("child");
  expect(interrupt).toHaveBeenCalledExactlyOnceWith("child");
  rec.awaiting = false;
  changed.mockClear();
  await old.dismiss?.("child");
  expect(changed).not.toHaveBeenCalled();
  expect(fresh.entries(1_000)).toHaveLength(1);
  await fresh.dismiss?.("child");
  expect(fresh.entries(1_000)).toEqual([]);
  d.overlays[0].handleInput("\x1b");
  await opened;
  activity.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
