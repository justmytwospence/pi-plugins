import { expect, test, vi } from "vitest";
import { NotebookState } from "../src/core/notebook.js";
import type { Followed } from "../src/core/watcher.js";
import { INPUT_CONTEXT } from "../src/activity.js";
import { NotebookView } from "../src/ui/view.js";
import { NotebookSource } from "../src/ui/source.js";
import { notebookKey } from "../src/ui/identity.js";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const tui = { requestRender: () => {}, terminal: { rows: 27 } };
function followed(url = "http://fixture.invalid", sessionId = "s"): Followed {
  const notebook = new NotebookState();
  notebook.apply("kernel-ready", { cell_ids: Array.from({ length: 100 }, (_, i) => `cell-${i}`), codes: Array(100).fill("x = 1"), names: Array(100).fill("_") });
  return { attachment: { path: "/w/nb.py", url, sessionId }, notebook, connection: "connected", current: true, touchedAt: 0 };
}
function busy(f: Followed) { f.notebook.apply("cell-op", { cell_id: "cell-0", status: "running" }); }

test("notebook detail uses Ctrl-U/D half-page primary and Page keys full-page", () => {
  const f = followed();
  const view = new NotebookView(tui as any, theme, notebookKey(f), { followed: () => [f], interrupt: async () => {}, openInBrowser: () => {} }, () => {});
  try {
    view.handleInput("g");
    view.handleInput("\x04");
    expect(view.render(100)[4]).toContain("cell-10");
    view.handleInput("\x1b[6~");
    expect(view.render(100)[4]).toContain("cell-30");
    view.handleInput("\x15");
    expect(view.render(100)[4]).toContain("cell-20");
    view.handleInput("\x1b[5~");
    expect(view.render(100)[4]).toContain("cell-0");
    expect(view[INPUT_CONTEXT]()).toBe("viewer");
  } finally { view.dispose(); }
});

test("the notebook producer rechecks connected busy eligibility before interrupting", async () => {
  const f = followed();
  const key = notebookKey(f);
  const interrupt = vi.fn(async () => {});
  const source = new NotebookSource({ followed: () => [f], open: async () => {}, interrupt, changed: () => {}, hostedChanged: () => {} });
  expect(source.section.canStop!(key)).toBe(false);
  busy(f);
  source.update([f]);
  expect(source.section.canStop!(key)).toBe(true);
  await source.section.stop!(key);
  expect(interrupt).toHaveBeenCalledOnce();
  f.connection = "disconnected";
  expect(source.section.canStop!(key)).toBe(false);
  await source.section.stop!(key);
  expect(interrupt).toHaveBeenCalledOnce();
});

test("two servers hosting the same file have distinct stable rows, interrupts and details", async () => {
  const a = followed("http://server-a.invalid");
  const b = followed("http://server-b.invalid");
  busy(a); busy(b);
  const interrupt = vi.fn(async () => {});
  const source = new NotebookSource({ followed: () => [a, b], open: async () => {}, interrupt, changed: () => {}, hostedChanged: () => {} });
  source.update([a, b]);
  const rows = source.entries(100);
  expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  await source.section.stop!(rows[1]!.key);
  expect(interrupt).toHaveBeenCalledExactlyOnceWith(b);
  const view = new NotebookView(tui as any, theme, rows[1]!.key, { followed: () => [a, b], interrupt, openInBrowser: () => {} }, () => {});
  try {
    expect(view.render(100).join("\n")).toContain("http://server-b.invalid");
    expect(view.render(100).join("\n")).not.toContain("http://server-a.invalid");
  } finally { view.dispose(); }
  const before = notebookKey(b);
  b.attachment.sessionId = "reconnected";
  expect(notebookKey(b)).toBe(before);
});

test("confirmation is invalidated by replacement, disappearance, observed idle and disconnect", () => {
  const initial = followed(); busy(initial);
  let all = [initial];
  const interrupt = vi.fn(async () => {});
  const view = new NotebookView(tui as any, theme, notebookKey(initial), { followed: () => all, interrupt, openInBrowser: () => {} }, () => {});
  try {
    view.handleInput("x");
    const replacement = followed(initial.attachment.url, "new-session"); busy(replacement);
    all = [replacement];
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    all = [];
    view.render(100);
    all = [replacement];
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    replacement.notebook.apply("cell-op", { cell_id: "cell-0", status: "idle" });
    view.render(100);
    busy(replacement);
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    replacement.connection = "disconnected";
    view.render(100);
    replacement.connection = "connected";
    view.handleInput("x");
    expect(interrupt).not.toHaveBeenCalled();
    view.handleInput("x");
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(replacement);
  } finally { view.dispose(); }
});
