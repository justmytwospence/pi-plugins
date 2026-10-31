import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import { type ActivityEntry, type ActivitySection, captureMainEditor, EDITOR_MODE, EDITOR_SURFACE, INPUT_CONTEXT, leavesPromptDown, mainEditorFocused, stableKey } from "../src/activity.ts";
import { TasksDialog } from "../src/dialog.ts";
import { LogViewer } from "../src/viewer.ts";
import { PillView } from "../src/pill.ts";
import type { Task } from "../src/registry.ts";
import { fakeCtx, fakePi } from "./fake.ts";

const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
const tui = { requestRender: () => {}, terminal: { rows: 27 } };
const nativeEditor = () => new CustomEditor(tui as any, { borderColor: (s: string) => s } as any, { matches: () => false } as any);
const entry = (key: string, startedAt: number): ActivityEntry => ({ key, startedAt, label: key, detail: "", stats: "", status: "running" });
const source = (id: string, entries: () => ActivityEntry[], stop?: ActivitySection["stop"]): ActivitySection => ({ id, title: id, entries, open: async () => {}, ...(stop ? { stop } : {}) });
const options = (sections: ActivitySection[]) => ({ sections: () => sections, ownId: "bg", canFollow: false });


describe("positive main-editor ownership", () => {
  const methods = { getText: () => "", setText: (_text: string) => {} };
  const native = { ...methods, onExtensionShortcut: undefined };
  const cases: Array<[string, unknown, boolean, boolean]> = [
    ["null", null, false, false],
    ["unknown", undefined, false, false],
    ["primitive", "editor", false, false],
    ["empty object", {}, false, false],
    ["editor shape only", { ...methods }, false, false],
    ["editor context only", { [INPUT_CONTEXT]: () => "editor" }, false, false],
    ["unmarked editor wrapper", { ...methods, [INPUT_CONTEXT]: () => "editor" }, false, false],
    ["native declaration without a handler", native, true, false],
    ["native shortcut handler", { ...methods, onExtensionShortcut: () => false }, true, false],
    ["inherited native declaration", Object.assign(Object.create({ onExtensionShortcut: undefined }), methods), true, false],
    ["explicit main", { ...methods, [EDITOR_SURFACE]: "main" }, true, true],
    ["explicit main editor", { ...methods, [EDITOR_SURFACE]: "main", [INPUT_CONTEXT]: () => "editor" }, true, true],
    ["explicit embedded", { ...native, [EDITOR_SURFACE]: "embedded" }, false, false],
    ["embedded wrapper", { ...methods, [EDITOR_SURFACE]: "embedded", [INPUT_CONTEXT]: () => "editor" }, false, false],
    ["main marker without methods", { [EDITOR_SURFACE]: "main" }, false, false],
    ["main without getText", { setText: methods.setText, [EDITOR_SURFACE]: "main" }, false, false],
    ["main without setText", { getText: methods.getText, [EDITOR_SURFACE]: "main" }, false, false],
    ["native without getText", { setText: methods.setText, onExtensionShortcut: undefined }, false, false],
    ["native without setText", { getText: methods.getText, onExtensionShortcut: undefined }, false, false],
    ["foreign explicit context", { ...native, [EDITOR_SURFACE]: "main", [INPUT_CONTEXT]: "other" }, false, false],
    ["unreadable context", { ...native, [INPUT_CONTEXT]: () => { throw new Error("unavailable"); } }, false, false],
    ["foreign explicit surface", { ...native, [EDITOR_SURFACE]: "other" }, false, false],
    ["unreadable surface", { ...native, get [EDITOR_SURFACE]() { throw new Error("unavailable"); } }, false, false],
    ...(["filter", "list", "viewer"] as const).map((context): [string, unknown, boolean, boolean] =>
      [context, { ...native, [EDITOR_SURFACE]: "main", [INPUT_CONTEXT]: () => context }, false, false]),
  ];

  it.each(cases)("%s requires positive identity and editor methods", (_name, focused, captures, explicit) => {
    const main = captureMainEditor(focused);
    expect(main).toBe(captures ? focused : undefined);
    expect(mainEditorFocused(focused)).toBe(explicit);
    expect(mainEditorFocused(focused, main)).toBe(captures);
  });

  it("matches only the captured instance and rechecks its ownership and methods", () => {
    const focused = { ...native };
    const main = captureMainEditor(focused);
    expect(mainEditorFocused(focused, main)).toBe(true);
    expect(mainEditorFocused({ ...native }, main)).toBe(false);
    expect(mainEditorFocused({ ...methods, [INPUT_CONTEXT]: () => "editor" }, main)).toBe(false);
    Object.assign(focused, { [EDITOR_SURFACE]: "embedded" });
    expect(mainEditorFocused(focused, main)).toBe(false);
    Object.assign(focused, { [EDITOR_SURFACE]: "main", [INPUT_CONTEXT]: () => "filter" });
    expect(mainEditorFocused(focused, main)).toBe(false);
    Object.assign(focused, { [INPUT_CONTEXT]: () => "editor", getText: undefined });
    expect(mainEditorFocused(focused, main)).toBe(false);
  });

  it("captures a real native CustomEditor even before its shortcut callback is assigned", () => {
    const editor = new CustomEditor(
      { requestRender: () => {} } as any,
      { borderColor: (s: string) => s } as any,
      { matches: () => false } as any,
    );
    expect("onExtensionShortcut" in editor).toBe(true);
    expect(editor.onExtensionShortcut).toBeUndefined();
    expect(captureMainEditor(editor)).toBe(editor);
    expect(mainEditorFocused(editor)).toBe(false);
    expect(mainEditorFocused(editor, captureMainEditor(editor))).toBe(true);
  });

  it.each([undefined, null, {}, { getLines: () => [""], getCursor: () => ({ line: 0, col: 0 }) }])(
    "never leaves a prompt whose text is unavailable: %s",
    (focused) => {
      expect(leavesPromptDown(focused, "\x1b[B", true, false)).toBe(false);
      expect(leavesPromptDown(focused, "j", false, true)).toBe(false);
    },
  );

  it("keeps cursor, history, autocomplete and unfinished modal input in the editor", () => {
    const editor = { ...methods, getText: () => "draft", getCursor: () => ({ line: 0, col: 5 }) };
    expect(leavesPromptDown(editor, "\x1b[B", true, false)).toBe(true);
    expect(leavesPromptDown({ ...editor, getCursor: () => ({ line: 0, col: 2 }) }, "\x1b[B", true, false)).toBe(false);
    expect(leavesPromptDown({ ...editor, historyIndex: 0 }, "\x1b[B", true, false)).toBe(false);
    expect(leavesPromptDown({ ...editor, isShowingAutocomplete: () => true }, "\x1b[B", true, false)).toBe(false);
    for (const state of ["ex", "pending", "visual"]) {
      expect(leavesPromptDown({ ...editor, [EDITOR_MODE]: () => ({ state }) }, "\x1b[B", true, false)).toBe(false);
    }
  });
});


describe("independent Pill prompt ownership", () => {
  it("captures before work exists, removes the probe, and retains identity across hidden widgets", () => {
    const c = fakeCtx("/w");
    const setWidget = vi.spyOn(c.ctx.ui, "setWidget");
    let visible = false;
    const pill = new PillView({ pill: () => visible ? { label: "one task" } : undefined, open: vi.fn() }, "pi-bg-pill");
    try {
      pill.setUI(c.ctx.ui as any);
      expect(setWidget.mock.calls.map(([key, content]) => [key, typeof content])).toEqual([
        ["pi-bg-pill-probe", "function"], ["pi-bg-pill-probe", "undefined"],
      ]);
      expect(c.widgets.size).toBe(0);
      pill.update();
      expect(pill.tab()).toBe(false);
      // A later visible widget is constructed while a native dialog owns the keyboard.
      const dialog = new Editor(tui as any, { borderColor: (s: string) => s } as any);
      for (let i = 0; i < 2; i++) {
        c.state.focused = dialog;
        visible = true;
        pill.update();
        expect(c.widgetLines()).toEqual([" ○ one task"]);
        expect(c.press("\x1b[B")).toBe(false);
        expect(pill.tab()).toBe(false);
        c.state.focused = c.main;
        expect(c.press("\x1b[B")).toBe(true);
        visible = false;
        pill.update();
        expect(pill.isSelected).toBe(false);
      }
      expect(setWidget.mock.calls.filter(([key, content]) => key.endsWith("-probe") && content)).toHaveLength(1);
    } finally { pill.dispose(); }
  });

  it.each<[string, unknown]>([
    ["unknown", undefined],
    ["unmarked field wrapper", { [INPUT_CONTEXT]: () => "editor", getText: () => "", setText: () => {} }],
    ["native dialog editor", new Editor(tui as any, { borderColor: (s: string) => s } as any)],
    ["embedded surface", { [INPUT_CONTEXT]: () => "editor", [EDITOR_SURFACE]: "embedded", getText: () => "", setText: () => {}, onExtensionShortcut: undefined }],
    ["different native editor", nativeEditor()],
  ])("yields Down/Enter/Tab to %s after virtual selection", (_name, focused) => {
    const c = fakeCtx("/w");
    const open = vi.fn();
    const pill = new PillView({ pill: () => ({ label: "work" }), open }, "pi-bg-pill");
    try {
      pill.setUI(c.ctx.ui as any); pill.update();
      for (const key of ["\x1b[B", "\r", "\t"]) {
        c.state.focused = c.main;
        expect(c.press("\x1b[B")).toBe(true);
        c.state.focused = focused;
        pill.setUI(c.ctx.ui as any); // A singleton UI is not a new binding.
        pill.update(); c.widgetLines();
        expect(key === "\t" ? pill.tab() : c.press(key)).toBe(false);
        expect(pill.isSelected).toBe(false);
      }
      expect(open).not.toHaveBeenCalled();
      c.state.focused = c.main;
      expect(c.press("\x1b[B")).toBe(true);
      expect(c.press("\r")).toBe(true);
      expect(open).toHaveBeenCalledOnce();
    } finally { pill.dispose(); }
  });

  it("retains native main when Fleet returns the same UI during a dialog, without adopting the dialog", () => {
    const c = fakeCtx("/w", nativeEditor());
    const pill = new PillView({ pill: () => ({ label: "work" }), open: vi.fn() }, "pi-bg-pill");
    try {
      pill.setUI(c.ctx.ui as any); pill.update();
      expect(c.press("\x1b[B")).toBe(true);
      // This is how pi-bg's setHosted toggle detaches and reattaches its independent pill.
      pill.setUI(undefined);
      expect(c.widgets.size).toBe(0);
      expect(c.press("\x1b[B")).toBe(false);
      // Even a different component with the native declaration must not replace the cached owner.
      c.state.focused = { [INPUT_CONTEXT]: () => "editor", getText: () => "", setText: () => {}, onExtensionShortcut: undefined };
      pill.setUI(c.ctx.ui as any); pill.update();
      expect(pill.tab()).toBe(false);
      expect(c.press("\x1b[B")).toBe(false);
      c.state.focused = c.main;
      pill.setUI(c.ctx.ui as any); pill.update(); c.widgetLines();
      // Restoration needs no rebind: this is still the main captured before Fleet took hosting.
      expect(c.press("\x1b[B")).toBe(true);
      expect(c.press("\r")).toBe(true);
    } finally { pill.dispose(); }
  });

  it("ignores removed probes and stale factories/listeners when the UI singleton is rebound", () => {
    const c = fakeCtx("/w");
    const widgets = vi.spyOn(c.ctx.ui, "setWidget");
    const inputs = vi.spyOn(c.ctx.ui, "onTerminalInput");
    const pill = new PillView({ pill: () => ({ label: "work" }), open: vi.fn() }, "pi-bg-pill");
    try {
      pill.setUI(c.ctx.ui as any); pill.update();
      const oldProbe = widgets.mock.calls.find(([key]) => key.endsWith("-probe"))![1];
      const oldFactory = c.widgets.get("pi-bg-pill");
      const oldInput = inputs.mock.calls[0]![0];
      const foreign = nativeEditor();
      // Even before disposal a probe already removed in finally cannot change ownership.
      oldProbe({ ...c.tui, getFocusedComponent: () => foreign }, theme);
      expect(c.press("\x1b[B")).toBe(true);
      pill.dispose();
      pill.setUI(c.ctx.ui as any); pill.update();
      oldProbe({ ...c.tui, getFocusedComponent: () => foreign }, theme);
      expect(oldFactory({ ...c.tui, getFocusedComponent: () => foreign }, theme).render(80)).toEqual([]);
      expect(oldInput("\x1b[B")).toBeUndefined();
      c.state.focused = foreign;
      expect(c.press("\x1b[B")).toBe(false);
      c.state.focused = c.main;
      expect(c.press("\x1b[B")).toBe(true);
      // A new session has a different UI identity and independently captures its own native main.
      const next = fakeCtx("/next", nativeEditor());
      pill.setUI(next.ctx.ui as any); pill.update();
      next.state.focused = c.main;
      expect(next.press("\x1b[B")).toBe(false);
      next.state.focused = next.main;
      expect(next.press("\x1b[B")).toBe(true);
    } finally { pill.dispose(); }
  });

  it("removes its temporary probe even if focus capture throws", () => {
    const c = fakeCtx("/w");
    vi.spyOn(c.tui, "getFocusedComponent").mockImplementation(() => { throw new Error("unavailable focus"); });
    const pill = new PillView({ pill: () => ({ label: "work" }), open: vi.fn() }, "pi-bg-pill");
    try {
      expect(() => pill.setUI(c.ctx.ui as any)).toThrow("unavailable focus");
      expect(c.widgets.size).toBe(0);
      expect(c.press("\x1b[B")).toBe(false);
    } finally { pill.dispose(); }
  });
});

describe("activity contract and dialog", () => {
  it("keeps all four suite-resident package-local protocol copies byte-identical", () => {
    const original = fs.readFileSync(new URL("../src/activity.ts", import.meta.url), "utf8");
    for (const name of ["pi-subagents", "pi-herdr", "pi-plan-mode"]) {
      expect(fs.readFileSync(new URL(`../../${name}/src/activity.ts`, import.meta.url), "utf8")).toBe(original);
    }
  });

  it("selects and arms composite identities, never another source's equal key", () => {
    const stopA = vi.fn();
    const stopB = vi.fn();
    const a = entry("same", 1);
    const b = entry("same", 2);
    const sections = [source("a", () => [a], stopA), source("b", () => [b], stopB)];
    const dialog = new TasksDialog(tui as any, theme, { ...options(sections), initialKey: stableKey("b", "same") }, () => {});
    try {
      dialog.handleInput("x");
      b.startedAt = 0; // Reorder beneath an armed selection.
      dialog.handleInput("x");
      expect(stopA).not.toHaveBeenCalled();
      expect(stopB).toHaveBeenCalledExactlyOnceWith("same");
    } finally { dialog.dispose(); }
  });

  it("clears arming when the selected work disappears or becomes uninterruptible", () => {
    const stop = vi.fn();
    let entries = [entry("first", 1), entry("second", 2)];
    let canStop = true;
    const s = { ...source("s", () => entries, stop), canStop: () => canStop };
    const dialog = new TasksDialog(tui as any, theme, options([s]), () => {});
    try {
      dialog.handleInput("x");
      entries = [entries[1]!];
      dialog.handleInput("x");
      expect(stop).not.toHaveBeenCalled();
      canStop = false;
      dialog.render(100);
      dialog.handleInput("x");
      canStop = true;
      dialog.handleInput("x");
      expect(stop).not.toHaveBeenCalled();
      dialog.handleInput("x");
      expect(stop).toHaveBeenCalledExactlyOnceWith("second");
    } finally { dialog.dispose(); }
  });

  it("invalidates stop confirmation when a stable row's operation target changes", () => {
    const row = { ...entry("notebook", 1), stopToken: "session-a" };
    const stop = vi.fn();
    const dialog = new TasksDialog(tui as any, theme, options([source("s", () => [row], stop)]), () => {});
    try {
      dialog.handleInput("x");
      row.stopToken = "session-b";
      dialog.handleInput("x");
      expect(stop).not.toHaveBeenCalled();
      dialog.handleInput("x");
      expect(stop).toHaveBeenCalledExactlyOnceWith("notebook");
    } finally { dialog.dispose(); }
  });

  it("feature-tests optional actions and contains rejected asynchronous stops", async () => {
    const s = source("read-only", () => [entry("one", 1)]);
    const dialog = new TasksDialog(tui as any, theme, options([s]), () => {});
    try {
      expect(dialog.render(120).join("\n")).not.toContain("x stop");
      dialog.handleInput("x");
      const stop = vi.fn(async () => { throw new Error("stale source"); });
      s.stop = stop;
      dialog.handleInput("x");
      dialog.handleInput("x");
      await Promise.resolve();
      expect(stop).toHaveBeenCalledOnce();
    } finally { dialog.dispose(); }
  });

  it("targets the selected notebook-style contract key, not the same filename on another server", async () => {
    const firstKey = stableKey("http://fixture.invalid", "/w/nb.py");
    const otherKey = stableKey("http://other.invalid", "/w/nb.py");
    const interrupt = vi.fn(async (_key: string) => {});
    const open = vi.fn(async (_key: string, _ctx: unknown) => {});
    const section: ActivitySection = {
      id: "marimo", title: "notebooks",
      entries: () => [firstKey, otherKey].map((key) => ({ ...entry(key, 100), label: "nb.py" })),
      stop: interrupt, open,
    };
    let result: any;
    const dialog = new TasksDialog(tui as any, theme, { ...options([section]), initialKey: stableKey("marimo", otherKey) }, (picked) => { result = picked; });
    try {
      dialog.handleInput("x");
      dialog.handleInput("x");
      await Promise.resolve();
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(otherKey);
      dialog.handleInput("\r");
      expect(result.section).toBe(section);
      await result.section.open(result.key, {});
      expect(open).toHaveBeenCalledExactlyOnceWith(otherKey, {});
    } finally { dialog.dispose(); }
  });
});

it("/stop is shell-only, and shutdown cannot reoffer a stale activity source", async () => {
  const { default: piBg } = await import("../src/index.ts");
  const f = fakePi();
  const c = fakeCtx("/fixture");
  piBg(f.pi as any);
  for (const h of f.handlers.get("session_start") ?? []) await h({ reason: "reload" }, c.ctx);
  const stop = vi.fn();
  f.pi.events.emit("activity:section", { section: source("not-shell", () => [entry("other", 1)], stop) });
  await f.commands.get("stop").handler("", c.ctx);
  expect(stop).not.toHaveBeenCalled();
  // A surviving host responds synchronously when our source leaves.
  f.pi.events.on("activity:gone", () => f.pi.events.emit("activity:host", { host: "subagents", priority: 20 }));
  const offers = () => f.emitted.filter((e) => e.channel === "activity:section" && e.data.section.id === "bg").length;
  const before = offers();
  for (const h of f.handlers.get("session_shutdown") ?? []) await h({ reason: "reload" }, c.ctx);
  expect(offers()).toBe(before);
  f.pi.events.emit("activity:host", {});
  expect(offers()).toBe(before);
});

it("scrolls shell logs a half page with Ctrl-U/D and a full page with Page keys", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-view-"));
  const logPath = path.join(dir, "log");
  fs.writeFileSync(logPath, Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n") + "\n");
  const task = { id: "one", name: "one", kind: "job", command: "true", cwd: dir, logPath, status: "done", startedAt: 0, endedAt: 1, exitCode: 0 } as Task;
  const view = new LogViewer(tui as any, theme, task, undefined, () => {});
  try {
    view.handleInput("g");
    view.handleInput("\x04");
    expect(view.render(100)[4]).toContain("line-10"); // 27 rows minus seven chrome = 20; half = 10.
    view.handleInput("\x1b[6~");
    expect(view.render(100)[4]).toContain("line-30");
    view.handleInput("\x15");
    expect(view.render(100)[4]).toContain("line-20");
    view.handleInput("\x1b[5~");
    expect(view.render(100)[4]).toContain("line-0");
    expect(view[INPUT_CONTEXT]()).toBe("viewer");
  } finally { view.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

it("Tab can select a background pill with a draft, cycle safely and return with Esc", () => {
  const editor = nativeEditor();
  editor.setText("keep this draft");
  const c = fakeCtx("/w", editor); const open = vi.fn();
  const pill = new PillView({ pill: () => ({ label: "1 task" }), open }, "pi-bg-pill");
  pill.setUI(c.ctx.ui as any); pill.update();
  c.widgets.get("pi-bg-pill")({ ...tui, getFocusedComponent: () => editor }, theme).render(100);
  try {
    expect(pill.tab(true)).toBe(false);
    expect(pill.tab()).toBe(true);
    expect(pill.handleKey("\t")).toEqual({ consume: true });
    expect(pill.isSelected).toBe(true);
    expect(pill.handleKey("\x1b")).toEqual({ consume: true });
    expect(pill.tab(true)).toBe(false);
    expect(editor.getText()).toBe("keep this draft");
    pill.tab(); pill.handleKey("\r");
    expect(open).toHaveBeenCalledOnce();
    expect(editor.getText()).toBe("keep this draft");
    pill.dispose(); expect(pill.tab()).toBe(false);
  } finally { pill.dispose(); }
});

it("the local pill leaves typed navigation letters to the native editor", () => {
  const editor = nativeEditor();
  const c = fakeCtx("/w", editor);
  const open = vi.fn();
  const pill = new PillView({ pill: () => ({ label: "work" }), open }, "pi-bg-pill");
  pill.setUI(c.ctx.ui as any);
  pill.update();
  c.widgets.get("pi-bg-pill")({ ...tui, getFocusedComponent: () => editor }, theme).render(100);
  try {
    for (const key of ["h", "j", "k", "l", "\x15", "\x04"]) {
      expect(pill.handleKey("\x1b[B")).toEqual({ consume: true });
      expect(pill.handleKey(key)).toBeUndefined();
      expect(pill.isSelected).toBe(false);
    }
    expect(open).not.toHaveBeenCalled();
    pill.handleKey("\x1b[B");
    expect(pill.handleKey("\r")).toEqual({ consume: true });
    expect(open).toHaveBeenCalledOnce();
  } finally { pill.dispose(); }
});

it("a real pi-vim main editor yields only idle navigation; pending/visual/EX/embedded focus stays owned", async () => {
  const { MainEditor } = await import(new URL("../../pi-vim/src/index.ts", import.meta.url).href);
  const editor = new MainEditor(tui, { ...theme, borderColor: (s: string) => s }, { matches: () => false });
  const c = fakeCtx("/w", editor);
  const liveTui = { ...tui, getFocusedComponent: () => editor };
  const pill = new PillView({ pill: () => ({ label: "one shell" }), open: () => {} }, "pi-bg-pill");
  pill.setUI(c.ctx.ui as any);
  pill.update();
  try {
    c.widgets.get("pi-bg-pill")(liveTui, theme).render(100);
    editor.setText("abc");
    editor.handleInput("\x1b");
    editor.handleInput("$");
    expect(leavesPromptDown(editor, "j", false, true)).toBe(true);
    expect(pill.handleKey("j")).toEqual({ consume: true });
    editor.handleInput(":");
    expect(editor[EDITOR_MODE]().state).toBe("ex");
    expect(pill.handleKey("j")).toBeUndefined();
    expect(pill.isSelected).toBe(false);
    editor.handleInput("\x1b");
    editor.handleInput("d");
    expect(leavesPromptDown(editor, "j", false, true)).toBe(false);
    editor.handleInput("\x1b");
    editor.handleInput("v");
    expect(leavesPromptDown(editor, "\x1b[B", true, false)).toBe(false);
    expect(mainEditorFocused({ [INPUT_CONTEXT]: () => "filter" })).toBe(false);
    expect(mainEditorFocused({ [INPUT_CONTEXT]: () => "editor", [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded" })).toBe(false);
  } finally { pill.dispose(); editor.dispose(); }
});

it("a pill with rows: ↓ selects the first row, ↑↓ move through rows and label, Enter opens the row, Esc and ↑ past the first go back", async () => {
  const editor = nativeEditor();
  editor.setText("draft");
  const c = fakeCtx("/w", editor);
  const open = vi.fn();
  const openRow = vi.fn();
  const rows = [
    { key: "a", label: "a.py", detail: ":2718 · idle", status: "done" as const, stats: "", startedAt: 0 },
    { key: "b", label: "b.py", detail: ":2719 · running Fit", status: "running" as const, stats: "0:12", startedAt: 0 },
  ];
  const pill = new PillView({ pill: () => ({ label: "1 task", rows }), open, openRow }, "pi-bg-pill");
  pill.setUI(c.ctx.ui as any);
  pill.update();
  const widget = c.widgets.get("pi-bg-pill")({ ...tui, getFocusedComponent: () => editor }, theme);
  try {
    // Rows first, then the label line.
    const idle = widget.render(100);
    expect(idle).toHaveLength(3);
    expect(idle[0]).toContain("a.py");
    expect(idle[1]).toMatch(/○ b\.py {2}:2719 · running Fit +0:12/u);
    expect(idle[2]).toContain("1 task");
    expect(pill.handleKey("\x1b[B")).toEqual({ consume: true });
    // No hint line under the rows; the selected one is on the selection background.
    expect(widget.render(100)).toHaveLength(3);
    expect(widget.render(100)[0]).toContain(" ● a.py");
    expect(pill.handleKey("\x1b[B")).toEqual({ consume: true });
    expect(pill.handleKey("\r")).toEqual({ consume: true });
    expect(openRow).toHaveBeenCalledExactlyOnceWith("b");
    expect(pill.isSelected).toBe(false);
    // The label line opens the dialog.
    pill.handleKey("\x1b[B");
    pill.handleKey("\x1b[B");
    pill.handleKey("\x1b[B");
    pill.handleKey("\x1b[B");
    pill.handleKey("\r");
    expect(open).toHaveBeenCalledOnce();
    // ↑ past the first row, and Esc, go back to the prompt; the draft is untouched.
    pill.handleKey("\x1b[B");
    expect(pill.handleKey("\x1b[A")).toEqual({ consume: true });
    expect(pill.isSelected).toBe(false);
    pill.handleKey("\x1b[B");
    pill.handleKey("\x1b[B");
    expect(pill.handleKey("\x1b")).toEqual({ consume: true });
    expect(pill.isSelected).toBe(false);
    expect(editor.getText()).toBe("draft");
  } finally { pill.dispose(); }
});

it("x twice stops the selected running row in pi-vim normal mode, and a row that cannot be stopped is not offered", async () => {
  const { MainEditor } = await import(new URL("../../pi-vim/src/index.ts", import.meta.url).href);
  const editor = new MainEditor(tui, { ...theme, borderColor: (s: string) => s }, { matches: () => false });
  const c = fakeCtx("/w", editor);
  const stopRow = vi.fn(async () => {});
  const rows = [
    { key: "a", label: "a.py", detail: "idle", status: "done" as const, stats: "", startedAt: 0 },
    { key: "b", label: "b.py", detail: "running", status: "running" as const, stats: "", startedAt: 0, stopToken: "t1" },
  ];
  const pill = new PillView({ pill: () => ({ label: "", rows }), open: () => {}, openRow: () => {}, stopRow, canStopRow: (r) => r.status === "running" }, "pi-bg-pill");
  pill.setUI(c.ctx.ui as any);
  pill.update();
  const widget = c.widgets.get("pi-bg-pill")({ ...tui, getFocusedComponent: () => editor }, theme);
  try {
    editor.setText("abc");
    editor.handleInput("\x1b");
    editor.handleInput("$");
    expect(pill.handleKey("j")).toEqual({ consume: true });
    // On the idle row, x is not the pill's.
    pill.handleKey("j");
    expect(widget.render(100)).toHaveLength(2);
    expect(pill.handleKey("x")).toEqual({ consume: true });
    expect(stopRow).not.toHaveBeenCalled();
    expect(widget.render(100).at(-1)).toContain("x again to stop");
    // Moving away cancels the arming.
    pill.handleKey("k");
    pill.handleKey("j");
    expect(pill.handleKey("x")).toEqual({ consume: true });
    expect(stopRow).not.toHaveBeenCalled();
    expect(pill.handleKey("x")).toEqual({ consume: true });
    expect(stopRow).toHaveBeenCalledExactlyOnceWith("b");
    // No label, no label line: the rows are the whole pill.
    expect(widget.render(100).filter((l: string) => l.trim()).length).toBe(2);
  } finally { pill.dispose(); editor.dispose(); }
});

it("the combined pill, with no label of its own, lists a hosted guest's rows", async () => {
  const { default: piBg } = await import("../src/index.ts");
  const f = fakePi();
  const c = fakeCtx("/fixture");
  piBg(f.pi as any);
  for (const h of f.handlers.get("session_start") ?? []) await h({ reason: "startup" }, c.ctx);
  const open = async () => {};
  const stop = async () => {};
  const row = { key: "nb", label: "nb.py", detail: ":2718", status: "running" as const, stats: "0:03", startedAt: 0, stopToken: "s1" };
  const guest = { id: "marimo", title: "notebooks", noun: "notebook", entries: () => [row], open, stop, canStop: () => true, pill: () => ({ label: "", rows: [row] }), setHosted: () => {} };
  f.pi.events.emit("activity:section", { section: guest });
  const widget = [...c.widgets.values()].at(-1);
  expect(widget).toBeDefined();
  const text = widget({ ...tui, getFocusedComponent: () => undefined }, theme).render(100).join("\n");
  expect(text).toMatch(/○ nb\.py {2}:2718 +0:03/u);
});

it("a row with its own styled line draws it after the dot, which is filled while selected", async () => {
  const { renderPill } = await import("../src/pill.ts");
  const row = { key: "a", label: "a.py", detail: "", status: "done" as const, stats: "", startedAt: 0, line: (t: { fg(c: string, s: string): string }) => `Marimo ${t.fg("accent", "a.py")}:2718 · idle` };
  const pill = { label: "", rows: [row] };
  expect(renderPill(pill, false, 80, theme)).toEqual([" ○ Marimo a.py:2718 · idle"]);
  expect(renderPill(pill, { index: 0 }, 80, theme)[0]).toBe(" ● Marimo a.py:2718 · idle");
  // A failed row says so at the right, before its stats.
  expect(renderPill({ label: "", rows: [{ ...row, status: "failed" as const }] }, false, 30, theme)[0]).toBe(" ○ Marimo a.py:2718 · idle   ✗");
});

it("going back out of a row's view selects that row again, not the prompt", async () => {
  const editor = nativeEditor();
  const c = fakeCtx("/w", editor);
  let close!: () => void;
  const openRow = vi.fn(() => new Promise<void>((resolve) => { close = resolve; }));
  const rows = ["a", "b", "c"].map((k) => ({ key: k, label: `${k}.py`, detail: "", status: "done" as const, stats: "", startedAt: 0 }));
  const pill = new PillView({ pill: () => ({ label: "", rows }), open: () => {}, openRow }, "pi-bg-pill");
  pill.setUI(c.ctx.ui as any);
  pill.update();
  const widget = c.widgets.get("pi-bg-pill")({ ...tui, getFocusedComponent: () => editor }, theme);
  try {
    pill.handleKey("\x1b[B");
    pill.handleKey("\x1b[B");
    pill.handleKey("\r");
    expect(openRow).toHaveBeenCalledWith("b");
    expect(pill.isSelected).toBe(false);
    close();
    await new Promise((r) => setTimeout(r, 0));
    expect(pill.isSelected).toBe(true);
    // The second row is the selected one: Enter opens it again.
    pill.handleKey("\r");
    expect(openRow).toHaveBeenLastCalledWith("b");
    close();
    await new Promise((r) => setTimeout(r, 0));
    // Esc still goes back to the prompt.
    expect(pill.handleKey("\x1b")).toEqual({ consume: true });
    expect(pill.isSelected).toBe(false);
    expect(widget.render(100).length).toBe(3);
  } finally { pill.dispose(); }
});
