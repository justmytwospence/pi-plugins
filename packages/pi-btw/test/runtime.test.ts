import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { beforeEach, expect, test, vi } from "vitest";
import { assistant, deferred, FakeSession, flush, harness, model } from "./harness.ts";
import { BtwOverlayComponent } from "../src/overlay.ts";
import { BTW_ENTRY_TYPE, BTW_MODEL_OVERRIDE_TYPE, BTW_RESET_TYPE, BTW_THINKING_OVERRIDE_TYPE } from "../src/thread.ts";

const mocks = vi.hoisted(() => ({ create: vi.fn(), runtime: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...await original<typeof import("@earendil-works/pi-coding-agent")>(), createAgentSession: mocks.create,
}));
vi.mock("../src/session.ts", async (original) => ({
  ...await original<typeof import("../src/session.ts")>(), createBtwModelRuntimeOptions: mocks.runtime,
}));
import btw from "../src/index.ts";

let sessions: FakeSession[];
let planned: FakeSession[];
beforeEach(() => {
  sessions = []; planned = [];
  mocks.runtime.mockReset().mockResolvedValue({});
  mocks.create.mockReset().mockImplementation(async (options: CreateAgentSessionOptions) => {
    const session = planned.shift() ?? new FakeSession();
    session.state.messages = options.sessionManager!.buildSessionContext().messages;
    sessions.push(session);
    return { session: session.asSession() };
  });
});
function setup() { const h = harness(); btw(h.api); return h; }
function persisted(question = "old", answer = "old answer") {
  return { type: "custom", customType: BTW_ENTRY_TYPE, data: { question, answer, thinking: "", provider: model.provider, model: model.id, api: model.api, thinkingLevel: "off", timestamp: 1 } };
}
function options(index = 0): CreateAgentSessionOptions { return mocks.create.mock.calls[index]![0] as CreateAgentSessionOptions; }

test("registers the complete upstream command/shortcut/renderer/event surface without parent tool access", () => {
  const h = setup();
  expect([...h.commands.keys()].sort()).toEqual(["btw", "side", "btw:ask", "btw:tangent", "btw:new", "btw:clear", "btw:model", "btw:thinking", "btw:inject", "btw:summarize"].sort());
  expect([...h.shortcuts.keys()]).toEqual(["alt+/", "super+/", "ctrl+alt+w", "alt+w"]);
  expect([...h.renderers.keys()]).toEqual(["btw-note"]);
  expect([...h.handlers.keys()]).toEqual(["context", "session_start", "session_tree", "session_shutdown"]);
  expect(h.commands.get("btw:ask")!.description).not.toMatch(/cannot|guarantee|enforced|safe/i);
});

test("ask has only explicit built-ins and isolated resources, tangent omits main context, side aliases BTW", async () => {
  const h = setup();
  h.setBranch([{ type: "message", id: "p", parentId: null, timestamp: "t", message: { role: "user", content: "parent", timestamp: 1 } }]);
  h.ctx.sessionManager.getLeafId = () => "p" as never;
  await h.command("btw:ask", "--save inspect");
  expect(options().tools).toEqual(["read", "grep", "find", "ls"]);
  expect(options().cwd).toBe(h.ctx.cwd);
  expect(options().sessionManager!.getCwd()).toBe(h.ctx.cwd);
  expect(options().resourceLoader!.getExtensions().extensions).toEqual([]);
  expect(options().resourceLoader!.getSkills().skills).toEqual([]);
  expect(options().resourceLoader!.getSystemPrompt()).toBe("Parent instructions");
  expect(sessions[0]!.state.messages[0]).toMatchObject({ role: "user", content: "parent" });
  await h.command("btw:tangent", "idea");
  expect(options(1).tools).toEqual(["read", "bash", "edit", "write"]);
  expect(sessions[1]!.state.messages[0]).toMatchObject({ role: "user", content: [{ text: "idea" }] });
  await h.command("side", "contextual");
  expect(options(2).tools).toEqual(["read", "bash", "edit", "write"]);
  expect(h.pi.appendEntry.mock.calls.filter(([type]) => type === BTW_RESET_TYPE).map(([, data]) => data)).toEqual([
    expect.objectContaining({ mode: "readonly" }), expect.objectContaining({ mode: "tangent" }), expect.objectContaining({ mode: "contextual" }),
  ]);
});

for (const mode of ["rpc", "json", "print"] as const) test(`${mode} uses visible inline notes, no custom terminal UI`, async () => {
  const h = setup(); h.setMode(mode);
  await h.command("btw", "question");
  expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "btw-note", display: true }));
  expect(h.ctx.ui.custom).not.toHaveBeenCalled();
  await h.command("btw:ask");
  expect(mocks.create).toHaveBeenCalledTimes(1);
  if (mode === "rpc") expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Pass the question inline"), "warning");
});

for (const initialIdle of [true, false]) test(`saved notes use delivery-time idle status (initial idle ${initialIdle})`, async () => {
  const h = setup(); h.setIdle(initialIdle);
  const gate = deferred<ReturnType<typeof assistant>>();
  const session = new FakeSession(); session.respond = () => gate.promise; planned.push(session);
  const run = h.command("btw", "--save question");
  await flush(); expect(session.prompt).toHaveBeenCalledTimes(1);
  h.setIdle(!initialIdle); gate.resolve(assistant()); await run;
  if (initialIdle) expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.anything(), { deliverAs: "followUp" });
  else expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.anything());
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
});

test("prompts serialize and handoff waits for the queued turn; injection uses current busy status", async () => {
  const h = setup();
  const gate = deferred<ReturnType<typeof assistant>>();
  const session = new FakeSession(); session.respond = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(assistant("second")); planned.push(session);
  const first = h.command("btw", "first"); await flush();
  const second = h.command("btw", "second");
  const inject = h.command("btw:inject", "act on this"); await flush();
  expect(session.prompt).toHaveBeenCalledTimes(1);
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  h.setIdle(false); gate.resolve(assistant("first answer")); await Promise.all([first, second, inject]);
  expect(session.prompt.mock.calls.map(([text]) => text)).toEqual(["first", "second"]);
  expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  expect(h.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("User: second\nAssistant: second"), { deliverAs: "followUp" });
  expect(session.dispose).toHaveBeenCalledTimes(1);
});

test("model/thinking overrides persist and reject invalid levels and API triples without touching main settings", async () => {
  const h = setup();
  await h.command("btw:model", `${model.provider} ${model.id} wrong-api`);
  await h.command("btw:thinking", "bogus");
  expect(h.pi.appendEntry).not.toHaveBeenCalled();
  await h.command("btw:model", `${model.provider} ${model.id} ${model.api}`);
  await h.command("btw:thinking", "low");
  expect(h.pi.appendEntry).toHaveBeenCalledWith(BTW_MODEL_OVERRIDE_TYPE, expect.objectContaining({ action: "set", provider: model.provider, api: model.api }));
  expect(h.pi.appendEntry).toHaveBeenCalledWith(BTW_THINKING_OVERRIDE_TYPE, expect.objectContaining({ action: "set", thinkingLevel: "low" }));
  await h.command("btw", "question");
  expect(options().thinkingLevel).toBe("low");
  await h.command("btw:thinking", "clear");
  expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
  await h.command("btw", "followup");
  expect(sessions[1]!.state.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("question"))).toBe(true);
});

test("a late auth result after tree navigation cannot construct, save or reopen a child", async () => {
  const h = setup(); h.setMode("tui");
  const auth = deferred<{ ok: true; apiKey: string }>();
  h.ctx.modelRegistry.getApiKeyAndHeaders.mockReturnValueOnce(auth.promise);
  const run = h.command("btw", "--save old"); await flush();
  await h.event("session_tree");
  auth.resolve({ ok: true, apiKey: "unit-placeholder" }); await run;
  expect(mocks.create).not.toHaveBeenCalled();
  expect(h.pi.sendMessage).not.toHaveBeenCalled(); expect(h.mounts).toHaveLength(0);
});

test("late child factories are disposed once and do not block or dispose a new generation", async () => {
  const h = setup();
  const gate = deferred<{ session: ReturnType<FakeSession["asSession"]> }>();
  const old = new FakeSession();
  mocks.create.mockReturnValueOnce(gate.promise);
  const run = h.command("btw", "old"); await flush();
  await h.command("btw:clear");
  await h.command("btw", "new");
  expect(sessions[0]!.prompt).toHaveBeenCalledTimes(1);
  gate.resolve({ session: old.asSession() }); await run;
  expect(old.prompt).not.toHaveBeenCalled(); expect(old.abort).toHaveBeenCalledTimes(1); expect(old.dispose).toHaveBeenCalledTimes(1);
  expect(sessions[0]!.dispose).not.toHaveBeenCalled();
  expect(h.pi.appendEntry.mock.calls.filter(([type]) => type === BTW_ENTRY_TYPE)).toHaveLength(1);
});

test("a reset awaiting an old abort never clears restored branch state or closes its new overlay", async () => {
  const h = setup(); h.setMode("tui"); await h.command("btw", "old"); await flush();
  const abort = deferred<void>(); sessions[0]!.abort.mockReturnValueOnce(abort.promise);
  const clear = h.command("btw:clear"); await flush();
  h.setBranch([persisted("branch question", "branch answer")]);
  await h.event("session_tree");
  await h.command("btw"); await flush();
  const newMount = h.mounts.at(-1)!;
  abort.resolve(); await clear; await flush();
  expect(newMount.done).not.toHaveBeenCalled();
  expect((newMount.component as BtwOverlayComponent).getTranscriptEntries()).toEqual(expect.arrayContaining([expect.objectContaining({ text: "branch answer" })]));
  expect(sessions[1]!.dispose).not.toHaveBeenCalled();
  await h.command("btw:inject");
  expect(h.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("branch question"));
});

for (const event of ["session_tree", "session_shutdown"] as const) test(`late summaries after ${event} cannot inject/reset/UI-update a newer thread`, async () => {
  const h = setup(); await h.command("btw", "original");
  const gate = deferred<ReturnType<typeof assistant>>();
  const summary = new FakeSession(); summary.respond = () => gate.promise; planned.push(summary);
  const summarize = h.command("btw:summarize"); await flush();
  expect(options(1).tools).toEqual([]); expect(options(1).thinkingLevel).toBe("off");
  await h.event(event);
  if (event === "session_shutdown") await h.event("session_start");
  await h.command("btw", "new question");
  const entryCount = h.pi.appendEntry.mock.calls.length;
  gate.resolve(assistant("stale summary")); await summarize;
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(h.pi.appendEntry.mock.calls).toHaveLength(entryCount);
  expect(summary.abort).toHaveBeenCalledTimes(1); expect(summary.dispose).toHaveBeenCalledTimes(1);
  expect(sessions.at(-1)!.dispose).not.toHaveBeenCalled();
});

test("summary factory completion after clear is disposed without prompting", async () => {
  const h = setup(); await h.command("btw", "original");
  const gate = deferred<{ session: ReturnType<FakeSession["asSession"]> }>();
  const summary = new FakeSession(); mocks.create.mockReturnValueOnce(gate.promise);
  const summarize = h.command("btw:summarize"); await flush();
  await h.command("btw:clear"); await h.command("btw", "new question");
  gate.resolve({ session: summary.asSession() }); await summarize;
  expect(summary.prompt).not.toHaveBeenCalled(); expect(summary.dispose).toHaveBeenCalledTimes(1);
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
});

test("successful summary delivers with current idle status, clears only after sending, and preserves instructions", async () => {
  const h = setup(); await h.command("btw", "original");
  const gate = deferred<ReturnType<typeof assistant>>();
  const summary = new FakeSession(); summary.respond = () => gate.promise; planned.push(summary);
  const summarize = h.command("btw:summarize", "implement the result"); await flush();
  h.setIdle(false); gate.resolve(assistant("summary")); await summarize;
  expect(h.pi.sendUserMessage).toHaveBeenCalledWith("Here is a summary of a side conversation I had. implement the result\n\nsummary", { deliverAs: "followUp" });
  expect(h.pi.appendEntry.mock.calls.at(-1)).toEqual([BTW_RESET_TYPE, expect.objectContaining({ mode: "contextual" })]);
  expect(summary.dispose).toHaveBeenCalledTimes(1);
});

test("summary errors preserve the completed thread for retry/injection", async () => {
  const h = setup(); await h.command("btw", "original");
  const summary = new FakeSession(); summary.respond = async () => { throw new Error("summary failed"); }; planned.push(summary);
  await h.command("btw:summarize");
  expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
  expect(h.pi.appendEntry.mock.calls.filter(([type]) => type === BTW_RESET_TYPE)).toHaveLength(0);
  await h.command("btw:inject"); expect(h.pi.sendUserMessage).toHaveBeenCalledWith(expect.stringContaining("original"));
});

test("deferred old overlay mount closes only after its own handle arrives, without editor discovery", async () => {
  const h = setup(); h.setMode("tui"); h.setAutoMount(false);
  await h.command("btw"); const old = h.mounts[0]!;
  await h.command("btw:clear");
  await h.command("btw"); const fresh = h.mounts[1]!; await fresh.mount();
  expect(old.done).not.toHaveBeenCalled();
  await old.mount(); await flush();
  expect(old.done).toHaveBeenCalledTimes(1); expect(fresh.done).not.toHaveBeenCalled();
  expect(h.pi.events.emit).toHaveBeenCalledTimes(1);
  expect(old.component).not.toBeInstanceOf(BtwOverlayComponent);
});

test("concurrent composer opens share a single child and a single pending overlay", async () => {
  const h = setup(); h.setMode("tui"); h.setAutoMount(false);
  await Promise.all([h.command("btw"), h.command("btw")]);
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(h.mounts).toHaveLength(1);
});

test("width remount preserves draft/unfocused state, disposes old component, keeps transcript subscription", async () => {
  const h = setup(); h.setMode("tui"); await h.command("btw", "first"); await flush();
  const first = h.mounts[0]!; const component = first.component as BtwOverlayComponent;
  component.setDraft("draft"); first.handle.unfocus();
  await h.shortcuts.get("alt+w")!.handler(h.context); await flush();
  const second = h.mounts[1]!; const next = second.component as BtwOverlayComponent;
  expect(component.focused).toBe(true); // mount snapshot; later refresh follows the handle
  expect(next.getDraft()).toBe("draft"); expect(second.handle.isFocused()).toBe(false);
  expect(first.done).toHaveBeenCalledTimes(1);
  expect(sessions[0]!.callbacks.size).toBe(1);
  component.handleInput("ignored"); expect(next.getDraft()).toBe("draft");
});

test("first Escape aborts, second dismisses even while abort is pending; late answers are discarded", async () => {
  const h = setup(); h.setMode("tui");
  const answer = deferred<ReturnType<typeof assistant>>(); const abort = deferred<void>();
  const session = new FakeSession(); session.respond = () => answer.promise; session.abort.mockReturnValueOnce(abort.promise); planned.push(session);
  const run = h.command("btw", "question"); await flush();
  const mount = h.mounts[0]!; const overlay = mount.component as BtwOverlayComponent;
  overlay.handleInput("\x1b"); await flush(); expect(session.abort).toHaveBeenCalledTimes(1); expect(mount.done).not.toHaveBeenCalled();
  overlay.handleInput("\x1b"); await flush(); expect(mount.done).toHaveBeenCalledTimes(1);
  answer.resolve(assistant()); abort.resolve(); await run; await flush();
  expect(h.pi.appendEntry).not.toHaveBeenCalled(); expect(session.dispose).toHaveBeenCalledTimes(1);
});

test("visible notes are removed from main context and a handled slash command cannot reuse the previous answer", async () => {
  const h = setup(); await h.command("btw", "first");
  const prior = sessions[0]!.state.messages.length;
  sessions[0]!.prompt.mockImplementationOnce(async () => {});
  await h.command("btw", "/help");
  expect(sessions[0]!.state.messages).toHaveLength(prior);
  expect(h.pi.appendEntry.mock.calls.filter(([type]) => type === BTW_ENTRY_TYPE)).toHaveLength(1);
  const result = await h.event("context", { messages: [{ role: "custom", customType: "btw-note" }, { role: "user", content: "main" }] });
  expect(result).toEqual({ messages: [{ role: "user", content: "main" }] });
});
