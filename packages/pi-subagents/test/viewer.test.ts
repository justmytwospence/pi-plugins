import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { TuiMainScreen, type Terminal, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, expect, test, vi } from "vitest";
import { InteractiveMode as InteractiveMode14, initTheme as initTheme14 } from "pi-coding-agent-1-4";
import { TuiMainScreen as TuiMainScreen14 } from "pi-tui-1-4";
import { transcriptWriter } from "../src/conversation.ts";
import { recordedRun } from "../src/index.ts";
import type { Run } from "../src/run.ts";
import type { ActivityEntry, ActivitySection } from "../src/activity.ts";
import { INPUT_CONTEXT } from "../src/editor-contract.ts";
import type { FamilyService } from "../src/family-contract.ts";
import { type ViewerUI, type SessionSource, SessionView, openViewer } from "../src/ui/viewer.ts";
import { KEY, fakeRun, fakeTui, fakeUI, plain } from "./ui-helpers.ts";

// Pi's message and tool components draw with Pi's theme.
beforeAll(() => {
  initTheme("dark");
  initTheme14("dark");
  setKeybindings(new KeybindingsManager());
});

const CTRL_C = "\x03";
const SHIFT_TAB = "\x1b[Z";

function liveRun(over: Parameters<typeof fakeRun>[0] = {}) {
  const run = fakeRun({ child: {} as never, state: { turns: 1, startedAt: Date.now() }, ...over });
  const c = run.conversation;
  c.apply({ type: "message_end", message: { role: "user", content: "Find where the config is loaded" } });
  c.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Looking with **rg**." }, { type: "toolCall", id: "t", name: "bash", arguments: { command: "rg loadConfig" } }] } });
  c.apply({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "rg loadConfig" } });
  c.apply({ type: "tool_execution_end", toolCallId: "t", result: { content: [{ type: "text", text: "src/config.ts:8" }] }, isError: false });
  c.apply({ type: "message_end", message: { role: "toolResult", toolCallId: "t", toolName: "bash", content: [{ type: "text", text: "src/config.ts:8" }] } });
  return run;
}

function setup(runs: Run[] = [liveRun()], rows = 40) {
  const tui = fakeTui(rows);
  const calls = { done: 0, steer: [] as Array<[string, string]>, stop: [] as string[], background: [] as string[], switched: [] as string[] };
  const source: SessionSource = {
    runs: () => runs,
    enabled: () => true,
    actions: (run) => ({
      steer: (m) => calls.steer.push([run.id, m]) > 0,
      stop: () => void calls.stop.push(run.id),
      background: () => void calls.background.push(run.id),
      canBackground: () => true,
    }),
    contextWindow: () => 200_000,
    onSwitch: (run) => void calls.switched.push(run.id),
  };
  const v = new SessionView(tui as never, runs[0]!, plain, () => void calls.done++, source.actions(runs[0]!), undefined, source);
  v.focused = true;
  return { v, tui, calls, runs };
}

const text = (lines: string[]) => lines.map((l) => stripVTControlCharacters(l).trimEnd()).join("\n");
const type = (v: SessionView, s: string) => {
  for (const ch of s) v.handleInput(ch);
};

test.each([46, 120, 180])("family-hosted viewer uses allocated height, preserves drafts and publishes focus at width %i", async (width) => {
  const ui = fakeUI(fakeTui(50, width));
  const a = liveRun({ agentId: "a-uuid" });
  const b = liveRun({ agentId: "b-uuid" });
  const focus = vi.fn();
  const overlay = vi.spyOn(ui.tui, "showOverlay");
  let height = 17;
  let view!: SessionView;
  let closed = 0;
  const family = {
    focus,
    view: ({ factory }) => new Promise<void>(resolve => {
      view = factory(ui.tui as never, plain, undefined, () => { closed++; resolve(); }, () => ({ width, height })) as SessionView;
    }),
  } satisfies Partial<FamilyService>;
  const source: SessionSource = { runs: () => [a, b], actions: () => ({ steer: () => true }), family: () => family as unknown as FamilyService };
  const work = openViewer(ui, a, source.actions(a), undefined, source);
  expect(ui.customs).toHaveLength(0);
  view.focused = true;
  type(view, "draft a");
  expect(view.render(width)).toHaveLength(height);
  view.switchTo(b);
  type(view, "draft b");
  view.switchTo(a);
  expect(text(view.render(width))).toContain("draft a");
  height = 8;
  expect(view.render(width)).toHaveLength(height);
  expect(ui.tui.terminal.rows).toBe(50);
  for (const line of view.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  view.switchTo(undefined);
  await work;
  expect(focus.mock.calls.map(call => call[0])).toEqual(["a-uuid", "b-uuid", "a-uuid", undefined]);
  expect(closed).toBe(1);
  expect(overlay).not.toHaveBeenCalled();
  overlay.mockRestore();
});

test("a delayed family factory rechecks auto-view eligibility before creating a view", async () => {
  const ui = fakeUI();
  let factory!: Parameters<FamilyService["view"]>[0]["factory"];
  let reject!: (error: Error) => void;
  const focus = vi.fn();
  const family = { focus, view: (options: Parameters<FamilyService["view"]>[0]) => {
    factory = options.factory;
    return new Promise<void>((_resolve, no) => { reject = no; });
  } } as unknown as FamilyService;
  let eligible = true;
  const work = openViewer(ui, liveRun(), {}, undefined, { runs: () => [], actions: () => ({}), family: () => family }, undefined, () => eligible);
  eligible = false;
  const rejected = expect(work).rejects.toThrow("Viewer opening cancelled");
  try { factory(ui.tui as never, plain, undefined, () => {}, () => ({ width: 100, height: 20 })); }
  catch (error) { reject(error as Error); }
  await rejected;
  expect(focus).not.toHaveBeenCalled();
  expect(ui.customs).toHaveLength(0);
});

test("interaction is reported before navigation, typing and Esc; render and output do not report it", async () => {
  const ui = fakeUI();
  const run = liveRun();
  const inputs: string[] = [];
  let current = "";
  let closed = false;
  const done = openViewer(ui, run, { steer: () => { expect(inputs.at(-1)).toBe(KEY.enter); return true; } }, undefined, undefined, () => {
    expect(closed).toBe(false);
    inputs.push(current);
  });
  void done.then(() => { closed = true; });
  const view = ui.overlays[0]!.component as SessionView;
  view.render(100);
  run.conversation.apply({ type: "message_end", message: { role: "assistant", content: [] } });
  expect(inputs).toEqual([]);
  for (const key of [KEY.up, "a", KEY.enter, KEY.escape]) {
    current = key;
    view.handleInput(key);
    expect(inputs.at(-1)).toBe(key);
  }
  await done;
  expect(inputs).toEqual([KEY.up, "a", KEY.enter, KEY.escape]);
  view.handleInput("stale");
  expect(inputs).toHaveLength(4);
});

test.each([
  { version: "1.2", Mode: InteractiveMode, Screen: TuiMainScreen },
  { version: "1.4", Mode: InteractiveMode14, Screen: TuiMainScreen14 },
].flatMap((pi) => [undefined, false, true].map((nonCapturing) => ({ ...pi, nonCapturing }))))(
  "Pi $version owned overlay closes without disturbing dialog (nonCapturing=$nonCapturing)",
  async ({ Mode, Screen, nonCapturing }) => {
  // Real TUI stack ownership plus native custom-dialog disposal, not input dispatch.
  // The viewer owns a direct handle; only the dialog uses Pi's custom lifecycle.
  const tui = new Screen({ rows: 40, columns: 100, hideCursor() {} } as Terminal);
  // No terminal rendering loop is needed to exercise real overlay ownership/focus.
  tui.requestRender = () => {};
  const editor = { render: () => [], getText: () => "draft", invalidate() {} };
  tui.setFocus(editor);
  const host = { ui: tui, editor };
  const ui: ViewerUI = {
    setWidget: (_key, factory) => { factory?.(tui as never, plain); },
    custom: (factory, options) => (Mode.prototype as any).showExtensionCustom.call(host, factory, options),
  };
  let close!: () => void;
  const viewerDone = openViewer(ui, liveRun(), {}, (fn) => { close = fn; });
  await Promise.resolve();
  const viewer = tui.getFocusedComponent() as SessionView;
  const dispose = vi.spyOn(viewer, "dispose");
  let dialogDone!: () => void;
  const dialog = { render: () => ["user dialog"], invalidate() {}, focused: false };
  const dialogPromise = nonCapturing === undefined ? undefined : ui.custom<void>((_tui, _theme, _keys, done) => {
    dialogDone = () => done(undefined);
    return dialog;
  }, { overlay: true, overlayOptions: { nonCapturing } } as never);
  await Promise.resolve();
  const focus = tui.getFocusedComponent();

  close();
  close(); // A stale automatic cancellation must not pop the dialog either.
  await viewerDone;
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(tui.getFocusedComponent()).toBe(nonCapturing !== false ? editor : focus);
  // Check ownership as well as hasOverlayEntries: a leaked blank placeholder
  // must not hide behind the remaining dialog.
  expect((tui as any).overlayStack.map((entry: any) => entry.component)).toEqual(dialogPromise ? [dialog] : []);
  expect(tui.hasOverlayEntries).toBe(!!dialogPromise);
  if (dialogPromise) {
    expect(dialog.render()).toEqual(["user dialog"]);
    dialogDone();
    await dialogPromise;
  }
  expect(tui.hasOverlayEntries).toBe(false);
  // The dialog's saved focus must no longer point at the disposed viewer.
  expect(tui.getFocusedComponent()).toBe(editor);
  dispose.mockRestore();
});

test("direct session switching and mouse input notify before processing, but same-run switching does not", () => {
  const first = liveRun();
  const second = liveRun();
  const seen: Run[] = [];
  const v = new SessionView(fakeTui() as never, first, plain, () => {}, {}, undefined, undefined, undefined, () => { seen.push(v.current); });
  v.switchTo(first);
  expect(seen).toEqual([]);
  v.switchTo(second);
  expect(seen).toEqual([first]);
  v.handleMouse({ type: "wheel", x: 0, y: 0, wheelDelta: 1 } as never);
  expect(seen).toEqual([first, second]);
  v.switchTo(undefined);
  expect(seen).toEqual([first, second, second]);
  v.dispose();
});

test("a subagent's session draws as Pi draws main: transcript, working row, editor, list, footer", () => {
  const { v, runs } = setup();
  const lines = v.render(100);
  // The whole screen, no box and no banner.
  expect(lines).toHaveLength(40);
  expect(lines.every((l) => visibleWidth(l) <= 100)).toBe(true);
  const out = text(lines);
  expect(out).not.toContain("not your main session");
  expect(out).not.toContain("╭");
  expect(out).not.toContain("[User]");
  // Pi's components: the user message, Markdown, and the bash card with its output.
  expect(out).toMatch(/Find where the config is loaded[^]*Looking with rg\.[^]*\$ rg loadConfig[^]*src\/config\.ts:8/u);
  expect(out).toContain("Working");
  // The editor's rules, then the list (this session marked), then the footer.
  expect(out).toMatch(/─{20}\n.*\n─{20}[^]*○ main\n ◉ Find where the config is loaded  scout/u);
  expect(out).toContain("esc main · tab/shift+tab sessions · ↓ list");
  expect(out).toMatch(/esc main[^\n]*\n─{20}/u);
  expect(out).toContain("claude-haiku-5 • low");
  expect(out).toContain(`/tmp • ${"Find where the config is loaded"}`);
  // The transcript sits at the top; the editor and footer at the bottom.
  expect(text([lines[1]!])).toContain("Find where the config is loaded");
  expect(text(lines.slice(-2))).toContain("claude-haiku-5");
  void runs;
  v.dispose();
});

test("it follows new output until scrolled up, and again from the end", () => {
  const { v, runs } = setup([liveRun()], 20);
  const c = runs[0]!.conversation;
  const say = (text: string) => {
    const message = { role: "assistant", content: [{ type: "text", text }] };
    c.apply({ type: "message_start", message });
    c.apply({ type: "message_end", message });
  };
  say(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n\n"));
  expect(text(v.render(60))).toContain("line 39");
  v.handleInput("\x1b[5~"); // PageUp
  say("line 40");
  let out = text(v.render(60));
  expect(out).not.toContain("line 40");
  expect(out).toContain("↓ Jump to latest message · ctrl+end");
  v.handleInput("\x1b[1;5F"); // Ctrl+End
  out = text(v.render(60));
  expect(out).toContain("line 40");
  v.dispose();
});

test("typing steers; Ctrl+C clears, then twice on an empty editor stops; Esc goes back to main", () => {
  const { v, calls, runs } = setup();
  type(v, "focus on tests");
  v.handleInput(KEY.enter);
  expect(calls.steer).toEqual([[runs[0]!.id, "focus on tests"]]);
  type(v, "draft");
  v.handleInput(CTRL_C);
  expect(text(v.render(100))).not.toContain("draft");
  expect(calls.stop).toEqual([]);
  v.handleInput(CTRL_C);
  expect(text(v.render(100))).toContain("ctrl+c again to stop Find where the config is loaded");
  v.handleInput(CTRL_C);
  expect(calls.stop).toEqual([runs[0]!.id]);
  expect(calls.done).toBe(0);
  v.handleInput(KEY.escape);
  expect(calls.done).toBe(1);
  v.dispose();
});

test("Tab/Shift+Tab and Ctrl+J/Ctrl+K switch sessions through main; drafts stay with their run", () => {
  const second = liveRun({ label: "Second task", state: { startedAt: Date.now() + 1 } });
  const { v, calls, runs } = setup([liveRun(), second]);
  type(v, "half a thought");
  v.handleInput("\t");
  expect(v.current).toBe(second);
  expect(calls.switched).toEqual([second.id]);
  let out = text(v.render(100));
  expect(out).toContain("◉ Second task");
  expect(out).not.toContain("half a thought");
  v.handleInput(SHIFT_TAB);
  expect(v.current).toBe(runs[0]);
  expect(text(v.render(100))).toContain("half a thought");
  // Ctrl+J and Ctrl+K cycle the same way.
  v.handleInput("\n");
  expect(v.current).toBe(second);
  v.handleInput("\x0b");
  expect(v.current).toBe(runs[0]);
  // Past the last run is main: the view closes.
  v.handleInput("\t");
  v.handleInput("\t");
  expect(calls.done).toBe(1);
  void out;
  v.dispose();
});

test("↓ from the editor enters the list: select, switch, background, back", () => {
  const second = liveRun({ label: "Second task", state: { startedAt: Date.now() + 1 } });
  const { v, calls } = setup([liveRun(), second]);
  v.handleInput(KEY.down);
  expect((v as any)[Symbol.for("pi-plugins.input-context.v1")]()).toBe("list");
  expect(text(v.render(100))).toContain("j/k select");
  v.handleInput("j");
  v.handleInput("b");
  expect(calls.background).toEqual([second.id]);
  v.handleInput(KEY.enter);
  expect(v.current).toBe(second);
  // Back in the editor after switching; ↓ and Esc in the list return to it.
  v.handleInput(KEY.down);
  v.handleInput(KEY.escape);
  expect(calls.done).toBe(0);
  type(v, "x");
  v.handleInput(KEY.enter);
  expect(calls.steer).toEqual([[second.id, "x"]]);
  // main in the list goes back.
  v.handleInput(KEY.down);
  v.handleInput("k");
  v.handleInput("k");
  expect(calls.done).toBe(0);
  v.handleInput(KEY.enter);
  expect(calls.done).toBe(1);
  v.dispose();
});

test("a finished run has no editor: it shows how it ended; Esc or q goes back", () => {
  const run = liveRun({ child: undefined, state: { status: "failed", error: "boom", endedAt: Date.now() } });
  const { v, calls } = setup([run]);
  const out = text(v.render(100));
  expect(out).toContain("✗ failed: boom");
  expect(out).not.toContain("Working");
  type(v, "hello");
  v.handleInput(CTRL_C);
  v.handleInput(CTRL_C);
  expect(calls.steer).toEqual([]);
  expect(calls.stop).toEqual([]);
  v.handleInput("q");
  expect(calls.done).toBe(1);
  v.dispose();
});

test("opened mid-tool, the running tool's card gets its result later", () => {
  const run = liveRun();
  const c = run.conversation;
  c.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "u", name: "bash", arguments: { command: "npm test" } }] } });
  c.apply({ type: "tool_execution_start", toolCallId: "u", toolName: "bash", args: { command: "npm test" } });
  c.apply({ type: "tool_execution_update", toolCallId: "u", partialResult: { content: [{ type: "text", text: "running 3 tests" }] } });
  const { v } = setup([run]);
  expect(text(v.render(100))).toContain("running 3 tests");
  c.apply({ type: "tool_execution_end", toolCallId: "u", result: { content: [{ type: "text", text: "3 passed" }] }, isError: false });
  expect(text(v.render(100))).toContain("3 passed");
  v.dispose();
});

test("openViewer shows an overlay that re-renders on new messages and resolves on close", async () => {
  const ui = fakeUI();
  const run = liveRun();
  const closed = openViewer(ui, run);
  expect(ui.overlays[0]?.options).toMatchObject({ anchor: "top-left", width: "100%", maxHeight: "100%" });
  const before = ui.tui.renders;
  run.conversation.apply({ type: "message_start", message: { role: "assistant", content: [] } });
  expect(ui.tui.renders).toBeGreaterThan(before);
  ui.overlays[0]?.component.handleInput(KEY.escape);
  await closed;
  const after = ui.tui.renders;
  run.conversation.apply({ type: "message_end", message: { role: "assistant", content: [] } });
  expect(ui.tui.renders).toBe(after);
});

test("a recorded run opens from its saved conversation, or else its task and output", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-test-"));
  const record = { id: "abc123", agent: "scout", task: "t", model: "m/x", thinking: "low", byJev: { agent: true, model: false, thinking: false }, status: "running" as const, turns: 2, tokens: 1_500, cost: 0.01, seconds: 9, outputPath: path.join(dir, "abc123", "output.md"), async: true };
  mkdirSync(path.dirname(record.outputPath), { recursive: true });
  writeFileSync(record.outputPath, "the answer");
  const fallback = recordedRun(record);
  expect(fallback.conversation.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  // A record still saying running whose run no runtime owns: lost.
  expect(fallback.state).toMatchObject({ status: "lost", turns: 2, endedAt: 9_000 });
  expect(fallback.state.sessionFile).toBeUndefined();
  const withNativeHistory = recordedRun({ ...record, sessionFile: "/missing/native-child.jsonl" });
  expect(withNativeHistory.state.sessionFile).toBe("/missing/native-child.jsonl");
  expect(withNativeHistory.conversation.messages).toEqual(fallback.conversation.messages);
  const save = transcriptWriter(path.join(dir, "abc123", "messages.jsonl"));
  save({ role: "user", content: [{ type: "text", text: "t" }] });
  save({ role: "assistant", content: [{ type: "text", text: "a" }] });
  save({ role: "toolResult", content: [{ type: "text", text: "r" }] });
  expect(recordedRun(record).conversation.messages).toHaveLength(3);
  const restored = recordedRun({ ...record, sessionFile: "/native/child.jsonl" });
  expect(restored.state.sessionFile).toBe("/native/child.jsonl");
  expect(restored.conversation.messages).toHaveLength(3);
  // Not one of this session's live runs, it is still listed while shown.
  const v = new SessionView(fakeTui() as never, restored, plain, () => undefined, {}, undefined, { runs: () => [], actions: () => ({}), enabled: () => true });
  const out = text(v.render(80));
  expect(out).toContain("◉ t");
  expect(out).toContain("? lost");
  v.dispose();
});

test("Enter on the current row restores composer focus and preserves its cursor", () => {
  const { v, calls, runs } = setup();
  type(v, "draft");
  v.handleInput(KEY.down);
  const composer = (v as any).composer;
  const cursor = composer.getCursor();
  expect(composer.focused).toBe(false);
  v.handleInput(KEY.enter);
  expect(v[INPUT_CONTEXT]()).toBe("editor");
  expect(composer.focused).toBe(true);
  expect(composer.getCursor()).toEqual(cursor);
  v.handleInput(KEY.enter);
  expect(calls.steer).toEqual([[runs[0]!.id, "draft"]]);
  expect(calls.done).toBe(0);
  v.dispose();
});

test("list selection follows a stable key through roster insertions and falls back when removed", () => {
  const a = liveRun({ state: { startedAt: 10 } });
  const b = liveRun({ state: { startedAt: 20 } });
  const { v, runs, calls } = setup([a, b]);
  v.handleInput(KEY.down); v.handleInput("j");
  const c = liveRun({ state: { startedAt: 5 } });
  runs.unshift(c);
  v.render(100);
  expect((v as any).listSelectedKey).toBe(`run:${b.id}`);
  v.handleInput(KEY.enter);
  expect(v.current).toBe(b);
  expect(calls.switched).toEqual([b.id]);
  v.dispose();
});

test.each(["removed", "completed", "child-replaced", "same-id-replaced"])("stop confirmation cannot transfer after %s", change => {
  const a = liveRun({ state: { startedAt: 10 } });
  const b = liveRun({ state: { startedAt: 20 } });
  const c = liveRun({ state: { startedAt: 30 } });
  const { v, runs, calls } = setup([a, b, c]);
  v.handleInput(KEY.down); v.handleInput("j"); v.handleInput("x");
  expect(text(v.render(100))).toContain("x again");
  if (change === "removed") runs.splice(1, 1);
  if (change === "completed") b.state.status = "done";
  if (change === "child-replaced") b.child = {} as never;
  if (change === "same-id-replaced") runs[1] = liveRun({ id: b.id, state: { startedAt: 20 } });
  expect(text(v.render(100))).not.toContain("x again");
  v.handleInput("x");
  expect(calls.stop).toEqual([]);
  v.handleInput("x");
  expect(calls.stop).toEqual([change === "removed" || change === "completed" ? c.id : b.id]);
  v.dispose();
});

test.each(["?", KEY.up, KEY.escape, "\t"])("non-confirming list key %j clears stop arming", key => {
  const { v, calls } = setup([liveRun({ state: { startedAt: 10 } }), liveRun({ state: { startedAt: 20 } })]);
  v.handleInput(KEY.down); v.handleInput("x");
  expect(text(v.render(100))).toContain("x again");
  v.handleInput(key);
  expect((v as any).listStopArmed).toBeUndefined();
  expect(calls.stop).toEqual([]);
  v.dispose();
});

test.each([false, true])("row/pill opening stays in the viewer and routes to the section (hosted=%s)", async hosted => {
  const ui = fakeUI();
  const run = liveRun();
  const row: ActivityEntry = { key: "notebook", label: "Notebook", detail: "", status: "running", stats: "", startedAt: 1, stopToken: "kernel-1" };
  const section: ActivitySection = {
    id: "notebooks", title: "Notebooks", entries: () => [row], pill: () => ({ label: "1 notebook", rows: [row] }),
    open: vi.fn(async () => {}), openDialog: vi.fn(async () => {}), stop: vi.fn(), dismiss: vi.fn(),
  };
  let view!: SessionView;
  const family = { focus() {}, view: ({ factory }: Parameters<FamilyService["view"]>[0]) => new Promise<void>(resolve => {
    view = factory(ui.tui as never, plain, new KeybindingsManager(), resolve, () => ({ width: 100, height: 30 })) as SessionView;
  }) } as unknown as FamilyService;
  const source: SessionSource = { runs: () => [run], actions: () => ({ steer: () => true }), enabled: () => true, sections: () => [section], family: () => hosted ? family : undefined };
  let close!: () => void;
  const work = openViewer(ui, run, source.actions(run), fn => { close = fn; }, source);
  if (!hosted) view = ui.overlays[0]!.component;
  view.focused = true;
  view.handleInput(KEY.down); view.handleInput("j");
  view.handleInput(KEY.enter);
  expect(section.open).toHaveBeenCalledWith("notebook", ui);
  expect(view.current).toBe(run);
  expect(view[INPUT_CONTEXT]()).toBe("list");
  view.handleInput("x");
  row.stopToken = "kernel-2";
  view.render(100);
  expect(text(view.render(100))).not.toContain("x again");
  view.handleInput("x"); expect(section.stop).not.toHaveBeenCalled();
  view.handleInput("x"); expect(section.stop).toHaveBeenCalledWith("notebook");
  row.status = "done";
  view.handleInput("x"); expect(section.dismiss).toHaveBeenCalledWith("notebook");
  view.handleInput("j"); view.handleInput(KEY.enter);
  expect(section.openDialog).toHaveBeenCalledWith(ui);
  expect(view.current).toBe(run);
  close(); await work;
});

test.each([false, true])("row open failure is contained without closing the viewer (async=%s)", async asynchronous => {
  const run = liveRun();
  const ui = fakeUI();
  const row: ActivityEntry = { key: "row", label: "Row", detail: "", status: "running", stats: "", startedAt: 1 };
  const open = asynchronous ? async () => { throw new Error("async open"); } : () => { throw new Error("sync open"); };
  const section: ActivitySection = { id: "test", title: "Test", entries: () => [row], pill: () => ({ label: "", rows: [row] }), open };
  let close!: () => void;
  const work = openViewer(ui, run, { steer: () => true }, fn => { close = fn; }, { runs: () => [run], actions: () => ({ steer: () => true }), enabled: () => true, sections: () => [section] });
  const view = ui.overlays[0]!.component as SessionView;
  view.handleInput(KEY.down); view.handleInput("j");
  expect(() => view.handleInput(KEY.enter)).not.toThrow();
  await Promise.resolve(); await Promise.resolve();
  expect(ui.overlays[0]!.component).toBe(view);
  expect(view[INPUT_CONTEXT]()).toBe("list");
  close(); await work;
});
