import assert from "node:assert/strict";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { type LaneInput, LanesPage } from "../src/app/lanes-page.js";
import { PiChat, piChatTheme } from "../src/app/pi-chat.js";
import {
  EDITOR_FACTORY_CHANNEL,
  EDITOR_MODE,
  type EditorFactoryOptions,
  type EditorFactoryRequest,
  readEditorMode,
  readEditorSurface,
  readInputContext,
  type SuiteEditor,
} from "../src/editor-contract.js";
import planMode from "../src/index.js";
import type { PlannerAgent } from "../src/planner/agent.js";
import { PlannerTrace } from "../src/planner-trace.js";
import { SubagentTracker } from "../src/subagent-progress.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark");
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as never;
const editorTheme = {
  borderColor: (text: string) => text,
  selectList: {
    selectedPrefix: (text: string) => text,
    selectedText: (text: string) => text,
    description: (text: string) => text,
    scrollInfo: (text: string) => text,
    noMatch: (text: string) => text,
  },
};
const tui = { terminal: { rows: 40, cols: 120 }, requestRender() {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// URL imports keep production independent and don't pull sibling sources into this package's rootDir.
async function embeddedConstructor(): Promise<new (options: EditorFactoryOptions) => SuiteEditor> {
  return (await import(new URL("../../pi-vim/src/embedded-editor.ts", import.meta.url).href)).EmbeddedEditor;
}

function agent(): PlannerAgent {
  return {
    id: "A",
    name: "Model A",
    spec: { provider: "test", modelId: "model" },
    status: "idle",
    working: false,
    chat: new PiChat(piChatTheme, { cwd: "/fixture" }),
    trace: new PlannerTrace(),
    subagents: new SubagentTracker("A"),
    stats: { startedAt: 1, endedAt: 2, totalTokens: 0, costUsd: 0, toolCalls: 0, subagentTasks: 0 },
    revision: 1,
    plan: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"),
  } as PlannerAgent;
}

function laneOptions(a: PlannerAgent, say: (agent: PlannerAgent, text: string) => void) {
  return {
    title: "Plan",
    task: () => "inspect",
    agents: () => [a],
    actions: () => [],
    onAction() {},
    say,
    hide() {},
    stopAll() {},
    rowsAvailable: () => 40,
    requestRender() {},
  };
}

function laneAdapter(editor: SuiteEditor): LaneInput {
  return {
    get focused() {
      return editor.focused;
    },
    set focused(value: boolean) {
      editor.focused = value;
    },
    getValue: () => editor.getText(),
    setValue: (text) => editor.setText(text),
    render: (width) => editor.render(width),
    handleInput: (data) => editor.handleInput(data),
    ownsEnter: true,
    [EDITOR_MODE]: () => readEditorMode(editor),
    dispose: () => editor.dispose(),
  };
}

test("actual pi-vim embedded lane preserves Insert, Visual, pending, EX and autocomplete input ownership", async () => {
  const EmbeddedEditor = await embeddedConstructor();
  const submitted: string[] = [];
  let editor!: SuiteEditor;
  let cancels = 0;
  const page = new LanesPage(theme, {
    ...laneOptions(agent(), (_agent, text) => submitted.push(text)),
    createInput: (_id, hooks) => {
      editor = new EmbeddedEditor({
        surface: "embedded",
        tui: tui as never,
        theme: editorTheme,
        keybindings: { matches: () => false, getKeys: () => [] } as never,
        onSubmit: hooks.submit,
        onCancel: () => {
          cancels++;
          hooks.cancel();
        },
        scrollViewport: hooks.scroll,
      });
      return laneAdapter(editor);
    },
  });
  try {
    page.render(100);
    assert.equal(readEditorSurface(page), "embedded");
    assert.equal(readInputContext(page), "editor");
    for (const char of "draft") page.handleInput(char);
    page.handleInput("\x1b"); // Insert -> Normal, not the app's leave menu.
    assert.equal(cancels, 0);
    assert.equal(readEditorMode(page)?.state, "normal");
    page.handleInput("d");
    assert.equal(readEditorMode(page)?.state, "pending");
    page.handleInput("\x15"); // Pending Ctrl+U belongs to the engine, not the lane viewport.
    assert.match(page.render(100).join("\n"), /line 0/u);
    if (readEditorMode(page)?.state !== "normal") page.handleInput("\x1b");
    page.handleInput("v");
    assert.equal(readEditorMode(page)?.state, "visual");
    page.handleInput("\x04");
    assert.match(page.render(100).join("\n"), /line 0/u);
    if (readEditorMode(page)?.state !== "normal") page.handleInput("\x1b");
    page.handleInput(":");
    page.handleInput("x");
    page.handleInput("\x15"); // The editor may cancel EX, but it must not scroll the plan.
    assert.match(page.render(100).join("\n"), /line 0/u);
    if (readEditorMode(page)?.state !== "ex") page.handleInput(":");
    page.handleInput("\t");
    assert.equal(page.focus, 0, "EX Tab cannot leave the composer");
    if (readEditorMode(page)?.state !== "normal") page.handleInput("\x1b");
    page.handleInput("i");
    const internal = editor as unknown as { autocompleteState: string | null };
    internal.autocompleteState = "regular";
    assert.equal(readEditorMode(page)?.autocomplete, true);
    page.handleInput("\t");
    assert.equal(page.focus, 0, "autocomplete Tab cannot switch panes");
    internal.autocompleteState = null;
    page.handleInput("\x1b");
    editor.setText("first\nsecond");
    page.handleInput("\x1b[B");
    assert.equal(editor.getCursor().line, 1, "Normal arrows edit a nonempty multiline draft, not the viewer");
    editor.setText("draft");
    page.handleInput("\x04");
    assert.doesNotMatch(page.render(100).join("\n"), /\bline 0\b/u, "idle Normal Ctrl+D scrolls half a viewport");
    page.handleInput("\x15");
    assert.match(page.render(100).join("\n"), /line 0/u);
    for (const key of [":", "w", "\r"]) page.handleInput(key);
    assert.deepEqual(submitted, ["draft"]);
    assert.equal(cancels, 0);
  } finally {
    page.dispose();
  }
});

test("native lane drafts keep native Ctrl+U instead of scrolling, empty read-only lanes use half-pages", () => {
  const submitted: string[] = [];
  const page = new LanesPage(
    theme,
    laneOptions(agent(), (_agent, text) => submitted.push(text)),
  );
  try {
    page.render(100);
    for (const char of "draft") page.handleInput(char);
    page.handleInput("\x15");
    assert.match(page.render(100).join("\n"), /line 0/u);
    page.handleInput("n");
    page.handleInput("\r");
    assert.deepEqual(submitted, ["n"], "Ctrl+U edited the draft");
    page.handleInput("\x0f"); // Return from chat to the plan.
    const position = () => {
      const match = /plan (\d+)–(\d+)\/\d+/u.exec(page.render(100).join("\n"));
      assert.ok(match);
      return { start: Number(match[1]), size: Number(match[2]) - Number(match[1]) + 1 };
    };
    const before = position();
    page.handleInput("\x04");
    assert.equal(position().start, before.start + Math.max(1, Math.floor(before.size / 2)));
    page.handleInput("\x15");
    assert.equal(position().start, before.start);
    page.handleInput("\x1b[6~");
    assert.equal(position().start, before.start + before.size, "PageDown is the optional full-page alias");
    page.handleInput("\x1b[5~");
    assert.equal(position().start, before.start);
  } finally {
    page.dispose();
  }
});

test("/plan discovers the actual embedded factory for task and lane editors and disposes both", async () => {
  const EmbeddedEditor = await embeddedConstructor();
  const mock = createMockPi();
  const editors: SuiteEditor[] = [];
  let disposals = 0;
  mock.eventBus.on(EDITOR_FACTORY_CHANNEL, (data) => {
    const request = data as EditorFactoryRequest;
    request.factory = (options) => {
      assert.equal(options.surface, "embedded");
      const editor = new EmbeddedEditor(options);
      const dispose = editor.dispose.bind(editor);
      editor.dispose = () => {
        disposals++;
        dispose();
      };
      editors.push(editor);
      return editor;
    };
    request.provider = "pi-vim";
  });
  let app!: ReturnType<typeof createCustomSelectorHarness>;
  const ctx = createMockContext({
    mode: "tui",
    hasUI: true,
    model: { provider: "test", id: "model", name: "Model A" },
    modelRegistry: { getAvailable: () => [{ provider: "test", id: "model", name: "Model A" }] },
    sessionManager: { getBranch: () => mock.entries.map((entry) => ({ type: "custom", ...entry })) },
    custom: (factory: unknown) => {
      app = createCustomSelectorHarness(factory, 120, undefined, 40);
      return app.resultPromise;
    },
  }).ctx as ExtensionCommandContext;
  await planMode(mock.pi, { readSettings: async () => ({ thinkingLevel: "inherit", jevToolSelection: false }) });
  const first = mock.commands.get("plan")?.handler("task", ctx);
  await tick();
  app.handleInput("\t");
  assert.equal(editors.length, 1);
  const taskEditor = editors[0];
  assert.ok(taskEditor);
  assert.equal(readEditorSurface(taskEditor), "embedded");
  app.handleInput("\x1b");
  assert.equal(readEditorMode(taskEditor)?.state, "normal");
  app.handleInput(":");
  app.handleInput("\t");
  assert.equal(taskEditor.focused, true, "EX Tab must stay in the task box");
  app.dispose();
  await first;
  assert.equal(disposals, 1);

  mock.entries.push({
    customType: "plan-run",
    data: {
      id: "run",
      task: "task",
      state: "active",
      createdAt: 1,
      planners: [
        { id: "A", name: "Model A", spec: "test/model", sessionFile: "/fixture/planner.jsonl", plan: "# Ready" },
      ],
    },
  });
  for (const handler of mock.events.get("session_start") ?? []) await handler({}, ctx);
  const second = mock.commands.get("plan")?.handler("", ctx);
  await tick();
  app.render();
  assert.equal(editors.length, 2);
  assert.equal(readEditorSurface(editors[1]), "embedded");
  app.dispose();
  await second;
  assert.equal(disposals, 2);
  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
});
