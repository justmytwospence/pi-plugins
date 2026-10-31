import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  type ExtensionAPI,
  type ExtensionContext,
  initTheme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import planMode from "../src/index.js";
import {
  ENTER_TOOL,
  EXEC_GUIDANCE,
  EXIT_TOOL,
  INLINE_ENTRY,
  MODE_CHANGED,
  MODE_SET,
  NOTICE_TYPE,
  PLAN_PROVIDER,
  registerInlinePlanMode,
} from "../src/inline-plan.js";
import * as planFiles from "../src/plan-file.js";
import { PlanNameInput } from "../src/plan-name-input.js";
import { createCustomSelectorHarness, createMockContext, createMockPi } from "./shared/support.js";

const opus = { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true };
const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true };

type Tool = {
  exposure?: string;
  name: string;
  execute(...args: unknown[]): Promise<{ content: Array<{ text: string }>; details?: any; terminate?: boolean }>;
};

async function setup(
  options: {
    select?: string[];
    input?: string;
    gate?: boolean;
    cycle?: string[];
    plansDirectory?: string;
    cwd?: string;
    /** Give the session a model (opus) with a sonnet handoff target. */
    models?: boolean;
    approval?: string;
    toggleShortcut?: "alt+p";
    switchFails?: boolean;
    implementationModelMap?: Record<string, Array<{ provider: string; modelId: string }>>;
  } = {},
) {
  const mock = createMockPi();
  if (options.switchFails) (mock.pi as ExtensionAPI).setModel = async () => false;
  const plansDirectory = options.plansDirectory ?? mkdtempSync(join(tmpdir(), "plans-"));
  await planMode(mock.pi, {
    readSettings: async () => ({
      thinkingLevel: "inherit" as const,
      jevToolSelection: false,
      plansDirectory,
      ...(options.toggleShortcut ? { toggleShortcut: options.toggleShortcut } : {}),
      ...(options.implementationModelMap ? { implementationModelMap: options.implementationModelMap } : {}),
      ...(options.models
        ? {
            implementationModelMap: {
              "anthropic/claude-opus-5-5": [
                {
                  provider: "anthropic",
                  modelId: "claude-sonnet-5-5",
                  thinkingLevel: "high",
                },
              ],
            },
          }
        : {}),
    }),
  });
  const answers = [...(options.select ?? [])];
  const selects: Array<{ title: string; options: string[] }> = [];
  const context = createMockContext({
    // Keep the RPC fallback covered here; the viewport suite drives the real TUI picker.
    mode: "rpc",
    hasUI: true,
    cwd: options.cwd ?? "/work/app",
    select: async (title: string, choices: string[]) => {
      selects.push({ title, options: choices });
      return title === "Implementation effort" && answers.length === 0 ? "high" : answers.shift();
    },
    input: async () => options.input,
    ...(options.models
      ? {
          model: opus,
          modelRegistry: {
            getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
            getAvailable: () => [opus, sonnet],
            getAll: () => [opus, sonnet],
            find: (provider: string, id: string) => [opus, sonnet].find((m) => m.provider === provider && m.id === id),
            isUsingOAuth: () => false,
          },
        }
      : {}),
    sessionManager: {
      getSessionId: () => "s",
      getBranch: () => [
        { type: "message", id: "planning-leaf" },
        ...mock.entries.map((entry, index) => ({ type: "custom", id: `entry-${index}`, ...entry })),
      ],
      getEntries: () => [],
      getSessionFile: () => "/main.jsonl",
      buildSessionProjection: () => ({ messages: [{ role: "user", content: "plan it", timestamp: 1 }] }),
    },
  });
  const session = (context.ctx as ExtensionContext).sessionManager as unknown as Record<string, unknown>;
  const getLeafId = vi.fn(() => "planning-leaf");
  const newSession = vi.fn(async () => ({ cancelled: false }));
  session.getLeafId = getLeafId;
  (context.ctx as unknown as Record<string, unknown>).newSession = newSession;
  const projection = vi.spyOn((context.ctx as ExtensionContext).sessionManager, "buildSessionProjection");
  const gateEvents: Array<{ channel: string; data: any }> = [];
  if (options.gate) {
    // A stand-in for pi-tool-gate: workflow and approvals have independent events.
    let mode = "work";
    let approval = options.approval ?? "auto";
    const announce = () =>
      mock.eventBus.emit(MODE_CHANGED, {
        mode,
        cycle: options.cycle ?? ["work", "chat", "plan"],
      });
    mock.eventBus.on("permission-mode:set", (data) => {
      gateEvents.push({ channel: "permission-mode:set", data });
      approval = (data as { mode: string }).mode;
      mock.eventBus.emit("permission-mode:changed", { mode: approval, cycle: ["auto", "bypassPermissions"] });
    });
    mock.eventBus.emit("permission-mode:changed", { mode: approval, cycle: ["auto", "bypassPermissions"] });
    mock.eventBus.on(MODE_SET, (data) => {
      gateEvents.push({ channel: MODE_SET, data });
      mode = (data as { mode: string }).mode;
      announce();
    });
    mock.eventBus.on(PLAN_PROVIDER, (data) => gateEvents.push({ channel: PLAN_PROVIDER, data }));
    announce();
  }
  for (const handler of mock.events.get("session_start") ?? []) await handler({ reason: "startup" }, context.ctx);
  const tool = (name: string) => mock.tools.find((candidate) => candidate.name === name) as unknown as Tool;
  const emit = async (name: string, payload: Record<string, unknown>) => {
    let result: unknown;
    for (const handler of mock.events.get(name) ?? [])
      result = (await handler({ type: name, ...payload }, context.ctx)) ?? result;
    return result as any;
  };
  const inline = () => mock.entries.filter((entry) => entry.customType === INLINE_ENTRY).at(-1)?.data as any;
  return { mock, context, selects, tool, emit, inline, gateEvents, plansDirectory, getLeafId, newSession, projection };
}

for (const gate of [false, true]) {
  for (const approval of ["auto", "bypassPermissions"]) {
    test(`Save for later leaves planning without implementation (${gate ? "gate" : "standalone"}, ${approval})`, async () => {
      const h = await setup({
        gate,
        approval,
        models: true,
        select: ["Save for later", "Enter different name"],
        input: "My custom name.md",
      });
      const ctx = h.context.ctx as ExtensionContext;
      const permissions: unknown[] = [];
      h.mock.eventBus.on("permission-mode:set", (data) => permissions.push(data));
      h.mock.eventBus.on("permission-mode:changed", (data) => permissions.push(data));
      await h.mock.commands.get("plan")?.handler("", ctx);
      const draft = h.inline().planFile;
      const plan = "# Add retry support\n\n1. Preserve `literal` details.";
      writeFileSync(draft, `${plan}\n`);
      const input = vi.fn<ExtensionContext["ui"]["input"]>().mockResolvedValue("My custom name.md");
      ctx.ui.input = input;
      const controller = new AbortController();
      const result = await h.tool(EXIT_TOOL).execute("save", {}, controller.signal, undefined, ctx);
      const saved = join(h.plansDirectory, "my-custom-name.md");
      assert.match(input.mock.calls[0]?.[0] ?? "", /^Save plan as/u);
      assert.ok(!input.mock.calls[0]?.[1], "renaming starts without a placeholder suggestion");
      assert.equal(input.mock.calls[0]?.[2]?.signal, controller.signal);
      assert.deepEqual(h.selects[1], {
        title: "Save plan as add-retry-support.md",
        options: ["Use suggested name", "Enter different name", "Cancel"],
      });
      assert.equal(result.terminate, true);
      assert.deepEqual(result.details, {
        plan,
        planFile: draft,
        savedFile: saved,
        outcome: "saved",
        edited: false,
        mode: "work",
      });
      assert.ok(result.content[0]?.text.includes(saved));
      assert.match(result.content[0]?.text ?? "", /not approval to implement[\s\S]*Stop here/u);
      assert.equal(readFileSync(saved, "utf8"), `${plan}\n`);
      assert.equal(readFileSync(draft, "utf8"), `${plan}\n`, "the original draft is intact");
      assert.equal(h.inline().active, false);
      assert.equal(h.inline().planFile, undefined);
      assert.equal(h.context.statuses.get("workflow-mode"), gate ? undefined : "workflow: work");
      if (gate) {
        assert.deepEqual(
          h.gateEvents.filter((e) => e.channel === MODE_SET).map((e) => e.data.mode),
          ["plan", "work"],
        );
        assert.deepEqual(h.gateEvents.filter((e) => e.channel === PLAN_PROVIDER).at(-1)?.data, {});
      }
      assert.deepEqual(permissions, []);
      assert.equal(ctx.model, opus);
      assert.deepEqual(h.mock.setModels, []);
      assert.deepEqual(h.mock.thinkingLevels, []);
      assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
      assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
      assert.equal(
        h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
        false,
      );
      assert.equal(h.newSession.mock.calls.length, 0);
      assert.equal(h.projection.mock.calls.length, 0);
      assert.deepEqual(h.mock.sentUserMessages, []);
      assert.equal(await h.emit("before_agent_start", { prompt: "next" }), undefined);
      const entries = h.mock.entries.length;
      await h.emit("session_tree", {});
      assert.equal(h.mock.entries.length, entries, "restore does not persist a new draft");
      assert.equal(await h.emit("before_agent_start", { prompt: "restored" }), undefined);
      await h.mock.commands.get("plan")?.handler("", ctx);
      assert.equal(h.inline().active, true);
      assert.notEqual(h.inline().planFile, draft, "later planning allocates a fresh draft");
      assert.notEqual(h.inline().planFile, saved);
      assert.equal(existsSync(h.inline().planFile), false);
      assert.equal(readFileSync(saved, "utf8"), `${plan}\n`);
      assert.equal(readFileSync(draft, "utf8"), `${plan}\n`);
    });
  }
}

test("saving never calls the approval hook or any implementation host callback", async () => {
  const h = setupWorkflowLifecycle();
  await h.emit("session_start");
  Object.assign(h.ctx, { mode: "rpc" });
  h.ctx.ui.select = async (title) => (title === "Implement this plan?" ? "Save for later" : "Enter different name");
  h.ctx.ui.input = async () => "deferred";
  h.inline.enter(h.ctx);
  writeFileSync(h.inline.planFile as string, "# Deferred work\n");
  const tool = h.mock.tools.find((candidate) => candidate.name === EXIT_TOOL) as unknown as Tool;
  const result = await tool.execute("save-host", {}, undefined, undefined, h.ctx);
  assert.equal(result.details.outcome, "saved");
  for (const callback of [h.approved, h.compactHere, h.handoff, h.implementHere])
    assert.equal(callback.mock.calls.length, 0);
  assert.equal(h.inline.active, false);
  assert.equal(h.inline.planFile, undefined);
});

for (const title of ["Plan", "The plan"]) {
  test(`Save for later leaves the generic ${title} filename suggestion empty`, async () => {
    const h = await setup({ select: ["Save for later"] });
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    writeFileSync(h.inline().planFile, `# ${title}\n`);
    const input = vi.fn<ExtensionContext["ui"]["input"]>().mockResolvedValue(undefined);
    (h.context.ctx as ExtensionContext).ui.input = input;
    await h.tool(EXIT_TOOL).execute("generic-title", {}, undefined, undefined, h.context.ctx);
    assert.ok(!input.mock.calls[0]?.[1]);
    assert.equal(h.selects.length, 2, "no name-choice selector opens without a suggestion");
    assert.equal(h.selects[1]?.title, "Implement this plan?");
    assert.equal(h.inline().active, true);
  });
}

test("Save for later snapshots user-edited review text, not the originally submitted plan", async () => {
  const h = await setup({
    select: ["Edit the plan", "Save for later", "Enter different name"],
    input: "edited-snapshot",
  });
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  const draft = h.inline().planFile;
  writeFileSync(draft, "# Original\n");
  const edited = "# User revised title\n\nUse Redis, not SQLite.";
  (h.context.ctx as ExtensionContext).ui.editor = async () => edited;
  const editor = process.env.EDITOR;
  const visual = process.env.VISUAL;
  delete process.env.EDITOR;
  delete process.env.VISUAL;
  try {
    const result = await h.tool(EXIT_TOOL).execute("edited-save", {}, undefined, undefined, h.context.ctx);
    assert.equal(result.details.outcome, "saved");
    assert.equal(result.details.edited, true);
    assert.equal(result.details.plan, edited);
    assert.equal(readFileSync(result.details.savedFile, "utf8"), `${edited}\n`);
    assert.equal(readFileSync(draft, "utf8"), `${edited}\n`);
  } finally {
    if (editor !== undefined) process.env.EDITOR = editor;
    if (visual !== undefined) process.env.VISUAL = visual;
  }
});

for (const failure of ["cancel", "invalid-name", "write-error"] as const) {
  test(`Save for later ${failure} returns to review and preserves planning`, async () => {
    const h = await setup({ gate: true, select: ["Save for later", "Enter different name", "No, keep planning"] });
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    const draft = h.inline().planFile;
    writeFileSync(draft, "# Still planning\n");
    (h.context.ctx as ExtensionContext).ui.input = async () => {
      return failure === "cancel" ? undefined : failure === "write-error" ? "valid-name" : "../unsafe";
    };
    const save =
      failure === "write-error"
        ? vi.spyOn(planFiles, "savePlanSnapshot").mockImplementationOnce(() => {
            throw new Error("disk full");
          })
        : undefined;
    let result: Awaited<ReturnType<Tool["execute"]>>;
    try {
      result = await h.tool(EXIT_TOOL).execute("save-failed", {}, undefined, undefined, h.context.ctx);
    } finally {
      save?.mockRestore();
    }
    assert.equal(result.details.outcome, "kept");
    assert.equal(h.selects.length, 3);
    assert.equal(h.inline().active, true);
    assert.equal(h.inline().planFile, draft);
    assert.equal(readFileSync(draft, "utf8"), "# Still planning\n");
    assert.deepEqual(readdirSync(h.plansDirectory), [draft.split("/").at(-1)]);
    assert.deepEqual(
      h.gateEvents.filter((e) => e.channel === MODE_SET).map((e) => e.data.mode),
      ["plan"],
    );
    assert.equal(
      h.context.notifications.some((note) => note.level === "error"),
      failure !== "cancel",
    );
    assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  });
}

for (const interruption of ["branch", "workflow"] as const) {
  test(`pending save filename is invalidated by ${interruption}`, async () => {
    const h = await setup({ gate: true, select: ["Save for later", "Enter different name"] });
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    const draft = h.inline().planFile;
    writeFileSync(draft, "# Old plan\n");
    const controller = new AbortController();
    let finish!: (name: string) => void;
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    (h.context.ctx as ExtensionContext).ui.input = () =>
      new Promise<string>((resolve) => {
        finish = resolve;
        opened();
      });
    const pending = h.tool(EXIT_TOOL).execute("stale-save", {}, controller.signal, undefined, h.context.ctx);
    await ready;
    if (interruption === "workflow") h.mock.eventBus.emit(MODE_CHANGED, { mode: "chat", cycle: [] });
    else {
      h.getLeafId.mockReturnValue("other-branch");
      Object.assign((h.context.ctx as ExtensionContext).sessionManager, { getBranch: () => [] });
      await h.emit("session_tree", {});
    }
    const entries = h.mock.entries.length;
    const transitions = h.gateEvents.length;
    finish("must-not-save");
    const result = await pending;
    assert.match(result.content[0]?.text ?? "", /review expired/u);
    assert.equal(result.details?.outcome, undefined);
    assert.equal(h.mock.entries.length, entries);
    assert.equal(h.gateEvents.length, transitions);
    assert.equal(existsSync(join(h.plansDirectory, "must-not-save.md")), false);
    assert.equal(readFileSync(draft, "utf8"), "# Old plan\n");
    if (interruption !== "branch") assert.equal(h.inline().active, false);
    else assert.equal(await h.emit("tool_call", { toolName: "write", input: { path: "src/other.ts" } }), undefined);
    assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  });
}

for (const action of ["enter", "abort"] as const) {
  test(`TUI save filename ${action} uses the live PlanNameInput and releases review resources`, async () => {
    initTheme("dark", false);
    const h = await setup({ gate: true });
    const ctx = h.context.ctx as ExtensionContext;
    Object.assign(ctx, { mode: "tui" });
    await h.mock.commands.get("plan")?.handler("", ctx);
    const draft = h.inline().planFile;
    writeFileSync(draft, "# Suggested title\n\nKeep the details.\n");
    const controller = new AbortController();
    const holds: unknown[] = [];
    h.mock.eventBus.on("herdr:blocked", (data) => holds.push(data));
    const working = vi.fn<NonNullable<ExtensionContext["ui"]["setWorkingVisible"]>>();
    ctx.ui.setWorkingVisible = working;
    const removeKeys = vi.fn();
    ctx.ui.onTerminalInput = vi.fn(() => removeKeys);
    ctx.ui.input = async () => assert.fail("TUI must use its editable custom input");
    ctx.ui.select = async () => assert.fail("TUI must use its custom approval picker");
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    let nameInput!: ReturnType<typeof createCustomSelectorHarness>;
    let dialogs = 0;
    ctx.ui.custom = (async (factory) => {
      let isNameInput = false;
      const harness = createCustomSelectorHarness((...args: Parameters<typeof factory>) => {
        const component = factory(...args);
        isNameInput = component instanceof PlanNameInput;
        return component;
      });
      dialogs++;
      try {
        if (dialogs === 1) {
          assert.equal(isNameInput, false);
          harness.handleInput("tui.select.up"); // Keep planning.
          harness.handleInput("tui.select.up"); // Save for later.
          harness.handleInput("\r");
        } else {
          assert.equal(dialogs, 2, "abort must not reopen approval");
          assert.equal(isNameInput, true);
          harness.setFocused(true);
          nameInput = harness;
          opened();
        }
        return await harness.resultPromise;
      } finally {
        harness.dispose();
      }
    }) as ExtensionContext["ui"]["custom"];
    const pending = h.tool(EXIT_TOOL).execute("live-name", {}, controller.signal, undefined, ctx);
    await ready;
    assert.match(stripVTControlCharacters(nameInput.render().join("\n")), /suggested-title/u);
    assert.deepEqual(holds, [{ active: true, label: "Review the plan" }]);
    assert.equal(removeKeys.mock.calls.length, 0);
    const entries = h.mock.entries.length;
    const transitions = h.gateEvents.length;
    if (action === "enter") nameInput.handleInput("\r");
    else controller.abort(); // The real input settles; no fake prompt resolver is invoked.
    const result = await pending;
    assert.deepEqual(holds, [{ active: true, label: "Review the plan" }, { active: false }]);
    assert.deepEqual(working.mock.calls, [[false], [true]]);
    assert.equal(removeKeys.mock.calls.length, 1);
    assert.equal(
      [...h.context.widgets.entries()].some(
        ([key, value]) => key.startsWith("plan-review-viewport/") && value !== undefined,
      ),
      false,
    );
    assert.equal(dialogs, 2);
    assert.equal(readFileSync(draft, "utf8"), "# Suggested title\n\nKeep the details.\n");
    const saved = join(h.plansDirectory, "suggested-title.md");
    if (action === "enter") {
      assert.equal(result.details.outcome, "saved");
      assert.equal(result.details.savedFile, saved);
      assert.equal(readFileSync(saved, "utf8"), readFileSync(draft, "utf8"));
      assert.equal(h.inline().active, false);
    } else {
      assert.match(result.content[0]?.text ?? "", /review expired/u);
      assert.equal(result.details?.outcome, undefined);
      assert.deepEqual(readdirSync(h.plansDirectory), [draft.split("/").at(-1)]);
      assert.equal(h.mock.entries.length, entries);
      assert.equal(h.gateEvents.length, transitions);
      assert.equal(h.inline().active, true);
      assert.equal(h.inline().planFile, draft);
    }
    assert.deepEqual(h.mock.setModels, []);
    assert.deepEqual(h.mock.thinkingLevels, []);
    assert.deepEqual(h.mock.sentUserMessages, []);
    assert.equal(h.newSession.mock.calls.length, 0);
    assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  });
}

test("saving clears the declined baseline both immediately and after branch restore", async () => {
  for (const restore of [false, true]) {
    const h = await setup({
      select: ["No, keep planning", "Save for later", "Enter different name", "No, keep planning"],
      input: "deferred",
    });
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    const draft = h.inline().planFile;
    writeFileSync(draft, "# Declined baseline\n");
    const kept = await h.tool(EXIT_TOOL).execute("declined", {}, undefined, undefined, h.context.ctx);
    writeFileSync(draft, "# Revised saved plan\n");
    const updates: any[] = [];
    const saved = await h
      .tool(EXIT_TOOL)
      .execute("saved-revision", {}, undefined, (update: unknown) => updates.push(update), h.context.ctx);
    assert.equal(updates[0]?.details.previous, "# Declined baseline");
    assert.equal(saved.details.outcome, "saved");
    if (restore) {
      const branch = [
        ...h.mock.entries.map((entry) => ({ type: "custom", ...entry })),
        ...[kept, saved].map((result) => ({
          type: "message",
          message: { role: "toolResult", toolName: EXIT_TOOL, details: result.details },
        })),
      ];
      Object.assign((h.context.ctx as ExtensionContext).sessionManager, { getBranch: () => branch });
      await h.emit("session_tree", {});
    }
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    writeFileSync(h.inline().planFile, "# Entirely new task\n");
    updates.length = 0;
    await h
      .tool(EXIT_TOOL)
      .execute(
        "new-review",
        { changes: ["Not related to the old plan"] },
        undefined,
        (update: unknown) => updates.push(update),
        h.context.ctx,
      );
    assert.equal(updates[0]?.details.previous, undefined);
    assert.equal(updates[0]?.details.changes, undefined);
  }
});

test("a saved review renders the saved path neutrally rather than approval or pending status", async () => {
  const h = await setup({ select: ["Save for later", "Enter different name"], input: "rendered-save" });
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Saved document\n\nKeep the details.");
  const result = await h.tool(EXIT_TOOL).execute("render-save", {}, undefined, undefined, h.context.ctx);
  initTheme("dark", false);
  const colors: Array<{ role: string; text: string }> = [];
  const theme = {
    fg: (role: string, text: string) => {
      colors.push({ role, text });
      return text;
    },
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as ExtensionContext["ui"]["theme"];
  const exit = h.mock.tools.find((candidate) => candidate.name === EXIT_TOOL) as unknown as ToolDefinition;
  const renderContext = {
    toolCallId: "render-save",
    args: {},
    state: {},
    invalidate() {},
    lastComponent: undefined,
    cwd: (h.context.ctx as ExtensionContext).cwd,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
    durationMs: undefined,
    outputPad: 0,
  };
  const component = exit.renderResult?.(result as never, { expanded: false, isPartial: false }, theme, renderContext);
  assert.ok(component);
  const rendered = component.render(160).map(stripVTControlCharacters).join("\n");
  assert.match(rendered, /Saved document[\s\S]*Saved for later/u);
  assert.ok(rendered.includes(result.details.savedFile));
  assert.doesNotMatch(rendered, /Approved|implementing|Waiting for approval|Kept planning/u);
  assert.ok(colors.some((color) => color.role === "muted" && color.text === "Saved for later"));
  assert.ok(colors.some((color) => color.role === "dim" && color.text.includes(result.details.savedFile)));
});

function workflowTransitions(mock: ReturnType<typeof createMockPi>) {
  return mock.sentMessages.filter(
    ({ message }) => (message as { customType?: string }).customType === "workflow:transition",
  );
}

function transition(previous: string, mode: string, explanation: string) {
  return {
    message: {
      customType: "workflow:transition",
      content: `${mode.toUpperCase()} · ${explanation}`,
      display: true,
      details: { version: 1, previous, mode },
    },
    options: { triggerTurn: false },
  };
}

function setupWorkflowLifecycle() {
  const mock = createMockPi();
  const context = createMockContext({ hasUI: true });
  const ctx = context.ctx as ExtensionContext;
  let executing = false;
  const approved = vi.fn();
  const compactHere = vi.fn();
  const handoff = vi.fn();
  const implementHere = vi.fn(() => "");
  const inline = registerInlinePlanMode(mock.pi, {
    plansDirectory: () => mkdtempSync(join(tmpdir(), "workflow-plan-")),
    safeSubcommands: () => undefined,
    executing: () => executing,
    toggleKey: () => undefined,
    implementationChoices: () => undefined,
    approved,
    compactHere,
    handoff,
    implementHere,
  });
  const emit = async (name: string) => {
    for (const handler of mock.events.get(name) ?? []) await handler({}, ctx);
  };
  const exec = (active: boolean, source: "restore" | "transition") => {
    executing = active;
    mock.eventBus.emit("workflow-mode:exec", { active, source });
  };
  return { mock, context, ctx, inline, emit, exec, approved, compactHere, handoff, implementHere };
}

test("standalone workflow badges describe work/plan/exec transitions once without triggering turns", async () => {
  const h = await setup({ models: true, select: ["Yes, hand off to Claude Sonnet 5.5 (high)"] });
  assert.deepEqual(workflowTransitions(h.mock), [], "startup is silent");
  assert.ok(h.mock.messageRenderers.has("workflow:transition"));
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  assert.deepEqual(workflowTransitions(h.mock), [transition("work", "plan", "research and plan only")]);
  writeFileSync(h.inline().planFile, "# Plan\n");
  await h.tool(EXIT_TOOL).execute("approve", {}, undefined, undefined, h.context.ctx);
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_before_settle", { outcome: "completed" });
  h.mock.eventBus.emit("workflow-mode:exec", { active: true, source: "transition" });
  assert.deepEqual(workflowTransitions(h.mock), [
    transition("work", "plan", "research and plan only"),
    transition("plan", "work", "edits and actions"),
    transition("work", "exec", "implementing approved plan"),
  ]);
  assert.equal(h.mock.sentUserMessages.length, 0, "badges do not send prompts");
});

test("standalone repeated plan and exec notifications do not duplicate badges", async () => {
  const h = setupWorkflowLifecycle();
  await h.emit("session_start");
  h.inline.enter(h.ctx);
  h.inline.enter(h.ctx);
  h.inline.work(h.ctx);
  h.inline.work(h.ctx);
  h.exec(true, "transition");
  h.exec(true, "transition");
  h.exec(false, "transition");
  h.exec(false, "transition");
  assert.deepEqual(workflowTransitions(h.mock), [
    transition("work", "plan", "research and plan only"),
    transition("plan", "work", "edits and actions"),
    transition("work", "exec", "implementing approved plan"),
    transition("exec", "work", "edits and actions"),
  ]);
});

for (const lifecycle of ["session_start", "session_tree"]) {
  for (const mode of ["work", "plan", "exec"]) {
    test(`${lifecycle} restores ${mode} silently and resets the badge baseline`, async () => {
      const h = setupWorkflowLifecycle();
      await h.emit("session_start");
      h.inline.enter(h.ctx);
      const before = structuredClone(h.mock.sentMessages);
      Object.assign(h.ctx.sessionManager, {
        getBranch: () => [{ type: "custom", customType: INLINE_ENTRY, data: { active: mode === "plan", told: true } }],
      });
      h.exec(mode === "exec", "restore");
      await h.emit(lifecycle);
      assert.deepEqual(h.mock.sentMessages, before, "restoration sends neither badges nor notices");
      h.exec(mode === "exec", "transition");
      assert.deepEqual(h.mock.sentMessages, before, "same restored mode is not a transition");
      if (mode === "exec") h.exec(false, "transition");
      else if (mode === "plan") h.inline.work(h.ctx);
      else h.inline.enter(h.ctx);
      assert.deepEqual(workflowTransitions(h.mock).slice(1), [
        mode === "work"
          ? transition("work", "plan", "research and plan only")
          : transition(mode, "work", "edits and actions"),
      ]);
    });
  }
}

test("the gate owns workflow badges, including plan approval and exec changes", async () => {
  const h = await setup({ gate: true, models: true, select: ["Yes, hand off to Claude Sonnet 5.5 (high)"] });
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  await h.tool(EXIT_TOOL).execute("approve", {}, undefined, undefined, h.context.ctx);
  await h.emit("agent_before_settle", { outcome: "completed" });
  h.mock.eventBus.emit(MODE_CHANGED, { mode: "exec", source: "transition" });
  h.mock.eventBus.emit("workflow-mode:exec", { active: true, source: "transition" });
  assert.deepEqual(workflowTransitions(h.mock), [], "inline never duplicates the gate's badges");
});

test("shutdown and reload discard the previous gate and presented workflow", async () => {
  const h = setupWorkflowLifecycle();
  await h.emit("session_start");
  h.mock.eventBus.emit(MODE_CHANGED, { mode: "plan", source: "transition" });
  h.exec(true, "transition");
  await h.emit("session_shutdown");
  h.exec(false, "transition");
  assert.deepEqual(workflowTransitions(h.mock), [], "shutdown discards the presented exec baseline");
  await h.emit("session_start");
  assert.deepEqual(workflowTransitions(h.mock), [], "reload does not announce the old exec to work change");
  h.inline.enter(h.ctx);
  h.inline.work(h.ctx);
  assert.deepEqual(
    workflowTransitions(h.mock),
    [transition("work", "plan", "research and plan only"), transition("plan", "work", "edits and actions")],
    "the previous gate cannot suppress standalone badges after reload",
  );
});

for (const order of ["gate-first", "plan-first", "no-gate"] as const) {
  test(`early saved-plan entry survives later lifecycle restoration: ${order}`, async () => {
    const mock = createMockPi();
    const plansDirectory = mkdtempSync(join(tmpdir(), "early-plan-"));
    const planFile = join(plansDirectory, "saved-plan.md");
    writeFileSync(planFile, "# Saved plan\n\nRecover for reapproval.\n");
    const context = createMockContext({
      hasUI: true,
      isIdle: () => false,
      sessionManager: {
        getBranch: () => mock.entries.map((entry, index) => ({ type: "custom", id: `entry-${index}`, ...entry })),
        getLeafId: () => (mock.entries.length ? `entry-${mock.entries.length - 1}` : null),
      },
    });
    const ctx = context.ctx as ExtensionContext;
    const pi = mock.pi as ExtensionAPI;
    const requests: string[] = [];
    const registerGate = () => {
      let mode = "work";
      const publish = (source: string) =>
        mock.eventBus.emit(MODE_CHANGED, { mode, source, cycle: ["work", "chat", "plan"] });
      mock.eventBus.on("workflow-mode:query", (data) => {
        (data as { reply(snapshot: { mode: string }): void }).reply({ mode });
      });
      mock.eventBus.on(MODE_SET, (data) => {
        mode = (data as { mode: string }).mode;
        requests.push(mode);
        publish("transition");
      });
      pi.on("session_start", () => publish("restore"));
    };
    if (order === "gate-first") registerGate();
    // The host's fresh activation recovery runs before inline's own startup handler.
    pi.on("session_start", () => inline.enter(ctx, planFile));
    const inline = registerInlinePlanMode(pi, {
      plansDirectory: () => plansDirectory,
      safeSubcommands: () => undefined,
      executing: () => false,
      toggleKey: () => undefined,
      implementationChoices: () => undefined,
      approved: vi.fn(),
      compactHere: vi.fn(),
      handoff: vi.fn(),
      implementHere: () => "",
    });
    if (order === "plan-first") registerGate();
    // Subsequent pure queries may see the now-durable plan transition.
    const entriesAtQuery: number[] = [];
    mock.eventBus.on("workflow-mode:query", () => entriesAtQuery.push(mock.entries.length));
    for (const handler of mock.events.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
    assert.equal(inline.active, true);
    assert.equal(inline.planFile, planFile);
    assert.equal((mock.entries.at(-1)?.data as { active?: boolean } | undefined)?.active, true);
    assert.deepEqual(requests, order === "no-gate" ? [] : ["plan"]);
    assert.equal(mock.sentUserMessages.length, 0, "recovery never sends an implementation brief");
    const notices = mock.sentMessages.filter(
      ({ message }) => (message as { customType?: string }).customType === NOTICE_TYPE,
    );
    assert.equal(notices.length, 1, "later lifecycle restore does not duplicate the entry notice");
    assert.deepEqual(
      workflowTransitions(mock),
      order === "no-gate" ? [transition("work", "plan", "research and plan only")] : [],
    );
    assert.equal((notices[0]?.message as { customType?: string } | undefined)?.customType, NOTICE_TYPE);
    assert.equal((notices[0]?.message as { details?: { active?: boolean } } | undefined)?.details?.active, true);
    const durable = structuredClone(mock.entries);
    for (const handler of mock.events.get("before_agent_start") ?? []) {
      assert.equal(await handler({ prompt: "review again" }, ctx), undefined, "entry was already announced");
    }
    assert.deepEqual(mock.entries, durable, "restoration and already-told prompt do not persist snapshots");
    assert.equal(readFileSync(planFile, "utf8"), "# Saved plan\n\nRecover for reapproval.\n");
    if (order !== "no-gate") assert.deepEqual(entriesAtQuery, [0, durable.length]);
  });
}

test("/plan enters plan mode: only the plan file may be written, and only read-only commands run", async () => {
  const { mock, context, emit, inline } = await setup();
  await mock.commands.get("plan")?.handler("", context.ctx);
  const planFile = inline().planFile as string;
  assert.equal(inline().active, true);
  assert.match(planFile, /\/[a-z]+-[a-z]+\.md$/u);
  assert.equal(context.statuses.get("workflow-mode"), "workflow: plan");
  assert.equal(context.statuses.get("permission-mode"), undefined);
  assert.deepEqual(
    await emit("tool_call", { toolName: "write", input: { path: planFile, content: "# Plan" } }),
    undefined,
  );
  assert.match(
    (await emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } })).reason,
    /only file you may write is the plan file/u,
  );
  assert.equal(await emit("tool_call", { toolName: "bash", input: { command: "git status && rg foo" } }), undefined);
  assert.equal((await emit("tool_call", { toolName: "bash", input: { command: "npm install left-pad" } })).block, true);

  // Your agent is told once, with your next prompt.
  const first = await emit("before_agent_start", { prompt: "x" });
  assert.equal(first.message.customType, NOTICE_TYPE);
  assert.equal(first.message.display, false);
  assert.match(first.message.content, /Plan mode is active/u);
  assert.match(first.message.content, new RegExp(planFile.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
  assert.equal(await emit("before_agent_start", { prompt: "y" }), undefined);
});

test("/plan with a task enters plan mode and sends the task", async () => {
  const { mock, context, inline } = await setup();
  await mock.commands.get("plan")?.handler("add rate limiting", context.ctx);
  assert.equal(inline().active, true);
  assert.equal(mock.sentUserMessages.at(-1)?.text, "add rate limiting");
});

test("exit_plan_mode needs a written plan, shows it, and implements it here once approved", async () => {
  const { mock, context, tool, emit, inline, selects } = await setup({ select: ["Yes, implement here"] });
  const outside = await tool(EXIT_TOOL).execute("t0", {}, undefined, undefined, context.ctx);
  assert.match(outside.content[0]?.text ?? "", /not in plan mode/u);
  await mock.commands.get("plan")?.handler("", context.ctx);
  const planFile = inline().planFile as string;
  const empty = await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.match(empty.content[0]?.text ?? "", /empty or missing/u);
  writeFileSync(planFile, "# Plan\n\n1. Do it\n");
  const updates: any[] = [];
  const result = await tool(EXIT_TOOL).execute(
    "t2",
    {},
    undefined,
    (update: unknown) => updates.push(update),
    context.ctx,
  );
  assert.equal(updates[0]?.details.outcome, "pending", "the plan shows while you decide");
  const exit = mock.tools.find((candidate) => candidate.name === EXIT_TOOL);
  assert.equal(exit?.ccstyleOwnResult, true, "cc-render must preserve the plan's own result renderer");
  initTheme("dark", false);
  const theme = {
    fg: (_role: string, text: string) => text,
    bg: (_role: string, text: string) => text,
    bold: (text: string) => text,
  } as ExtensionContext["ui"]["theme"];
  const pending = (exit as unknown as ToolDefinition).renderResult?.(
    updates[0],
    { expanded: false, isPartial: true },
    theme,
    {
      toolCallId: "t2",
      args: {},
      state: {},
      invalidate() {},
      lastComponent: undefined,
      cwd: (context.ctx as ExtensionContext).cwd,
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
      durationMs: undefined,
      outputPad: 0,
    },
  );
  assert.ok(pending, "the pending review has a result component");
  const rendered = pending.render(80).map(stripVTControlCharacters).join("\n");
  assert.match(rendered, /Plan/u);
  assert.match(rendered, /1\. Do it/u);
  assert.match(rendered, /Waiting for approval/u);
  assert.deepEqual(selects[0]?.options, [
    "Yes, implement here",
    "Yes, compact plan and implement here",
    "Edit the plan",
    "Save for later",
    "No, keep planning",
  ]);
  assert.match(
    result.content[0]?.text ?? "",
    /^The user approved the plan\.[\s\S]*reply normally[\s\S]*## Approved plan\n\n# Plan\n\n1\. Do it$/u,
  );
  assert.equal(inline().active, false);
  const exec = mock.entries.filter((entry) => entry.customType === "plan-mode:exec").at(-1)?.data as any;
  assert.equal(exec, undefined, "ordinary implementation never starts exec mode");
  assert.notEqual(result.terminate, true, "the current agent implements without ending its turn");
  assert.doesNotMatch(result.content[0]?.text ?? "", /finish_plan|ask_planner|exec mode|handoff/iu);
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(mock.setModels.length, 0);
  assert.equal(context.statuses.get("permission-mode"), undefined);
  assert.equal(context.statuses.get("workflow-mode"), "workflow: work");
  // The result told your agent: no separate notice.
  assert.equal(await emit("before_agent_start", { prompt: "go" }), undefined);
  assert.equal(await emit("tool_call", { toolName: "edit", input: { path: "src/a.ts" } }), undefined);
});

for (const compact of [false, true]) {
  test(`ordinary ${compact ? "compact" : "direct"} approval keeps the session and has no handoff machinery`, async () => {
    const h = await setup({
      models: true,
      select: [compact ? "Yes, compact plan and implement here" : "Yes, implement here", "high"],
    });
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    const plan = "# Exact approved plan\n\n1. Preserve `literal` details.\n2. Verify once.";
    writeFileSync(h.inline().planFile, `${plan}\n`);
    const result = await h.tool(EXIT_TOOL).execute("direct", {}, undefined, undefined, h.context.ctx);
    assert.equal(result.details.outcome, "approved");
    assert.equal(result.terminate === true, compact);
    assert.equal(h.inline().active, false);
    const settled = await h.emit("agent_before_settle", { outcome: "completed" });
    const brief = compact ? settled.entries[1].content : result.content[0]?.text;
    assert.ok(brief.endsWith(`## Approved plan\n\n${plan}`));
    assert.doesNotMatch(brief, /ask_planner|finish_plan|exec mode|handoff/iu);
    if (compact) {
      assert.equal(settled.continue, true);
      assert.equal(settled.entries.length, 2);
      assert.equal(settled.entries[0].type, "compaction");
      assert.equal(settled.entries[0].firstKeptEntryId, null);
      assert.equal(settled.entries[1].customType, "plan-mode-implementation");
      assert.equal(settled.entries[1].details.planFile, h.inline().planFile);
    } else assert.equal(settled, undefined);
    assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
    assert.equal((h.context.ctx as ExtensionContext).sessionManager.getSessionId(), "s");
    assert.equal((h.context.ctx as ExtensionContext).model, opus);
    assert.equal(h.mock.thinkingLevels.at(-1), "high");
    assert.equal(h.mock.setModels.length, 0);
    assert.equal(
      h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
      false,
    );
    assert.equal(
      (h.mock.pi as ExtensionAPI).getActiveTools().some((name) => ["finish_plan", "ask_planner"].includes(name)),
      false,
    );
    // Restoration may inspect the leaf for workflow reconciliation; ordinary approval does not navigate.
    assert.equal(
      h.getLeafId.mock.results.every((result) => result.value === "planning-leaf"),
      true,
    );
    assert.equal(h.newSession.mock.calls.length, 0);
    assert.equal(h.projection.mock.calls.length, 0, "no consultant session seeded");
  });
}

for (const outcome of ["aborted", "error"]) {
  test(`compact approval does not implement after an ${outcome} turn`, async () => {
    const h = await setup({ select: ["Yes, compact plan and implement here"] });
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    writeFileSync(h.inline().planFile, "# Plan\n");
    await h.tool(EXIT_TOOL).execute("compact", {}, undefined, undefined, h.context.ctx);
    assert.equal(await h.emit("agent_before_settle", { outcome }), undefined);
    assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
    assert.equal(h.mock.setModels.length, 0);
    assert.equal(
      h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
      false,
    );
    assert.equal(h.projection.mock.calls.length, 0);
  });
}

test("failed model switch never starts handoff implementation", async () => {
  const h = await setup({
    models: true,
    switchFails: true,
    select: ["Yes, hand off to Claude Sonnet 5.5 (high)", "high"],
  });
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  await h.tool(EXIT_TOOL).execute("failed", {}, undefined, undefined, h.context.ctx);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(
    h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
    false,
  );
  assert.equal(h.projection.mock.calls.length, 0);
  assert.ok(h.getLeafId.mock.calls.length >= 1);
  assert.equal(h.newSession.mock.calls.length, 0);
  assert.ok(h.context.notifications.some(({ level }) => level === "warning"));
  assert.equal(h.inline().active, true, "failed handoff returns to plan for reapproval");
  assert.equal(h.context.statuses.get("workflow-mode"), "workflow: plan");
});

test("aborting during a model switch never starts handoff implementation", async () => {
  const h = await setup({ models: true, select: ["Yes, hand off to Claude Sonnet 5.5 (high)", "high"] });
  const abort = new AbortController();
  (h.context.ctx as ExtensionContext).signal = abort.signal;
  (h.mock.pi as ExtensionAPI).setModel = async () => {
    abort.abort();
    return true;
  };
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  await h.tool(EXIT_TOOL).execute("abort-switch", {}, undefined, undefined, h.context.ctx);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(
    h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
    false,
  );
  assert.equal(h.projection.mock.calls.length, 0);
  assert.ok(h.getLeafId.mock.calls.length >= 1);
  assert.deepEqual(h.mock.thinkingLevels, []);
  assert.equal(h.inline().active, false, "aborted model switch must not recover into planning");
  assert.equal(h.context.statuses.get("workflow-mode"), "workflow: work");
});

test("cancelling RPC effort returns to actions; action cancel does not approve or implement", async () => {
  const h = await setup({
    models: true,
    select: ["Yes, compact plan and implement here", undefined as never, undefined as never],
  });
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  const result = await h.tool(EXIT_TOOL).execute("cancel-effort", {}, undefined, undefined, h.context.ctx);
  assert.equal(h.selects.length, 3);
  assert.equal(h.selects[2]?.title, "Implement this plan?");
  assert.equal(h.selects[2]?.options[0], "Yes, compact plan and implement here");
  assert.equal(result.details.outcome, "kept");
  assert.equal(h.inline().active, true);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(h.mock.setModels.length, 0);
  assert.equal(
    h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
    false,
  );
});

test("RPC effort back navigation can change action before approving", async () => {
  const h = await setup({
    models: true,
    select: ["Yes, compact plan and implement here", undefined as never, "Yes, implement here", "high"],
  });
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  const result = await h.tool(EXIT_TOOL).execute("back", {}, undefined, undefined, h.context.ctx);
  assert.equal(h.selects.length, 4);
  assert.equal(h.selects[2]?.options[0], "Yes, compact plan and implement here");
  assert.equal(result.details.outcome, "approved");
  assert.notEqual(result.terminate, true);
  assert.equal(h.inline().active, false);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(h.mock.setModels.length, 0);
});

test("RPC signal abort during effort selection keeps planning without reopening actions", async () => {
  const h = await setup({ models: true });
  const controller = new AbortController();
  const select = vi
    .fn<ExtensionContext["ui"]["select"]>()
    .mockResolvedValueOnce("Yes, compact plan and implement here")
    .mockImplementationOnce(async (_title, _choices, options) => {
      assert.equal(options?.signal, controller.signal);
      controller.abort();
      return undefined;
    });
  (h.context.ctx as ExtensionContext).ui.select = select;
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Plan\n");
  const result = await h.tool(EXIT_TOOL).execute("abort-effort", {}, controller.signal, undefined, h.context.ctx);
  assert.equal(select.mock.calls.length, 2);
  assert.equal(result.details.outcome, "kept");
  assert.equal(h.inline().active, true);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
  assert.equal(h.mock.setModels.length, 0);
  assert.equal(h.projection.mock.calls.length, 0);
  assert.equal(
    h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
    false,
  );
});

test("keep planning ends the turn for your reply in the chat; the next review shows what changed", async () => {
  const { mock, context, tool, inline } = await setup({ select: ["No, keep planning", undefined as never] });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  const ui = (context.ctx as ExtensionContext).ui;
  ui.input = async () => assert.fail("no separate feedback prompt");
  const kept = await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.match(kept.content[0]?.text ?? "", /declined the plan[\s\S]*next message/u);
  assert.equal(kept.terminate, true);
  assert.equal(kept.details.outcome, "kept");
  assert.equal(inline().active, true);
  writeFileSync(inline().planFile, "# Plan\n\nUse redis\n");
  const updates: any[] = [];
  const escaped = await tool(EXIT_TOOL).execute(
    "t2",
    {},
    undefined,
    (update: unknown) => updates.push(update),
    context.ctx,
  );
  assert.equal(updates[0]?.details.previous, "# Plan");
  assert.equal(escaped.terminate, true);
  assert.equal(inline().active, true);
});

test("revision summaries are bounded, suppressed on first/identical plans and cleared after editing", async () => {
  const h = await setup();
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  const file = h.inline().planFile;
  const exit = h.tool(EXIT_TOOL);
  const definition = h.mock.tools.find((candidate) => candidate.name === EXIT_TOOL);
  const schema = definition?.parameters as unknown as {
    properties: {
      changes: { minItems: number; maxItems: number; items: { minLength: number; maxLength: number; pattern: string } };
    };
    required?: string[];
  };
  assert.equal(schema.properties.changes.minItems, 1);
  assert.equal(schema.properties.changes.maxItems, 5);
  assert.equal(schema.properties.changes.items.minLength, 1);
  assert.equal(schema.properties.changes.items.maxLength, 240);
  assert.ok(new RegExp(schema.properties.changes.items.pattern).test("Scope changed"));
  assert.equal(new RegExp(schema.properties.changes.items.pattern).test(" "), false);
  assert.equal(schema.required, undefined);
  writeFileSync(file, "# Original");
  const updates: any[] = [];
  const submit = (params: unknown) =>
    exit.execute("summary", params, undefined, (update: any) => updates.push(update), h.context.ctx);
  await submit({ changes: ["Not a revision yet"] });
  assert.equal(updates.at(-1).details.changes, undefined);
  await submit({ changes: ["Identical"] });
  assert.equal(updates.at(-1).details.changes, undefined);
  writeFileSync(file, "# Revised\n\nUse Redis.");
  await submit({ changes: ["Use Redis instead of SQLite."] });
  assert.deepEqual(updates.at(-1).details.changes, ["Use Redis instead of SQLite."]);
  writeFileSync(file, "# Revised again");
  let selection = 0;
  (h.context.ctx as ExtensionContext).ui.select = async () => (selection++ === 0 ? "Edit the plan" : undefined);
  (h.context.ctx as ExtensionContext).ui.editor = async () => "# User-edited";
  const editor = process.env.EDITOR;
  const visual = process.env.VISUAL;
  delete process.env.EDITOR;
  delete process.env.VISUAL;
  try {
    await submit({ changes: ["Agent summary"] });
    assert.deepEqual(updates.at(-2).details.changes, ["Agent summary"]);
    assert.equal(updates.at(-1).details.changes, undefined);
    assert.equal(updates.at(-1).details.plan, "# User-edited");
  } finally {
    if (editor !== undefined) process.env.EDITOR = editor;
    if (visual !== undefined) process.env.VISUAL = visual;
  }
  for (const changes of [[], [" "], ["x".repeat(241)], Array(6).fill("x"), "x", [1]]) {
    const before = updates.length;
    const result = await submit({ changes });
    assert.match(result.content[0]?.text ?? "", /1–5 nonempty strings/u);
    assert.equal(updates.length, before);
  }
});

test("with a model, approval offers direct choices first and configured handoffs after them", async () => {
  const { mock, context, tool, inline, selects } = await setup({ models: true, select: [undefined as never] });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.deepEqual(selects[0]?.options, [
    "Yes, implement here",
    "Yes, compact plan and implement here",
    "Yes, hand off to Claude Sonnet 5.5 (high)",
    "Edit the plan",
    "Save for later",
    "No, keep planning",
  ]);
  for (const option of selects[0]?.options ?? []) assert.ok(option.length <= 42, option);
});

test("inline handoffs use authenticated availability, not the cycling shortlist", async () => {
  const astra = { provider: "openai-codex", id: "gpt-6-astra", name: "Astra" };
  const sol = { ...astra, id: "gpt-6-sol", name: "Sol" };
  const terra = { ...astra, id: "gpt-6-terra", name: "Terra" };
  for (const targets of [undefined, [terra.id], [], ["unavailable"]]) {
    const h = await setup({
      implementationModelMap: targets
        ? { "openai-codex/gpt-6-astra": targets.map((modelId) => ({ provider: astra.provider, modelId })) }
        : undefined,
    });
    const ctx = h.context.ctx as ExtensionContext;
    ctx.model = astra as ExtensionContext["model"];
    Object.assign(ctx, { scopedModels: [{ model: astra }, { model: sol }] });
    Object.assign(ctx.modelRegistry, {
      getAvailable: () => [astra, sol, terra],
      find: (provider: string, id: string) => [astra, sol, terra].find((m) => m.provider === provider && m.id === id),
    });
    await h.mock.commands.get("plan")?.handler("", ctx);
    writeFileSync(h.inline().planFile, "# Plan");
    await h.tool(EXIT_TOOL).execute("availability", {}, undefined, undefined, ctx);
    const choices = h.selects[0]?.options ?? [];
    assert.equal(
      choices.some((choice) => choice.includes("hand off to Sol")),
      targets === undefined,
    );
    assert.equal(
      choices.some((choice) => choice.includes("hand off to Terra")),
      targets === undefined || targets.includes(terra.id),
    );
    assert.equal(
      choices.some((choice) => choice.includes("unavailable")),
      false,
    );
  }
});

test("a handoff preserves history and continues on the target model with exactly two drafts, once", async () => {
  const { mock, context, tool, emit, inline, getLeafId } = await setup({
    models: true,
    select: ["Yes, hand off to Claude Sonnet 5.5 (high)"],
  });
  const pi = mock.pi as ExtensionAPI;
  const setModel = pi.setModel.bind(pi);
  pi.setModel = async (model) => {
    getLeafId.mockReturnValue("model-change-leaf");
    return setModel(model);
  };
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n\n1. Do it\n");
  const result = await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.equal(result.terminate, true);
  assert.equal(result.details.outcome, "handoff");
  assert.equal(result.details.handoff, "Claude Sonnet 5.5");
  assert.equal(context.statuses.get("workflow-mode"), "workflow: work", "pending handoff is not exec");
  assert.match(result.content[0]?.text ?? "", /continues in this conversation with its history/u);
  assert.match(result.content[0]?.text ?? "", /You stay on call/u);
  const leafReads = getLeafId.mock.calls.length;
  const settled = await emit("agent_before_settle", { outcome: "completed" });
  assert.deepEqual(Object.keys(settled).sort(), ["continue", "entries"], "no context edits");
  assert.equal(settled.continue, true);
  assert.equal(settled.entries.length, 2, "only exec state and the conversational handoff brief");
  assert.equal(settled.entries[0].type, "custom");
  assert.equal(settled.entries[0].customType, "plan-mode:exec");
  assert.equal(settled.entries[0].data.active, true);
  assert.equal(context.statuses.get("workflow-mode"), "workflow: exec");
  assert.equal(context.statuses.get("permission-mode"), undefined);
  assert.equal(Object.hasOwn(settled.entries[0].data, "returnTo"), false);
  assert.equal(getLeafId.mock.calls.length, leafReads, "handoff does not capture a return-navigation anchor");
  assert.equal(settled.entries[0].data.planner.name, "Claude Opus 5.5");
  assert.equal(settled.entries[0].data.restore, "anthropic/claude-opus-5-5:off");
  assert.ok(existsSync(settled.entries[0].data.planner.sessionFile), "the seeded planner session is on disk");
  assert.equal(settled.entries[1].type, "custom_message");
  assert.equal(settled.entries[1].customType, "plan-mode-handoff");
  assert.equal(settled.entries[1].display, true);
  assert.match(settled.entries[1].content, /ask_planner/u);
  assert.match(settled.entries[1].content, /Claude Opus 5\.5 researched and decided it and is on call/u);
  assert.doesNotMatch(settled.entries[1].content, /this message is all you have of the planning/u);
  assert.match(settled.entries[1].content, /## Approved plan\n\n# Plan\n\n1\. Do it$/u);
  assert.equal(settled.entries[1].details.implementer, "Claude Sonnet 5.5");
  assert.equal(settled.entries[1].details.planner, "Claude Opus 5.5");
  assert.equal(
    settled.entries.some((entry: { type: string }) => entry.type === "compaction"),
    false,
  );
  assert.equal((context.ctx as ExtensionContext).sessionManager.getSessionId(), "s");
  assert.deepEqual(mock.sentUserMessages, []);
  assert.ok(
    mock.sentMessages.every(
      ({ message, options }) =>
        (message as { customType?: string }).customType === "workflow:transition" &&
        (options as { triggerTurn?: boolean }).triggerTurn === false,
    ),
    "workflow notices must not queue another continuation",
  );
  assert.deepEqual(mock.thinkingLevels, ["high"]);
  assert.deepEqual(
    mock.setModels.map((model: any) => model.id),
    ["claude-sonnet-5-5"],
  );
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined, "only once");
});

test("a handoff does nothing, and says so, when the turn did not complete", async () => {
  const { mock, context, tool, emit, inline } = await setup({
    models: true,
    select: ["Yes, hand off to Claude Sonnet 5.5 (high)"],
  });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.equal(await emit("agent_before_settle", { outcome: "aborted" }), undefined);
  assert.equal(mock.setModels.length, 0);
  assert.equal(inline().active, true, "aborted handoff returns to plan for reapproval");
  assert.equal(context.statuses.get("workflow-mode"), "workflow: plan");
  assert.match(context.notifications.at(-1)?.message ?? "", /handoff did not happen/u);
  assert.equal(await emit("agent_before_settle", { outcome: "completed" }), undefined);
});

test("with pi-tool-gate, /plan requests planning and approval requests ordinary work", async () => {
  const { mock, context, tool, inline, gateEvents, selects } = await setup({
    gate: true,
    select: ["Yes, implement here"],
  });
  assert.ok(
    gateEvents.some((event) => event.channel === PLAN_PROVIDER),
    "plan mode is offered to the gate",
  );
  await mock.commands.get("plan")?.handler("", context.ctx);
  assert.deepEqual(
    gateEvents.filter((event) => event.channel === MODE_SET).map((event) => event.data.mode),
    ["plan"],
  );
  assert.equal(inline().active, true);
  assert.equal(context.statuses.get("workflow-mode"), undefined, "the gate owns workflow status");
  assert.equal(context.statuses.get("permission-mode"), undefined);
  const planFile = inline().planFile as string;
  assert.ok(gateEvents.some((event) => event.channel === PLAN_PROVIDER && event.data.planFile === planFile));
  writeFileSync(planFile, "# Plan\n");
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.deepEqual(selects[0]?.options, [
    "Yes, implement here",
    "Yes, compact plan and implement here",
    "Edit the plan",
    "Save for later",
    "No, keep planning",
  ]);
  assert.deepEqual(
    gateEvents.filter((event) => event.channel === MODE_SET).map((event) => event.data.mode),
    ["plan", "work"],
    "approval leaves planning for ordinary work",
  );
  assert.equal(inline().active, false);
  // Leaving plan mode with Shift+Tab (the gate's cycle) leaves it here too.
  mock.eventBus.emit(MODE_CHANGED, { mode: "plan", cycle: [] });
  assert.equal(inline().active, true);
  mock.eventBus.emit(MODE_CHANGED, { mode: "work", cycle: [] });
  assert.equal(inline().active, false);
});

test("with the gate's chat mode enabled, leaving into chat grants nothing", async () => {
  const { mock, context, tool, emit, inline } = await setup({
    gate: true,
    cycle: ["work", "chat", "plan"],
    select: [undefined as never],
  });
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n");
  await emit("before_agent_start", { prompt: "x" });
  await tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  mock.eventBus.emit(MODE_CHANGED, { mode: "chat", cycle: ["work", "chat", "plan"] });
  const notice = await emit("before_agent_start", { prompt: "y" });
  assert.match(notice.message.content, /left plan mode/u);
  assert.doesNotMatch(notice.message.content, /may now make edits/u);
});

for (const approval of ["auto", "bypassPermissions"]) {
  for (const compact of [false, true]) {
    test(`${approval} approvals remain independent during ${compact ? "compact" : "effort-only"} ordinary execution`, async () => {
      const h = await setup({
        gate: true,
        approval,
        models: true,
        select: [compact ? "Yes, compact plan and implement here" : "Yes, implement here", "high"],
      });
      const approvals: string[] = [];
      h.mock.eventBus.on("permission-mode:changed", (data) => approvals.push((data as { mode: string }).mode));
      await h.mock.commands.get("plan")?.handler("", h.context.ctx);
      h.mock.eventBus.emit("permission-mode:set", { mode: approval });
      assert.equal(h.inline().active, true, "approval changes do not leave planning");
      writeFileSync(h.inline().planFile, "# Plan\n");
      await h.tool(EXIT_TOOL).execute("t1", {}, undefined, undefined, h.context.ctx);
      await h.emit("agent_before_settle", { outcome: "completed" });
      assert.deepEqual(approvals, [approval]);
      assert.deepEqual(
        h.gateEvents.filter((event) => event.channel === MODE_SET).map((event) => event.data.mode),
        ["plan", "work"],
      );
      assert.equal(h.gateEvents.filter((event) => event.channel === "permission-mode:set").length, 1);
      assert.equal(
        h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
        false,
      );
      assert.equal(h.mock.setModels.length, 0);
      assert.equal(h.mock.thinkingLevels.at(-1), "high");
    });
  }
}

for (const gate of [false, true]) {
  test(`active exec rejects /plan tasks, /planners, enter_plan_mode and toggle (${gate ? "gate" : "standalone"})`, async () => {
    const h = await setup({
      gate,
      models: true,
      toggleShortcut: "alt+p",
      select: ["Yes, hand off to Claude Sonnet 5.5 (high)"],
    });
    await h.mock.commands.get("plan")?.handler("", h.context.ctx);
    writeFileSync(h.inline().planFile, "# Execute\n");
    await h.tool(EXIT_TOOL).execute("approve", {}, undefined, undefined, h.context.ctx);
    await h.emit("agent_before_settle", { outcome: "completed" });
    const entries = h.mock.entries.length;
    const sent = h.mock.sentUserMessages.length;
    const transitions = h.gateEvents.length;
    await h.mock.commands.get("plan")?.handler("must not queue this task", h.context.ctx);
    await h.mock.commands.get("planners")?.handler("must not open planners", h.context.ctx);
    const entered = await h.tool(ENTER_TOOL).execute("enter", {}, undefined, undefined, h.context.ctx);
    const toggle = h.mock.shortcuts.get("alt+p");
    assert.ok(toggle);
    await toggle.handler(h.context.ctx);
    assert.match(entered.content[0]?.text ?? "", /Exec is active\./u);
    assert.ok(entered.content[0]?.text.includes(EXEC_GUIDANCE));
    assert.deepEqual(
      h.context.notifications.slice(-3).map((note) => note.message),
      [EXEC_GUIDANCE, EXEC_GUIDANCE, EXEC_GUIDANCE],
    );
    assert.equal(h.mock.entries.length, entries);
    assert.equal(h.mock.sentUserMessages.length, sent);
    assert.equal(h.gateEvents.length, transitions);
    assert.equal(h.inline().active, false);
  });
}

for (const switched of [false, true]) {
  for (const newer of ["workflow", "navigation", "shutdown", "abort"] as const) {
    test(`deferred ${switched ? "successful" : "failed"} handoff switch is invalidated by ${newer}`, async () => {
      const h = await setup({ gate: true, models: true, select: ["Yes, hand off to Claude Sonnet 5.5 (high)"] });
      await h.mock.commands.get("plan")?.handler("", h.context.ctx);
      writeFileSync(h.inline().planFile, "# Plan\n");
      await h.tool(EXIT_TOOL).execute("approve", {}, undefined, undefined, h.context.ctx);
      const abort = new AbortController();
      (h.context.ctx as ExtensionContext).signal = abort.signal;
      let resolveSwitch!: (value: boolean) => void;
      let switchStarted!: () => void;
      const ready = new Promise<void>((resolve) => {
        switchStarted = resolve;
      });
      h.mock.rawPi.setModel = () =>
        new Promise<boolean>((resolve) => {
          resolveSwitch = resolve;
          switchStarted();
        });
      const settling = h.emit("agent_before_settle", { outcome: "completed" });
      await ready;
      if (newer === "workflow") h.mock.eventBus.emit(MODE_CHANGED, { mode: "chat", cycle: ["work", "chat", "plan"] });
      else if (newer === "navigation") {
        h.getLeafId.mockReturnValue("other-leaf");
        Object.assign((h.context.ctx as ExtensionContext).sessionManager, { getBranch: () => [] });
        await h.emit("session_tree", {});
      } else if (newer === "shutdown") await h.emit("session_shutdown", {});
      else abort.abort();
      const transitions = h.gateEvents.length;
      const entries = h.mock.entries.length;
      const statuses = [...h.context.statuses];
      resolveSwitch(switched);
      assert.equal(await settling, undefined);
      assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined, "no delayed continuation");
      assert.equal(h.inline().active, false);
      assert.equal(h.gateEvents.length, transitions, "recovery must not request plan on newer state");
      assert.equal(h.mock.entries.length, entries, "no stale exec state is persisted");
      assert.deepEqual([...h.context.statuses], statuses);
      assert.deepEqual(h.mock.thinkingLevels, [], "stale success must not change effort");
      assert.equal(h.projection.mock.calls.length, 0, "no consultant is seeded");
      assert.equal(h.newSession.mock.calls.length, 0);
      assert.deepEqual(h.mock.sentMessages, []);
      assert.deepEqual(h.mock.sentUserMessages, []);
      assert.equal(
        h.mock.entries.some((entry) => entry.customType === "plan-mode:exec"),
        false,
      );
    });
  }
}

test("restore queries destination entries and cwd, ignores cached exec, and defers missing plan allocation", async () => {
  const h = await setup({ gate: true });
  const branch = [
    { type: "custom", id: "destination", customType: "tool-gate:workflow", data: { version: 1, mode: "plan" } },
  ];
  Object.assign((h.context.ctx as ExtensionContext).sessionManager, { getBranch: () => branch });
  h.getLeafId.mockReturnValue("destination");
  h.mock.eventBus.emit(MODE_CHANGED, { mode: "exec", source: "restore" });
  let queries = 0;
  h.mock.eventBus.on("workflow-mode:query", (data) => {
    const query = data as { entries: unknown; cwd: string; reply: (snapshot: unknown) => void };
    assert.equal(query.entries, branch);
    assert.equal(query.cwd, (h.context.ctx as ExtensionContext).cwd);
    queries++;
    query.reply({ mode: "plan", cycle: ["work", "chat", "plan"], source: "restore" });
  });
  const entries = h.mock.entries.length;
  await h.emit("session_tree", {});
  assert.equal(queries, 1);
  assert.equal(h.mock.entries.length, entries, "restore never persists an allocated plan or inline state");
  const provider = h.gateEvents.filter((event) => event.channel === PLAN_PROVIDER).at(-1);
  assert.deepEqual(provider?.data, {}, "missing file stays unallocated during restore");
  h.mock.eventBus.emit(MODE_CHANGED, { mode: "work", source: "restore" });
  assert.equal(h.mock.entries.length, entries, "restore announcements are metadata only");
  const notice = await h.emit("before_agent_start", { prompt: "continue" });
  assert.equal(notice.message.details.active, true, "cached workflow snapshots do not exit the restored plan");
  assert.ok(h.inline().planFile, "the next agent start allocates the missing plan");
  assert.equal(h.inline().active, true);
});

for (const gateFirst of [false, true]) {
  test(`tree restore reannounces plan provider with gate ${gateFirst ? "before" : "after"} inline restore`, async () => {
    const h = await setup({ gate: true });
    const planFile = join(h.plansDirectory, "restored.md");
    const branch = [
      { type: "custom", id: "restored-leaf", customType: INLINE_ENTRY, data: { active: true, told: false, planFile } },
    ];
    Object.assign((h.context.ctx as ExtensionContext).sessionManager, { getBranch: () => branch });
    h.getLeafId.mockReturnValue("restored-leaf");
    const announce = () =>
      h.mock.eventBus.emit(MODE_CHANGED, { mode: "plan", cycle: ["work", "chat", "plan"], source: "restore" });
    const entries = h.mock.entries.length;
    if (gateFirst) announce();
    await h.emit("session_tree", {});
    if (!gateFirst) announce();
    assert.equal(h.mock.entries.length, entries, "restore announcements never append inline transitions");
    const providers = h.gateEvents.filter((event) => event.channel === PLAN_PROVIDER);
    assert.equal(providers.at(-1)?.data.planFile, planFile);
    assert.equal(
      h.gateEvents.some((event) => event.channel === MODE_SET),
      false,
      "restoration does not echo transitions",
    );
    const notice = await h.emit("before_agent_start", { prompt: "restored" });
    assert.equal(notice.message.details.active, true);
    assert.ok(notice.message.content.includes(planFile));
    assert.equal(h.context.statuses.get("workflow-mode"), undefined);
    assert.equal(h.context.statuses.get("permission-mode"), undefined);
  });
}

test("branch navigation invalidates a pending approval instead of implementing the previous branch's plan", async () => {
  const h = await setup();
  await h.mock.commands.get("plan")?.handler("", h.context.ctx);
  writeFileSync(h.inline().planFile, "# Old branch plan\n");
  let approve!: (value: string) => void;
  (h.context.ctx as ExtensionContext).ui.select = () =>
    new Promise<string>((resolve) => {
      approve = resolve;
    });
  const pending = h.tool(EXIT_TOOL).execute("review", {}, undefined, undefined, h.context.ctx);
  h.getLeafId.mockReturnValue("new-branch");
  Object.assign((h.context.ctx as ExtensionContext).sessionManager, { getBranch: () => [] });
  await h.emit("session_tree", {});
  const entries = h.mock.entries.length;
  approve("Yes, implement here");
  const result = await pending;
  assert.notEqual(result.details?.outcome, "approved");
  assert.equal(h.mock.entries.length, entries);
  assert.equal(h.context.statuses.get("workflow-mode"), "workflow: work");
  assert.equal(h.mock.sentUserMessages.length, 0);
  assert.equal(await h.emit("agent_before_settle", { outcome: "completed" }), undefined);
});

test("plan tools stay top-level so codemode cannot hide the inline plan review", async () => {
  const { tool } = await setup();
  assert.equal(tool(ENTER_TOOL).exposure, "model-only");
  assert.equal(tool(EXIT_TOOL).exposure, "model-only");
});

test("exit_plan_mode runs after a plan write in the same message, so it never reviews the previous plan", async () => {
  const { tool } = await setup();
  assert.equal((tool(EXIT_TOOL) as { executionMode?: string }).executionMode, "sequential");
});

test("enter_plan_mode lets your agent switch into plan mode itself", async () => {
  const { context, tool, inline, emit } = await setup();
  const result = await tool(ENTER_TOOL).execute("t1", {}, undefined, undefined, context.ctx);
  assert.match(result.content[0]?.text ?? "", /^Entered plan mode\.[\s\S]*Plan mode is active/u);
  assert.equal(inline().active, true);
  assert.equal(await emit("before_agent_start", { prompt: "x" }), undefined, "the tool result was the notice");
  assert.ok(existsSync(inline().planFile.replace(/\/[^/]+$/u, "")), "the plans directory exists");
});

test("Edit the plan opens your external editor in pi's terminal, and saves what you wrote", async () => {
  const { mock, context, tool, inline } = await setup();
  await mock.commands.get("plan")?.handler("", context.ctx);
  writeFileSync(inline().planFile, "# Plan\n\nDo it.");
  const dir = mkdtempSync(join(tmpdir(), "plan-editor-"));
  const editor = join(dir, "fake-editor");
  // Records the file it was given, then writes the revised plan into it.
  writeFileSync(editor, `#!/bin/sh\necho "$1" > "${dir}/opened"\nprintf '# Better plan\\n\\nDo it well.\\n' > "$1"\n`, {
    mode: 0o755,
  });
  const previous = process.env.EDITOR;
  process.env.EDITOR = editor;
  const terminal: string[] = [];
  let calls = 0;
  const ui = (context.ctx as ExtensionContext).ui;
  ui.select = async (_title, options) => {
    const label = calls++ === 0 ? "Edit the plan" : "Yes, implement here";
    return options.find((s) => s === label);
  };
  ui.editor = async () => assert.fail("pi's editor is not used when an external one is set");
  (ui as unknown as { custom: unknown }).custom = (
    factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => unknown,
  ) =>
    new Promise((resolve) => {
      factory(
        {
          stop: () => terminal.push("stop"),
          start: () => terminal.push("start"),
          requestRender: () => terminal.push("render"),
        },
        undefined,
        undefined,
        resolve,
      );
    });
  try {
    await tool(EXIT_TOOL).execute("edit", {}, undefined, undefined, context.ctx);
  } finally {
    if (previous === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previous;
  }
  assert.deepEqual(terminal, ["stop", "start", "render"], "pi hands its terminal to the editor and takes it back");
  assert.match(readFileSync(join(dir, "opened"), "utf8"), /plan\.md\n$/u, "a Markdown file");
  assert.equal(readFileSync(inline().planFile, "utf8"), "# Better plan\n\nDo it well.\n", "the plan file is updated");
});

for (const outcome of ["approve", "cancel", "feedback", "edit", "throw", "abort"] as const) {
  test(`plan review releases its blocked hold after ${outcome}`, async () => {
    const { mock, context, tool, inline } = await setup();
    await mock.commands.get("plan")?.handler("", context.ctx);
    writeFileSync(inline().planFile, "# Plan\n\nDo it.");
    const holds: unknown[] = [];
    mock.eventBus.on("herdr:blocked", (data) => holds.push(data));
    const controller = new AbortController();
    let calls = 0;
    const ui = (context.ctx as ExtensionContext).ui;
    ui.select = async (_title, options) => {
      assert.deepEqual(holds, [{ active: true, label: "Review the plan" }]);
      if (outcome === "throw") throw new Error("dialog failed");
      if (outcome === "abort") {
        controller.abort();
        return undefined;
      }
      if (outcome === "cancel") return undefined;
      if (outcome === "feedback") return options.find((s) => s === "No, keep planning");
      if (outcome === "edit" && calls++ === 0) return options.find((s) => s === "Edit the plan");
      return options.find((s) => s === "Yes, implement here");
    };
    ui.input = async () => {
      assert.equal(holds.length, 1);
      return "Revise it";
    };
    ui.editor = async () => {
      assert.equal(holds.length, 1);
      return "# Edited plan";
    };
    const result = tool(EXIT_TOOL).execute("review", {}, controller.signal, undefined, context.ctx);
    if (outcome === "throw") await assert.rejects(result, /dialog failed/);
    else await result;
    assert.deepEqual(holds, [{ active: true, label: "Review the plan" }, { active: false }]);
    if (["cancel", "feedback", "throw", "abort"].includes(outcome)) assert.equal(inline().active, true);
  });
}
