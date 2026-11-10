import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import nextPrompt from "../src/index.ts";
import { fakeJev, harness } from "./harness.ts";

afterEach(() => vi.useRealTimers());

test("readable terminal diagnostics omit command, draft, answer and shell JSON", async () => {
  const s = await setup({ ghost: true });
  await s.h.emit("agent_start", {}, s.ctx);
  await s.offer("printf 'PRIVATE_COMMAND'");
  await s.h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_ANSWER" }] } }, s.ctx);
  await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
  await s.h.emit("agent_settled", {}, s.ctx);
  s.render();
  s.ctx.ui.editorText = "PRIVATE_DRAFT";
  s.ctx.ui.press("x");
  for (const args of ["status", "trace"]) {
    await s.h.commands.get("next-prompt").handler(args, s.ctx);
    expect(s.ctx.ui.notes.at(-1)!.message).not.toMatch(/PRIVATE|printf|\{|\}/);
  }
  s.ctx.ui.editorText = "";
  s.shell({ available: false, layout: "unsupported", reason: "malformed document", shape: { rootChildren: ["Container"] } });
  expect((await s.execute()).details.status).toBe("blocked");
  await s.h.commands.get("next-prompt").handler("status", s.ctx);
  const status = s.ctx.ui.notes.at(-1)!.message;
  expect(status).toContain("interactive-shell unavailable");
  expect(status).not.toMatch(/\{|\}|rootChildren/);
});
async function diagnostics(s: Awaited<ReturnType<typeof setup>>) {
  await s.h.commands.get("next-prompt").handler("status", s.ctx);
  return s.diagnostics();
}

test.each([false, true])("diagnostics distinguish mid-turn output, final answer and post-settlement output (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  await s.h.emit("agent_start", {}, s.ctx);
  expect((await s.offer("printf 'PRIVATE_COMMAND'")).details.status).toBe("displayed");
  const mid = await diagnostics(s);
  expect(mid.before).toMatchObject({ visible: true, busy: true, settled: false });
  expect(mid.after).toBeNull();
  expect(mid.ready).toBe(true);
  expect(mid.trace.map((event: any) => event.event)).toEqual(expect.arrayContaining(["create", "show", "acknowledge"]));
  if (ghost) expect(mid.trace.some((event: any) => event.event === "patch-install")).toBe(true);
  await s.h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_FINAL" }] } }, s.ctx);
  s.render(); // The final-answer repaint still precedes settlement.
  await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
  await s.h.emit("agent_settled", {}, s.ctx);
  const settled = await diagnostics(s);
  expect(settled.after).toBeNull(); // Status must not render or manufacture acknowledgement.
  s.render();
  const post = await diagnostics(s);
  expect(post.before).toEqual(mid.before);
  expect(post.after).toMatchObject({ visible: true, busy: false, settled: true });
  const count = post.trace.length;
  for (let i = 0; i < 100; i++) s.render();
  expect((await diagnostics(s)).trace).toHaveLength(count);
  // Typing the status command causes ordinary input invalidation, but retains the preceding evidence.
  await s.h.emit("input", { text: "/next-prompt status" }, s.ctx);
  const removed = await diagnostics(s);
  expect(removed.trace).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: "acknowledge" }),
    expect.objectContaining({ event: "hide", reason: "input" }),
  ]));
  expect(removed.state.offerId).toBeNull();
  expect(JSON.stringify(removed)).not.toMatch(/PRIVATE_COMMAND|PRIVATE_FINAL|printf|next-prompt status/);
});

test("lifecycle trace is bounded across ordinary turns and cleared on session replacement", async () => {
  const s = await setup();
  for (let i = 0; i < 20; i++) {
    await s.h.emit("agent_start", {}, s.ctx);
    await s.offer(`printf 'PRIVATE_${i}'`);
    await s.h.emit("input", { text: "PRIVATE_INPUT" }, s.ctx);
  }
  const info = await diagnostics(s);
  expect(info.trace).toHaveLength(32);
  expect(JSON.stringify(info)).not.toContain("PRIVATE");
  expect(new Set(info.trace.filter((event: any) => event.event === "create").map((event: any) => event.offerId)).size).toBeGreaterThan(1);
  await s.h.emit("session_start", {}, s.ctx);
  const fresh = await diagnostics(s);
  expect(fresh.trace.map((event: any) => event.reason)).toEqual(["session_start", "session_start"]);
  expect(fresh.before).toBeNull();
  expect(fresh.after).toBeNull();
});

test.each(["agent_start", "input", "user_bash", "prompt:clear", "session_tree", "model_select", "session_compact", "session_shutdown"])("retains a named reset cause after acknowledged removal: %s", async event => {
  const s = await setup();
  await s.offer();
  if (event === "prompt:clear") s.h.pi.events.emit(event, {});
  else await s.h.emit(event, {}, s.ctx);
  const info = await diagnostics(s);
  expect(info.trace).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: "acknowledge" }),
    expect.objectContaining({ event: "reset", reason: event }),
    expect.objectContaining({ event: "hide", reason: event }),
  ]));
  expect(info.state.offerId).toBeNull();
});

test("render-wrapper replacement is distinguishable from a successful receipt", async () => {
  const s = await setup({ ghost: true });
  await s.h.emit("agent_start", {}, s.ctx);
  await s.offer();
  s.ctx.ui.editor.render = () => ["replacement editor output"];
  await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
  await s.h.emit("agent_settled", {}, s.ctx);
  s.render();
  const info = await diagnostics(s);
  expect(info.before).toMatchObject({ visible: true, patchCurrent: true });
  expect(info.after).toBeNull(); // A replaced wrapper cannot observe subsequent frames.
  expect(info.state.patchCurrent).toBe(false);
  expect(info.trace).toContainEqual(expect.objectContaining({ event: "patch-replaced", reason: "render wrapper replaced" }));
  expect(info.trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
});
async function setup(options: { shell?: boolean; ghost?: boolean; maxChars?: number; context?: Record<string, unknown> } = {}) {
  vi.useFakeTimers();
  const h = harness();
  const sendUserMessage = vi.fn();
  const executeCommand = vi.fn();
  Object.assign(h.pi, { sendUserMessage, executeCommand });
  const diagnostics = nextPrompt(h.pi);
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
  return { h, ctx, tool, execute, render, offer, diagnostics, sendUserMessage, executeCommand, shell: (value: any) => { info = value; } };
}

function expectQueued(result: any, command = "printf 'one  two'", reason = "editor contains a draft") {
  const text = `!i ${command}`;
  expect(result.details).toEqual({ status: "queued", kind: "terminal", text, reason });
  expect(result.isError).toBeUndefined();
  expect(result.content).toEqual([{
    type: "text",
    text: `Queued editable suggestion: ${text}\nYour existing draft is unchanged. Once the editor is empty and the suggestion appears, press Tab/Right to copy it into an editable draft. Wait for the current response to finish before pressing Enter to run it. Nothing was executed.`,
  }]);
}

function expectNoExecution(s: Awaited<ReturnType<typeof setup>>) {
  expect(s.sendUserMessage).not.toHaveBeenCalled();
  expect(s.executeCommand).not.toHaveBeenCalled();
  expect(s.h.messages).toEqual([]);
}

test("model-only schema and guidelines distinguish verified display, queueing and blockers", async () => {
  const { tool } = await setup();
  expect(tool.exposure).toBe("model-only");
  expect(tool.label).toBe("Offer terminal command");
  expect(tool.description).toBe("Offer an editable !i suggestion, never execute it. Returns queued behind an existing draft; otherwise waits up to one second for render acknowledgement and returns displayed or a concrete blocker.");
  expect(tool.parameters.properties.command).toMatchObject({ type: "string", minLength: 1 });
  const guidelines = tool.promptGuidelines.join(" ");
  expect(guidelines).toContain("status displayed permits claiming a visible offer");
  expect(guidelines).toContain("On status queued");
  expect(guidelines).toContain("clear or stash the draft to reveal it");
  expect(guidelines).toContain("Do not claim it was displayed or inserted");
  expect(guidelines).toMatch(/blocker/i);
  expect(guidelines).toMatch(/secret|credential/i);
  expect(guidelines).toContain("Tab/Right to copy the suggestion immediately into an editable draft");
  expect(guidelines).toContain("Enter is a separate submission");
  expect(guidelines).toContain("Wait for the current response to finish before pressing Enter to run an interactive command.");
});

test.each(["", "  ", " true", "true ", "one \\ \ntwo", "one\r\ntwo", "one\rtwo", "one\x1btwo", "one\x00two", "!i true", "!!i true"])("rejects invalid input %j", async command => {
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
  expect(result.details).toEqual({ status: "displayed", kind: "terminal", text: `!i ${command}`, surface: ghost ? "ghost" : "widget", acceptAfterTurn: false });
  expect(result.content).toEqual([{
    type: "text",
    text: `Displayed editable suggestion: !i ${command}\nPress Tab/Right to copy it into an editable draft now. Wait for the current response to finish before pressing Enter to run it. Nothing was executed.`,
  }]);
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
  for (const mode of ["disabled", "focus", "external", "missing", "unsupported", "rpc", "unattached", "limit"]) {
    const s = await setup({ shell: mode !== "missing", context: mode === "rpc" ? { mode: "rpc" } : mode === "unattached" ? { hasUI: false } : {}, maxChars: mode === "limit" ? 4 : undefined });
    if (mode === "disabled") await s.h.commands.get("next-prompt").handler("off", s.ctx);
    if (mode === "focus") s.ctx.ui.focus({});
    if (mode === "external") s.h.pi.events.emit("prompt:offer", { source: "other", text: "external" });
    if (mode === "unsupported") s.shell({ available: false, layout: "unsupported", reason: "malformed document", shape: { rootChildren: ["Container"] }, rendererMode: "fullscreen" });
    const result = await s.execute("true");
    expect(result.details.status, mode).toBe("blocked");
    expect(result.details.reason, mode).toBeTruthy();
    if (mode === "unsupported") expect(result.details.reason).toContain("malformed document");
  }
});

test.each([false, true])("preexisting draft queues an exact terminal suggestion without rendering or execution (ghost=%s)", async ghost => {
  const jev = fakeJev(() => ({ useful: { type: "bool", probability: 0.9 } }));
  const s = await setup({ ghost, context: { modelRegistry: jev.registry } });
  const command = "sh -c 'printf \"one  two 日本語\"'";
  const text = `!i ${command}`;
  const draft = "PRIVATE_DRAFT  日本語\nsecond line";
  s.ctx.ui.edit(draft);
  const original = s.ctx.ui.editor.render;
  const timerCount = vi.getTimerCount();
  expectQueued(await s.execute(command), command);
  expect(vi.getTimerCount()).toBe(timerCount);
  expect(s.ctx.ui.editor.render).toBe(original);
  expect(s.ctx.ui.widgets.size).toBe(0);
  for (const key of ["\t", "\x1b[C"]) expect(s.ctx.ui.press(key)).toBe(false);
  const take: { text?: string } = {};
  s.h.pi.events.emit("prompt:take-next", take);
  expect(take).toEqual({});
  expect(s.ctx.ui.editorText).toBe(draft);
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expect(jev.calls).toEqual([]);
  expectNoExecution(s);
  s.ctx.ui.setEditorText("");
  await vi.advanceTimersByTimeAsync(0);
  expect(s.render()?.join("").replace(/\x1b\[[0-9;]*m/g, "")).toContain(text);
  expect(s.ctx.ui.press("\t")).toBe(false);
  await Promise.resolve();
  expect(s.ctx.ui.press("\x1b[C")).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual(["", text]);
  expectNoExecution(s);
});

test.each([false, true])("queued terminal repeats retain ownership and wait for actual later output (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  s.ctx.ui.edit("PRIVATE_DRAFT");
  const first = await s.execute("true");
  expectQueued(first, "true");
  const before = s.diagnostics();
  expect(await s.execute("true")).toEqual(first);
  expect(s.diagnostics()).toEqual(before);
  expect((await s.execute("false")).details.reason).toContain("different explicit");
  const conflict = await s.h.tools.get("offer_prompt").execute("prompt", { text: "/different" }, undefined, undefined, s.ctx);
  expect(conflict.details.reason).toContain("different explicit");
  s.h.pi.events.emit("prompt:offer", { source: "other", text: "external" });
  s.h.pi.events.emit("prompt:offer", { source: "other" });
  s.ctx.ui.edit("");
  await vi.advanceTimersByTimeAsync(0);
  expectQueued(await s.execute("true"), "true", "awaiting render acknowledgement");
  expect(s.diagnostics().state.offerId).toBe(before.state.offerId);
  expect(s.diagnostics().trace.filter((event: any) => event.event === "create")).toHaveLength(1);
  expect(s.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toEqual([]);
  s.render();
  await Promise.resolve();
  const displayed = await s.execute("true");
  expect(displayed.details).toEqual({ status: "displayed", kind: "terminal", text: "!i true", surface: ghost ? "ghost" : "widget", acceptAfterTurn: false });
  s.ctx.ui.edit("restored draft");
  await vi.advanceTimersByTimeAsync(0);
  expectQueued(await s.execute("true"), "true");
  s.ctx.ui.edit("");
  await vi.advanceTimersByTimeAsync(0);
  s.render();
  await Promise.resolve();
  expect(s.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorText).toBe("!i true");
});

test.each([false, true])("queued terminal has no deadline or lingering abort listener (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  const controller = new AbortController();
  s.ctx.ui.edit("draft");
  expectQueued(await s.execute("true", controller.signal), "true");
  controller.abort();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(s.diagnostics().offer).toBe("concealed");
  s.ctx.ui.edit("");
  await vi.advanceTimersByTimeAsync(0);
  s.render();
  await Promise.resolve();
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual(["!i true"]);
  expectNoExecution(s);
});

test.each([false, true])("queued terminal diagnostics remain private and never manufacture output (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  s.ctx.ui.edit("PRIVATE_DRAFT");
  expectQueued(await s.execute("printf 'PRIVATE_COMMAND'"), "printf 'PRIVATE_COMMAND'");
  await vi.advanceTimersByTimeAsync(0);
  const render = vi.spyOn(s.ctx.ui.editor, "render");
  const widget = vi.spyOn(s.ctx.ui, "widgetLines");
  const before = s.diagnostics();
  for (const args of ["status", "trace"]) {
    await s.h.commands.get("next-prompt").handler(args, s.ctx);
    expect(s.ctx.ui.notes.at(-1).message).not.toMatch(/PRIVATE|printf|\{|\}/);
  }
  expect(render).not.toHaveBeenCalled();
  expect(widget).not.toHaveBeenCalled();
  expect(s.diagnostics()).toEqual(before);
  expect(before.lastExplicit).toBe("terminal queued behind draft");
  expect(before.explicit).toContain("queued");
  expect(before.trace.length).toBeLessThanOrEqual(32);
  expect(before.trace.filter((event: any) => event.event === "acknowledge")).toEqual([]);
  expect(s.ctx.ui.editorWrites).toEqual([]);
});

test.each(["input", "session_tree", "model_select", "session_compact", "session_shutdown", "session_start", "user_bash", "agent_start", "prompt:clear", "off"])("reset drops a queued terminal and its scheduled clear (%s)", async event => {
  const s = await setup();
  s.ctx.ui.edit("draft");
  expectQueued(await s.execute());
  s.ctx.ui.edit("");
  if (event === "prompt:clear") s.h.pi.events.emit(event, {});
  else if (event === "off") await s.h.commands.get("next-prompt").handler("off", s.ctx);
  else await s.h.emit(event, {}, s.ctx);
  await vi.advanceTimersByTimeAsync(0);
  expect(s.render()).toBeUndefined();
  expect(s.ctx.ui.press("\t")).toBe(false);
  expect(s.diagnostics().state.offerId).toBeNull();
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expectNoExecution(s);
});

test.each(["completed", "failed", "aborted", "error"])("queued terminal settlement retains only successful ownership (%s)", async outcome => {
  const s = await setup();
  await s.h.emit("agent_start", {}, s.ctx);
  s.ctx.ui.edit("draft");
  expectQueued(await s.execute());
  await s.h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Done\n<next>Conflicting automatic suggestion</next>" }] } }, s.ctx);
  await s.h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Final without tag" }] } }, s.ctx);
  await s.h.emit("agent_before_settle", { outcome }, s.ctx);
  await s.h.emit("agent_settled", {}, s.ctx);
  s.ctx.ui.edit("");
  await vi.advanceTimersByTimeAsync(0);
  s.render();
  await Promise.resolve();
  expect(s.ctx.ui.press("\t")).toBe(outcome === "completed");
  expect(s.ctx.ui.editorWrites).toEqual(outcome === "completed" ? ["!i printf 'one  two'"] : []);
  expectNoExecution(s);
});

test.each(["missing", "unsupported", "invalid", "limit"])("terminal validation is still blocked behind drafts (%s)", async mode => {
  const s = await setup({ shell: mode !== "missing", maxChars: mode === "limit" ? 4 : undefined });
  s.ctx.ui.edit("PRIVATE_DRAFT");
  if (mode === "unsupported") s.shell({ available: false, layout: "unsupported", reason: "unsupported fixture" });
  const result = await s.execute(mode === "invalid" ? "!i true" : "true");
  expect(result.details.status).toBe("blocked");
  expect(result.isError).toBe(true);
  expect(result.details.reason).toContain({ missing: "missing", unsupported: "unsupported fixture", invalid: "prefix", limit: "maxChars" }[mode]);
  expect(s.diagnostics().state.offerId).toBeNull();
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.ctx.ui.editorText).toBe("PRIVATE_DRAFT");
  expect(s.ctx.ui.editorWrites).toEqual([]);
  expectNoExecution(s);
});

test.each([false, true].flatMap(ghost => ["\t", "\x1b[C"].map(key => ({ ghost, key }))))("busy terminal acceptance immediately copies an acknowledged draft without execution (ghost=$ghost, key=$key)", async ({ ghost, key }) => {
  const s = await setup({ ghost });
  const command = "sh -c 'printf \"one  two 日本語\"'";
  const text = `!i ${command}`;
  const accepted = vi.fn();
  const insert = vi.fn();
  s.h.pi.events.on("interactive-shell:suggestion-accepted", accepted);
  s.ctx.ui.editor[Symbol.for("pi-plugins.editor-insert.v1")] = insert;
  await s.h.emit("agent_start", {}, s.ctx);
  const pending = s.execute(command);
  expect(s.diagnostics().ready).toBe(false);
  expect(s.ctx.ui.press(key)).toBe(false);
  s.render();
  expect(s.ctx.ui.press(key)).toBe(false); // A queued acknowledgement is not a receipt yet.
  expect(s.ctx.ui.editorWrites).toEqual([]);
  const result = await pending;
  expect(result.details).toEqual({ status: "displayed", kind: "terminal", text, surface: ghost ? "ghost" : "widget", acceptAfterTurn: false });
  expect(result.content[0].text).toBe(`Displayed editable suggestion: ${text}\nPress Tab/Right to copy it into an editable draft now. Wait for the current response to finish before pressing Enter to run it. Nothing was executed.`);
  expect(s.diagnostics().state.busy).toBe(true);
  expect(s.diagnostics().ready).toBe(true);
  expect(s.ctx.ui.press(key)).toBe(true);
  expect(s.ctx.ui.editorText).toBe(text);
  expect(s.ctx.ui.editorWrites).toEqual([text]);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(accepted.mock.calls).toEqual([[{ text }]]);
  expect(s.ctx.ui.press(key)).toBe(false);
  expect(s.ctx.ui.editorWrites).toEqual([text]);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(s.diagnostics().ready).toBe(false);
  expect(s.sendUserMessage).not.toHaveBeenCalled();
  expect(s.executeCommand).not.toHaveBeenCalled();
  expect(s.h.messages).toEqual([]);
});

test("unaccepted busy offer outranks tags and survives tagless successful final answer", async () => {
  const { h, ctx, offer, diagnostics } = await setup();
  await h.emit("agent_start", {}, ctx);
  expect((await offer("true")).details.acceptAfterTurn).toBe(false);
  expect(diagnostics().ready).toBe(true);
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

test.each(["aborted", "failed", "error"])("unsuccessful settlement clears explicit offer (%s)", async outcome => {
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

test.each([false, true])("focus changes before render never acknowledge (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  const promise = s.execute();
  s.ctx.ui.focus({});
  s.render();
  expect((await promise).details.status).toBe("blocked");
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toEqual([]);
});

test.each([false, true])("live draft arrival completes a terminal waiter without a render (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  const pending = s.execute();
  const render = vi.spyOn(s.ctx.ui.editor, "render");
  const widget = vi.spyOn(s.ctx.ui, "widgetLines");
  s.ctx.ui.edit("PRIVATE_DRAFT before output");
  expectQueued(await pending);
  expect(render).not.toHaveBeenCalled();
  expect(widget).not.toHaveBeenCalled();
  expect(s.ctx.ui.widgets.size).toBe(0);
  expect(s.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  s.ctx.ui.edit("");
  await vi.advanceTimersByTimeAsync(0);
  s.render();
  await Promise.resolve();
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual(["!i printf 'one  two'"]);
  expectNoExecution(s);
});

test.each([false, true])("draft before output or racing acknowledgement queues terminal ownership (ghost=%s)", async ghost => {
  for (const rendered of [false, true]) {
    const s = await setup({ ghost });
    const promise = s.execute();
    if (rendered) s.render();
    // Bypass the observer to check live guards, not just deferred reconciliation.
    s.ctx.ui.editorText = "PRIVATE_DRAFT entered after output";
    if (!rendered) expect(s.render()?.join("") ?? "").not.toContain("printf");
    expectQueued(await promise);
    expect(s.ctx.ui.editorText).toBe("PRIVATE_DRAFT entered after output");
    expect(s.ctx.ui.editorWrites).toEqual([]);
    expect(s.ctx.ui.widgets.size).toBe(0);
    expect(s.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    s.ctx.ui.edit("");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.ctx.ui.press("\t")).toBe(false);
    s.render();
    await Promise.resolve();
    expect(s.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
    expect(s.ctx.ui.press("\t")).toBe(true);
    expect(s.ctx.ui.editorWrites).toEqual(["!i printf 'one  two'"]);
    expectNoExecution(s);
  }
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
  expect((await execute("true")).details.reason).toContain("fixture unavailable");
  expect(inspect).toHaveBeenCalledTimes(1);
  // Non-draft eligibility checks still run ahead of the optional inspector.
  ctx.ui.focus({});
  expect((await execute("true")).details.reason).toContain("focused");
  expect(inspect).toHaveBeenCalledTimes(1);
  ctx.ui.focus(ctx.ui.editor);
  ctx.ui.editorText = "";
  const pending = h.tools.get("offer_prompt").execute("prompt", { text: "/fixture" }, undefined, undefined, ctx);
  ctx.ui.widgetLines("next-prompt");
  expect((await pending).details.status).toBe("displayed");
  expect(inspect).toHaveBeenCalledTimes(1);
});

test.each([false, true])("normal typing conceals an acknowledged terminal offer and clearing reveals it (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  const accepted = vi.fn();
  s.h.pi.events.on("interactive-shell:suggestion-accepted", accepted);
  await s.h.emit("agent_start", {}, s.ctx);
  await s.offer();
  const owner = s.diagnostics().state.offerId;
  for (const draft of ["x", "restored  draft 日本語", "swapped draft"]) {
    s.ctx.ui.edit(draft);
    expect(s.render()?.join("") ?? "").not.toContain("printf");
    expect(s.ctx.ui.press("\t")).toBe(false);
    const take: { text?: string } = {};
    s.h.pi.events.emit("prompt:take-next", take);
    expect(take).toEqual({});
    await vi.advanceTimersByTimeAsync(0);
    expect(s.ctx.ui.widgets.size).toBe(0);
    expect(s.ctx.ui.editorText).toBe(draft);
    expect(s.diagnostics().state.offerId).toBe(owner);
    s.ctx.ui.edit("");
    await vi.advanceTimersByTimeAsync(0);
    s.render();
  }
  expect(s.diagnostics().state.busy).toBe(true);
  expect(s.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual(["!i printf 'one  two'"]);
  expect(accepted.mock.calls).toEqual([[{ text: "!i printf 'one  two'" }]]);
  expectNoExecution(s);
});


// Completed explicit offers keep their installed surface across temporary Sidebar focus.
test.each([false, true])("completed offer suspends and resumes only on focused render (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  const baseRender = s.ctx.ui.editor.render;
  await s.h.emit("agent_start", {}, s.ctx);
  const text = "!i sh -c 'printf \"one  two\"'";
  expect((await s.offer(text.slice(3))).details.status).toBe("displayed");
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
  const suspended = await diagnostics(s);
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
  const info = await diagnostics(s);
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
  expect(accepted.mock.calls).toEqual([[{ text }]]);
  expect(s.ctx.ui.press("\t")).toBe(false);
  expect(s.ctx.ui.editorWrites).toEqual([text]);
  expect(insert).toHaveBeenCalledTimes(1);
  expect(s.h.messages).toEqual([]);
});

test.each([false, true])("main draft conceals a suspended terminal offer until cleared with main focus (ghost=%s)", async ghost => {
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
    s.ctx.ui.edit("");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.ctx.ui.widgets.size).toBe(0);
    s.ctx.ui.focus(s.ctx.ui.editor);
    s.ctx.ui.press("\x1b[A");
    await vi.advanceTimersByTimeAsync(0);
    s.render();
    expect(s.ctx.ui.editorWrites).toEqual([]);
    expect(s.diagnostics().trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
    expect(s.ctx.ui.press("\t")).toBe(true);
    expect(s.ctx.ui.editorWrites).toEqual(["!i printf 'one  two'"]);
    expectNoExecution(s);
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
  const replacementText = "printf 'replacement  bytes'";
  const replacement = s.execute(replacementText);
  s.render();
  expect((await pending).details.status).toBe("blocked");
  expect((await replacement).details.status).toBe("displayed");
  await vi.advanceTimersByTimeAsync(0);
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual([`!i ${replacementText}`]);
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
  const info = await diagnostics(s);
  expect(info.state.suspended).toBe(true);
  expect(info.after).toMatchObject({ visible: false, suspended: true });
  expect(info.trace.filter((event: any) => event.event === "resume")).toHaveLength(0);
  expect(s.ctx.ui.press("\t")).toBe(false);
  const take: { text?: string } = {};
  s.h.pi.events.emit("prompt:take-next", take);
  expect(take.text).toBeUndefined();
  expect(s.ctx.ui.editorWrites).toEqual([]);
  cursor = true;
  expect(s.render()?.join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toContain("!i printf 'one  two'");
  expect(s.ctx.ui.editor.render).toBe(installed);
  const resumed = await diagnostics(s);
  expect(resumed.state.suspended).toBe(false);
  expect(resumed.trace.filter((event: any) => event.event === "resume")).toHaveLength(1);
  expect(resumed.trace.filter((event: any) => event.event === "acknowledge")).toHaveLength(1);
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorWrites).toEqual(["!i printf 'one  two'"]);
  expect(s.ctx.ui.press("\t")).toBe(false);
});

test("an acknowledged offer survives /reload into the new extension instance", async () => {
  const s = await setup();
  await s.h.emit("agent_start", {}, s.ctx);
  expect((await s.offer()).details.status).toBe("displayed");
  await s.h.emit("agent_before_settle", { outcome: "completed" }, s.ctx);
  await s.h.emit("agent_settled", {}, s.ctx);
  await s.h.emit("session_shutdown", { reason: "reload" }, s.ctx);
  // Pi builds a fresh instance on reload; the harness shares the UI, as Pi does.
  const h2 = harness();
  h2.pi.events.on("interactive-shell:inspect", ({ reply }: any) => reply({ available: true, layout: "inline" }));
  const diagnostics2 = nextPrompt(h2.pi);
  s.ctx.ui.inputHandlers.length = 0;
  await h2.emit("session_start", { reason: "reload" }, s.ctx);
  expect(s.ctx.ui.widgetLines("next-prompt").join("")).toContain("!i printf 'one  two'");
  expect(diagnostics2().ready).toBe(true);
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorText).toBe("!i printf 'one  two'");
});

test("no carry across a non-reload session start", async () => {
  const s = await setup();
  await s.offer();
  await s.h.emit("session_shutdown", { reason: "new" }, s.ctx);
  const h2 = harness();
  nextPrompt(h2.pi);
  await h2.emit("session_start", { reason: "reload" }, s.ctx);
  expect(s.ctx.ui.widgets.has("next-prompt")).toBe(false);
});

test("the next turn is told when an offer was cleared without acceptance", async () => {
  const s = await setup();
  await s.offer();
  await s.h.emit("input", { text: "what do i need to run?" }, s.ctx);
  const event = { prompt: "what do i need to run?", systemPromptOptions: { sections: {} as Record<string, string> } };
  const result: any = await s.h.emit("before_agent_start", event, s.ctx);
  expect(result.message.display).toBe(false);
  expect(result.message.content).toContain("call offer_terminal again");
  expect(await s.h.emit("before_agent_start", event, s.ctx)).toBeUndefined();
});

test("an accepted offer sends no withdrawal notice", async () => {
  const s = await setup();
  await s.offer();
  expect(s.ctx.ui.press("\t")).toBe(true);
  await s.h.emit("input", { text: "go" }, s.ctx);
  const event = { prompt: "go", systemPromptOptions: { sections: {} as Record<string, string> } };
  expect(await s.h.emit("before_agent_start", event, s.ctx)).toBeUndefined();
});

test.each([false, true])("a long command offered over several lines keeps its layout (ghost=%s)", async ghost => {
  const s = await setup({ ghost });
  const command = "sudo sh -c '\n  set -e\n  apt-get update\n' \\\n  && echo done";
  expect((await s.offer(command)).details.status).toBe("displayed");
  const shown = (ghost ? s.ctx.ui.renderEditor() : s.ctx.ui.widgetLines("next-prompt")).join("\n");
  for (const part of ["i sudo sh -c '", "  set -e", "  apt-get update", "' \\", "  && echo done"]) expect(shown).toContain(part);
  expect(s.ctx.ui.press("\t")).toBe(true);
  expect(s.ctx.ui.editorText).toBe(`!i ${command}`);
});
