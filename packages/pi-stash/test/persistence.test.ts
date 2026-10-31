import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EDITOR_SNAPSHOT, TAKE_NEXT_CHANNEL, type EditorSnapshot, type TakeNextRequest } from "../src/contract.ts";
import { PromptStash, type StashedPrompt } from "../src/core.ts";
import promptStash, { adoptStash, createStashController, LEASE, STASH_KEY, STATUS_ID, STATUS_TEXT, WRAPPER } from "../src/index.ts";
import { readStashState, serializeStash, STASH_ENTRY_TYPE } from "../src/persistence.ts";
import { CTRL_S, ENTER, FakeEditor, FakeSessionManager, SnapshotEditor, flush, harness, type TestSessionManager } from "./harness.ts";

const globals = globalThis as Record<symbol, unknown>;
const binding = Symbol.for("pi-plugins.pi-stash/session.v1");
const resetProcess = () => {
  delete globals[LEASE];
  delete globals[STASH_KEY];
};
beforeEach(resetProcess);
afterEach(resetProcess);

const stash = () => globals[STASH_KEY] as PromptStash;
const record = (data: unknown) => ({ type: "custom", customType: STASH_ENTRY_TYPE, data });
const saved = (text?: string) => record(serializeStash(text === undefined ? undefined : { text }));
const snapshot = (text: string): EditorSnapshot => ({
  version: 1, text, cursor: { line: 1, col: 2 }, mode: "visual", anchor: { line: 0, col: 1 },
});

async function boot(manager: TestSessionManager = new FakeSessionManager(), options: {
  text?: string; base?: () => FakeEditor; reason?: string; late?: string[];
} = {}) {
  const h = harness();
  promptStash(h.pi);
  const s = h.session({ manager, base: options.base, late: options.late });
  if (options.text !== undefined) s.state.main.setText(options.text);
  await h.emit("session_start", { reason: options.reason }, s.ctx);
  return { h, s };
}

function reloadedManager(manager: TestSessionManager) {
  return new FakeSessionManager({
    id: manager.getSessionId(), file: manager.getSessionFile() ?? null,
    entries: structuredClone(manager.getEntries()),
  });
}

// Codec: all durable data is detached and whitelisted, never JSON-stringified wholesale.
test.each(["first\nsecond\n", "日本語 🐢 café e\u0301", " \t\n  "])("codec preserves every text byte: %j", (text) => {
  const original: StashedPrompt = { text };
  const encoded = serializeStash(original);
  expect(encoded).toEqual({ version: 1, prompt: { text } });
  expect(encoded.prompt).not.toBe(original);
  expect(readStashState([record(JSON.parse(JSON.stringify(encoded)))])).toEqual({ status: "valid", entry: original });
});

test("codec copies cursor/mode/anchor, strips history and unknown properties, and isolates mutations", () => {
  const text = "a\nbcd";
  const history: Record<string, unknown> = {};
  history.circular = history;
  const original = { ...snapshot(text), history, unknown: "not durable" };
  Object.assign(original.cursor, { extra: "not durable" });
  const encoded = serializeStash({ text, snapshot: original });
  expect(() => JSON.stringify(encoded)).not.toThrow();
  expect(encoded.prompt?.snapshot).toEqual(snapshot(text));
  expect(encoded.prompt?.snapshot).not.toBe(original);
  expect(encoded.prompt?.snapshot?.cursor).not.toBe(original.cursor);
  expect(encoded.prompt?.snapshot?.anchor).not.toBe(original.anchor);
  const result = readStashState([record(encoded)]);
  expect(result.status).toBe("valid");
  if (result.status !== "valid") throw new Error("expected valid snapshot");
  expect(result.entry?.snapshot).toEqual(snapshot(text));
  expect(result.entry?.snapshot).not.toBe(encoded.prompt?.snapshot);
  result.entry!.snapshot!.cursor.col = 99;
  result.entry!.snapshot!.anchor!.line = 99;
  expect(encoded.prompt?.snapshot).toEqual(snapshot(text));
  original.cursor.col = 42;
  expect(encoded.prompt?.snapshot?.cursor.col).toBe(2);
  encoded.prompt!.text = "changed durable reference";
  expect(result.entry?.text).toBe(text);
  expect(original.history).toBe(history);
});

test.each([
  undefined, null, {}, { ...snapshot("x"), version: 2 }, snapshot("different"),
  { ...snapshot("x"), cursor: { line: -1, col: 0 } },
  { ...snapshot("x"), cursor: { line: 0, col: 1.5 } },
  { ...snapshot("x"), mode: "unsupported" },
  { ...snapshot("x"), anchor: { line: 0, col: -1 } },
])("invalid optional snapshot keeps valid text: %j", (value) => {
  expect(readStashState([record({ version: 1, prompt: { text: "x", snapshot: value } })]))
    .toEqual({ status: "valid", entry: { text: "x" } });
  expect(serializeStash({ text: "x", snapshot: value as EditorSnapshot })).toEqual({ version: 1, prompt: { text: "x" } });
});

test("codec scans file order, not branch ancestry, ignores other entry types and respects explicit null", () => {
  expect(readStashState([{}, null, { type: "custom_message", customType: STASH_ENTRY_TYPE }])).toEqual({ status: "missing" });
  const entries = [
    { ...saved("old"), id: "old", parentId: null },
    { ...saved("abandoned branch"), id: "abandoned", parentId: "old" },
    { type: "custom", customType: "another.extension", data: { version: 1, prompt: null } },
    { ...saved(), id: "consumed", parentId: "old" },
    { type: "custom_message", customType: STASH_ENTRY_TYPE, data: { version: 1, prompt: { text: "not a snapshot" } } },
  ];
  expect(readStashState(entries)).toEqual({ status: "valid" });
  expect(readStashState([...entries, saved("latest")])).toEqual({ status: "valid", entry: { text: "latest" } });
  expect(serializeStash(undefined)).toEqual({ version: 1, prompt: null });
  expect(serializeStash(undefined)).not.toBe(serializeStash(undefined));
});

test.each([
  undefined, null, [], {}, { version: 2, prompt: null }, { version: 1 },
  { version: 1, prompt: "text" }, { version: 1, prompt: {} },
  { version: 1, prompt: { text: "" } }, { version: 1, prompt: { text: 123 } },
])("malformed latest envelope never falls back to an older stash: %j", (data) => {
  expect(readStashState([saved("must not return"), record(data)])).toEqual({ status: "invalid" });
});

// Mutation-time records, not shutdown-only saves or intermediate swap states.
test("stash, swap, manual restore and automatic restore save their final state exactly once", async () => {
  const { h, s } = await boot();
  s.state.main.handleInput(CTRL_S); // nothing to stash
  s.state.main.handleInput("x"); // ordinary typing
  expect(h.writes).toEqual([]);
  s.state.main.setText("one");
  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("two");
  s.state.main.handleInput(CTRL_S);
  expect(s.state.main.getText()).toBe("one");
  expect(h.writes.map((write) => write.data)).toEqual([
    { version: 1, prompt: { text: "one" } }, { version: 1, prompt: { text: "two" } },
  ]);
  s.state.main.setText("");
  s.state.main.handleInput(CTRL_S);
  expect(s.state.main.getText()).toBe("two");
  expect(h.writes.at(-1)?.data).toEqual({ version: 1, prompt: null });
  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("/model");
  s.state.main.handleInput(ENTER);
  await flush();
  expect(s.state.main.getText()).toBe("two");
  expect(h.writes.map((write) => write.data)).toEqual([
    { version: 1, prompt: { text: "one" } }, { version: 1, prompt: { text: "two" } },
    { version: 1, prompt: null }, { version: 1, prompt: { text: "two" } }, { version: 1, prompt: null },
  ]);
  expect(h.writes.every((write) => write.customType === STASH_ENTRY_TYPE)).toBe(true);
  await h.emit("session_start", {}, s.ctx);
  await h.emit("session_shutdown", {}, s.ctx);
  expect(h.writes).toHaveLength(5); // no unchanged reload/shutdown duplicates
});

test("taking an optional next-prompt suggestion saves it without submission", async () => {
  const { h, s } = await boot();
  h.events.on(TAKE_NEXT_CHANNEL, (request) => { (request as TakeNextRequest).text = "\n Suggested next step 🐢 \n"; });
  s.state.main.handleInput(CTRL_S);
  expect(h.writes).toEqual([{ customType: STASH_ENTRY_TYPE, data: { version: 1, prompt: { text: "\n Suggested next step 🐢 \n" } } }]);
  expect(s.state.main.getText()).toBe("");
  expect(s.submitted).toEqual([]);
});

test("independent controller stashes never create main-session records", async () => {
  const { h } = await boot();
  const editor = new FakeEditor();
  const controller = createStashController({ editor: () => editor, notify() {} });
  editor.setText("Sidebar only");
  controller.handleKey(CTRL_S);
  editor.setText("swap");
  controller.handleKey(CTRL_S);
  editor.setText("");
  controller.submitted("/command");
  expect(editor.getText()).toBe("swap");
  expect(stash().hasPrompt).toBe(false);
  expect(h.writes).toEqual([]);
});

test.each(["", "a new current draft"])("full restart keeps a recovered stash stashed and protects editor %j", async (text) => {
  const first = await boot();
  first.s.state.main.setText("recover me\n日本語");
  first.s.state.main.handleInput(CTRL_S);
  await first.h.emit("session_shutdown", {}, first.s.ctx);
  const manager = reloadedManager(first.s.manager);
  resetProcess();
  const next = await boot(manager, { text });
  expect(next.s.state.main.getText()).toBe(text);
  expect(next.s.status.get(STATUS_ID)).toBe(STATUS_TEXT);
  expect(stash().value).toBe("recover me\n日本語");
  expect(next.h.writes).toEqual([]);
  next.s.state.main.handleInput(CTRL_S);
  expect(next.s.state.main.getText()).toBe("recover me\n日本語");
  expect(stash().value).toBe(text || undefined);
  await next.h.emit("session_shutdown", {}, next.s.ctx);
  resetProcess();
  const again = await boot(reloadedManager(manager));
  expect(again.s.state.main.getText()).toBe("");
  expect(stash().value).toBe(text || undefined); // consumed prompt can never return
  expect(again.s.status.get(STATUS_ID)).toBe(text ? STATUS_TEXT : undefined);
});

test("session A -> fresh B -> A isolates slots even in the same cwd", async () => {
  const { h, s: a } = await boot();
  Object.assign(a.ctx, { cwd: "/same/cwd" });
  a.state.main.setText("A draft");
  a.state.main.handleInput(CTRL_S);
  const b = h.session();
  Object.assign(b.ctx, { cwd: "/same/cwd" });
  await h.emit("session_start", { reason: "new" }, b.ctx);
  expect(stash().hasPrompt).toBe(false);
  expect(b.writes).toEqual([]);
  b.state.main.setText("B draft");
  b.state.main.handleInput(CTRL_S);
  const resumedA = h.session({ manager: a.manager });
  await h.emit("session_start", { reason: "resume" }, resumedA.ctx);
  expect(resumedA.state.main.getText()).toBe("");
  expect(stash().value).toBe("A draft");
  expect(a.writes).toHaveLength(1);
  resumedA.state.main.handleInput(CTRL_S);
  const resumedB = h.session({ manager: b.manager });
  await h.emit("session_start", { reason: "resume" }, resumedB.ctx);
  expect(stash().value).toBe("B draft");
  expect(readStashState(a.manager.getEntries())).toEqual({ status: "valid" });
});

test.each([undefined, "imported stash"])("same-ID different-path imports load only destination state (%j)", async (destination) => {
  const parent = new FakeSessionManager({ id: "shared-id", file: "/sessions/original.jsonl" });
  const { h, s } = await boot(parent, { late: ["/import copy.jsonl"] });
  s.state.main.setText("outgoing stash");
  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("/import copy.jsonl");
  s.state.main.handleInput(ENTER);
  expect(stash().awaitText).toBe(true);
  const imported = new FakeSessionManager({ id: "shared-id", file: "/sessions/imported.jsonl", entries: [saved(destination)] });
  const next = h.session({ manager: imported });
  next.state.main.setText("prefill");
  await h.emit("session_start", { reason: "resume" }, next.ctx);
  expect(stash().value).toBe(destination);
  expect(stash().awaitText).toBe(false);
  expect(stash().held).toBe(false);
  s.late.resolve?.();
  next.state.main.setText(""); // import completion must not schedule restoration
  await flush();
  expect(next.state.main.getText()).toBe("");
  expect(next.writes).toEqual([]);
  expect(parent.writes).toHaveLength(1);
  expect(readStashState(parent.getEntries())).toEqual({ status: "valid", entry: { text: "outgoing stash" } });
});

test("same-session factory reload retains in-process snapshot/history without duplicate writes", async () => {
  const first = await boot(undefined, { base: () => new SnapshotEditor() });
  const editor = first.s.state.main as SnapshotEditor;
  const history = { opaque: new Map([["undo", "private"]]) };
  editor.setText("rich snapshot");
  editor[EDITOR_SNAPSHOT].capture = () => ({ ...snapshot(editor.getText()), history });
  editor.handleInput(CTRL_S);
  const entry = stash().entry;
  expect(entry?.snapshot?.history).toBe(history);
  expect(first.h.writes[0]?.data).toEqual({ version: 1, prompt: { text: "rich snapshot", snapshot: snapshot("rich snapshot") } });
  await first.h.emit("session_shutdown", {}, first.s.ctx);
  const next = await boot(first.s.manager, { base: () => new SnapshotEditor() });
  expect(stash().entry).toBe(entry);
  expect(next.s.state.main.getText()).toBe("");
  expect(next.h.writes).toEqual([]);
  const descriptor = Object.getOwnPropertyDescriptor(stash(), binding);
  expect(descriptor?.enumerable).toBe(false);
  expect(descriptor?.value).toBe(JSON.stringify([first.s.manager.getSessionId(), first.s.manager.getSessionFile()]));
  next.s.state.main.handleInput(CTRL_S);
  expect((next.s.state.main as SnapshotEditor).restored[0]?.history).toBe(history);
});

test("an unbound tagged-suite draft migrates once only when durable state is missing", async () => {
  const adopted = adoptStash();
  if (adopted.status !== "ready") throw new Error("expected suite stash");
  adopted.stash.stash("pre-persistence suite draft");
  const { h, s } = await boot();
  expect(stash()).toBe(adopted.stash);
  expect(s.state.main.getText()).toBe("");
  expect(h.writes).toHaveLength(1);
  expect(h.writes[0]?.data).toEqual({ version: 1, prompt: { text: "pre-persistence suite draft" } });
  await h.emit("session_start", {}, s.ctx);
  expect(h.writes).toHaveLength(1);
  await h.emit("session_shutdown", {}, s.ctx);
  resetProcess();
  const unbound = adoptStash();
  if (unbound.status !== "ready") throw new Error("expected suite stash");
  unbound.stash.stash("must not beat explicit null");
  const empty = await boot(new FakeSessionManager({ entries: [saved()] }));
  expect(stash().hasPrompt).toBe(false);
  expect(empty.h.writes).toEqual([]);
});

test("a rejected factory installation cannot bind, migrate, or mutate an unbound suite stash", async () => {
  const adopted = adoptStash();
  if (adopted.status !== "ready") throw new Error("expected suite stash");
  adopted.stash.stash("suite draft awaiting migration");
  const original = adopted.stash.entry;
  const h = harness();
  promptStash(h.pi);
  const s = h.session();
  const foreign = Object.assign(() => new FakeEditor(), { [WRAPPER]: { owner: "other/pi-stash", previous: undefined } });
  s.ui.setEditorComponent(foreign);
  await h.emit("session_start", {}, s.ctx);
  expect(s.factory()).toBe(foreign);
  expect(stash().entry).toBe(original);
  expect(Object.getOwnPropertyDescriptor(stash(), binding)).toBeUndefined();
  expect(globals[LEASE]).toBeUndefined();
  await h.emit("session_shutdown", {}, s.ctx);
  expect(h.writes).toEqual([]);
  expect(s.manager.getEntries()).toEqual([]);
});

test.each([false, true])("interactive fork copies live state including empty, overriding stale ancestry (empty=%s)", async (empty) => {
  const { h, s } = await boot();
  s.state.main.setText("parent stash");
  s.state.main.handleInput(CTRL_S);
  const staleEntries = structuredClone(s.manager.getEntries()); // fork prepared before consumption
  if (empty) s.state.main.handleInput(CTRL_S);
  const parentRecords = structuredClone(s.manager.getEntries());
  await h.emit("session_shutdown", { reason: "fork" }, s.ctx);
  const childManager = new FakeSessionManager({ entries: staleEntries });
  const child = h.session({ manager: childManager });
  await h.emit("session_start", { reason: "fork" }, child.ctx);
  expect(child.writes).toEqual([{ customType: STASH_ENTRY_TYPE, data: { version: 1, prompt: empty ? null : { text: "parent stash" } } }]);
  expect(child.state.main.getText()).toBe("");
  child.state.main.setText("selected message");
  await flush();
  expect(child.state.main.getText()).toBe("selected message");
  expect(stash().value).toBe(empty ? undefined : "parent stash");
  if (!empty) {
    child.state.main.handleInput(ENTER);
    await flush();
    expect(child.state.main.getText()).toBe("parent stash");
    expect(readStashState(childManager.getEntries())).toEqual({ status: "valid" });
  }
  expect(s.manager.getEntries()).toEqual(parentRecords);
  const resumed = h.session({ manager: s.manager });
  await h.emit("session_start", { reason: "resume" }, resumed.ctx);
  expect(stash().value).toBe(empty ? undefined : "parent stash");
});

test("interactive fork detaches snapshot fields and does not transfer opaque parent history", async () => {
  const { h, s } = await boot(undefined, { base: () => new SnapshotEditor() });
  const editor = s.state.main as SnapshotEditor;
  const history = { undo: "parent only" };
  editor.setText("parent snapshot");
  editor[EDITOR_SNAPSHOT].capture = () => ({ ...snapshot(editor.getText()), history });
  editor.handleInput(CTRL_S);
  const original = stash().entry!;
  const child = h.session();
  await h.emit("session_start", { reason: "fork" }, child.ctx);
  expect(stash().entry?.snapshot).toEqual(snapshot("parent snapshot"));
  expect(stash().entry?.snapshot).not.toBe(original.snapshot);
  stash().entry!.snapshot!.cursor.col = 99;
  expect(original.snapshot?.cursor.col).toBe(2);
  expect(original.snapshot?.history).toBe(history);
});

test("CLI fork uses copied entries and consumption only clears the child", async () => {
  const parent = new FakeSessionManager({ entries: [saved("copied stash")] });
  const child = new FakeSessionManager({ entries: structuredClone(parent.getEntries()) });
  const { h, s } = await boot(child, { reason: "fork" }); // no live parent binding
  expect(stash().value).toBe("copied stash");
  expect(s.state.main.getText()).toBe("");
  expect(h.writes).toEqual([]);
  s.state.main.handleInput(CTRL_S);
  expect(readStashState(child.getEntries())).toEqual({ status: "valid" });
  expect(readStashState(parent.getEntries())).toEqual({ status: "valid", entry: { text: "copied stash" } });
});

for (const command of ["/model", "!ls"]) {
  test(`stale ${command} completion cannot restore or persist into a replacement session`, async () => {
    const { h, s } = await boot();
    s.state.main.setText("outgoing stash");
    s.state.main.handleInput(CTRL_S);
    s.state.main.setText(command);
    s.state.main.handleInput(ENTER);
    const manager = new FakeSessionManager({ entries: [saved("destination stash")] });
    const next = h.session({ manager });
    await h.emit("session_start", { reason: "resume" }, next.ctx);
    s.shell.resolve?.();
    await flush();
    expect(next.state.main.getText()).toBe("");
    expect(stash().value).toBe("destination stash");
    expect(next.writes).toEqual([]);
    expect(readStashState(s.manager.getEntries())).toEqual({ status: "valid", entry: { text: "outgoing stash" } });
  });
}

test("invalid durable state warns generically, never mutates entries or overwrites the current draft", async () => {
  const data = Object.freeze({ version: 99, prompt: Object.freeze({ text: "secret invalid draft" }) });
  const entries = [saved("older secret"), Object.freeze(record(data))];
  const manager = new FakeSessionManager({ entries });
  const { h, s } = await boot(manager, { text: "current draft" });
  expect(s.state.main.getText()).toBe("current draft");
  expect(stash().hasPrompt).toBe(false);
  expect(s.notes).toEqual([{ message: "pi-stash: saved stash state is unsupported or invalid; no prompt was restored.", type: "warning" }]);
  await h.emit("session_shutdown", {}, s.ctx);
  expect(manager.getEntries()).toEqual(entries);
  expect(h.writes).toEqual([]);
});

test("write failures retain memory, omit exception/draft text and retry the final state at the next mutation", async () => {
  const { h, s } = await boot();
  h.writeError = new Error("private storage failure contents");
  s.state.main.setText("private stashed prompt");
  expect(() => s.state.main.handleInput(CTRL_S)).not.toThrow();
  expect(stash().value).toBe("private stashed prompt");
  expect(s.state.main.getText()).toBe("");
  expect(s.status.get(STATUS_ID)).toBe(STATUS_TEXT);
  expect(s.notes.filter((note) => note.type === "warning")).toEqual([
    { message: "pi-stash: could not save stash state; changes are in memory only until a save succeeds.", type: "warning" },
  ]);
  expect(JSON.stringify(s.notes)).not.toMatch(/private/);
  expect(h.writes).toEqual([]);
  h.writeError = undefined;
  s.state.main.setText("replacement draft");
  s.state.main.handleInput(CTRL_S); // swap retries the current, not failed old, snapshot
  expect(s.state.main.getText()).toBe("private stashed prompt");
  expect(h.writes).toEqual([{ customType: STASH_ENTRY_TYPE, data: { version: 1, prompt: { text: "replacement draft" } } }]);
  await h.emit("session_shutdown", {}, s.ctx);
  expect(h.writes).toHaveLength(1);
});

test("a dirty state is rewritten even if it returns to the last successful snapshot after a partial write", async () => {
  class PartialWriteManager extends FakeSessionManager {
    failNext = false;
    override appendCustomEntry(customType: string, data?: unknown): string {
      const id = super.appendCustomEntry(customType, data);
      if (this.failNext) {
        this.failNext = false;
        throw new Error("write may already have reached storage");
      }
      return id;
    }
  }
  const manager = new PartialWriteManager();
  const { h, s } = await boot(manager);
  s.state.main.setText("one");
  s.state.main.handleInput(CTRL_S);
  manager.failNext = true;
  s.state.main.setText("two");
  s.state.main.handleInput(CTRL_S);
  expect(readStashState(manager.getEntries())).toEqual({ status: "valid", entry: { text: "two" } });
  s.state.main.handleInput(CTRL_S); // back to "one", but "two" may have been written
  expect(h.writes).toHaveLength(2);
  expect(manager.writes).toHaveLength(3);
  expect(readStashState(manager.getEntries())).toEqual({ status: "valid", entry: { text: "one" } });
});

test("shutdown retries dirty state, including a failed empty-state write, without losing current text", async () => {
  const { h, s } = await boot();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  h.failWrites = true;
  s.state.main.handleInput(CTRL_S);
  expect(s.state.main.getText()).toBe("draft");
  expect(stash().hasPrompt).toBe(false);
  h.failWrites = false;
  await h.emit("session_shutdown", {}, s.ctx);
  expect(h.writes.at(-1)?.data).toEqual({ version: 1, prompt: null });
  resetProcess();
  await boot(reloadedManager(s.manager));
  expect(stash().hasPrompt).toBe(false);
});

test("a throwing stale context cannot escape shutdown; a dirty outgoing session cannot write to a destination", async () => {
  const { h, s } = await boot();
  h.failWrites = true;
  s.state.main.setText("unsaved outgoing");
  s.state.main.handleInput(CTRL_S);
  h.failWrites = false;
  const destination = h.session();
  await h.emit("session_start", { reason: "new" }, destination.ctx);
  expect(destination.writes).toEqual([]);
  expect(stash().hasPrompt).toBe(false);
  destination.state.main.setText("dirty destination");
  h.failWrites = true;
  destination.state.main.handleInput(CTRL_S);
  Object.defineProperty(destination.ctx, "sessionManager", { get() { throw new Error("stale context"); } });
  // Normal Pi shutdown dispatch already has an active manager; use a context for routing
  // while the extension's saved context itself is no longer usable.
  const routing = { sessionManager: new FakeSessionManager() };
  await expect(h.emit("session_shutdown", {}, routing)).resolves.toBeUndefined();
  expect(stash().value).toBe("dirty destination");
});

// Public SDK only: no network, private flush, JSONL edits, or model calls.
test("real SDK disk round trip stores the stash only as custom state, outside model context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-stash-persistence-"));
  try {
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "establish saved conversation", timestamp: Date.now() });
    const file = manager.getSessionFile()!;
    expect(existsSync(file)).toBe(true);
    const first = await boot(manager, { base: () => new SnapshotEditor() });
    const editor = first.s.state.main as SnapshotEditor;
    const text = "STASH ONLY: never send this draft to the model 日本語\n";
    editor.setText(text);
    editor.mode = "normal";
    editor.cursor = { line: 0, col: 5 };
    editor.handleInput(CTRL_S);
    await first.h.emit("session_shutdown", {}, first.s.ctx);
    const reopened = SessionManager.open(file);
    const containing = reopened.getEntries().filter((entry) => JSON.stringify(entry).includes("STASH ONLY"));
    expect(containing).toHaveLength(1);
    expect(containing[0]?.type).toBe("custom");
    expect(containing[0] && "customType" in containing[0] && containing[0].customType).toBe(STASH_ENTRY_TYPE);
    expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain("STASH ONLY");
    expect(readFileSync(file, "utf8")).toContain("STASH ONLY");
    resetProcess();
    const next = await boot(reopened, { base: () => new SnapshotEditor() });
    expect(next.s.state.main.getText()).toBe("");
    expect(next.s.status.get(STATUS_ID)).toBe(STATUS_TEXT);
    next.s.state.main.handleInput(CTRL_S);
    expect(next.s.state.main.getText()).toBe(text);
    expect((next.s.state.main as SnapshotEditor).cursor.col).toBe(5);
    expect((next.s.state.main as SnapshotEditor).mode).toBe("normal");
    await next.h.emit("session_shutdown", {}, next.s.ctx);
    resetProcess();
    const consumed = SessionManager.open(file);
    expect(readStashState(consumed.getEntries())).toEqual({ status: "valid" });
    expect(consumed.getEntries().filter((entry) => entry.type === "custom")).toHaveLength(2);
    await boot(consumed);
    expect(stash().hasPrompt).toBe(false);
    expect(JSON.stringify(consumed.buildSessionContext().messages)).not.toContain("STASH ONLY");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real SDK draft-only sessions buffer stash state until the first user message", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-stash-buffer-"));
  try {
    const manager = SessionManager.create(dir, dir);
    const file = manager.getSessionFile()!;
    const { h, s } = await boot(manager);
    s.state.main.setText("buffered stash");
    s.state.main.handleInput(CTRL_S);
    await h.emit("session_shutdown", {}, s.ctx);
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(readStashState(manager.getEntries())).toEqual({ status: "valid", entry: { text: "buffered stash" } });
    manager.appendMessage({ role: "user", content: "first user prompt, no assistant reply yet", timestamp: Date.now() });
    expect(existsSync(file)).toBe(true);
    expect(readStashState(SessionManager.open(file).getEntries())).toEqual({ status: "valid", entry: { text: "buffered stash" } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("real SDK --no-session manager keeps state in memory without creating files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-stash-in-memory-"));
  try {
    const manager = SessionManager.inMemory(dir);
    manager.appendMessage({ role: "user", content: "ephemeral conversation", timestamp: Date.now() });
    const { h, s } = await boot(manager);
    s.state.main.setText("ephemeral stash");
    s.state.main.handleInput(CTRL_S);
    await h.emit("session_shutdown", {}, s.ctx);
    expect(manager.getSessionFile()).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
    expect(readStashState(manager.getEntries())).toEqual({ status: "valid", entry: { text: "ephemeral stash" } });
    expect(readStashState(SessionManager.inMemory(dir).getEntries())).toEqual({ status: "missing" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
