// Actual sibling entry points, loaded only by tests. Runtime source remains independently usable.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchesKey } from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { EDITOR_FACTORY_CHANNEL, EDITOR_MODE, EDITOR_SURFACE, INPUT_CONTEXT } from "../src/editor-contract.ts";
import { FleetView } from "../src/ui/fleet.ts";
import { ConversationViewer } from "../src/ui/viewer.ts";
import subagents from "../src/index.ts";
import { harness } from "./harness.ts";
import { fakeRun, fakeTui, fakeUI, KEY, plain } from "./ui-helpers.ts";

const sibling = (name: string, file = "index.ts") => path.resolve(import.meta.dirname, `../../${name}/src/${file}`);
const keys = { matches: (data: string, id: string) => {
  const key = ({ "tui.editor.deleteToLineStart": "ctrl+u", "tui.editor.deleteCharForward": "ctrl+d", "tui.editor.cursorLineStart": "home", "tui.input.submit": "enter" } as Record<string, string>)[id];
  return !!key && matchesKey(data, key as never);
} };
const editorTheme = { borderColor: (s: string) => s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } };

afterEach(() => vi.unstubAllEnvs());
function bus(h: ReturnType<typeof harness>) {
  const handlers = new Map<string, Array<(data: any) => void>>();
  h.pi.events = { emit: (name: string, data: any) => { for (const fn of handlers.get(name) ?? []) fn(data); }, on: (name: string, fn: (data: any) => void) => { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } };
}

test.each(["ex", "pending", "visual", "insert"])("actual MainEditor releases a selected Fleet row when entering %s", async (state) => {
  const { MainEditor } = await import(sibling("pi-vim"));
  const ui = fakeUI();
  const editor = new MainEditor(ui.tui, editorTheme, keys);
  editor.setClipboardMirrorPolicy("off");
  editor.setText("draft");
  editor.handleInput(KEY.escape);
  editor.handleInput("$");
  ui.tui.focused = editor;
  const fleet = new FleetView({ runs: () => [fakeRun()], enabled: () => true, actions: () => ({}) });
  fleet.setUI(ui); fleet.update();
  expect(editor[EDITOR_SURFACE]).toBe("main");
  expect(editor[INPUT_CONTEXT]()).toBe("editor");
  expect(ui.press("j")).toBe(true);
  editor.handleInput(({ ex: ":", pending: "d", visual: "v", insert: "i" } as Record<string, string>)[state]);
  expect(editor[EDITOR_MODE]().state).toBe(state);
  // Even arrows must reach the editor after a state transition (no virtual list ownership).
  expect(ui.press(KEY.down)).toBe(false);
  for (const key of ["j", "k", "x", "h", "\x15", "\x04"]) expect(ui.press(key)).toBe(false);
  if (state === "insert") {
    editor.handleInput("\x15");
    expect(editor.getText().length).toBeLessThan(5);
  }
  fleet.dispose(); editor.dispose();
});

test("actual MainEditor EOL and insert-selected native edit keys are not stolen", async () => {
  const { MainEditor } = await import(sibling("pi-vim"));
  const ui = fakeUI();
  const editor = new MainEditor(ui.tui, editorTheme, keys);
  editor.setText("draft");
  ui.tui.focused = editor;
  const fleet = new FleetView({ runs: () => [fakeRun()], enabled: () => true, actions: () => ({}) });
  fleet.setUI(ui); fleet.update();
  editor.handleInput("\x1b[D");
  expect(ui.press(KEY.down)).toBe(false);
  editor.handleInput("\x1b[C");
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press("\x15")).toBe(false);
  editor.handleInput("\x15");
  expect(editor.getText()).toBe("");
  editor.setText("abc");
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press("\x04")).toBe(false);
  fleet.dispose(); editor.dispose();
});

test("viewer requests actual pi-vim factory after startup; embedded modes, focus, EX submit and cancel stay local", async () => {
  const { default: vim, EmbeddedEditor } = await import(sibling("pi-vim"));
  const h = harness(); bus(h);
  const cwd = mkdtempSync(path.join(tmpdir(), "subagents-vim-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
  const ui = Object.assign(fakeUI(), { setEditorComponent: () => undefined, getEditorComponent: () => undefined });
  const ctx = h.ctx({ cwd, ui });
  await vim(h.pi);
  const before: any = { version: 1 }; h.pi.events.emit(EDITOR_FACTORY_CHANNEL, before);
  expect(before.factory).toBeUndefined();
  await h.emit("session_start", {}, ctx);
  let embedded: any;
  h.pi.events.on(EDITOR_FACTORY_CHANNEL, (request: any) => {
    const factory = request.factory;
    request.factory = (options: any) => (embedded = factory(options));
  });
  const run = fakeRun({ child: {} as never });
  run.conversation.apply({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n") }] } });
  const steered: string[] = [];
  let closed = 0;
  const viewer = new ConversationViewer(ui.tui, run, plain, () => closed++, { events: h.pi.events, steer: (message) => { steered.push(message); return true; } }, keys);
  viewer.focused = true; viewer.render(120); viewer.handleInput(KEY.enter);
  expect(embedded).toBeInstanceOf(EmbeddedEditor);
  expect(viewer[INPUT_CONTEXT]()).toBe("editor");
  expect(viewer[EDITOR_MODE]()?.state).toBe("insert");
  viewer.focused = false; expect(embedded.focused).toBe(false);
  viewer.focused = true; expect(embedded.focused).toBe(true);
  for (const key of "abc") viewer.handleInput(key);
  viewer.handleInput("\x15"); expect(embedded.getText()).toBe("");
  for (const key of "steer this") viewer.handleInput(key);
  viewer.handleInput(KEY.escape);
  expect(viewer[EDITOR_MODE]()?.state).toBe("normal");
  viewer.render(120);
  viewer.handleInput("\x15");
  expect((viewer as any).follow).toBe(false);
  viewer.handleInput("v"); const scroll = (viewer as any).scroll;
  viewer.handleInput("\x04"); expect((viewer as any).scroll).toBe(scroll);
  // Visual Ctrl+D belongs to the editor (it may delete the selection), not viewport scrolling.
  const editedDraft = embedded.getText();
  viewer.handleInput(KEY.escape);
  viewer.handleInput(":"); viewer.handleInput("w"); viewer.handleInput(KEY.enter);
  expect(steered).toEqual([editedDraft]);
  expect(editedDraft).toBe("steer thi");
  expect(viewer[INPUT_CONTEXT]()).toBe("viewer");
  expect(closed).toBe(0);
  viewer.handleInput(KEY.enter); viewer.handleInput(KEY.escape); viewer.handleInput(KEY.escape);
  expect(viewer[INPUT_CONTEXT]()).toBe("viewer");
  viewer.dispose(); await h.emit("session_shutdown", { reason: "quit" }, ctx);
});

test.each([true, false])("actual pi-bg and subagents negotiate hosts in both startup orders (%s)", async (bgFirst) => {
  const { default: bg } = await import(sibling("pi-bg"));
  const h = harness(); bus(h);
  const cwd = mkdtempSync(path.join(tmpdir(), "subagents-bg-"));
  vi.stubEnv("PI_BG_DIR", cwd); vi.stubEnv("PI_CODING_AGENT_DIR", cwd);
  let subagentShutdown: any[] = [];
  const installSubagents = async () => {
    const before = new Set(h.handlers.get("session_shutdown") ?? []);
    await subagents(h.pi);
    subagentShutdown = (h.handlers.get("session_shutdown") ?? []).filter((fn) => !before.has(fn));
  };
  const offered: any[] = [];
  const hosts: any[] = [];
  h.pi.events.on("activity:section", (data: any) => { offered.push(data.section); });
  h.pi.events.on("activity:host", (data: any) => { hosts.push(data); });
  if (bgFirst) { await bg(h.pi); await installSubagents(); }
  else { await installSubagents(); await bg(h.pi); }
  const ui = fakeUI();
  const ctx = h.ctx({ cwd, ui, isIdle: () => true, hasPendingMessages: () => false });
  await h.emit("session_start", {}, ctx);
  let yes = false;
  h.pi.events.emit("bg:probe", { reply: () => { yes = true; } });
  expect(yes).toBe(true);
  expect(hosts).toContainEqual({ host: "subagents", priority: 20 });
  expect(offered.some((section) => section.id === "bg")).toBe(true);
  // Seed the actual registry with a completed fixture: no subprocess or socket is opened.
  const { registry } = await import(sibling("pi-bg", "registry.ts"));
  const reg = registry();
  const task = { id: "fixture", name: "Fixture", command: "fixture only", cwd, logPath: path.join(cwd, "fixture.log"), kind: "job", origin: "agent", status: "failed", startedAt: Date.now(), endedAt: Date.now(), exitCode: 1, ready: false, keep: false, delivered: true, readyDelivered: true };
  reg.tasks.set(task.id, task);
  reg.emit("change", task);
  expect(ui.render("subagents-fleet").join("\n")).toContain("shells");
  expect(ui.widgets.has("pi-bg-pill")).toBe(false);
  // Fleet selected pill opens pi-bg's actual dialog factory over the same bus/UI.
  expect(ui.press(KEY.down)).toBe(true);
  expect(ui.press(KEY.enter)).toBe(true);
  await Promise.resolve();
  expect(ui.customs).toHaveLength(1);
  expect(ui.customs[0]!.component.render(100).join("\n")).toContain("Fixture");
  ui.customs[0]!.component.handleInput(KEY.escape);
  await Promise.resolve();
  // Only Fleet leaves: the actual bg section gets its pill back and resumes lesser hosting.
  for (const fn of subagentShutdown) await fn({ reason: "quit" }, ctx);
  expect(ui.widgets.has("subagents-fleet")).toBe(false);
  expect(ui.render("pi-bg-pill").join("\n")).toContain("shells");
  reg.tasks.delete(task.id);
  await h.emit("session_shutdown", { reason: "quit" }, ctx);
  expect(ui.inputHandlers.size).toBe(0);
});
