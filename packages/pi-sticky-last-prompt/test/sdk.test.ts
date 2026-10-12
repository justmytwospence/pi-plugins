import { Container, ScrollView, TuiAltScreen, VStack, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import { initTheme, UserMessageComponent, type ExtensionAPI, type ExtensionContext, type SessionStartEvent, type SessionShutdownEvent, type Theme } from "@earendil-works/pi-coding-agent";
import { expect, test, vi } from "vitest";
// Test the actual pinned SDK proxy, not an approximation with extra reflection traps.
import { createInteractiveTuiReference } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import stickyLastPrompt, { CLEAR_SENTINEL, OWNER, PinBar, WRAPPER_TAG } from "../src/index.ts";

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
  const other = h.renderer.showOverlay({ render: () => ["new owner"], invalidate() {} });
  expect(h.reference.hasOverlay()).toBe(true);
  other.hide();
  expect(h.reference.hasOverlay()).toBe(false);
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
