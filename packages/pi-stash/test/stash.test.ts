import { afterEach, beforeEach, expect, test } from "vitest";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { EDITOR_SNAPSHOT, STASH_CHANNEL, type StashRequest } from "../src/contract.ts";
import { isShellAction, isTemporaryAction, PromptStash } from "../src/core.ts";
import promptStash, { LEASE, OWNER, STASH_KEY, STASH_OWNER, STATUS_ID, STATUS_TEXT, WRAPPER, adoptStash, capture } from "../src/index.ts";
import { CTRL_S, ENTER, FakeEditor, SnapshotEditor, flush, harness, markEmbedded } from "./harness.ts";

const globals = globalThis as Record<symbol, unknown>;

beforeEach(() => {
  delete globals[LEASE];
  delete globals[STASH_KEY];
});
afterEach(() => {
  delete globals[LEASE];
  delete globals[STASH_KEY];
});

async function start(options: Parameters<ReturnType<typeof harness>["session"]>[0] = {}) {
  const h = harness();
  promptStash(h.pi);
  const s = h.session(options);
  await h.emit("session_start", {}, s.ctx);
  return { h, s };
}

// ─── core ───

test("core: temporary and shell actions", () => {
  expect(isTemporaryAction("  /model")).toBe(true);
  expect(isTemporaryAction("hello /x")).toBe(false);
  expect(isShellAction("!ls")).toBe(true);
  expect(isShellAction("!!ls")).toBe(true);
  expect(isShellAction("ls")).toBe(false);
});

test("core: PromptStash keeps text and an optional snapshot, value stays upstream-shaped", () => {
  const stash = new PromptStash();
  expect(stash.hasPrompt).toBe(false);
  stash.stash("draft");
  expect(stash.value).toBe("draft");
  expect(stash.entry).toEqual({ text: "draft" });
  stash.stash({ text: "x", snapshot: { version: 1, text: "x", cursor: { line: 0, col: 1 }, mode: "normal" } });
  expect(stash.value).toBe("x");
  expect(stash.take()?.snapshot?.mode).toBe("normal");
  expect(stash.hasPrompt).toBe(false);
});

// ─── stash / restore / swap ───

test("Ctrl+S stashes the main draft, clears the editor and publishes the upstream global", async () => {
  const { s } = await start();
  s.state.main.setText("write the tests");
  s.state.main.handleInput(CTRL_S);
  expect(s.state.main.getText()).toBe("");
  expect(s.status.get(STATUS_ID)).toBe(STATUS_TEXT);
  expect(s.notes.at(-1)).toEqual({ message: "Prompt stashed", type: "info" });
  const published = globals[STASH_KEY] as PromptStash & Record<symbol, unknown>;
  expect(published.value).toBe("write the tests");
  expect(published[STASH_OWNER]).toBe(OWNER);
  // The key never reaches the wrapped editor.
  expect(s.state.main instanceof FakeEditor && s.state.main.keys).toEqual([]);
});

test("Ctrl+S on an empty editor restores; with text in both it swaps", async () => {
  const { s } = await start();
  s.state.main.setText("one");
  s.state.main.handleInput(CTRL_S);
  s.state.main.handleInput(CTRL_S);
  expect(s.state.main.getText()).toBe("one");
  expect(s.status.get(STATUS_ID)).toBeUndefined();
  expect(s.notes.at(-1)?.message).toBe("Restored stashed prompt");

  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("two");
  s.state.main.handleInput(CTRL_S);
  expect(s.state.main.getText()).toBe("one");
  expect((globals[STASH_KEY] as PromptStash).value).toBe("two");
  expect(s.notes.at(-1)?.message).toBe("Swapped current and stashed prompts");
});

test("nothing to stash is a warning", async () => {
  const { s } = await start();
  s.state.main.handleInput(CTRL_S);
  expect(s.notes.at(-1)).toEqual({ message: "Nothing to stash", type: "warning" });
  expect(s.status.get(STATUS_ID)).toBeUndefined();
});

test("a slash command restores the prompt once it has started", async () => {
  const { s } = await start();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  for (const key of "/model") s.state.main.handleInput(key);
  s.state.main.handleInput(ENTER);
  expect(s.submitted).toEqual(["/model"]);
  expect(s.state.main.getText()).toBe("");
  await flush();
  expect(s.state.main.getText()).toBe("draft");
  expect(s.status.get(STATUS_ID)).toBeUndefined();
});

test("automatic restoration never overwrites text typed in the meantime", async () => {
  const { s } = await start();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  for (const key of "/x") s.state.main.handleInput(key);
  s.state.main.handleInput(ENTER);
  s.state.main.setText("new idea");
  await flush();
  expect(s.state.main.getText()).toBe("new idea");
  expect((globals[STASH_KEY] as PromptStash).value).toBe("draft");
  expect(s.status.get(STATUS_ID)).toBe(STATUS_TEXT);
});

test("a shell command restores after it finishes, removing only the completed command", async () => {
  const { s } = await start();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  await flush(); // onSubmit is wrapped a microtask after creation
  for (const key of "!ls") s.state.main.handleInput(key);
  s.state.main.handleInput(ENTER);
  await flush();
  expect(s.state.main.getText()).toBe("!ls"); // Pi leaves the command while it runs
  s.shell.resolve?.();
  await flush();
  expect(s.state.main.getText()).toBe("draft");
});

test("a shell command does not restore over a draft typed while it ran", async () => {
  const { s } = await start();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  await flush();
  for (const key of "!ls") s.state.main.handleInput(key);
  s.state.main.handleInput(ENTER);
  s.state.main.setText("typed meanwhile");
  s.shell.resolve?.();
  await flush();
  expect(s.state.main.getText()).toBe("typed meanwhile");
  expect((globals[STASH_KEY] as PromptStash).value).toBe("draft");
});

test("model and thinking selection restore only into an empty editor", async () => {
  const { h, s } = await start();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("busy");
  await h.emit("model_select", {}, s.ctx);
  expect(s.state.main.getText()).toBe("busy");
  s.state.main.setText("");
  await h.emit("thinking_level_select", {}, s.ctx);
  expect(s.state.main.getText()).toBe("draft");
});

test("a stashed prompt survives into the next session start and fills its empty editor", async () => {
  const { h, s } = await start();
  s.state.main.setText("carry me");
  s.state.main.handleInput(CTRL_S);
  await h.emit("session_shutdown", {}, s.ctx);
  const next = h.session();
  await h.emit("session_start", {}, next.ctx);
  expect(next.state.main.getText()).toBe("carry me");
  expect(next.status.get(STATUS_ID)).toBeUndefined();
});

// ─── main only, never embedded ───

test("an editor marked embedded by the contract passes Ctrl+S through", async () => {
  const { s } = await start();
  const embedded = markEmbedded(s.embed());
  embedded.setText("side draft");
  embedded.handleInput(CTRL_S);
  expect(embedded.getText()).toBe("side draft");
  expect(embedded.keys).toEqual([CTRL_S]);
  expect(globals[STASH_KEY] && (globals[STASH_KEY] as PromptStash).hasPrompt).toBe(false);
});

test("an unmarked editor that is not Pi's focused main editor passes Ctrl+S through", async () => {
  const { s } = await start();
  const other = s.embed();
  other.setText("dialog text");
  s.state.main.setText("main text");
  other.handleInput(CTRL_S);
  expect(other.getText()).toBe("dialog text");
  expect(s.state.main.getText()).toBe("main text");
  expect(other.keys).toEqual([CTRL_S]);
});

// ─── snapshot protocol ───

test("capture keeps the snapshot only when the editor offers one that matches the text", () => {
  const editor = new SnapshotEditor();
  editor.text = "abc";
  editor.mode = "normal";
  editor.cursor = { line: 0, col: 2 };
  expect(capture(editor, "abc")).toEqual({ text: "abc", snapshot: { version: 1, text: "abc", cursor: { line: 0, col: 2 }, mode: "normal" } });
  expect(capture(editor, "other")).toEqual({ text: "other" });
  expect(capture(new FakeEditor(), "abc")).toEqual({ text: "abc" });
});

test("a snapshot-capable editor gets cursor and mode back; failures fall back to text", async () => {
  const { s } = await start({ base: () => new SnapshotEditor() });
  const editor = s.state.main as SnapshotEditor;
  expect(EDITOR_SNAPSHOT in editor).toBe(true);
  editor.setText("snap");
  editor.mode = "normal";
  editor.cursor = { line: 0, col: 3 };
  editor.handleInput(CTRL_S);
  expect((globals[STASH_KEY] as PromptStash).entry?.snapshot?.mode).toBe("normal");
  editor.mode = "insert";
  editor.handleInput(CTRL_S);
  expect(editor.getText()).toBe("snap");
  expect(editor.mode).toBe("normal");
  expect(editor.cursor).toEqual({ line: 0, col: 3 });
  expect(editor.restored).toHaveLength(1);

  editor.handleInput(CTRL_S);
  editor.restoreResult = false;
  editor.handleInput(CTRL_S);
  expect(editor.restored).toHaveLength(2);
  expect(editor.getText()).toBe("snap"); // native text fallback
});

// ─── ownership ───

test("an unrecognized stash stays untouched without asserting an active owner", async () => {
  const unknown = Object.freeze({ value: "unrecognized draft" });
  globals[STASH_KEY] = unknown;
  const h = harness();
  promptStash(h.pi);
  const s = h.session();
  const before = s.factory();
  await h.emit("session_start", {}, s.ctx);
  expect(s.notes.at(-1)?.type).toBe("warning");
  expect(s.notes.at(-1)?.message).toMatch(/unrecognized process-global stash/);
  expect(s.notes.at(-1)?.message).not.toMatch(/already owns Ctrl\+S/);
  expect(s.factory()).toBe(before);
  expect(adoptStash()).toEqual({ status: "unknown" });
  expect(globals[STASH_KEY]).toBe(unknown);
  expect(unknown.value).toBe("unrecognized draft");
  expect(globals[LEASE]).toBeUndefined();
});

test("a tagged wrapper from another pi-stash instance is reported, not wrapped again", async () => {
  const h = harness();
  promptStash(h.pi);
  const s = h.session();
  const foreign = Object.assign(() => new FakeEditor(), { [WRAPPER]: { owner: "other/pi-stash", previous: undefined } });
  s.ui.setEditorComponent(foreign as never);
  await h.emit("session_start", {}, s.ctx);
  expect(s.notes.at(-1)?.message).toMatch(/other\/pi-stash/);
  expect(s.factory()).toBe(foreign);
});

test("the wrapper is tagged, unwrapped on the next session start and released on shutdown", async () => {
  const { h, s } = await start();
  const first = s.factory() as { [WRAPPER]?: { previous?: unknown } } | undefined;
  expect(first?.[WRAPPER]?.previous).toBe(s.baseFactory);
  await h.emit("session_start", {}, s.ctx);
  const second = s.factory() as { [WRAPPER]?: { previous?: unknown } } | undefined;
  expect(second).not.toBe(first);
  expect(second?.[WRAPPER]?.previous).toBe(s.baseFactory);
  await h.emit("session_shutdown", {}, s.ctx);
  expect(s.factory()).toBe(s.baseFactory);
});

test("shutdown cancels a pending restoration and later keys are plain pass-through", async () => {
  const { h, s } = await start();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  const wrapped = s.state.main;
  for (const key of "/x") wrapped.handleInput(key);
  wrapped.handleInput(ENTER);
  await h.emit("session_shutdown", {}, s.ctx);
  await flush();
  expect(wrapped.getText()).toBe("");
  expect((globals[STASH_KEY] as PromptStash).value).toBe("draft");
  wrapped.setText("after");
  wrapped.handleInput(CTRL_S);
  expect(wrapped.getText()).toBe("after");
});

test("a fresh extension restores a cursor/mode snapshot after session replacement", async () => {
  const { h, s } = await start({ base: () => new SnapshotEditor() });
  const editor = s.state.main as SnapshotEditor;
  editor.setText("carry snapshot");
  editor.mode = "normal";
  editor.cursor = { line: 0, col: 4 };
  editor.handleInput(CTRL_S);
  await h.emit("session_shutdown", {}, s.ctx);
  const nextHarness = harness();
  promptStash(nextHarness.pi);
  const next = nextHarness.session({ base: () => new SnapshotEditor() });
  await nextHarness.emit("session_start", {}, next.ctx);
  const restored = next.state.main as SnapshotEditor;
  expect(restored.text).toBe("carry snapshot");
  expect(restored.mode).toBe("normal");
  expect(restored.cursor.col).toBe(4);
});

test("replacement without shutdown uses the live context and does not restore over a new draft", async () => {
  const { h, s } = await start();
  s.state.main.setText("carry");
  s.state.main.handleInput(CTRL_S);
  const next = h.session();
  next.state.main.setText("new draft");
  await h.emit("session_start", {}, next.ctx);
  expect(next.state.main.getText()).toBe("new draft");
  next.state.main.handleInput(CTRL_S);
  expect(next.state.main.getText()).toBe("carry");
  expect((globals[STASH_KEY] as PromptStash).value).toBe("new draft");
});

test("shutdown never tears down a newer editor owner", async () => {
  const { h, s } = await start();
  const newer = () => new FakeEditor();
  s.ui.setEditorComponent(newer);
  await h.emit("session_shutdown", {}, s.ctx);
  expect(s.factory()).toBe(newer);
});

test("duplicate instance diagnostics work even when its editor wrapper is hidden", async () => {
  const first = await start();
  first.s.ui.setEditorComponent(() => new FakeEditor());
  const other = harness();
  promptStash(other.pi);
  const second = other.session();
  await other.emit("session_start", {}, second.ctx);
  expect(second.factory()).toBe(second.baseFactory);
  expect(second.notes.at(-1)?.message).toMatch(/another pi-stash instance is active/);
  await other.emit("session_shutdown", {}, second.ctx);
  expect(globals[LEASE]).toBeDefined(); // inactive copy must not release the first copy
  await first.h.emit("session_shutdown", {}, first.s.ctx);
  expect(globals[LEASE]).toBeUndefined();
});

test("shell completion cannot overwrite a newly typed identical command", async () => {
  const { s } = await start();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("!ls");
  s.state.main.handleInput(ENTER);
  s.state.main.setText("!ls"); // a new draft, not the completed command
  s.shell.resolve?.();
  await flush();
  expect(s.state.main.getText()).toBe("!ls");
  expect((globals[STASH_KEY] as PromptStash).value).toBe("draft");
});

test("late shell completion cannot restore into a replacement session", async () => {
  const { h, s } = await start();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("!ls");
  s.state.main.handleInput(ENTER);
  const next = h.session();
  next.state.main.setText("new draft");
  await h.emit("session_start", {}, next.ctx);
  s.shell.resolve?.();
  await flush();
  expect(next.state.main.getText()).toBe("new draft");
  expect((globals[STASH_KEY] as PromptStash).value).toBe("draft");
});

test("embedded submits never trigger an automatic restore", async () => {
  const { s } = await start();
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  const embedded = markEmbedded(s.embed());
  embedded.onSubmit = () => undefined;
  await flush();
  embedded.setText("/x");
  embedded.handleInput(ENTER);
  await flush();
  expect(s.state.main.getText()).toBe("");
  expect((globals[STASH_KEY] as PromptStash).value).toBe("draft");
});

test("autocomplete Enter that does not submit leaves the stash alone", async () => {
  class CompletionEditor extends FakeEditor {
    override handleInput(data: string) { if (data !== ENTER) super.handleInput(data); }
  }
  const { s } = await start({ base: () => new CompletionEditor() });
  s.state.main.setText("draft");
  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("/mo");
  s.state.main.handleInput(ENTER);
  await flush();
  expect(s.submitted).toEqual([]);
  expect((globals[STASH_KEY] as PromptStash).value).toBe("draft");
});

test("unknown focus and a focused dialog with identical text cannot stash the main draft", async () => {
  const { s } = await start();
  s.state.main.setText("same");
  s.state.focused = undefined;
  s.state.main.handleInput(CTRL_S);
  expect(s.state.main.getText()).toBe("same");
  expect((globals[STASH_KEY] as PromptStash).hasPrompt).toBe(false);
  const dialog = s.embed();
  dialog.setText("same");
  s.state.focused = s.state.main;
  dialog.handleInput(CTRL_S);
  expect((globals[STASH_KEY] as PromptStash).hasPrompt).toBe(false);
});

test("a failed shell submit restores safely and preserves the original error", async () => {
  const h = harness();
  promptStash(h.pi);
  const s = h.session();
  s.state.main.setText("draft");
  await h.emit("session_start", {}, s.ctx);
  // Create through the wrapper so we can supply a failing callback before its microtask.
  const editor = s.embed();
  const failure = new Error("shell failed");
  editor.onSubmit = async () => { throw failure; };
  s.state.main = editor;
  s.state.focused = editor;
  editor.setText("draft");
  await flush();
  editor.handleInput(CTRL_S);
  editor.setText("!false");
  await expect(editor.onSubmit!("!false")).rejects.toBe(failure);
  expect(editor.getText()).toBe("draft");
});

test("malformed or throwing snapshot providers fall back to plain text", () => {
  const invalid = new FakeEditor();
  Object.assign(invalid, { [EDITOR_SNAPSHOT]: { capture: () => ({ version: 1, text: "x" }), restore: () => true } });
  expect(capture(invalid, "x")).toEqual({ text: "x" });
  const throws = new FakeEditor();
  Object.assign(throws, { [EDITOR_SNAPSHOT]: { capture: () => { throw new Error("oops"); }, restore: () => false } });
  expect(capture(throws, "x")).toEqual({ text: "x" });
});

test("SDK native editor clears before onSubmit and still restores after a shell command", async () => {
  const { s } = await start({ base: () => new CustomEditor(
    { requestRender() {} } as never,
    {
      borderColor: (text) => text,
      selectList: {
        selectedPrefix: (text) => text, selectedText: (text) => text,
        description: (text) => text, scrollInfo: (text) => text, noMatch: (text) => text,
      },
    },
    { matches: () => false } as never,
  ) as unknown as FakeEditor });
  s.state.main.setText("native draft");
  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("!ls");
  s.state.main.handleInput(ENTER);
  expect(s.state.main.getText()).toBe("");
  expect(s.submitted).toEqual(["!ls"]);
  s.shell.resolve?.();
  await flush();
  expect(s.state.main.getText()).toBe("native draft");
});

test("non-TUI sessions install nothing", async () => {
  const h = harness();
  promptStash(h.pi);
  const s = h.session({ mode: "rpc" });
  await h.emit("session_start", {}, s.ctx);
  expect(s.factory()).toBe(s.baseFactory);
  expect(globals[STASH_KEY]).toBeUndefined();
});

// ─── stash service for other plugins' editors ───

test("service: answers only while active, and each controller keeps its own stash", async () => {
  const h = harness();
  promptStash(h.pi);
  const before: StashRequest = { version: 1 };
  h.events.emit(STASH_CHANNEL, before);
  expect(before.create).toBeUndefined();

  const s = h.session();
  await h.emit("session_start", {}, s.ctx);
  const request: StashRequest = { version: 1 };
  h.events.emit(STASH_CHANNEL, request);
  expect(request.provider).toBe("pi-stash");

  const editor = new SnapshotEditor();
  const notes: string[] = [];
  let changes = 0;
  const ctl = request.create!({ editor: () => editor, notify: (m) => notes.push(m), changed: () => changes++ });
  expect(ctl.handleKey("x")).toBe(false);
  expect(ctl.handleKey(CTRL_S)).toBe(true);
  expect(notes.at(-1)).toBe("Nothing to stash");

  editor.text = "side draft";
  editor.mode = "normal";
  ctl.handleKey(CTRL_S);
  expect(editor.text).toBe("");
  expect(ctl.stashed).toBe(true);
  expect(changes).toBe(1);
  expect(globals[STASH_KEY] && (globals[STASH_KEY] as PromptStash).hasPrompt).toBe(false); // main's stash untouched

  editor.text = "other";
  ctl.handleKey(CTRL_S);
  expect(editor.text).toBe("side draft");
  expect(editor.mode).toBe("normal");
  expect(notes.at(-1)).toBe("Swapped current and stashed prompts");

  ctl.submitted("a question"); // not a / command: nothing comes back
  editor.text = "";
  ctl.submitted("a question");
  expect(editor.text).toBe("");
  ctl.submitted("/new");
  expect(editor.text).toBe("other");
  expect(ctl.stashed).toBe(false);
});
