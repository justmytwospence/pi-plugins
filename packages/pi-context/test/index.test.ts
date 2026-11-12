import { type BuildSystemPromptOptions, type ExtensionAPI, createEventBus, formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import extension from "../src/index.ts";
import { CONTEXT_METADATA_CHANNEL, type ContextMetadataRequest } from "../src/context-metadata.ts";
import { FOOTER_ACTIONS_CHANNEL, queryFooterActions } from "../src/footer-actions.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};
const tui = { terminal: { rows: 40, columns: 100 }, requestRender: vi.fn() };

type Comp = {
  render(width: number): string[];
  handleInput(data: string): void;
  handleMouse(event: Record<string, unknown>): { handled?: boolean; render?: boolean } | undefined;
};

/** Runs each overlay factory, hands the component to `drive`, which must end it by calling done. */
function customStub(drive: (component: Comp, done: (value: unknown) => void, call: number) => void) {
  let call = 0;
  return async (factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => Comp) =>
    new Promise((resolve) => {
      const component = factory(tui, theme, {}, resolve);
      drive(component, resolve, call++);
    });
}

const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  type,
  button: "left",
  x,
  y,
  screenX: x,
  screenY: y,
  width: 64,
  height: 20,
  shift: false,
  alt: false,
  ctrl: false,
  ...extra,
});

describe("extension", () => {
  test("registers /context and reports in plain text outside the TUI", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
      registerEntryRenderer: () => {},
      getAllTools: () => [{ name: "read", description: "Read", parameters: { type: "object" } }],
      on: vi.fn(), events: createEventBus(),
    } as unknown as ExtensionAPI;
    extension(pi);
    expect([...commands.keys()]).toEqual(["context"]);

    const notify = vi.fn();
    await commands.get("context")!.handler("", {
      hasUI: true,
      mode: "rpc",
      model: { contextWindow: 200_000 },
      getContextUsage: () => ({ tokens: 10_000, percent: 5, contextWindow: 200_000 }),
      getSystemPrompt: () => "x".repeat(4_000),
      getSystemPromptOptions: () => ({ cwd: "/", selectedTools: ["read"] }),
      sessionManager: { getSessionId: () => "session", buildContextEntries: () => [] },
      ui: { notify },
    });
    expect(notify).toHaveBeenCalledTimes(1);
    const [text, level] = notify.mock.calls[0];
    expect(level).toBe("info");
    expect(text).toContain("Context: 10.0k / 200k tokens (5.0%)");
    expect(text).toContain("System prompt: 1.0k tokens");
    expect(text).toContain("Free space: 190k tokens");
  });

  test("draws the dialog, opens a preview on Enter and on click, and closes on escape", async () => {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, command),
      registerEntryRenderer: () => {},
      getAllTools: () => [{ name: "read", description: "Read", parameters: { type: "object" } }],
      on: vi.fn(), events: createEventBus(),
    } as unknown as ExtensionAPI;
    extension(pi);

    const frames: string[][] = [];
    const custom = customStub((component, done, call) => {
      const lines = component.render(64).map((line) => stripTerminalSequences(line));
      frames.push(lines);
      switch (call) {
        case 0: // dialog: move down once, Enter opens Memory
          component.handleInput("\x1b[B");
          component.handleInput("\r");
          break;
        case 1: // preview: scroll and close
          expect(component.handleMouse(mouse("wheel", 5, 5, { wheelDelta: 3 }))).toEqual({ handled: true, render: false });
          component.handleInput("\x1b");
          break;
        case 2: // dialog again: click the Skills row (local row 5 + 2)
          expect(component.handleMouse(mouse("click", 10, 7))).toEqual({ handled: true });
          break;
        case 3: // preview: click [esc] on the title row
          expect(component.handleMouse(mouse("click", 60, 1))).toEqual({ handled: true });
          break;
        default: // dialog: ctrl+c
          component.handleInput("\x03");
      }
      void done;
    });

    await commands.get("context")!.handler("", {
      hasUI: true,
      mode: "tui",
      model: { contextWindow: 200_000 },
      getContextUsage: () => ({ tokens: 10_000, percent: 5, contextWindow: 200_000 }),
      getSystemPrompt: () => "You are helpful.\n\nMEMORY BODY",
      getSystemPromptOptions: () => ({ cwd: "/", selectedTools: ["read"], contextFiles: [{ path: "/p/AGENTS.md", content: "MEMORY BODY" }] }),
      sessionManager: { getSessionId: () => "session", buildContextEntries: () => [] },
      ui: { custom, notify: vi.fn() },
    });

    expect(frames).toHaveLength(5);
    const dialog = frames[0];
    expect(dialog[1]).toContain("Context Usage");
    expect(dialog[1]).toContain("10.0k / 200k tokens (5.0%)");
    expect(dialog[1]).toContain("[esc]");
    expect(dialog[5]).toMatch(/^│› ■ System prompt/);
    expect(dialog[6]).toMatch(/^│ {2}■ Memory/);
    expect(dialog.map(visibleWidth)).toEqual(dialog.map(() => 64));

    expect(frames[1][1]).toContain("Memory Files");
    expect(frames[1].join("\n")).toContain("/p/AGENTS.md");
    expect(frames[2][6]).toMatch(/^│› ■ Memory/);
    expect(frames[3][1]).toContain("Skills");
    expect(frames[3].join("\n")).toContain("No skills in context.");
    expect(frames[4][7]).toMatch(/^│› ■ Skills/);
  });
});

async function footerFixture(start = true, bridge = true) {
  let id = "session";
  const events = createEventBus();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const mutations = {
    setModel: vi.fn(), setThinkingLevel: vi.fn(), setActiveTools: vi.fn(), appendEntry: vi.fn(),
    sendMessage: vi.fn(), sendUserMessage: vi.fn(), exec: vi.fn(),
  };
  const pi = {
    ...mutations, events,
    on(name: string, handler: (...args: any[]) => any) {
      const callbacks = handlers.get(name) ?? [];
      callbacks.push(handler); handlers.set(name, callbacks);
    },
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerEntryRenderer: () => {},
    getAllTools: vi.fn(() => [
      { name: "read", description: "Read", parameters: { type: "object" } },
      { name: "inspect", description: "Inspect custom state", parameters: { type: "object" } },
    ]),
  };
  const options: BuildSystemPromptOptions = {
    cwd: "/project", selectedTools: ["inspect"],
    contextFiles: [{ path: "/project/AGENTS.md", content: "MEMORY BODY" }],
    skills: [{ name: "fresh-skill", description: "Fresh skill metadata", filePath: "/skills/fresh-skill/SKILL.md",
      baseDir: "/skills/fresh-skill", disableModelInvocation: false,
      sourceInfo: { path: "/skills/fresh-skill/SKILL.md", source: "test", scope: "temporary", origin: "top-level" } }],
  };
  const read = vi.fn((): BuildSystemPromptOptions | undefined => options);
  let removeBridge = () => {};
  const ui = {
    custom: vi.fn(customStub((_component, done) => done(undefined))), notify: vi.fn(),
    setEditorText: vi.fn(), pasteToEditor: vi.fn(), getEditorText: vi.fn(() => "unsent\n界 draft"),
  };
  const manager = { getSessionId: () => id, buildContextEntries: vi.fn(() => []) };
  // Deliberately the SDK lifecycle shape: no getSystemPromptOptions method here.
  const ctx = {
    mode: "tui", hasUI: true, ui, sessionManager: manager, model: { contextWindow: 200_000 },
    getContextUsage: vi.fn(() => ({ tokens: 10_000, percent: 5, contextWindow: 200_000 })),
    getSystemPrompt: vi.fn(() => `System rules\nMEMORY BODY\n${formatSkillsForPrompt(options.skills!)}`),
    isIdle: vi.fn(() => true), compact: vi.fn(), abort: vi.fn(),
  };
  const installBridge = () => {
    removeBridge();
    let live = true;
    const off = events.on(CONTEXT_METADATA_CHANNEL, (data) => {
      const request = data as ContextMetadataRequest;
      if (request.version === 1 && request.sessionManager === manager) {
        request.read = () => live ? read() : undefined;
      }
    });
    removeBridge = () => { live = false; off(); };
  };
  if (bridge) installBridge();
  extension(pi as unknown as ExtensionAPI);
  const emit = async (name: string) => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx);
  };
  if (start) await emit("session_start");
  return {
    pi, ctx, ui, manager, options, read, mutations, commands, emit, installBridge,
    removeBridge: () => removeBridge(), setId: (next: string) => { id = next; },
    query: () => queryFooterActions(events),
    command: () => commands.get("context")!.handler("", { ...ctx, getSystemPromptOptions: read }),
  };
}

function expectObservational(f: Awaited<ReturnType<typeof footerFixture>>) {
  for (const mutation of Object.values(f.mutations)) expect(mutation).not.toHaveBeenCalled();
  for (const mutation of [f.ctx.compact, f.ctx.abort, f.ui.setEditorText, f.ui.pasteToEditor, f.ui.getEditorText]) {
    expect(mutation).not.toHaveBeenCalled();
  }
}

describe("optional Context/Skills footer actions", () => {
  test("discovers only after startup and only with a metadata bridge, without reading any context", async () => {
    const f = await footerFixture(false, false);
    expect(f.query()).toEqual({});
    await f.emit("session_start");
    expect(f.query()).toEqual({});
    f.installBridge(); // Provider load order is not latched at session_start.
    expect(Object.keys(f.query())).toEqual(["context.open", "context.skills"]);
    expect(f.query()["context.open"]).toMatchObject({ label: "Context usage", key: "/context" });
    expect(f.read).not.toHaveBeenCalled();
    expect(f.pi.getAllTools).not.toHaveBeenCalled();
    expect(f.ctx.getContextUsage).not.toHaveBeenCalled();
    expect(f.ctx.getSystemPrompt).not.toHaveBeenCalled();
    expect(f.manager.buildContextEntries).not.toHaveBeenCalled();
    expect(f.ui.custom).not.toHaveBeenCalled();
    expect(f.ui.notify).not.toHaveBeenCalled();
    f.removeBridge();
    expect(f.query()).toEqual({});
    expectObservational(f);
  });

  test("the standalone command does not require either provider startup or a bridge", async () => {
    const f = await footerFixture(false, false);
    expect(f.query()).toEqual({});
    await f.command();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.ui.custom).toHaveBeenCalledTimes(1);
    expectObservational(f);
  });

  test.each([46, 120, 180])("Context click and /context have identical dialogs and previews at %i columns", async (width) => {
    const f = await footerFixture();
    const capture = () => {
      const frames: string[][] = [];
      f.ui.custom.mockImplementation(customStub((component, _done, call) => {
        frames.push(component.render(width).map(stripTerminalSequences));
        if (call % 2 || call === 12) component.handleInput("\x1b");
        else {
          if (call) component.handleInput("\x1b[B");
          component.handleInput("\r");
        }
      }));
      return frames;
    };
    const commandFrames = capture();
    await f.command();
    const footerFrames = capture();
    await f.query()["context.open"]!.run();
    expect(footerFrames).toEqual(commandFrames);
    expect(footerFrames).toHaveLength(13);
    expect(footerFrames.flat().every(line => visibleWidth(line) <= width)).toBe(true);
    const body = footerFrames.flat().join("\n");
    expect(body).toContain("/project/AGENTS.md");
    expect(body).toContain("fresh-skill");
    expect(body).toContain("Definition: inspect");
    expect(body).not.toContain("Definition: read");
    expect(f.read).toHaveBeenCalledTimes(2);
    expectObservational(f);
  });

  test("Skills opens its preview first, then returns to normal navigation with Skills selected", async () => {
    const f = await footerFixture();
    const frames: string[][] = [];
    f.ui.custom.mockImplementation(customStub((component, _done, call) => {
      frames.push(component.render(100).map(stripTerminalSequences));
      if (call === 1) {
        component.handleInput("\x1b[B");
        component.handleInput("\r");
      } else component.handleInput("\x1b");
    }));
    await f.query()["context.skills"]!.run();
    expect(frames).toHaveLength(4);
    expect(frames[0][1]).toContain("Skills");
    expect(frames[0].join("\n")).toContain("fresh-skill");
    expect(frames[0].join("\n")).not.toContain("Context Usage");
    expect(frames[1][1]).toContain("Context Usage");
    expect(frames[1][7]).toMatch(/^│› ■ Skills/);
    expect(frames[2][1]).toContain("Tool Definitions");
    expect(frames[3][8]).toMatch(/^│› ■ Tools definition/);
    expect(f.read).toHaveBeenCalledTimes(1);
    expectObservational(f);
  });

  test("reads current metadata at activation and remains observational while the agent is busy", async () => {
    const f = await footerFixture();
    const action = f.query()["context.skills"]!;
    f.ctx.isIdle.mockReturnValue(false);
    f.options.skills![0].name = "updated-skill";
    const before = JSON.stringify(f.options);
    const frames: string[][] = [];
    f.ui.custom.mockImplementation(customStub((component, done) => {
      frames.push(component.render(100).map(stripTerminalSequences));
      done(undefined);
    }));
    await action.run();
    expect(frames[0].join("\n")).toContain("updated-skill");
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.options)).toBe(before);
    expectObservational(f);
  });

  test.each([undefined, {}, { cwd: 3 }])("missing or malformed metadata %j never produces an empty report", async (options) => {
    const f = await footerFixture();
    const actions = f.query();
    f.read.mockReturnValue(options as BuildSystemPromptOptions | undefined);
    await actions["context.open"]!.run();
    await actions["context.skills"]!.run();
    expect(f.ui.custom).not.toHaveBeenCalled();
    expect(f.ui.notify).not.toHaveBeenCalled();
    expect(f.pi.getAllTools).not.toHaveBeenCalled();
    expectObservational(f);
  });

  test("cached capabilities fail closed if the metadata provider leaves or fails", async () => {
    const f = await footerFixture();
    const actions = f.query();
    f.removeBridge();
    await actions["context.open"]!.run();
    await actions["context.skills"]!.run();
    expect(f.ui.custom).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    f.installBridge();
    f.read.mockImplementationOnce(() => { throw new Error("stale runtime"); });
    await f.query()["context.open"]!.run();
    expect(f.ui.custom).not.toHaveBeenCalled();
    expect(f.ui.notify).toHaveBeenCalledWith("Context metadata unavailable; use /context.", "warning");
    expectObservational(f);
  });

  test.each(["id", "tree", "restart", "shutdown", "rpc", "no-ui"])("cached actions are inert after %s", async (change) => {
    const f = await footerFixture();
    const actions = f.query();
    if (change === "id") f.setId("other");
    else if (change === "rpc") f.ctx.mode = "rpc";
    else if (change === "no-ui") f.ctx.hasUI = false;
    else await f.emit(change === "tree" ? "session_tree" : change === "restart" ? "session_start" : "session_shutdown");
    await actions["context.open"]!.run();
    await actions["context.skills"]!.run();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.ui.custom).not.toHaveBeenCalled();
    expect(f.ui.notify).not.toHaveBeenCalled();
    if (change === "tree" || change === "restart") {
      await f.query()["context.open"]!.run();
      expect(f.ui.custom).toHaveBeenCalledTimes(1);
    } else expect(f.query()).toEqual({});
    expectObservational(f);
  });

  test.each(["rpc", "json", "print", "no-ui"])("does not publish controls in %s startup", async (mode) => {
    const f = await footerFixture(false);
    if (mode === "no-ui") f.ctx.hasUI = false;
    else f.ctx.mode = mode;
    await f.emit("session_start");
    expect(f.query()).toEqual({});
    await f.command();
    expect(f.ui.custom).not.toHaveBeenCalled();
    expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Context: 10.0k / 200k"), "info");
    expectObservational(f);
  });

  test.each(["context.open", "context.skills"] as const)("%s checks generation after its first UI await", async (action) => {
    const f = await footerFixture();
    let finish!: (value: unknown) => void;
    f.ui.custom.mockImplementation(customStub((_component, done) => { finish = done; }));
    const opened = f.query()[action]!.run();
    expect(f.ui.custom).toHaveBeenCalledTimes(1);
    await f.emit("session_tree");
    finish(action === "context.open" ? "skills" : undefined);
    await opened;
    expect(f.ui.custom).toHaveBeenCalledTimes(1);
    expect(f.ui.notify).not.toHaveBeenCalled();
    expectObservational(f);
  });

  test("checks shutdown after a normal preview await, including the shared command path", async () => {
    for (const command of [false, true]) {
      const f = await footerFixture();
      let closePreview!: (value: unknown) => void;
      let previewMounted!: () => void;
      const ready = new Promise<void>(resolve => { previewMounted = resolve; });
      f.ui.custom.mockImplementation(customStub((_component, done, call) => {
        if (call === 0) done("skills");
        else { closePreview = done; previewMounted(); }
      }));
      const opened = command ? f.command() : f.query()["context.open"]!.run();
      await ready;
      expect(f.ui.custom).toHaveBeenCalledTimes(2);
      await f.emit("session_shutdown");
      closePreview(undefined);
      await opened;
      expect(f.ui.custom).toHaveBeenCalledTimes(2);
      expect(f.query()).toEqual({});
      expect(f.ui.notify).not.toHaveBeenCalled();
      expectObservational(f);
    }
  });

  test("serializes all Context/Skills descriptors, and an old completion cannot unlock a new session", async () => {
    const f = await footerFixture();
    const finishes: Array<(value: unknown) => void> = [];
    f.ui.custom.mockImplementation(customStub((_component, done) => { finishes.push(done); }));
    const old = f.query()["context.open"]!.run();
    await f.query()["context.skills"]!.run();
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.ui.custom).toHaveBeenCalledTimes(1);
    await f.emit("session_start");
    const opened = f.query()["context.open"]!.run();
    finishes[0]("skills"); await old;
    await f.query()["context.skills"]!.run();
    expect(f.ui.custom).toHaveBeenCalledTimes(2);
    finishes[1](undefined); await opened;
    expect(f.ui.notify).not.toHaveBeenCalled();
    expectObservational(f);
  });

  test("revalidates after metadata reads and does not report late UI errors into a replacement", async () => {
    const f = await footerFixture();
    f.read.mockImplementationOnce(() => { f.setId("replacement"); return f.options; });
    await f.query()["context.open"]!.run();
    expect(f.ui.custom).not.toHaveBeenCalled();
    expect(f.pi.getAllTools).not.toHaveBeenCalled();
    await f.emit("session_start");
    let reject!: (error: Error) => void;
    f.ui.custom.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const opened = f.query()["context.open"]!.run();
    await f.emit("session_shutdown");
    reject(new Error("disposed UI")); await opened;
    expect(f.ui.notify).not.toHaveBeenCalled();
    expectObservational(f);
  });

  test("rejects malformed requests and unsubscribes idempotently on shutdown", async () => {
    const f = await footerFixture();
    for (const request of [null, {}, { version: 2, actions: {} }, { version: 1, actions: null }, { version: 1, actions: [] }]) {
      expect(() => f.pi.events.emit(FOOTER_ACTIONS_CHANNEL, request)).not.toThrow();
    }
    const query = vi.spyOn(f.pi.events, "emit");
    await f.emit("session_shutdown"); await f.emit("session_shutdown");
    expect(f.query()).toEqual({});
    expect(query.mock.calls.map(([channel]) => channel)).toEqual([FOOTER_ACTIONS_CHANNEL]);
    expect(f.read).not.toHaveBeenCalled();
    expect(f.ui.custom).not.toHaveBeenCalled();
    expectObservational(f);
  });
});
