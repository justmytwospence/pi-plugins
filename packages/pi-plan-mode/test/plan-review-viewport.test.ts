import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExtensionContext,
  type ExtensionToolContext,
  initTheme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  ScrollView,
  type Terminal,
  Text,
  TuiAltScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { afterEach, expect, test, vi } from "vitest";
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { createInteractiveTuiReference } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { EXIT_TOOL, registerInlinePlanMode } from "../src/inline-plan.js";
import { PlanReviewViewport } from "../src/plan-review-viewport.js";
import { createMockContext, createMockPi } from "./shared/support.js";

class MemoryTerminal implements Terminal {
  columns = 64;
  rows = 35;
  kittyProtocolActive = false;
  start() {
    throw new Error("Live terminal startup is forbidden");
  }
  stop() {}
  async drainInput() {}
  write() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setup(plan: string, scrollbar: "always" | "hidden" = "always") {
  initTheme("dark", false);
  const terminal = new MemoryTerminal();
  const renderer = new TuiAltScreen(terminal);
  vi.spyOn(renderer, "requestRender").mockImplementation(() => {});
  let activeRenderer = renderer;
  const reference = createInteractiveTuiReference(() => activeRenderer);
  const chat = new Container();
  chat.addChild(new Text("Previous conversation with wrapped lines. ".repeat(120), 0, 0));
  const document = new Container();
  document.addChild(chat);
  const scroll = new ScrollView(document, { primary: true, follow: "end", scrollbar });
  const editor = new Text("Your prompt", 0, 0);
  const editorContainer = new Container();
  editorContainer.addChild(editor);
  const above = new Container();
  const below = new Container();
  const root = new VStack([{ component: scroll, basis: 0, grow: 1 }, above, editorContainer, below]);
  renderer.setLayoutRoot(root);
  // Use the SDK's real widget and selector lifecycles, without starting a terminal/session.
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: reference,
    editor,
    editorContainer,
    widgetContainerAbove: above,
    widgetContainerBelow: below,
    extensionWidgetsAbove: new Map(),
    extensionWidgetsBelow: new Map(),
    programStatus: { setBlocked() {} },
    disposeActiveSelector() {},
  }) as {
    setExtensionWidget: ExtensionContext["ui"]["setWidget"];
    showExtensionSelector: ExtensionContext["ui"]["select"];
    extensionSelector?: Component;
  };
  const ctx = createMockContext({ mode: "tui", hasUI: true }).ctx as ExtensionToolContext;
  ctx.ui.setWidget = mode.setExtensionWidget.bind(mode);
  ctx.ui.select = mode.showExtensionSelector.bind(mode);
  const mock = createMockPi();
  const directory = mkdtempSync(join(tmpdir(), "plan-review-"));
  directories.push(directory);
  const inline = registerInlinePlanMode(mock.pi, {
    safeSubcommands: () => undefined,
    plansDirectory: () => directory,
    approved() {},
    implementFresh() {},
    toggleKey: () => undefined,
  });
  inline.enter(ctx);
  writeFileSync(inline.planFile as string, plan);
  const definition = mock.tools.find((tool) => tool.name === EXIT_TOOL) as unknown as ToolDefinition;
  const card = new ToolExecutionComponent(EXIT_TOOL, "review-id", {}, {}, definition, reference, "/fixture");
  card.markExecutionStarted();
  chat.addChild(card);
  const internals = renderer as unknown as { currentLayout: ReturnType<typeof renderLayoutFrame> };
  const frame = () => {
    const layout = renderLayoutFrame(root, terminal.columns, terminal.rows, () => renderer.requestRender());
    internals.currentLayout = layout;
    return layout;
  };
  const settle = async () => {
    // First frame lays out the picker; the jump runs after layout. Subsequent frames
    // settle temporary tail sizing against that actual chat viewport.
    for (let i = 0; i < 4; i++) {
      frame();
      await Promise.resolve();
    }
    return frame();
  };
  frame();
  const run = () =>
    definition.execute(
      "review-id",
      {},
      undefined,
      (update) => {
        card.updateResult({ ...update, isError: false }, true);
      },
      ctx,
    );
  const choose = (index = 0) => {
    const selector = mode.extensionSelector as Component;
    for (let i = 0; i < index; i++) selector.handleInput?.("\x1b[B");
    selector.handleInput?.("\r");
  };
  const top = () =>
    chat.children
      .slice(0, chat.children.indexOf(card))
      .reduce((rows, child) => rows + child.render(scroll.getContentWidth(terminal.columns)).length, 1);
  const widgets = () => (mode as unknown as { extensionWidgetsAbove: Map<string, unknown> }).extensionWidgetsAbove;
  return {
    terminal,
    renderer,
    scroll,
    chat,
    card,
    mode,
    ctx,
    mock,
    run,
    choose,
    settle,
    frame,
    top,
    widgets,
    replaceRenderer: (next: TuiAltScreen) => {
      activeRenderer = next;
    },
  };
}

const longPlan =
  "# Beginning of plan\n\n" +
  Array.from({ length: 80 }, (_, i) => `Step ${i + 1}: carefully implement and verify this part of the feature.`).join(
    "\n",
  );

test.each(["long", "short"])(
  "actual SDK puts a %s plan at the top only after the picker has laid out",
  async (size) => {
    const h = setup(size === "long" ? longPlan : "# Beginning of plan\n\nDo it.");
    const result = h.run();
    const layout = await h.settle();
    expect(h.scroll.scrollTop).toBe(h.top());
    expect(h.scroll.isFollowingEnd).toBe(false);
    expect(layout.lines[1]).toContain("Plan review");
    expect(layout.lines[2]).toContain("Beginning of plan");
    expect(layout.lines.join("\n")).toContain("Implement this plan?");
    expect(h.widgets().size).toBe(1);
    h.choose();
    const approved = await result;
    h.card.updateResult({ ...approved, isError: false }, false);
    await h.settle();
    expect(h.widgets().size).toBe(0);
    expect(h.scroll.isFollowingEnd).toBe(true);
    expect(h.card.render(64).length).toBeLessThan(size === "long" ? 40 : 12);
  },
);

test("manual scrolling is not overwritten by rerenders or resizing away from the start", async () => {
  const h = setup(longPlan);
  const result = h.run();
  await h.settle();
  const jump = vi.spyOn(h.scroll, "scrollTo");
  h.scroll.scrollBy(9);
  const position = h.scroll.scrollTop;
  await h.settle();
  expect(h.scroll.scrollTop).toBe(position);
  h.terminal.columns = 48;
  h.terminal.rows = 40;
  await h.settle();
  expect(h.scroll.scrollTop).toBe(position);
  expect(jump).not.toHaveBeenCalled();
  h.choose();
  await result;
});

test.each(["width", "height"])(
  "resize of %s keeps a reader at the beginning anchored, including short plans",
  async (dimension) => {
    const h = setup("# Beginning of plan\n\nDo it.");
    const result = h.run();
    await h.settle();
    if (dimension === "width") h.terminal.columns = 31;
    else h.terminal.rows = 55;
    const layout = await h.settle();
    expect(h.scroll.scrollTop).toBe(h.top());
    expect(layout.lines[1]).toContain("Plan review");
    expect(layout.lines[2]).toContain("Beginning of plan");
    h.choose();
    await result;
  },
);

test("editing returns to the start of the revised plan", async () => {
  const h = setup(longPlan);
  h.ctx.ui.editor = async () => "# Revised plan\n\nSmaller.";
  const result = h.run();
  await h.settle();
  h.scroll.scrollBy(12);
  h.choose(2); // Edit the plan first, without a gate installed.
  await Promise.resolve();
  const layout = await h.settle();
  expect(h.scroll.scrollTop).toBe(h.top());
  expect(layout.lines[2]).toContain("Revised plan");
  h.choose();
  await result;
});

test.each(["escape", "keep", "fresh", "abort"])(
  "%s closes review, clears queued jumps and restores follow",
  async (ending) => {
    const h = setup(longPlan);
    const abort = new AbortController();
    const definition = h.mock.tools.find((tool) => tool.name === EXIT_TOOL) as unknown as ToolDefinition;
    const result = definition.execute(
      "review-id",
      {},
      abort.signal,
      (update) => {
        h.card.updateResult({ ...update, isError: false }, true);
      },
      h.ctx,
    );
    h.frame(); // Leave an anchor microtask queued while the user dismisses review.
    if (ending === "escape") h.mode.extensionSelector?.handleInput?.("\x1b");
    else if (ending === "abort") abort.abort();
    else h.choose(ending === "keep" ? 3 : 1);
    const final = await result;
    h.card.updateResult({ ...final, isError: false }, false);
    await h.settle();
    expect(h.widgets().size).toBe(0);
    expect(h.scroll.isFollowingEnd).toBe(true);
  },
);

test("a thrown dialog error releases review resources", async () => {
  const h = setup(longPlan);
  h.ctx.ui.select = async () => {
    throw new Error("dialog failed");
  };
  await expect(h.run()).rejects.toThrow("dialog failed");
  await h.settle();
  expect(h.widgets().size).toBe(0);
  expect(h.scroll.isFollowingEnd).toBe(true);
  const viewport = new PlanReviewViewport();
  viewport.begin(h.ctx, "review-id");
  viewport.wrap("review-id", new Text("pending", 0, 0)).render(64);
  viewport.end();
  await Promise.resolve();
  expect(h.widgets().size).toBe(0);
});

test("tool-call identity skips earlier plans and an optional top overlay leaves review visible", async () => {
  const h = setup(longPlan, "hidden");
  const old = new ToolExecutionComponent(
    EXIT_TOOL,
    "earlier-id",
    {},
    {},
    undefined,
    createInteractiveTuiReference(() => h.renderer),
    "/fixture",
  );
  old.updateResult({ content: [{ type: "text", text: longPlan }], isError: false }, false);
  h.chat.children.splice(1, 0, old);
  const overlay = h.renderer.showOverlay(new Text("Pinned user prompt", 0, 0), {
    anchor: "top-left",
    row: 0,
    col: 0,
    width: "100%",
    nonCapturing: true,
  });
  const result = h.run();
  const layout = await h.settle();
  expect(h.scroll.scrollTop).toBe(h.top());
  expect(layout.lines[1]).toContain("Plan review");
  overlay.hide();
  h.choose();
  await result;
});

test("session shutdown is idempotent and stops queued anchoring", async () => {
  const h = setup("# Plan\n\nShort.");
  const result = h.run();
  h.frame();
  for (const handler of h.mock.events.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown", reason: "reload" }, h.ctx);
  }
  await h.settle();
  expect(h.widgets().size).toBe(0);
  expect(h.scroll.isFollowingEnd).toBe(true);
  h.choose();
  await result;
  expect(h.widgets().size).toBe(0);
});

test("a replaced SDK renderer is not scrolled by stale review work or cleanup", async () => {
  const h = setup(longPlan);
  const result = h.run();
  h.frame(); // Queue the old review's jump.
  const next = new TuiAltScreen(h.terminal);
  vi.spyOn(next, "requestRender").mockImplementation(() => {});
  const nextDocument = new Container();
  nextDocument.addChild(new Text("New session\n".repeat(100), 0, 0));
  const nextScroll = new ScrollView(nextDocument, { primary: true, follow: "end" });
  const nextRoot = new VStack([{ component: nextScroll, basis: 0, grow: 1 }]);
  next.setLayoutRoot(nextRoot);
  renderLayoutFrame(nextRoot, 64, 35, () => {});
  nextScroll.scrollTo(10, { disableFollow: true });
  h.replaceRenderer(next);
  await Promise.resolve();
  h.choose();
  await result;
  expect(nextScroll.scrollTop).toBe(10);
  expect(nextScroll.isFollowingEnd).toBe(false);
  expect(h.widgets().size).toBe(0);
});

test.each(["rpc", "regular", "unsupported"])(
  "%s presentation stays unpadded and does not attempt scrolling",
  (mode) => {
    const viewport = new PlanReviewViewport();
    const scrollTo = vi.fn();
    const setWidget = vi.fn((_key: string, factory?: (tui: unknown) => Component) => {
      factory?.({ mode: mode === "regular" ? "regular" : "fullscreen", terminal: { rows: 40 }, scrollTo });
    });
    const ctx = createMockContext({ mode: mode === "rpc" ? "rpc" : "tui", hasUI: true }).ctx as ExtensionContext;
    ctx.ui.setWidget = setWidget as ExtensionContext["ui"]["setWidget"];
    viewport.begin(ctx, "review-id");
    expect(
      viewport
        .wrap("review-id", new Text("plan", 0, 0))
        .render(40)
        .map((line) => line.trim()),
    ).toEqual(["plan"]);
    viewport.end();
    expect(scrollTo).not.toHaveBeenCalled();
    if (mode === "rpc") expect(setWidget).not.toHaveBeenCalled();
  },
);
