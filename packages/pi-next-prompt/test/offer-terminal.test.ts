import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import nextPrompt from "../src/index.ts";
import { harness } from "./harness.ts";

afterEach(() => vi.useRealTimers());
async function setup(options: { shell?: boolean; ghost?: boolean; maxChars?: number; context?: Record<string, unknown> } = {}) {
  vi.useFakeTimers();
  const h = harness();
  nextPrompt(h.pi);
  const cwd = mkdtempSync("/tmp/offer-terminal-");
  if (options.maxChars !== undefined) {
    mkdirSync(`${cwd}/.pi`);
    writeFileSync(`${cwd}/.pi/next-prompt.json`, JSON.stringify({ maxChars: options.maxChars }));
  }
  const ctx = h.ctx({ cwd, ...options.context });
  if (options.ghost) ctx.ui.editor.render = () => ["\x1b[7m \x1b[0m"];
  let info: any = { available: true, layout: "inline", source: "document-root", rendererMode: "regular" };
  if (options.shell !== false) h.pi.events.on("interactive-shell:inspect", ({ reply }: any) => reply(info));
  await h.emit("session_start", {}, ctx);
  const tool = h.tools.get("offer_terminal");
  const execute = (command = "printf 'one  two'", signal?: AbortSignal) => tool.execute("call", { command }, signal, undefined, ctx);
  const render = () => options.ghost ? ctx.ui.renderEditor() : ctx.ui.widgetLines("next-prompt");
  const offer = async (command?: string) => { const promise = execute(command); render(); return await promise; };
  return { h, ctx, tool, execute, render, offer, shell: (value: any) => { info = value; } };
}

test("model-only schema and guidelines require verified display", async () => {
  const { tool } = await setup();
  expect(tool.exposure).toBe("model-only");
  expect(tool.label).toBe("Offer terminal command");
  expect(tool.parameters.properties.command).toMatchObject({ type: "string", minLength: 1 });
  expect(tool.promptGuidelines.join(" ")).toContain("status displayed");
});

test.each(["", "  ", " true", "true ", "one\ntwo", "one\rtwo", "one\x1btwo", "one\x00two", "!i true", "!!i true"])("rejects invalid input %j", async command => {
  const { execute, ctx } = await setup();
  expect((await execute(command)).details.status).toBe("blocked");
  expect(ctx.ui.widgets.size).toBe(0);
});

test.each([false, true])("acknowledges only actual output, preserving raw shell text (ghost=%s)", async ghost => {
  const { execute, render, ctx } = await setup({ ghost });
  const command = "sh -c 'printf \"one  two\"'";
  let done = false;
  const promise = execute(command).then((value: any) => { done = true; return value; });
  await Promise.resolve();
  expect(done).toBe(false); // Neither the widget factory nor the ghost cursor preflight is a render.
  expect(render()?.length).toBeGreaterThan(0);
  const result = await promise;
  expect(result.details).toMatchObject({ status: "displayed", kind: "terminal", text: `!i ${command}`, surface: ghost ? "ghost" : "widget" });
  expect(result.content[0].text).toContain(`!i ${command}`);
  expect(ctx.ui.editorWrites).toEqual([]);
});

test("boundary whitespace is rejected rather than silently trimmed by Pi submission", async () => {
  const { execute, ctx } = await setup();
  for (const command of [" sh -c 'printf \"one  two\"'", "sh -c 'printf \"one  two\"' "]) {
    const result = await execute(command);
    expect(result.details.reason).toContain("leading or trailing whitespace cannot be preserved");
    expect(ctx.ui.widgets.size).toBe(0);
  }
});

test("timeout and abort clear owned offers", async () => {
  for (const abort of [false, true]) {
    const { execute, ctx } = await setup();
    const controller = new AbortController();
    const promise = execute("true", controller.signal);
    if (abort) controller.abort();
    else await vi.advanceTimersByTimeAsync(1_000);
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(result.details.reason).toContain(abort ? "aborted" : "one second");
    expect(ctx.ui.widgets.size).toBe(0);
    expect(ctx.ui.press("\t")).toBe(false);
  }
});

test("blocked states report concrete reasons", async () => {
  for (const mode of ["disabled", "draft", "focus", "external", "missing", "unsupported", "rpc", "unattached", "limit"]) {
    const s = await setup({ shell: mode !== "missing", context: mode === "rpc" ? { mode: "rpc" } : mode === "unattached" ? { hasUI: false } : {}, maxChars: mode === "limit" ? 4 : undefined });
    if (mode === "disabled") await s.h.commands.get("next-prompt").handler("off", s.ctx);
    if (mode === "draft") s.ctx.ui.editorText = "draft";
    if (mode === "focus") s.ctx.ui.focus({});
    if (mode === "external") s.h.pi.events.emit("prompt:offer", { source: "other", text: "external" });
    if (mode === "unsupported") s.shell({ available: false, layout: "unsupported", reason: "malformed document", shape: { rootChildren: ["Container"] }, rendererMode: "fullscreen" });
    const result = await s.execute("true");
    expect(result.details.status, mode).toBe("blocked");
    expect(result.details.reason, mode).toBeTruthy();
    if (mode === "unsupported") expect(result.details.reason).toContain("malformed document");
  }
});

test("busy offer is visible, outranks tags and survives tagless final answer; settlement enables acceptance", async () => {
  const { h, ctx, offer } = await setup();
  await h.emit("agent_start", {}, ctx);
  expect((await offer("true")).details.acceptAfterTurn).toBe(true);
  expect(ctx.ui.press("\t")).toBe(false);
  expect(ctx.ui.editorWrites).toEqual([]);
  const tagged: any = await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done\n<next>Other</next>" }] } }, ctx);
  expect(tagged.message.content[0].text).toBe("Done");
  await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Final without tag" }] } }, ctx);
  await h.emit("agent_before_settle", { outcome: "completed" }, ctx);
  await h.emit("agent_settled", {}, ctx);
  const accepted: any[] = [];
  h.pi.events.on("interactive-shell:suggestion-accepted", (value: any) => accepted.push(value));
  expect(ctx.ui.press("\t")).toBe(true);
  expect(ctx.ui.editorText).toBe("!i true");
  expect(accepted).toEqual([{ text: "!i true" }]);
  expect(h.messages).toEqual([]);
});

test.each(["aborted", "failed"])("unsuccessful settlement clears explicit offer (%s)", async outcome => {
  const { h, ctx, offer } = await setup();
  await h.emit("agent_start", {}, ctx);
  await offer();
  await h.emit("agent_before_settle", { outcome }, ctx);
  await h.emit("agent_settled", {}, ctx);
  expect(ctx.ui.widgets.size).toBe(0);
});

test("identical rendered offers are idempotent and conflicts never overwrite", async () => {
  const { execute, offer, h, ctx } = await setup();
  const first = await offer("true");
  expect((await execute("true")).details).toEqual(first.details);
  expect((await execute("false")).details.reason).toContain("different explicit");
  h.pi.events.emit("prompt:offer", { source: "other", text: "external" });
  ctx.ui.press("\t");
  expect(ctx.ui.editorText).toBe("!i true");
});

test.each(["input", "session_tree", "model_select", "session_compact", "session_shutdown", "user_bash"])("reset settles pending render waiter (%s)", async event => {
  const { execute, h, ctx } = await setup();
  const promise = execute();
  await h.emit(event, {}, ctx);
  expect((await promise).details.status).toBe("blocked");
  expect(ctx.ui.widgets.size).toBe(0);
});

test.each([false, true])("draft/focus changes before render never acknowledge (focus=%s)", async focus => {
  const { execute, render, ctx } = await setup();
  const promise = execute();
  if (focus) ctx.ui.focus({});
  else ctx.ui.editorText = "my draft";
  render();
  expect((await promise).details.status).toBe("blocked");
  expect(ctx.ui.widgets.size).toBe(0);
});

test("queued render acknowledgement rechecks draft and generation", async () => {
  const { execute, render, ctx } = await setup({ ghost: true });
  const promise = execute();
  render();
  ctx.ui.editorText = "draft entered after output";
  await vi.advanceTimersByTimeAsync(0);
  expect((await promise).details.status).toBe("blocked");
  expect(ctx.ui.editorText).toBe("draft entered after output");
});

test("pending duplicate is blocked without invalidating the original; status records acknowledgement", async () => {
  const { execute, render, h, ctx } = await setup();
  const pending = execute("true");
  expect((await execute("true")).details.reason).toContain("awaiting render");
  render();
  expect((await pending).details.status).toBe("displayed");
  await h.commands.get("next-prompt").handler("status", ctx);
  expect(ctx.ui.notes.at(-1).message).toContain("rendered");
  expect(ctx.ui.notes.at(-1).message).toContain("displayed (widget)");
});

test("already-aborted tool never installs an offer", async () => {
  const { execute, ctx } = await setup();
  const controller = new AbortController();
  controller.abort();
  expect((await execute("true", controller.signal)).details.reason).toContain("aborted");
  expect(ctx.ui.widgets.size).toBe(0);
});

test.each(["prompt", "terminal"])("cross-tool ownership conflicts never replace the %s offer", async first => {
  const { h, ctx, offer, execute } = await setup();
  const prompt = () => h.tools.get("offer_prompt").execute("prompt", { text: "/fixture one  two" }, undefined, undefined, ctx);
  if (first === "terminal") await offer("true");
  else {
    const pending = prompt();
    ctx.ui.widgetLines("next-prompt");
    expect((await pending).details.kind).toBe("prompt");
  }
  const conflict = await (first === "terminal" ? prompt() : execute("true"));
  expect(conflict.details).toMatchObject({ status: "blocked", kind: first === "terminal" ? "prompt" : "terminal" });
  expect(conflict.details.reason).toContain("different explicit offer");
  const accepted: unknown[] = [];
  h.pi.events.on("interactive-shell:suggestion-accepted", (value: unknown) => accepted.push(value));
  expect(ctx.ui.press("\t")).toBe(true);
  expect(ctx.ui.editorText).toBe(first === "terminal" ? "!i true" : "/fixture one  two");
  expect(accepted).toEqual(first === "terminal" ? [{ text: "!i true" }] : []);
});

test("only terminal offers inspect shell support and preserve guard ordering", async () => {
  const { h, ctx, execute } = await setup({ shell: false });
  const inspect = vi.fn(({ reply }: any) => reply({ available: false, reason: "fixture unavailable" }));
  h.pi.events.on("interactive-shell:inspect", inspect);
  ctx.ui.editorText = "draft";
  expect((await execute("true")).details.reason).toBe("editor contains a draft");
  expect(inspect).not.toHaveBeenCalled();
  ctx.ui.editorText = "";
  expect((await execute("true")).details.reason).toContain("fixture unavailable");
  expect(inspect).toHaveBeenCalledTimes(1);
  const pending = h.tools.get("offer_prompt").execute("prompt", { text: "/fixture" }, undefined, undefined, ctx);
  ctx.ui.widgetLines("next-prompt");
  expect((await pending).details.status).toBe("displayed");
  expect(inspect).toHaveBeenCalledTimes(1);
});

test("normal typing invalidates an explicit offer rather than reappearing", async () => {
  const { offer, ctx } = await setup();
  await offer();
  ctx.ui.press("x", "x");
  await vi.advanceTimersByTimeAsync(0);
  ctx.ui.editorText = "";
  expect(ctx.ui.press("\t")).toBe(false);
});
