import { Container, HStack, ScrollView, TuiAltScreen, VStack, visibleWidth, type Terminal, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "../node_modules/@earendil-works/pi-tui/dist/layout.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createInteractiveSection, createSplashActionController } from "../src/feature/shell/startup-interactions.ts";
import { layoutSection, type ResourceSection, type SplashAction, type StartupTheme } from "../src/feature/shell/startup-resources.ts";
import { attachStartupHost, disposeStartupHost } from "../src/feature/shell/startup-state.ts";

const theme: StartupTheme = { fg: (_color, text) => text, bold: (text) => text };
const mcp = (name: string): SplashAction => ({ kind: "mcp", name });
const model = (id: string, thinkingLevel?: string): SplashAction => ({ kind: "model", provider: "test", id, ...(thinkingLevel ? { thinkingLevel } : {}) });
const section: ResourceSection = {
  title: "Models", count: 5, layout: "columns", groups: [
    { label: "test", items: ["wide 界", "αβ", "long-model-name", "four"],
      actions: [model("wide"), model("alpha"), model("long"), model("four")],
      right: ["200K", "1M", "922K", "128K"] },
    { label: "mcp", items: ["démo"], actions: [mcp("canonical-name")], right: ["connected"] },
  ],
};
function mouse(x: number, y: number, width: number, type: TuiMouseEvent["type"] = "click", extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return { type, button: "left", x, y, screenX: x, screenY: y, width, height: 50, shift: false, alt: false, ctrl: false, ...extra };
}
const hitsAt = (width: number) => layoutSection(section, width, theme).hits;

describe("interactive startup sections", () => {
  test("uses the exact rendered half-open cells, not labels; blank, heading and metadata gaps are inert", () => {
    const actions = vi.fn();
    const component = createInteractiveSection(() => section, () => theme, actions);
    const width = 120;
    const lines = component.render(width);
    const hits = hitsAt(width);
    expect(hits).toHaveLength(10);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    for (const hit of hits) {
      expect(component.handleMouse?.(mouse(hit.startCol, hit.row, width))).toEqual({ handled: true, render: false });
      expect(actions).toHaveBeenLastCalledWith(hit.action);
      expect(component.handleMouse?.(mouse(hit.endCol - 1, hit.row, width))).toEqual({ handled: true, render: false });
      if (!hits.some((other) => other.row === hit.row && other.startCol === hit.endCol)) {
        expect(component.handleMouse?.(mouse(hit.endCol, hit.row, width))).toBeUndefined();
      }
    }
    for (let index = 0; index + 1 < hits.length; index++) {
      const first = hits[index]!, second = hits[index + 1]!;
      if (first.row === second.row && first.action === second.action && second.startCol > first.endCol) {
        expect(component.handleMouse?.(mouse(first.endCol, first.row, width))).toBeUndefined();
      }
    }
    expect(component.handleMouse?.(mouse(0, 0, width))).toBeUndefined();
    expect(component.handleMouse?.(mouse(0, hits[0]!.row, width))).toBeUndefined();
    expect(component.handleMouse?.(mouse(119, hits[0]!.row, width))).toBeUndefined();
    expect(actions).toHaveBeenCalledWith(mcp("canonical-name"));
    component.dispose();
    expect(component.handleMouse?.(mouse(hits[0]!.startCol, hits[0]!.row, width))).toBeUndefined();
    expect(component.render(width)).toEqual([]);
  });

  test("Container dispatch applies vertical offsets and preserves drag, wheel, modified clicks and editor focus", () => {
    const actions = vi.fn();
    const component = createInteractiveSection(() => section, () => theme, actions);
    const editor = { focused: true, text: "unsent draft" };
    const container = new Container();
    container.addChild({ render: () => ["above", "above"], invalidate() {} });
    container.addChild(component);
    container.addChild({ render: () => [editor.text], invalidate() {} });
    const width = 90;
    container.render(width);
    const hit = hitsAt(width)[0]!;
    const event = mouse(hit.startCol, hit.row + 2, width);
    expect(container.handleMouse(event)?.handled).toBe(true);
    expect(actions).toHaveBeenCalledWith(hit.action);
    for (const modified of [{ shift: true }, { alt: true }, { ctrl: true }, { clickCount: 2 }, { button: "right" as const }]) {
      expect(container.handleMouse({ ...event, ...modified })).toBeUndefined();
    }
    for (const type of ["press", "release", "drag", "move", "wheel"] as const) {
      expect(container.handleMouse({ ...event, type })).toBeUndefined();
    }
    expect(actions).toHaveBeenCalledTimes(1);
    expect(editor).toEqual({ focused: true, text: "unsent draft" });
  });

  test("the fullscreen viewport routes a scrolled section alongside Sidebar, leaving selection and overlays in charge", () => {
    const terminal = {
      columns: 120, rows: 14, kittyProtocolActive: false,
      start() { throw new Error("No real terminal in tests"); }, stop() {}, async drainInput() {},
      write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
    } as Terminal;
    const renderer = new TuiAltScreen(terminal);
    vi.spyOn(renderer, "requestRender").mockImplementation(() => {});
    const actions = vi.fn();
    const component = createInteractiveSection(() => section, () => theme, actions);
    const document = new Container();
    document.addChild({ render: () => ["pad", "pad"], invalidate() {} });
    document.addChild(component);
    document.addChild({ render: () => Array(20).fill("history"), invalidate() {} });
    const scroll = new ScrollView(document, { primary: true, follow: "none", scrollbar: "hidden" });
    const editor = { focused: true, text: "unsent", render: () => ["unsent"], invalidate() {} };
    const main = new VStack([{ component: scroll, basis: 0, grow: 1 }, { component: editor }]);
    const sidebar = { render: () => ["Sidebar"], invalidate() {} };
    const root = new HStack([{ component: main, basis: 0, grow: 1 }, { component: sidebar, basis: 25 }]);
    renderer.setLayoutRoot(root);
    const internals = renderer as unknown as {
      currentLayout: ReturnType<typeof renderLayoutFrame>;
      compositeOverlays(lines: string[], width: number, height: number): string[];
      handleMouseEvent(raw: { button: number; x: number; y: number; release: boolean }): void;
    };
    internals.currentLayout = renderLayoutFrame(root, terminal.columns, terminal.rows, () => {});
    scroll.scrollTo(2);
    internals.currentLayout = renderLayoutFrame(root, terminal.columns, terminal.rows, () => {});
    const width = terminal.columns - 25;
    const hit = hitsAt(width)[0]!;
    const click = (x: number, y: number) => {
      internals.handleMouseEvent({ button: 0, x, y, release: false });
      internals.handleMouseEvent({ button: 0, x, y, release: true });
    };
    click(hit.startCol, hit.row);
    expect(actions).toHaveBeenCalledWith(hit.action);
    // Sidebar and a gap beside the action cannot open another model.
    click(119, hit.row);
    click(0, hit.row);
    expect(actions).toHaveBeenCalledTimes(1);
    // A press followed by motion remains a text-selection drag, not a click.
    internals.handleMouseEvent({ button: 0, x: hit.startCol, y: hit.row, release: false });
    internals.handleMouseEvent({ button: 32, x: hit.startCol + 3, y: hit.row, release: false });
    internals.handleMouseEvent({ button: 0, x: hit.startCol + 3, y: hit.row, release: true });
    expect(actions).toHaveBeenCalledTimes(1);
    expect(editor).toMatchObject({ focused: true, text: "unsent" });
    const overlay = renderer.showOverlay({ render: (width: number) => Array(terminal.rows).fill("dialog".padEnd(width)), invalidate() {} }, { anchor: "top-left", width: "100%" });
    internals.compositeOverlays(internals.currentLayout.lines, terminal.columns, terminal.rows);
    click(hit.startCol, hit.row);
    expect(actions).toHaveBeenCalledTimes(1);
    overlay.hide();
    renderer.resetTextSelection();
    component.dispose();
  });

  test("resize and invalidate discard old hit maps; Unicode and clipping remain tied to the new layout", () => {
    const actions = vi.fn();
    let current: ResourceSection | undefined = section;
    let activeTheme = theme;
    const component = createInteractiveSection(() => current, () => activeTheme, actions);
    component.render(120);
    const old = hitsAt(120);
    component.render(23);
    const narrow = hitsAt(23);
    expect(narrow).toHaveLength(10);
    expect(component.handleMouse?.(mouse(old[0]!.startCol, old[0]!.row, 120))).toBeUndefined();
    const wide = narrow.find((hit) => hit.action.kind === "model" && hit.action.id === "wide")!;
    expect(component.handleMouse?.(mouse(wide.startCol, wide.row, 23))?.handled).toBe(true);
    expect(actions).toHaveBeenLastCalledWith(model("wide"));
    component.invalidate();
    expect(component.handleMouse?.(mouse(wide.startCol, wide.row, 23))).toBeUndefined();
    activeTheme = { fg: (_color, text) => `\x1b[32m${text}\x1b[0m`, bold: (text) => text };
    component.render(23);
    expect(component.handleMouse?.(mouse(wide.startCol, wide.row, 23))?.handled).toBe(true);
    current = undefined;
    expect(component.render(23)).toEqual([]);
    expect(component.handleMouse?.(mouse(wide.startCol, wide.row, 23))).toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const modes: object[] = [];
afterEach(() => { for (const mode of modes.splice(0)) disposeStartupHost(mode); });
function fixture() {
  let sessionId = "first";
  const command = { sourceInfo: { path: "builtin:mcp" }, handler: vi.fn(async () => {}) };
  const ctx = {
    mode: "tui", isIdle: vi.fn(() => true), model: { provider: "test", id: "old" },
    modelRegistry: { find: vi.fn((provider: string, id: string) => ({ provider, id })) },
    ui: { notify: vi.fn(), getEditorText: vi.fn(() => "unsent draft") },
  };
  const runner = { createContext: vi.fn(() => ctx), createCommandContext: vi.fn(() => ({ mode: "tui", ui: ctx.ui })), getCommand: vi.fn(() => command) };
  const mode = {
    sessionManager: { getSessionId: () => sessionId }, session: { extensionRunner: runner },
    ui: { requestRender: vi.fn() }, footer: { invalidate: vi.fn() },
    updateEditorBorderColor: vi.fn(), updateAvailableProviderCount: vi.fn(), showStatus: vi.fn(),
    maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
  };
  modes.push(mode);
  const host = attachStartupHost(mode);
  host.refresh = vi.fn(); host.repaint = vi.fn();
  const pi = { setModel: vi.fn(async () => true), setThinkingLevel: vi.fn(), getThinkingLevel: vi.fn(() => "medium") };
  const controller = createSplashActionController(pi as any, mode, host);
  return { pi, ctx, runner, mode, host, command, controller, changeSession: () => { sessionId = "next"; attachStartupHost(mode); } };
}

describe("session-only splash action controller", () => {
  test("model resolution at click time, thinking suffix after selection, native footer/border refresh, no draft changes", async () => {
    const { controller, ctx, pi, mode, host } = fixture();
    await controller.activate(model("new", "high"));
    expect(ctx.modelRegistry.find).toHaveBeenCalledWith("test", "new");
    expect(pi.setModel).toHaveBeenCalledWith({ provider: "test", id: "new" });
    expect(pi.setThinkingLevel).toHaveBeenCalledAfter(pi.setModel);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(mode.footer.invalidate).toHaveBeenCalled();
    expect(mode.updateEditorBorderColor).toHaveBeenCalled();
    expect(mode.maybeWarnAboutAnthropicSubscriptionAuth).toHaveBeenCalled();
    expect(host.refresh).toHaveBeenCalled();
    expect(ctx.ui.getEditorText()).toBe("unsent draft");
    expect(host.actionBusy).toBe(false);
  });

  test("already selected model is a no-op except for a different explicit thinking suffix", async () => {
    const { controller, pi } = fixture();
    await controller.activate(model("old"));
    await controller.activate(model("old", "medium"));
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    await controller.activate(model("old", "high"));
    expect(pi.setModel).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
  });

  test("missing model, missing auth and rejection notify without applying a thinking suffix", async () => {
    const { controller, ctx, pi } = fixture();
    ctx.modelRegistry.find.mockReturnValueOnce(undefined as any);
    await controller.activate(model("gone", "high"));
    expect(ctx.ui.notify).toHaveBeenCalledWith("Model unavailable: test/gone.", "error");
    pi.setModel.mockResolvedValueOnce(false);
    await controller.activate(model("no-auth", "high"));
    expect(ctx.ui.notify).toHaveBeenCalledWith("Model authentication unavailable: test/no-auth.", "error");
    pi.setModel.mockRejectedValueOnce(new Error("credentials expired"));
    await expect(controller.activate(model("failure", "high"))).resolves.toBeUndefined();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Unable to switch model test/failure: credentials expired", "error");
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
  });

  test("busy turn and pending actions reject or ignore duplicates; session replacements/disposal discard late completions", async () => {
    const { controller, ctx, pi, host, changeSession } = fixture();
    ctx.isIdle.mockReturnValueOnce(false);
    await controller.activate(model("new"));
    expect(ctx.ui.notify).toHaveBeenCalledWith("Wait for the current turn before switching models.", "warning");
    const pending = deferred<boolean>();
    pi.setModel.mockReturnValueOnce(pending.promise);
    const first = controller.activate(model("new"));
    await controller.activate(model("other"));
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    changeSession();
    pending.resolve(true);
    await first;
    expect(host.refresh).not.toHaveBeenCalled();
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    await controller.activate(model("other"));
    expect(pi.setModel).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  test("only the native MCP command opens, with fresh TUI command context and canonical name", async () => {
    const { controller, ctx, runner, command, host } = fixture();
    const fresh = runner.createCommandContext();
    await controller.activate(mcp("server-name"));
    expect(runner.getCommand).toHaveBeenCalledWith("mcp");
    expect(command.handler).toHaveBeenCalledWith("", fresh);
    expect(ctx.ui.notify).toHaveBeenCalledWith("MCP controls: server-name", "info");
    expect(host.refresh).toHaveBeenCalled();
    command.sourceInfo.path = "extension:spoofed";
    await controller.activate(mcp("server-name"));
    expect(command.handler).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("MCP controls unavailable; use /mcp.", "warning");
  });

  test("MCP manager stays busy until close, never writes files; streaming and unavailable contexts do not open", async () => {
    const { controller, command, ctx, host, runner, mode } = fixture();
    ctx.isIdle.mockReturnValueOnce(false);
    await controller.activate(mcp("server"));
    expect(ctx.ui.notify).toHaveBeenCalledWith("Wait for the current turn before opening MCP controls.", "warning");
    const pending = deferred<void>();
    command.handler.mockReturnValueOnce(pending.promise);
    const opened = controller.activate(mcp("server"));
    expect(host.actionBusy).toBe(true);
    await controller.activate(mcp("server"));
    expect(command.handler).toHaveBeenCalledTimes(1);
    pending.resolve();
    await opened;
    expect(host.actionBusy).toBe(false);
    expect(host.refresh).toHaveBeenCalled();
    runner.getCommand.mockReturnValueOnce(undefined as any);
    await controller.activate(mcp("server"));
    expect(command.handler).toHaveBeenCalledTimes(1);
    expect(mode).not.toHaveProperty("settingsManager.setDefaultModelAndProvider");
  });
});
