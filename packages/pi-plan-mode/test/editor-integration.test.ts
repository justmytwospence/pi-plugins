import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";
import { InteractiveMode as InteractiveMode14, initTheme as initTheme14 } from "pi-coding-agent-1-4";
import { TuiMainScreen as TuiMainScreen14 } from "pi-tui-1-4";
import { test } from "vitest";
import { openPlanningView } from "../src/app/frame.js";
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
import { FAMILY_CHANNEL, type FamilyRequest, type FamilyService } from "../src/family-contract.js";
import { HERDR_BLOCKED_CHANNEL } from "../src/herdr-blocked.js";
import planMode from "../src/index.js";
import type { PlannerAgent } from "../src/planner/agent.js";
import { PlannerTrace } from "../src/planner-trace.js";
import { SubagentTracker } from "../src/subagent-progress.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./support.js";

initTheme("dark");
initTheme14("dark");
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
    plan: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n\n"),
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

for (const { version, Mode, Screen } of [
  { version: "1.2", Mode: InteractiveMode, Screen: TuiMainScreen },
  { version: "1.4", Mode: InteractiveMode14, Screen: TuiMainScreen14 },
]) {
  test(`Pi ${version} fallback planning closes through done and restores main focus`, async () => {
    const screen = new Screen({ rows: 40, columns: 120, hideCursor() {} } as Terminal);
    screen.requestRender = () => {};
    const editor = { render: () => [], getText: () => "main draft", invalidate() {} };
    screen.setFocus(editor);
    const host = { ui: screen, editor };
    const ui = {
      custom: (factory: unknown, options: unknown) =>
        (
          Mode.prototype as unknown as { showExtensionCustom: (...args: unknown[]) => Promise<void> }
        ).showExtensionCustom.call(host, factory, options),
    };
    let close!: () => void;
    const opened = openPlanningView({ ui } as never, undefined, (_tui, _theme, _keys, done, viewport) => {
      close = done;
      assert.equal(viewport().height, 40);
      return { render: () => ["planning"], invalidate() {} };
    });
    await tick();
    // 1.2's custom API pops its top overlay: fallback steps aside before the dialog mounts.
    // 1.4 owns its overlay handle and also supports closing underneath an existing dialog.
    if (version === "1.2") {
      close();
      await opened;
    }
    let dialogDone!: () => void;
    const dialog = { render: () => ["native question"], invalidate() {} };
    const waiting = ui.custom(
      (_tui: unknown, _theme: unknown, _keys: unknown, done: () => void) => {
        dialogDone = done;
        return dialog;
      },
      { overlay: true },
    );
    await tick();
    if (version === "1.4") {
      close();
      await opened;
    }
    assert.equal(screen.hasOverlayEntries, true);
    assert.equal(screen.getFocusedComponent(), dialog);
    dialogDone();
    await waiting;
    assert.equal(screen.hasOverlayEntries, false);
    assert.equal(screen.getFocusedComponent(), editor);
  });
}

for (const width of [46, 120, 180]) {
  test(`hosted lanes use allocated viewport and retain drafts and family subject at ${width} columns`, async () => {
    const a = agent();
    Object.assign(a, { familyAgentId: "planner-uuid" });
    a.subagents.apply("call", {
      kind: "plan-subagents-progress",
      version: 1,
      scouts: [
        {
          index: 0,
          label: "scout",
          model: "p/m",
          task: "look",
          state: "running",
          startedAt: 1,
          familyAgentId: "scout-uuid",
        },
      ],
      events: [],
    });
    let height = 20;
    let page!: LanesPage;
    let close!: () => void;
    const family = {
      view: async ({ factory }) => {
        page = (await factory(
          tui as never,
          theme,
          undefined,
          () => {},
          () => ({ width, height }),
        )) as LanesPage;
      },
    } satisfies Partial<FamilyService>;
    await openPlanningView(
      {
        ui: {
          custom: () => {
            throw new Error("must not overlay");
          },
        },
      } as never,
      family as FamilyService,
      (_tui, _theme, _keys, done, viewport) => {
        close = done;
        return new LanesPage(theme, { ...laneOptions(a, () => {}), rowsAvailable: () => viewport().height });
      },
    );
    assert.equal(page.viewedAgentId(), "planner-uuid");
    page.render(width);
    page.handleInput("\x0e");
    assert.equal(page.viewedAgentId(), "scout-uuid");
    page.handleInput("\x1b");
    assert.equal(page.viewedAgentId(), "planner-uuid");
    for (const char of "draft") page.handleInput(char);
    assert.match(page.render(width).join("\n"), /draft/u);
    height = 35;
    page.render(width);
    height = 20;
    assert.equal(page.render(width).length, 20);
    assert.match(page.render(width).join("\n"), /draft/u);
    page.handleInput("\t");
    assert.equal(page.viewedAgentId(), "planner-uuid", "actions retain meaningful focus");
    page.dispose();
    close();
  });
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
    page.handleInput("\x1b[D"); // Left on the empty line: from the chat back to the plan.
    const position = () => {
      const match = /plan {2}chat ─+ (\d+)–(\d+)\/\d+/u.exec(page.render(100).join("\n"));
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

test("the planning app delegates native-dialog suspension to the family host without discarding its page", async () => {
  const mock = createMockPi();
  let app!: ReturnType<typeof createCustomSelectorHarness>;
  let height = 22;
  const family = {
    focus: () => {},
    view: async ({ factory }) => {
      app = createCustomSelectorHarness(
        (tui: unknown, theme: unknown, keys: unknown, done: () => void) =>
          factory(tui as never, theme, keys, done, () => ({ width: 120, height })),
        120,
        undefined,
        50,
      );
      await app.resultPromise;
    },
  } satisfies Partial<FamilyService>;
  mock.eventBus.on(FAMILY_CHANNEL, (data) => {
    (data as FamilyRequest).service = family as unknown as FamilyService;
  });
  const ctx = createMockContext({
    mode: "tui",
    hasUI: true,
    custom: () => {
      throw new Error("hosted planning must not create a fullscreen overlay");
    },
  }).ctx as ExtensionCommandContext;
  await planMode(mock.pi, { readSettings: async () => ({ thinkingLevel: "inherit", jevToolSelection: false }) });
  const opened = mock.commands.get("planners")?.handler("keep this task", ctx);
  await tick();
  assert.equal(app.isFocusable, true);
  assert.ok(app.render().length <= 22);
  mock.eventBus.emit(HERDR_BLOCKED_CHANNEL, { active: true, label: "Native question" });
  assert.equal(app.result, undefined);
  assert.match(app.render().join("\n"), /keep this task/u);
  app.setFocused(false);
  height = 35;
  app.render();
  mock.eventBus.emit(HERDR_BLOCKED_CHANNEL, { active: false, label: "Native question" });
  app.setFocused(true);
  assert.match(app.render().join("\n"), /keep this task/u);
  app.dispose();
  await opened;
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
  const first = mock.commands.get("planners")?.handler("task", ctx);
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
  const second = mock.commands.get("planners")?.handler("", ctx);
  await tick();
  const screen = app.render().map((line) => stripVTControlCharacters(line));
  assert.equal(editors.length, 2);
  assert.equal(readEditorSurface(editors[1]), "embedded");
  // The lane draws one rule above its input; the editor's own border lines are left out.
  const rule = screen.findIndex((line) => /^── plan {2}chat ─+$/u.test(line));
  assert.ok(rule >= 0, "the lane's rule");
  assert.match(screen[rule + 1] ?? "", /^› /u, "the input text comes right under the rule, with no editor border");
  assert.match(screen[rule + 3] ?? "", /Implement…|Actions appear/u, "then the footer: its rule and the actions");
  app.dispose();
  await second;
  assert.equal(disposals, 2);
  for (const handler of mock.events.get("session_shutdown") ?? []) await handler({}, ctx);
});
