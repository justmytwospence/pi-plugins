import { mkdtempSync, rmSync } from "node:fs";
import { expect, test } from "vitest";
import nextPrompt from "../src/index.ts";
import { harness } from "./harness.ts";
const { routePromptTab, TASK_TAB } = await import(new URL("../../pi-select-nav/src/prompt-tab.ts", import.meta.url).href);
const { PillView } = await import(new URL("../../pi-bg/src/pill.ts", import.meta.url).href);
const { createEventBus } = await import(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js", import.meta.url).href);

for (const nextFirst of [true, false]) test(`Tab accepts next before tasks regardless of input registration order (${nextFirst})`, async () => {
  const h = harness(); h.pi.events = createEventBus(); nextPrompt(h.pi);
  const cwd = mkdtempSync("/tmp/pi-tab-");
  const ctx = h.ctx({ cwd });
  let popup = false;
  const editor = {
    getText: () => ctx.ui.editorText, setText: (text: string) => ctx.ui.setEditorText(text),
    getCursor: () => ({ line: 0, col: ctx.ui.editorText.length }), render: () => [],
    isShowingAutocomplete: () => popup,
    [Symbol.for("pi-plugins.editor-surface.v1")]: "main",
  };
  let focus: unknown = editor;
  const tui = { getFocusedComponent: () => focus, requestRender() {}, terminal: { columns: 80 } };
  ctx.ui.setWidget = (key: string, content: any, opts: any) => {
    if (typeof content === "function") content(tui, { fg: (_: string, s: string) => s });
    if (content === undefined) ctx.ui.widgets.delete(key);
    else ctx.ui.widgets.set(key, { content, opts });
  };
  const route = (data: string) => routePromptTab(data, focus, editor, (channel: string, request: unknown) => h.pi.events.emit(channel, request));
  if (!nextFirst) ctx.ui.onTerminalInput(route);
  await h.emit("session_start", {}, ctx);
  if (nextFirst) ctx.ui.onTerminalInput(route);
  let available = true;
  let opened = 0;
  const pill = new PillView({ pill: () => available ? { label: "1 shell" } : undefined, open: () => { opened++; } });
  pill.setUI(ctx.ui); pill.update();
  h.pi.events.on(TASK_TAB, (request: any) => { if (!request.handled) request.handled = pill.tab(request.phase === "active"); });
  try {
    await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done.\n<next>Run tests</next>" }] } }, ctx);
    await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
    await h.emit("agent_settled", {}, ctx);
    expect(ctx.ui.press("\t")).toBe(true);
    expect(ctx.ui.editorText).toBe("Run tests");
    expect(pill.isSelected).toBe(false);
    expect(opened).toBe(0);
    // A draft is preserved when task navigation takes over.
    expect(ctx.ui.press("\t")).toBe(true);
    expect(pill.isSelected).toBe(true);
    expect(ctx.ui.editorText).toBe("Run tests");
    // A new offer arriving while a task is selected must not steal navigation.
    ctx.ui.editorText = "";
    await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Ready.\n<next>Check results</next>" }] } }, ctx);
    await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
    await h.emit("agent_settled", {}, ctx);
    expect(ctx.ui.press("\t")).toBe(true);
    expect(ctx.ui.editorText).toBe("");
    expect(ctx.ui.press("\x1b")).toBe(true);
    expect(ctx.ui.press("\t")).toBe(true);
    expect(ctx.ui.editorText).toBe("Check results");
    ctx.ui.editorText = "Run tests";
    expect(pill.isSelected).toBe(false);
    expect(ctx.ui.editorText).toBe("Run tests");
    ctx.ui.press("\t"); ctx.ui.press("\r");
    expect(opened).toBe(1);
    expect(ctx.ui.editorText).toBe("Run tests");
    popup = true; ctx.ui.editorText = "@src/";
    expect(ctx.ui.press("\t")).toBe(false); // native completion
    expect(pill.isSelected).toBe(false);
    ctx.ui.editorText = "src/";
    expect(ctx.ui.press("\t")).toBe(true); // no implicit completion
    popup = false; available = false; pill.update();
    ctx.ui.editorText = "";
    expect(ctx.ui.press("\t")).toBe(true); // nothing available, nothing happens
    expect(ctx.ui.editorText).toBe("");
    focus = { render: () => [] };
    expect(ctx.ui.press("\t")).toBe(false); // dialog owns Tab
    focus = editor;
    expect(ctx.ui.press("\x1b[Z")).toBe(false); // thinking key untouched
    await h.emit("session_shutdown", {}, ctx);
    const request = { handled: false };
    h.pi.events.emit("prompt:accept-next", request);
    expect(request.handled).toBe(false);
  } finally { pill.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

test("another extension's prompt:offer shows only while idle and never replaces the model's suggestion", async () => {
  const h = harness(); h.pi.events = createEventBus(); nextPrompt(h.pi);
  const cwd = mkdtempSync("/tmp/pi-offer-");
  const ctx = h.ctx({ cwd });
  const editor = {
    getText: () => ctx.ui.editorText, setText: (text: string) => ctx.ui.setEditorText(text),
    getCursor: () => ({ line: 0, col: ctx.ui.editorText.length }), render: () => [],
    [Symbol.for("pi-plugins.editor-surface.v1")]: "main",
  };
  const tui = { getFocusedComponent: () => editor, requestRender() {}, terminal: { columns: 80 } };
  ctx.ui.setWidget = (key: string, content: any, opts: any) => {
    if (typeof content === "function") content(tui, { fg: (_: string, s: string) => s });
    if (content === undefined) ctx.ui.widgets.delete(key);
    else ctx.ui.widgets.set(key, { content, opts });
  };
  await h.emit("session_start", {}, ctx);
  try {
    const offer = (text?: string) => h.pi.events.emit("prompt:offer", { source: "pi-marimo", text });
    offer("Use Lens to address S1 in fit.py");
    expect(ctx.ui.press("\t")).toBe(true);
    expect(ctx.ui.editorText).toBe("Use Lens to address S1 in fit.py");
    // Withdrawn by its source.
    ctx.ui.editorText = "";
    offer("Use Lens to address S2 in fit.py");
    offer(undefined);
    ctx.ui.press("\t");
    expect(ctx.ui.editorText).toBe("");
    // Not during a turn.
    await h.emit("agent_start", {}, ctx);
    offer("Use Lens to address S3 in fit.py");
    await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done.\n<next>Run tests</next>" }] } }, ctx);
    await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
    await h.emit("agent_settled", {}, ctx);
    // The model's suggestion stays.
    offer("Use Lens to address S4 in fit.py");
    offer(undefined);
    expect(ctx.ui.press("\t")).toBe(true);
    expect(ctx.ui.editorText).toBe("Run tests");
  } finally {
    await h.emit("session_shutdown", {}, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});
