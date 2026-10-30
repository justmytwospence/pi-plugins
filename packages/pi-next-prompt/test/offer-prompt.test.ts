import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import nextPrompt from "../src/index.ts";
import { fakeJev, harness } from "./harness.ts";

const PROMPT = "/marimo new examples/viewer-demo.py";
// Parse only the text-free diagnostic suffix, never the offered text in legacy status fields.
async function lifecycle(s: Awaited<ReturnType<typeof setup>>) {
  await s.h.commands.get("next-prompt").handler("status", s.ctx);
  const status = s.ctx.ui.notes.at(-1)!.message;
  return {
    state: JSON.parse(status.split("Lifecycle state: ")[1]!.split(". Last render before settlement:")[0]!),
    before: JSON.parse(status.split("Last render before settlement: ")[1]!.split(". Last render after settlement:")[0]!),
    after: JSON.parse(status.split("Last render after settlement: ")[1]!.split(". Lifecycle trace:")[0]!),
    trace: JSON.parse(status.split("Lifecycle trace: ")[1]!),
  };
}

test.each([false, true])("status does not render a pending prompt or create a receipt (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  const pending = s.execute();
  const render = vi.spyOn(s.ctx.ui.editor, "render");
  const info = await lifecycle(s);
  expect(render).not.toHaveBeenCalled();
  expect(info.before).toBeNull();
  expect(info.after).toBeNull();
  expect(info.trace.some((event: any) => event.event === "acknowledge")).toBe(false);
  s.render();
  expectDisplayed(await pending, PROMPT, ghost);
});

test.each(["dialog", "sidebar"])("transient %s focus after receipt has a concrete hide cause, not proof of post-turn visibility", async focus => {
  for (const ghost of [false, true]) {
    const s = await setup({ ghost });
    await s.h.emit("agent_start", {}, s.ctx);
    expectDisplayed(await s.offer(), PROMPT, ghost, true);
    // Both surfaces are non-main focus, but no component names or text enter diagnostics.
    const other = focus === "sidebar"
      ? { [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded", getText: () => "PRIVATE_SIDEBAR" }
      : { render: () => ["PRIVATE_DIALOG"] };
    s.ctx.ui.focus(other);
    s.render();
    await Promise.resolve(); // Existing ownership policy clears explicit offers on focus loss.
    s.ctx.ui.focus(s.ctx.ui.editor);
    await s.settle();
    s.render();
    const info = await lifecycle(s);
    expect(info.before).toMatchObject({ visible: false, reason: "main editor lost focus", busy: true });
    expect(info.after).toBeNull();
    expect(info.trace).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "acknowledge" }),
      expect.objectContaining({ event: "hide", reason: "main editor lost focus" }),
    ]));
    expect(JSON.stringify(info)).not.toMatch(/PRIVATE|marimo|viewer-demo/);
    expect(s.ctx.ui.press(TAB)).toBe(false);
  }
});

test.each([false, true])("later agent run is a separate named removal after post-settlement prompt output (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  await s.h.emit("agent_start", {}, s.ctx);
  await s.offer();
  await s.h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] } }, s.ctx);
  s.render();
  await s.settle();
  expect((await lifecycle(s)).after).toBeNull();
  s.render();
  expect((await lifecycle(s)).after).toMatchObject({ visible: true, settled: true, busy: false });
  await s.h.emit("agent_start", {}, s.ctx);
  const info = await lifecycle(s);
  const ack = info.trace.findIndex((event: any) => event.event === "acknowledge");
  const removal = info.trace.findIndex((event: any, i: number) => i > ack && event.event === "hide" && event.reason === "agent_start");
  expect(removal).toBeGreaterThan(ack);
  if (ghost) expect(info.trace).toContainEqual(expect.objectContaining({ event: "patch-removal", reason: "agent_start" }));
  expect(s.ctx.ui.press(TAB)).toBe(false);
});

const TAB = "\t";
const RIGHT = "\x1b[C";
const roots: string[] = [];
const shutdowns: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0)) await shutdown();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Deliberately no interactive-shell listener: ordinary and slash prompts need no shell plugin.
async function setup(options: {
  ghost?: boolean;
  maxChars?: number;
  enabled?: boolean;
  context?: Record<string, unknown>;
  attach?: boolean;
} = {}) {
  vi.useFakeTimers();
  const cwd = mkdtempSync(join(tmpdir(), "offer-prompt-"));
  roots.push(cwd);
  vi.stubEnv("XDG_CONFIG_HOME", join(cwd, "xdg"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "next-prompt.json"), JSON.stringify({
    ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  }));
  const h = harness();
  // A veto if called: explicit offers must bypass classification, not merely fail open.
  const jev = fakeJev(() => ({ useful: { type: "bool", probability: 0 } }));
  const sendUserMessage = vi.fn();
  const executeCommand = vi.fn();
  Object.assign(h.pi, { sendUserMessage, executeCommand });
  nextPrompt(h.pi);
  const ctx = h.ctx({ cwd, modelRegistry: jev.registry, ...options.context });
  if (options.ghost) ctx.ui.editor.render = () => ["\x1b[7m \x1b[0m"];
  if (options.attach !== false) await h.emit("session_start", {}, ctx);
  shutdowns.push(() => h.emit("session_shutdown", {}, ctx));
  const tool = h.tools.get("offer_prompt");
  const execute = (text = PROMPT, signal?: AbortSignal) => tool.execute("prompt-call", { text }, signal, undefined, ctx);
  const terminal = (command = "true") => h.tools.get("offer_terminal").execute("terminal-call", { command }, undefined, undefined, ctx);
  const render = (width = 200) => options.ghost ? ctx.ui.renderEditor(width) : ctx.ui.widgetLines("next-prompt", width);
  const offer = async (text = PROMPT) => { const pending = execute(text); render(); return await pending; };
  const settle = async (outcome = "completed") => {
    await h.emit("agent_before_settle", { outcome }, ctx);
    await h.emit("agent_settled", {}, ctx);
  };
  return { h, ctx, jev, tool, execute, terminal, render, offer, settle, sendUserMessage, executeCommand };
}

function expectBlocked(result: any, reason?: string) {
  expect(result.details).toMatchObject({ status: "blocked", kind: "prompt" });
  expect(result.details.reason).toEqual(expect.any(String));
  expect(result.details.reason.length).toBeGreaterThan(0);
  if (reason) expect(result.details.reason).toContain(reason);
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: `Prompt suggestion blocked: ${result.details.reason}` }]);
}

function expectDisplayed(result: any, text: string, ghost = false, busy = false) {
  expect(result.details).toEqual({ status: "displayed", kind: "prompt", text, surface: ghost ? "ghost" : "widget", acceptAfterTurn: busy });
  expect(result.isError).not.toBe(true);
  expect(result.content).toEqual([{
    type: "text",
    text: `Displayed editable suggestion: ${text}\nAfter this response finishes, press Tab/Right to copy it into your prompt, then Enter to submit it. Nothing was submitted.`,
  }]);
}

function expectNoSubmission(s: Awaited<ReturnType<typeof setup>>) {
  expect(s.sendUserMessage).not.toHaveBeenCalled();
  expect(s.executeCommand).not.toHaveBeenCalled();
  expect(s.h.messages).toEqual([]);
}

test("registers the model-only exact-text prompt tool and verified-handoff guidance", async () => {
  const { tool } = await setup();
  expect(tool.name).toBe("offer_prompt");
  expect(tool.exposure).toBe("model-only");
  expect(tool.label).toBe("Offer prompt");
  expect(tool.description).toBe("Display an editable prompt or Pi slash command, never submit it. Waits up to one second for render acknowledgement and returns displayed or a concrete blocker.");
  expect(tool.parameters.properties.text).toMatchObject({ type: "string", minLength: 1 });
  expect(tool.parameters.required).toContain("text");
  const guidelines = tool.promptGuidelines.join(" ");
  expect(guidelines).toContain("offer_prompt");
  expect(guidelines).toContain("status displayed");
  expect(guidelines).toContain("Tab/Right then Enter");
  expect(guidelines).toMatch(/blocker/i);
  expect(guidelines).toMatch(/secret|credential/i);
});

test.each([false, true])("exact slash-command receipt requires actual output, not mounting/preflight (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  let done = false;
  const pending = s.execute().then((value: any) => { done = true; return value; });
  await Promise.resolve();
  expect(done).toBe(false);
  // Widget factories have already run, or ghost's cursor preflight has already run.
  expect(s.ctx.ui.editorText).toBe("");
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expect(s.ctx.ui.press(TAB)).toBe(false);
  expect(s.render()?.join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toContain(PROMPT);
  const result = await pending;
  expectDisplayed(result, PROMPT, ghost);
  expect(s.ctx.ui.editorText).toBe("");
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expectNoSubmission(s);
});

test.each([
  "Please review the changes",
  "Explain  the \"quoted value\" and 'other  value'",
  "/not-a-registered-command one  two",
  "Compare café and 日本語",
])("preserves arbitrary prompt bytes without shell or slash-name validation: %j", async text => {
  const s = await setup();
  expectDisplayed(await s.offer(text), text);
  expect(s.ctx.ui.widgetLines("next-prompt")).toEqual([`→ ${text}  Tab to accept`]);
  expect(s.ctx.ui.press(TAB)).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual([text]);
  expectNoSubmission(s);
});

const invalidTexts = [
  "", " ", "\t", " leading", "trailing ", "\u00a0boundary", "boundary\u00a0",
  "one\ntwo", "one\rtwo", "one\r\ntwo", "one\ttwo", "one\u2028two", "one\u2029two",
  ...Array.from({ length: 32 }, (_, code) => `one${String.fromCharCode(code)}two`),
  ...Array.from({ length: 33 }, (_, code) => `one${String.fromCharCode(0x7f + code)}two`),
];
test.each(invalidTexts)("rejects invalid prompt text without writing or showing: %j", async text => {
  const s = await setup();
  expectBlocked(await s.execute(text));
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expect(s.ctx.ui.press(TAB)).toBe(false);
  expectNoSubmission(s);
});

test.each(["!", "!ls", "!i true", "!!i true", "! ordinary prose"])("rejects every shell-prefixed input with the exact alternate-tool reason: %j", async text => {
  const s = await setup();
  const result = await s.execute(text);
  expectBlocked(result);
  expect(result.details.reason).toBe("Shell-prefixed input is not supported here; use offer_terminal for an interactive shell handoff");
  expect(s.ctx.ui.widgets.size).toBe(0);
});

test("positive maxChars rejects over-limit input instead of truncating, and accepts the exact boundary", async () => {
  const s = await setup({ maxChars: PROMPT.length });
  expectBlocked(await s.execute(`${PROMPT}x`), "maxChars");
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expectDisplayed(await s.offer(), PROMPT);
  expect(s.ctx.ui.press(RIGHT)).toBe(true);
  expect(s.ctx.ui.editorText).toBe(PROMPT);
});

test("unlimited offers retain the full text even when rendered output is clipped", async () => {
  const s = await setup({ maxChars: 0 });
  const text = `Review ${"one  two 'three' ".repeat(100)}end`;
  const pending = s.execute(text);
  expect(s.render(20)?.join("").length).toBeLessThan(text.length);
  expectDisplayed(await pending, text);
  expect(s.ctx.ui.press(TAB)).toBe(true);
  expect(s.ctx.ui.editorText).toBe(text);
});

test.each(["disabled", "config-disabled", "rpc", "print", "no-ui", "unattached", "focus", "embedded", "autocomplete", "vim-autocomplete", "draft", "external"])("concrete blocker protects the editor and ownership (%s)", async mode => {
  const s = await setup({
    enabled: mode === "config-disabled" ? false : undefined,
    attach: mode !== "unattached",
    context: mode === "rpc" || mode === "print" ? { mode } : mode === "no-ui" ? { hasUI: false } : {},
  });
  if (mode === "disabled") await s.h.commands.get("next-prompt").handler("off", s.ctx);
  if (mode === "draft") s.ctx.ui.editorText = "my existing draft";
  if (mode === "focus") s.ctx.ui.focus({});
  if (mode === "embedded") s.ctx.ui.focus({ [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded" });
  if (mode === "autocomplete") s.ctx.ui.editor.isShowingAutocomplete = () => true;
  if (mode === "vim-autocomplete") s.ctx.ui.editor[Symbol.for("pi-plugins.editor-mode.v1")] = () => ({ state: "insert", autocomplete: true });
  if (mode === "external") s.h.pi.events.emit("prompt:offer", { source: "other", text: "external owner text" });
  const result = await s.execute();
  const reason = mode.includes("disabled") ? "disabled"
    : ["rpc", "print", "no-ui", "unattached"].includes(mode) ? "UI"
    : mode === "draft" ? "draft" : mode === "external" ? "another extension" : "focused";
  expectBlocked(result, reason);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  if (mode === "draft") expect(s.ctx.ui.editorText).toBe("my existing draft");
  if (mode === "external") {
    expect(s.ctx.ui.press(TAB)).toBe(true);
    expect(s.ctx.ui.editorText).toBe("external owner text");
  } else expect(s.ctx.ui.widgets.size).toBe(0);
  expectNoSubmission(s);
});

test("an unavailable shell inspector is never consulted by prompt offers", async () => {
  const s = await setup();
  const inspect = vi.fn(({ reply }: any) => reply({ available: false, layout: "unsupported", reason: "shell unavailable" }));
  const probe = vi.fn();
  s.h.pi.events.on("interactive-shell:inspect", inspect);
  s.h.pi.events.on("interactive-shell:probe", probe);
  expectDisplayed(await s.offer(), PROMPT);
  expect(inspect).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  expect(s.ctx.ui.press(TAB)).toBe(true);
  expect(s.ctx.ui.editorText).toBe(PROMPT);
  expectNoSubmission(s);
});

test("render deadline is one second, and timeout removes the owned offer", async () => {
  const s = await setup();
  let done = false;
  const pending = s.execute().then((result: any) => { done = true; return result; });
  await vi.advanceTimersByTimeAsync(999);
  expect(done).toBe(false);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expectBlocked(await pending, "one second");
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.ctx.ui.press(TAB)).toBe(false);
  expect(s.render()).toBeUndefined();
  // Timeout releases ownership for a fresh call.
  expectDisplayed(await s.offer("Try again"), "Try again");
});

test.each([false, true])("aborted calls clear pending offers and never leave an acceptance path (already aborted=%s)", async already => {
  const s = await setup({ ghost: true });
  const original = s.ctx.ui.editor.render;
  const controller = new AbortController();
  if (already) controller.abort();
  const pending = s.execute(PROMPT, controller.signal);
  if (!already) controller.abort();
  expectBlocked(await pending, "aborted");
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.ctx.ui.editor.render).toBe(original);
  expect(s.ctx.ui.press(TAB)).toBe(false);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expectDisplayed(await s.offer("Fresh offer"), "Fresh offer", true);
});

test("successful acknowledgement cancels its deadline and abort listener", async () => {
  const s = await setup();
  const controller = new AbortController();
  const pending = s.execute(PROMPT, controller.signal);
  s.render();
  expectDisplayed(await pending, PROMPT);
  controller.abort();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(s.ctx.ui.press(TAB)).toBe(true);
  expect(s.ctx.ui.editorText).toBe(PROMPT);
});

test("pending duplicates cannot acknowledge themselves; rendered same-kind duplicates are idempotent", async () => {
  const s = await setup();
  const pending = s.execute();
  expectBlocked(await s.execute(), "awaiting render");
  s.render();
  const first = await pending;
  expectDisplayed(first, PROMPT);
  expect(await s.execute()).toEqual(first);
  await s.h.commands.get("next-prompt").handler("status", s.ctx);
  expect(s.ctx.ui.notes.at(-1).message).toContain("prompt");
  expect(s.ctx.ui.notes.at(-1).message).toContain("rendered");
  expect(s.ctx.ui.notes.at(-1).message).toContain("displayed (widget)");
  expectBlocked(await s.execute("Different text"), "different explicit");
  expect(s.ctx.ui.press(TAB)).toBe(true);
  expect(s.ctx.ui.editorText).toBe(PROMPT);
});

test.each(["prompt", "terminal"])("cross-tool conflicts preserve the first explicit owner (%s first)", async kind => {
  const s = await setup();
  s.h.pi.events.on("interactive-shell:inspect", ({ reply }: any) => reply({ available: true, layout: "inline" }));
  const accepted = vi.fn();
  s.h.pi.events.on("interactive-shell:suggestion-accepted", accepted);
  const pending = kind === "prompt" ? s.execute() : s.terminal();
  const conflict = kind === "prompt" ? await s.terminal() : await s.execute();
  expect(conflict.details).toMatchObject({ status: "blocked", reason: expect.stringContaining("different explicit") });
  s.render();
  const first = await pending;
  expect(first.details).toMatchObject({ status: "displayed", kind, text: kind === "prompt" ? PROMPT : "!i true" });
  const laterConflict = kind === "prompt" ? await s.terminal() : await s.execute();
  expect(laterConflict.details.status).toBe("blocked");
  // An external source must not steal or withdraw an explicit tool's offer either.
  s.h.pi.events.emit("prompt:offer", { source: "other", text: "replacement" });
  s.h.pi.events.emit("prompt:offer", { source: "other" });
  expect(s.ctx.ui.press(TAB)).toBe(true);
  expect(s.ctx.ui.editorText).toBe(kind === "prompt" ? PROMPT : "!i true");
  expect(accepted.mock.calls).toEqual(kind === "prompt" ? [] : [[{ text: "!i true" }]]);
  expectNoSubmission(s);
});

test.each([false, true])("focus/draft invalidation before actual output never acknowledges (ghost=%s)", async ghost => {
  for (const change of ["focus", "draft"]) {
    const s = await setup({ ghost });
    const pending = s.execute();
    if (change === "focus") s.ctx.ui.focus({});
    else s.ctx.ui.editorText = "draft before output";
    s.render();
    expectBlocked(await pending);
    expect(s.ctx.ui.widgets.size).toBe(0);
    expect(s.ctx.ui.editorWrites).toEqual([]);
    if (change === "draft") expect(s.ctx.ui.editorText).toBe("draft before output");
  }
});

test.each([false, true])("queued acknowledgement rechecks focus, draft and generation (ghost=%s)", async ghost => {
  for (const change of ["focus", "draft", "generation", "abort"]) {
    const s = await setup({ ghost });
    const controller = new AbortController();
    const pending = s.execute(PROMPT, controller.signal);
    s.render(); // Observation queues acknowledgement; it is not yet a success receipt.
    if (change === "focus") s.ctx.ui.focus({});
    if (change === "draft") s.ctx.ui.editorText = "draft after output";
    if (change === "generation") s.h.pi.events.emit("prompt:clear", {});
    if (change === "abort") controller.abort();
    expectBlocked(await pending);
    expect(s.ctx.ui.widgets.size).toBe(0);
    expect(s.ctx.ui.editorWrites).toEqual([]);
    if (change === "draft") expect(s.ctx.ui.editorText).toBe("draft after output");
    if (change === "generation") {
      expectDisplayed(await s.offer("New generation"), "New generation", ghost);
      expect(s.ctx.ui.press(TAB)).toBe(true);
      expect(s.ctx.ui.editorText).toBe("New generation");
    }
  }
});

test.each(["input", "session_tree", "model_select", "session_compact", "session_shutdown", "session_start", "user_bash", "agent_start", "prompt:clear", "off"])("reset settles an outstanding render waiter and drops ownership (%s)", async event => {
  const s = await setup();
  const pending = s.execute();
  if (event === "prompt:clear") s.h.pi.events.emit(event, {});
  else if (event === "off") await s.h.commands.get("next-prompt").handler("off", s.ctx);
  else await s.h.emit(event, {}, s.ctx);
  expectBlocked(await pending);
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.ctx.ui.press(TAB)).toBe(false);
  expect(s.ctx.ui.editorWrites).toEqual([]);
});

test.each([TAB, RIGHT])("completed settlement, not agent_end or before_settle, enables full-text insertion (%j)", async key => {
  const s = await setup();
  const accepted = vi.fn();
  s.h.pi.events.on("interactive-shell:suggestion-accepted", accepted);
  const insert = vi.fn(function (this: unknown) {
    expect(this).toBe(s.ctx.ui.editor);
    expect(s.ctx.ui.editorText).toBe(PROMPT);
  });
  s.ctx.ui.editor[Symbol.for("pi-plugins.editor-insert.v1")] = insert;
  await s.h.emit("agent_start", {}, s.ctx);
  expectDisplayed(await s.offer(), PROMPT, false, true);
  expect(s.ctx.ui.press(key)).toBe(false);
  await s.h.emit("agent_end", {}, s.ctx);
  expect(s.ctx.ui.press(key)).toBe(false);
  await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
  expect(s.ctx.ui.press(key)).toBe(false);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expect(insert).not.toHaveBeenCalled();
  await s.h.emit("agent_settled", {}, s.ctx);
  expect(s.ctx.ui.press(key)).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual([PROMPT]);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(accepted).not.toHaveBeenCalled();
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.ctx.ui.press(key)).toBe(false);
  expect(insert).toHaveBeenCalledTimes(1);
  expectNoSubmission(s);
});

test.each(["failed", "aborted", "error", undefined])("unsuccessful or unobserved settlement invalidates acknowledged prompt (%s)", async outcome => {
  const s = await setup();
  await s.h.emit("agent_start", {}, s.ctx);
  await s.offer();
  if (outcome !== undefined) await s.h.emit("agent_before_settle", { outcome }, s.ctx);
  await s.h.emit("agent_settled", {}, s.ctx);
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.ctx.ui.press(TAB)).toBe(false);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expect(s.jev.calls).toEqual([]);
});

test.each(["Final without tag", "Done\n<next>Conflicting automatic suggestion</next>"])("explicit offer survives final answer and bypasses Jev: %j", async text => {
  const s = await setup();
  await s.h.emit("agent_start", {}, s.ctx);
  await s.offer();
  const result: any = await s.h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }] } }, s.ctx);
  if (text.includes("<next>")) expect(result.message.content[0].text).toBe("Done");
  await s.settle();
  expect(s.jev.calls).toEqual([]);
  expect(s.ctx.ui.widgetLines("next-prompt")).toEqual([`→ ${PROMPT}  Tab to accept`]);
  expect(s.ctx.ui.press(TAB)).toBe(true);
  expect(s.ctx.ui.editorText).toBe(PROMPT);
  expectNoSubmission(s);
});

test.each(["focus", "draft"])("post-acknowledgement focus/draft changes cannot overwrite user input (%s)", async change => {
  const s = await setup();
  await s.offer();
  if (change === "focus") s.ctx.ui.focus({});
  else s.ctx.ui.editorText = "my later draft";
  expect(s.ctx.ui.press(TAB)).toBe(false);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  if (change === "draft") expect(s.ctx.ui.editorText).toBe("my later draft");
  s.ctx.ui.focus(s.ctx.ui.editor);
  s.ctx.ui.editorText = "";
  expect(s.ctx.ui.press(TAB)).toBe(false);
});

test("typing invalidates an explicit prompt permanently, not just until the editor is empty", async () => {
  const s = await setup();
  await s.offer();
  expect(s.ctx.ui.press("x", "x")).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.ctx.ui.widgets.size).toBe(0);
  s.ctx.ui.editorText = "";
  s.ctx.ui.press("\x7f");
  await vi.advanceTimersByTimeAsync(0);
  expect(s.ctx.ui.press(TAB)).toBe(false);
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.ctx.ui.editorWrites).toEqual([]);
});


// Completed explicit offers keep their installed surface across temporary Sidebar focus.
test.each([false, true])("completed offer suspends and resumes only on focused render (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  const baseRender = s.ctx.ui.editor.render;
  await s.h.emit("agent_start", {}, s.ctx);
  const text = PROMPT;
  expect((await s.offer(text)).details.status).toBe("displayed");
  await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
  await s.h.emit("agent_settled", {}, s.ctx);
  s.render();
  const installedRender = s.ctx.ui.editor.render;
  const installedWidget = s.ctx.ui.widgets.get("next-prompt");
  const accepted = vi.fn();
  const insert = vi.fn();
  s.h.pi.events.on("interactive-shell:suggestion-accepted", accepted);
  s.ctx.ui.editor[Symbol.for("pi-plugins.editor-insert.v1")] = insert;
  let sidebarDraft = "";
  s.ctx.ui.focus({
    [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded",
    getText: () => sidebarDraft,
  });
  // Even before the first unfocused repaint, neither acceptance nor stash may take it.
  const sidebarTake: { text?: string } = {};
  s.h.pi.events.emit("prompt:take-next", sidebarTake);
  expect(sidebarTake.text).toBeUndefined();
  expect(s.ctx.ui.press("\t")).toBe(false);
  sidebarDraft = "PRIVATE_SIDEBAR_DRAFT";
  expect(s.ctx.ui.press("x")).toBe(false);
  for (let i = 0; i < 3; i++) {
    expect(s.render()).toEqual(ghost ? baseRender(80) : []);
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(s.ctx.ui.editorText).toBe("");
  expect(s.ctx.ui.editor.render).toBe(installedRender);
  expect(s.ctx.ui.widgets.get("next-prompt")).toBe(installedWidget);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expect(insert).not.toHaveBeenCalled();
  const suspended = await lifecycle(s);
  expect(suspended.state).toMatchObject({ suspended: true, editorEmpty: true });
  expect(suspended.after).toMatchObject({ visible: false, suspended: true });
  expect(suspended.trace.filter((event: any) => event.event === "suspend")).toHaveLength(1);
  s.ctx.ui.focus(s.ctx.ui.editor);
  const returnedTake: { text?: string } = {};
  s.h.pi.events.emit("prompt:take-next", returnedTake);
  expect(returnedTake.text).toBeUndefined();
  expect(s.ctx.ui.press("\t")).toBe(false); // Focus alone is not a shown frame.
  const returnedAccept = { handled: false };
  s.h.pi.events.emit("prompt:accept-next", returnedAccept);
  expect(returnedAccept.handled).toBe(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  // No revival keystroke: the retained normal render surface restores the offer.
  expect(s.render()?.join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toContain(text);
  for (let i = 0; i < 5; i++) expect(s.render()?.join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toContain(text);
  const info = await lifecycle(s);
  expect(info.state.suspended).toBe(false);
  expect(info.after).toMatchObject({ visible: true, suspended: false, busy: false, settled: true });
  expect(info.trace.filter((event: any) => event.event === "suspend")).toHaveLength(1);
  expect(info.trace.filter((event: any) => event.event === "resume")).toHaveLength(1);
  expect(info.trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
  expect(JSON.stringify(info)).not.toContain("PRIVATE_SIDEBAR_DRAFT");
  expect(s.ctx.ui.editor.render).toBe(installedRender);
  expect(s.ctx.ui.widgets.get("next-prompt")).toBe(installedWidget);
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual([text]);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(accepted.mock.calls).toEqual([]);
  expect(s.ctx.ui.press("\t")).toBe(false);
  expect(s.ctx.ui.editorWrites).toEqual([text]);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(s.h.messages).toEqual([]);
});

test.each([false, true])("main draft permanently invalidates a suspended offer (ghost=%s)", async ghost => {
  for (const trigger of ["render", "input"]) {
    const s = await setup({ ghost });
    const baseRender = s.ctx.ui.editor.render;
    await s.h.emit("agent_start", {}, s.ctx);
    await s.offer();
    await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
    await s.h.emit("agent_settled", {}, s.ctx);
    s.ctx.ui.focus({ [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded" });
    s.render();
    s.ctx.ui.editorText = "PRIVATE_MAIN_DRAFT";
    if (trigger === "render") s.render();
    else s.ctx.ui.press("x");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.ctx.ui.editorText).toBe("PRIVATE_MAIN_DRAFT");
    expect(s.ctx.ui.editor.render).toBe(baseRender);
    expect(s.ctx.ui.widgets.size).toBe(0);
    s.ctx.ui.editorText = "";
    s.ctx.ui.focus(s.ctx.ui.editor);
    s.render();
    expect(s.ctx.ui.press("\t")).toBe(false);
    const take: { text?: string } = {};
    s.h.pi.events.emit("prompt:take-next", take);
    expect(take.text).toBeUndefined();
    expect(s.ctx.ui.editorWrites).toEqual([]);
  }
});

test.each([false, true])("focus loss remains strict before acknowledgement or while busy (ghost=%s)", async ghost => {
  for (const stage of ["pending", "acknowledged", "before-settle"]) {
    const s = await setup({ ghost });
    const baseRender = s.ctx.ui.editor.render;
    await s.h.emit("agent_start", {}, s.ctx);
    const pending = stage === "pending" ? s.execute() : undefined;
    if (stage !== "pending") await s.offer();
    if (stage === "before-settle") await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
    s.ctx.ui.focus({ [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded" });
    s.render();
    await vi.advanceTimersByTimeAsync(0);
    if (pending) expect((await pending).details.status).toBe("blocked");
    expect(s.ctx.ui.editor.render).toBe(baseRender);
    expect(s.ctx.ui.widgets.size).toBe(0);
    s.ctx.ui.focus(s.ctx.ui.editor);
    await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
    await s.h.emit("agent_settled", {}, s.ctx);
    s.render();
    expect(s.ctx.ui.press("\t")).toBe(false);
    expect(s.ctx.ui.editorWrites).toEqual([]);
  }
});

test.each([false, true])("failed settlement never preserves an unfocused acknowledged offer (ghost=%s)", async ghost => {
  for (const outcome of ["failed", "aborted"]) {
    const s = await setup({ ghost });
    const baseRender = s.ctx.ui.editor.render;
    await s.h.emit("agent_start", {}, s.ctx);
    await s.offer();
    s.ctx.ui.focus({ [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded" });
    await s.h.emit("agent_before_settle", { outcome }, s.ctx);
    await s.h.emit("agent_settled", {}, s.ctx);
    expect(s.ctx.ui.editor.render).toBe(baseRender);
    expect(s.ctx.ui.widgets.size).toBe(0);
    s.ctx.ui.focus(s.ctx.ui.editor);
    s.render();
    expect(s.ctx.ui.press("\t")).toBe(false);
    expect(s.ctx.ui.editorWrites).toEqual([]);
  }
});

test.each([false, true])("reset and new turn dispose a suspended surface permanently (ghost=%s)", async ghost => {
  for (const event of ["agent_start", "input", "user_bash", "prompt:clear", "session_tree", "model_select", "session_compact", "session_start", "session_shutdown", "off"]) {
    const s = await setup({ ghost });
    const baseRender = s.ctx.ui.editor.render;
    await s.h.emit("agent_start", {}, s.ctx);
    await s.offer();
    await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
    await s.h.emit("agent_settled", {}, s.ctx);
    s.ctx.ui.focus({ [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded" });
    s.render();
    if (event === "prompt:clear") s.h.pi.events.emit(event, {});
    else if (event === "off") await s.h.commands.get("next-prompt").handler("off", s.ctx);
    else await s.h.emit(event, {}, s.ctx);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.ctx.ui.editor.render, event).toBe(baseRender);
    expect(s.ctx.ui.widgets.size, event).toBe(0);
    s.ctx.ui.focus(s.ctx.ui.editor);
    s.render();
    expect(s.ctx.ui.press("\t"), event).toBe(false);
    const take: { text?: string } = {};
    s.h.pi.events.emit("prompt:take-next", take);
    expect(take.text, event).toBeUndefined();
    expect(s.ctx.ui.editorWrites, event).toEqual([]);
  }
});

test.each([false, true])("queued invalidation rechecks returned focus instead of clearing the current offer (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  await s.h.emit("agent_start", {}, s.ctx);
  const pending = s.execute();
  s.ctx.ui.focus({ [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded" });
  s.render(); // Queue a strict pre-ack invalidation, but focus returns in this stack.
  s.ctx.ui.focus(s.ctx.ui.editor);
  await Promise.resolve();
  expect(s.render()?.length).toBeGreaterThan(0);
  expect((await pending).details.status).toBe("displayed");
  await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
  await s.h.emit("agent_settled", {}, s.ctx);
  s.render();
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorWrites).toHaveLength(1);
});

test.each([false, true])("stale render invalidation cannot erase a replacement offer (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  const pending = s.execute();
  s.ctx.ui.focus({ [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded" });
  s.render(); // Old owner's invalidation has not run yet.
  s.h.pi.events.emit("prompt:clear", {});
  s.ctx.ui.focus(s.ctx.ui.editor);
  const replacementText = "/replacement one  two";
  const replacement = s.execute(replacementText);
  s.render();
  expect((await pending).details.status).toBe("blocked");
  expect((await replacement).details.status).toBe("displayed");
  await vi.advanceTimersByTimeAsync(0);
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual([replacementText]);
});


test("focused ghost without a cursor remains suspended until output includes the offer", async () => {
  const s = await setup({ ghost: true });
  let cursor = true;
  s.ctx.ui.editor.render = () => cursor ? ["\x1b[7m \x1b[0m"] : ["plain editor without cursor"];
  await s.h.emit("agent_start", {}, s.ctx);
  await s.offer();
  await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
  await s.h.emit("agent_settled", {}, s.ctx);
  s.ctx.ui.focus({ [Symbol.for("pi-plugins.editor-surface.v1")]: "embedded" });
  s.render();
  const installed = s.ctx.ui.editor.render;
  cursor = false;
  s.ctx.ui.focus(s.ctx.ui.editor);
  for (let i = 0; i < 3; i++) expect(s.render()).toEqual(["plain editor without cursor"]);
  const info = await lifecycle(s);
  expect(info.state.suspended).toBe(true);
  expect(info.after).toMatchObject({ visible: false, suspended: true });
  expect(info.trace.filter((event: any) => event.event === "resume")).toHaveLength(0);
  expect(s.ctx.ui.press("\t")).toBe(false);
  const take: { text?: string } = {};
  s.h.pi.events.emit("prompt:take-next", take);
  expect(take.text).toBeUndefined();
  expect(s.ctx.ui.editorWrites).toEqual([]);
  cursor = true;
  expect(s.render()?.join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toContain(PROMPT);
  expect(s.ctx.ui.editor.render).toBe(installed);
  const resumed = await lifecycle(s);
  expect(resumed.state.suspended).toBe(false);
  expect(resumed.trace.filter((event: any) => event.event === "resume")).toHaveLength(1);
  expect(resumed.trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual([PROMPT]);
  expect(s.ctx.ui.press("\t")).toBe(false);
});
