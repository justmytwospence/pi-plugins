import { Container, ScrollView, TuiAltScreen, VStack, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { getMarkdownTheme, initTheme, SkillInvocationMessageComponent, UserMessageComponent, type ExtensionAPI, type ExtensionContext, type SessionStartEvent, type SessionShutdownEvent, type Theme } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
// Test the actual pinned SDK proxy, not an approximation with extra reflection traps.
import { createInteractiveTuiReference } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { InteractiveMode } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import stickyLastPrompt, { CLEAR_SENTINEL, OWNER, PinBar, WRAPPER_TAG, classifyPiComponent, collectAnchors, type AnchorIndex } from "../src/index.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
} as unknown as Theme;

/** No ProcessTerminal, renderer start, real input, sockets, or external clipboard/browser calls. */
class MemoryTerminal implements Terminal {
  columns = 40;
  rows = 5;
  kittyProtocolActive = false;
  writes: string[] = [];
  start() { throw new Error("Live terminal startup is forbidden in this test"); }
  stop() {}
  async drainInput() {}
  write(data: string) { this.writes.push(data); }
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

type Internals = {
  overlayStack: Array<{ component: Component }>;
  currentLayout?: ReturnType<typeof renderLayoutFrame>;
  compositeOverlays(lines: string[], width: number, height: number): string[];
  handleMouseEvent(raw: { button: number; x: number; y: number; release: boolean }): void;
};

type LifecycleHandler = (event: SessionStartEvent | SessionShutdownEvent, ctx: ExtensionContext) => unknown;

function setup() {
  initTheme("dark", false); // Built-in palette only; no watcher or settings writes.
  const terminal = new MemoryTerminal();
  const renderer = new TuiAltScreen(terminal);
  const render = vi.spyOn(renderer, "requestRender").mockImplementation(() => {});
  const internals = renderer as unknown as Internals;
  const symbols = Object.getOwnPropertySymbols(renderer);
  let activeRenderer = renderer;
  const reference = createInteractiveTuiReference(() => activeRenderer);
  const handlers = new Map<string, LifecycleHandler>();
  const pi = { on: (event: string, handler: LifecycleHandler) => { handlers.set(event, handler); return () => {}; } } as unknown as ExtensionAPI;
  const widgets = new Map<string, Component & { dispose?(): void }>();
  const notes: string[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      notify: (message: string) => notes.push(message),
      setWidget(key: string, factory?: (tui: TUI, theme: Theme) => Component) {
        widgets.get(key)?.dispose?.();
        widgets.delete(key);
        if (factory) widgets.set(key, factory(reference, theme));
      },
    },
  } as unknown as ExtensionContext;
  const emit = (event: "session_start" | "session_shutdown") => handlers.get(event)?.(
    event === "session_start" ? { type: event, reason: "startup" } : { type: event, reason: "quit" }, ctx,
  );
  stickyLastPrompt(pi);
  return { renderer, internals, terminal, reference, emit, widgets, symbols, render, notes,
    switchRenderer: (next: TuiAltScreen) => { activeRenderer = next; },
  };
}

function transcript(renderer: TuiAltScreen) {
  const chat = new Container();
  const message = new UserMessageComponent("the real SDK prompt");
  chat.addChild(message);
  chat.addChild({ render: () => Array.from({ length: 20 }, () => "response"), invalidate() {} });
  const document = new Container();
  document.addChild(chat);
  const scroll = new ScrollView(document, { primary: true, follow: "none" });
  const root = new VStack([{ component: scroll, basis: 0, grow: 1 }]);
  renderer.setLayoutRoot(root);
  return { chat, message, document, scroll, root };
}

test.each(["string", "text/image blocks"])("SDK transcript classification is backend-independent for normalized %s user messages", (shape) => {
  initTheme("dark", false);
  const chat = new Container();
  // Run the actual SDK role-based transcript builder without starting InteractiveMode.
  // Native and CC-origin messages share this path after normalization to Pi's user role;
  // this does not exercise an external CC bridge or authenticate either backend.
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    chatContainer: chat,
    outputPad: 1,
    toolOutputExpanded: false,
    getMarkdownThemeWithSettings: getMarkdownTheme,
    getMarkdownTransformers: () => [],
  }) as { addMessageToChat(message: { role: "user"; content: unknown; timestamp: number }): void };
  const add = (text: string) => mode.addMessageToChat({
    role: "user", timestamp: 0,
    content: shape === "string" ? text : [
      { type: "text", text }, { type: "image", mimeType: "image/png", data: "unused" },
    ],
  });
  add("ordinary  prompt");
  add('<skill name="review" location="/fixture/SKILL.md">\nreview body\n</skill>');
  add('<skill name="review-tail" location="/fixture/SKILL.md">\nbody\n</skill>\n\nextra instructions');
  const prompts = chat.children.filter((child) => classifyPiComponent(child));
  expect(prompts[0]).toBeInstanceOf(UserMessageComponent);
  expect(prompts[1]).toBeInstanceOf(SkillInvocationMessageComponent);
  expect(prompts[2]).toBeInstanceOf(SkillInvocationMessageComponent);
  expect(prompts[3]).toBeInstanceOf(UserMessageComponent);
  expect(prompts.map(classifyPiComponent)).toEqual([
    { kind: "user", text: "ordinary  prompt" },
    { kind: "skill", name: "review" },
    { kind: "skill", name: "review-tail" },
    { kind: "user", text: "extra instructions" },
  ]);
  const measure = () => {
    const index: AnchorIndex = { anchors: [], horizons: [] };
    const height = collectAnchors([chat], 40, 0, index);
    expect(height).toBe(chat.render(40).length);
    expect(index.anchors.map(({ text }) => text)).toEqual([
      "ordinary prompt", "[skill] review", "[skill] review-tail", "extra instructions",
    ]);
    return index;
  };
  const collapsed = measure();
  (prompts[1] as SkillInvocationMessageComponent).setExpanded(true);
  const expanded = measure();
  expect(expanded.anchors[1]!.end - expanded.anchors[1]!.start).toBeGreaterThan(
    collapsed.anchors[1]!.end - collapsed.anchors[1]!.start,
  );
});

/** Relevant lifecycle from retained npm pi-sticky-last-prompt@0.1.1, unchanged in shape. */
function legacySticky(reference: TUI) {
  const screen = reference as TUI & {
    overlayStack: Array<{ component: Component; hidden?: boolean }>;
    isOverlayVisible(entry: unknown): boolean;
  };
  const bar: Component = { render: () => ["legacy prompt"], invalidate() {} };
  const originalHasOverlay = screen.hasOverlay.bind(screen);
  screen.hasOverlay = () => {
    const stack = screen.overlayStack;
    if (!Array.isArray(stack)) return originalHasOverlay();
    for (const entry of stack) {
      if (!screen.isOverlayVisible(entry)) continue;
      if (entry.component !== bar) return originalHasOverlay();
    }
    return false;
  };
  const overlay = screen.showOverlay(bar, { anchor: "top-left", row: 0, col: 0, width: "100%", nonCapturing: true });
  return {
    shutdown() {
      // SDK Proxy has no deleteProperty trap: this deletes on its empty target only.
      delete (screen as { hasOverlay?: () => boolean }).hasOverlay;
      overlay.hide();
    },
    overlay,
  };
}

test("legacy npm -> suite reload through the actual SDK proxy preserves scrolling and cleanup", async () => {
  const h = setup();
  const { scroll, root } = transcript(h.renderer);
  const legacy = legacySticky(h.reference);
  const descriptor = Object.getOwnPropertyDescriptor(h.renderer, "hasOverlay")!;
  expect(Object.hasOwn(h.reference, "hasOverlay")).toBe(false);
  expect(descriptor.value).toBeTypeOf("function");
  legacy.shutdown();
  expect(h.internals.overlayStack).toEqual([]);
  expect(Object.getOwnPropertyDescriptor(h.renderer, "hasOverlay")).toEqual(descriptor);

  // Two new lifecycles on the same renderer, as with a second /reload.
  for (let reload = 0; reload < 2; reload++) {
    await h.emit("session_start");
    expect(h.notes).toEqual([]);
    expect(h.internals.overlayStack).toHaveLength(1);
    const pin = h.internals.overlayStack[0]!.component;
    const layout = renderLayoutFrame(root, 40, 5, () => {});
    h.internals.currentLayout = layout;
    scroll.scrollTo(10);
    expect(h.internals.compositeOverlays(layout.lines, 40, 5)[0]).toContain("the real SDK prompt");
    expect(h.reference.hasOverlay()).toBe(false); // scrollbar/selection gate stays open
    const jump = vi.spyOn(scroll, "scrollTo");
    h.internals.handleMouseEvent({ button: 0, x: 1, y: 0, release: false });
    h.internals.handleMouseEvent({ button: 0, x: 1, y: 0, release: true });
    expect(jump).toHaveBeenCalledWith(0, { disableFollow: true });
    jump.mockRestore();
    const dialog = h.renderer.showOverlay({ render: () => ["dialog"], invalidate() {} });
    expect(h.reference.hasOverlay()).toBe(true);
    dialog.hide();
    await h.emit("session_shutdown");
    expect(pin.render(40)).toEqual([]);
    expect(h.internals.overlayStack).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(h.renderer, "hasOverlay")).toEqual(descriptor);
    expect(Object.getOwnPropertySymbols(h.renderer)).toEqual(h.symbols);
  }
  h.render.mockRestore();
});

test("an active tagged duplicate is rejected on the real SDK receiver, not the proxy", async () => {
  const first = setup();
  await first.emit("session_start");
  const descriptor = Object.getOwnPropertyDescriptor(first.renderer, "hasOverlay");
  const second = setup();
  second.switchRenderer(first.renderer);
  await second.emit("session_start");
  expect(second.notes).toHaveLength(1);
  expect(second.notes[0]).toMatch(/another copy already wraps/);
  expect(first.internals.overlayStack).toHaveLength(1);
  await second.emit("session_shutdown");
  expect(Object.getOwnPropertyDescriptor(first.renderer, "hasOverlay")).toEqual(descriptor);
  await first.emit("session_shutdown");
  expect(Object.hasOwn(first.renderer, "hasOverlay")).toBe(false);
  first.render.mockRestore();
  second.render.mockRestore();
});

test("an untagged live legacy top bar hides this bar and warns once until removed", async () => {
  const h = setup();
  const { scroll, root } = transcript(h.renderer);
  const legacy = legacySticky(h.reference);
  await h.emit("session_start");
  expect(h.internals.overlayStack).toHaveLength(2);
  const pin = h.internals.overlayStack[1]!.component;
  renderLayoutFrame(root, 40, 5, () => {});
  scroll.scrollTo(10);
  expect(pin.render(40)).toEqual([]);
  expect(pin.render(40)).toEqual([]);
  expect(h.notes).toHaveLength(1);
  expect(h.notes[0]).toMatch(/another top prompt bar/);
  legacy.overlay.setHidden(true);
  expect(pin.render(40)[0]).toContain("the real SDK prompt");
  expect(h.reference.hasOverlay()).toBe(false);
  legacy.shutdown();
  expect(pin.render(40)[0]).toContain("the real SDK prompt");
  expect((h.renderer.hasOverlay as typeof h.renderer.hasOverlay & { [WRAPPER_TAG]?: string })[WRAPPER_TAG]).toBe(OWNER);
  await h.emit("session_shutdown");
  h.render.mockRestore();
});

test("SDK 1.1 proxy: install on the real receiver, route press/release to click, restore prototype", async () => {
  const h = setup();
  const { scroll, root, message } = transcript(h.renderer);
  const paint = () => {
    const layout = renderLayoutFrame(root, h.terminal.columns, h.terminal.rows, () => {});
    h.internals.currentLayout = layout;
    return h.internals.compositeOverlays(layout.lines, h.terminal.columns, h.terminal.rows);
  };
  await h.emit("session_start");
  expect(Object.getOwnPropertySymbols(h.renderer)).toEqual(h.symbols); // receiver probe removed
  expect(Object.hasOwn(h.renderer, "hasOverlay")).toBe(true);
  expect((h.renderer.hasOverlay as typeof h.renderer.hasOverlay & { [WRAPPER_TAG]?: string })[WRAPPER_TAG]).toBe(OWNER);
  expect(h.reference.hasOverlay()).toBe(false);
  paint();
  scroll.scrollTo(message.render(h.terminal.columns).length);
  expect(paint()[0]).toContain("the real SDK prompt");
  expect(h.internals.overlayStack).toHaveLength(1);
  expect(h.internals.overlayStack[0]!.component).toBeInstanceOf(PinBar);
  const jump = vi.spyOn(scroll, "scrollTo");
  // The SDK synthesizes a click on release after our handled press, using local bounds.
  h.internals.handleMouseEvent({ button: 0, x: 1, y: 0, release: false });
  expect(jump).not.toHaveBeenCalled();
  h.internals.handleMouseEvent({ button: 0, x: 1, y: 0, release: true });
  expect(jump).toHaveBeenCalledWith(0, { disableFollow: true });
  expect(scroll.isFollowingEnd).toBe(false);
  scroll.scrollTo(10);
  paint();
  jump.mockClear();
  h.internals.handleMouseEvent({ button: 0, x: 1, y: 0, release: false });
  h.internals.handleMouseEvent({ button: 32, x: 2, y: 0, release: false });
  h.internals.handleMouseEvent({ button: 0, x: 2, y: 0, release: true });
  expect(jump).not.toHaveBeenCalled(); // a drag is not synthesized into a click
  const other = h.renderer.showOverlay({ render: () => ["dialog"], invalidate() {} });
  expect(h.reference.hasOverlay()).toBe(true);
  other.hide();
  await h.emit("session_shutdown");
  expect(Object.hasOwn(h.renderer, "hasOverlay")).toBe(false);
  expect(h.widgets.size).toBe(0);
  expect(h.internals.overlayStack).toEqual([]);
  expect(h.terminal.writes).toEqual([]);
  h.render.mockRestore();
});

test("SDK proxy teardown leaves a later wrapper and its chain alive", async () => {
  const h = setup();
  await h.emit("session_start");
  const own = h.renderer.hasOverlay;
  const later = () => own.call(h.renderer);
  h.renderer.hasOverlay = later;
  await h.emit("session_shutdown");
  expect(h.renderer.hasOverlay).toBe(later);
  expect((own as typeof own & { [WRAPPER_TAG]?: string })[WRAPPER_TAG]).toBeUndefined();
  const other = h.renderer.showOverlay({ render: () => ["new owner"], invalidate() {} });
  expect(h.reference.hasOverlay()).toBe(true);
  other.hide();
  expect(h.reference.hasOverlay()).toBe(false);
  // Reload can safely chain the surviving unknown wrapper, whose inner owner is dead.
  await h.emit("session_start");
  expect(h.notes).toEqual([]);
  expect(h.internals.overlayStack).toHaveLength(1);
  expect(h.reference.hasOverlay()).toBe(false);
  await h.emit("session_shutdown");
  expect(h.renderer.hasOverlay).toBe(later);
  h.render.mockRestore();
});

test("SDK first layout, nested clear, and resize use live ScrollView rows", async () => {
  const h = setup();
  const { chat, document, scroll, root } = transcript(h.renderer);
  await h.emit("session_start");
  const pin = h.internals.overlayStack[0]!.component;
  // Before currentLayout exists the SDK returns its implicit scroll view; scan the mounted one.
  renderLayoutFrame(root, 40, 5, () => {});
  scroll.scrollTo(10);
  expect(pin.render(40)[0]).toContain("the real SDK prompt");
  const marker = { render: () => [CLEAR_SENTINEL], invalidate() {} };
  chat.addChild(marker);
  const original = document.render.bind(document);
  document.render = (width) => original(width).filter((line) => line !== CLEAR_SENTINEL).concat(["", "", "", "", ""]);
  renderLayoutFrame(root, 40, 5, () => {});
  scroll.scrollToEnd();
  expect(pin.render(40)).toEqual([]);
  scroll.scrollTo(10);
  expect(pin.render(40)[0]).toContain("the real SDK prompt");
  h.terminal.columns = 5;
  renderLayoutFrame(root, 5, 5, () => {});
  scroll.scrollTo(1);
  expect(pin.render(5)).toEqual([]); // wrapped prompt now straddles the edge
  await h.emit("session_shutdown");
  h.render.mockRestore();
});

test("a stable reference retargeted before shutdown cannot make cleanup touch the new renderer", async () => {
  const h = setup();
  await h.emit("session_start");
  const newer = new TuiAltScreen(new MemoryTerminal());
  const newerRender = vi.spyOn(newer, "requestRender").mockImplementation(() => {});
  const foreign = () => true;
  newer.hasOverlay = foreign;
  h.switchRenderer(newer);
  await h.emit("session_shutdown");
  expect(Object.hasOwn(h.renderer, "hasOverlay")).toBe(false);
  expect(h.internals.overlayStack).toEqual([]);
  expect(newer.hasOverlay).toBe(foreign);
  expect(h.reference.hasOverlay()).toBe(true);
  h.render.mockRestore();
  newerRender.mockRestore();
});
