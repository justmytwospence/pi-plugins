import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Editor } from "@earendil-works/pi-tui";
import { type ActivityEntry, type ActivitySection, EDITOR_MODE, INPUT_CONTEXT, leavesPromptDown, mainEditorFocused, stableKey } from "../src/activity.ts";
import { TasksDialog } from "../src/dialog.ts";
import { LogViewer } from "../src/viewer.ts";
import { PillView } from "../src/pill.ts";
import type { Task } from "../src/registry.ts";
import { fakeCtx, fakePi } from "./fake.ts";

const theme = { fg: (_: string, s: string) => s, bold: (s: string) => s };
const tui = { requestRender: () => {}, terminal: { rows: 27 } };
const entry = (key: string, startedAt: number): ActivityEntry => ({ key, startedAt, label: key, detail: "", stats: "", status: "running" });
const source = (id: string, entries: () => ActivityEntry[], stop?: ActivitySection["stop"]): ActivitySection => ({ id, title: id, entries, open: async () => {}, ...(stop ? { stop } : {}) });
const options = (sections: ActivitySection[]) => ({ sections: () => sections, ownId: "bg", canFollow: false });

describe("activity contract and dialog", () => {
  it("keeps all five package-local protocol copies byte-identical", () => {
    const original = fs.readFileSync(new URL("../src/activity.ts", import.meta.url), "utf8");
    for (const name of ["pi-subagents", "pi-marimo", "pi-herdr", "pi-plan-mode"]) {
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

  it("uses a real sibling notebook producer without importing it at runtime", async () => {
    const { NotebookSource } = await import(new URL("../../pi-marimo/src/ui/source.ts", import.meta.url).href);
    const { NotebookState } = await import(new URL("../../pi-marimo/src/core/notebook.ts", import.meta.url).href);
    const notebook = new NotebookState();
    notebook.apply("kernel-ready", { cell_ids: ["cell"], codes: ["x = 1"], names: ["_"] });
    notebook.apply("cell-op", { cell_id: "cell", status: "running" });
    const followed = { attachment: { path: "/w/nb.py", url: "http://fixture.invalid", sessionId: "s" }, notebook, connection: "connected", current: true };
    const interrupt = vi.fn(async () => {});
    const open = vi.fn(async () => {});
    const other = { ...followed, attachment: { ...followed.attachment, url: "http://other.invalid" } };
    const nb = new NotebookSource({ followed: () => [followed, other], interrupt, open, changed: () => {}, hostedChanged: () => {} });
    nb.update([followed, other], 100);
    const otherKey = nb.section.entries(100)[1].key;
    let result: any;
    const dialog = new TasksDialog(tui as any, theme, { ...options([nb.section]), initialKey: stableKey("marimo", otherKey) }, (picked) => { result = picked; });
    try {
      dialog.handleInput("x");
      dialog.handleInput("x");
      await Promise.resolve();
      expect(interrupt).toHaveBeenCalledExactlyOnceWith(other);
      dialog.handleInput("\r");
      expect(result.section).toBe(nb.section);
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
  const editor = new Editor(tui as any, { borderColor: (s: string) => s } as any);
  editor.setText("keep this draft");
  const c = fakeCtx("/w"); const open = vi.fn();
  const pill = new PillView({ pill: () => ({ label: "1 shell" }), open });
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

it("both pills leave typed navigation letters to the native editor", async () => {
  const { PillView: NotebookPill } = await import(new URL("../../pi-marimo/src/ui/pill.ts", import.meta.url).href);
  for (const [View, widgetKey] of [[PillView, "pi-bg-pill"], [NotebookPill, "pi-marimo-pill"]] as const) {
    const editor = new Editor(tui as any, { borderColor: (s: string) => s } as any);
    const c = fakeCtx("/w");
    const open = vi.fn();
    const pill = new View({ pill: () => ({ label: "work" }), open });
    pill.setUI(c.ctx.ui as any);
    pill.update();
    c.widgets.get(widgetKey)({ ...tui, getFocusedComponent: () => editor }, theme).render(100);
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
  }
});

it("a real pi-vim main editor yields only idle navigation; pending/visual/EX/embedded focus stays owned", async () => {
  const { MainEditor } = await import(new URL("../../pi-vim/src/index.ts", import.meta.url).href);
  const editor = new MainEditor(tui, { ...theme, borderColor: (s: string) => s }, { matches: () => false });
  const c = fakeCtx("/w");
  const liveTui = { ...tui, getFocusedComponent: () => editor };
  const pill = new PillView({ pill: () => ({ label: "one shell" }), open: () => {} });
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
