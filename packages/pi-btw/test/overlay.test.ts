import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { expect, test, vi } from "vitest";
import { EDITOR_MODE, EDITOR_SURFACE, INPUT_CONTEXT, requestEditorFactory, type EditorFactoryOptions, type EditorModeContext, type SuiteEditor } from "../src/contract.ts";
import { BtwOverlayComponent, type BtwOverlayOptions } from "../src/overlay.ts";
import { fakeTui, keybindings, theme } from "./harness.ts";

function overlay(overrides: Partial<BtwOverlayOptions> = {}) {
  const options: BtwOverlayOptions = {
    tui: fakeTui(), theme, keybindings,
    readTranscriptEntries: () => Array.from({ length: 60 }, (_, id) => ({ id, turnId: 1, type: "assistant-text" as const, text: `line ${id}`, streaming: false })),
    getStatus: () => null, getMode: () => "contextual", getWidthMode: () => "window", focusShortcutsLabel: "Alt+/",
    onSubmit: vi.fn(), onDismiss: vi.fn(), onUnfocus: vi.fn(), onToggleWidth: vi.fn(), ...overrides,
  };
  const view = new BtwOverlayComponent(options); view.focused = true; view.render(80);
  return { view, options };
}
function provider() {
  let options!: EditorFactoryOptions;
  let text = "draft";
  let mode: EditorModeContext = { state: "insert", mode: "insert", pending: "", ex: null, autocomplete: false };
  const editor: SuiteEditor = {
    focused: false, getText: () => text, setText: (value) => { text = value; },
    handleInput: vi.fn((data) => {
      // Synthetic structural provider: BTW itself must not intercept these keys.
      if (mode.state === "normal" && !mode.autocomplete && (data === "\x15" || data === "\x04")) options.scrollViewport?.(data === "\x15" ? -1 : 1);
    }),
    render: vi.fn(() => [text]), invalidate: vi.fn(), dispose: vi.fn(),
    [EDITOR_SURFACE]: "embedded", [EDITOR_MODE]: () => mode,
  };
  return { editor, factory: vi.fn((value: EditorFactoryOptions) => { options = value; text = value.initialText ?? text; return editor; }),
    setMode: (value: EditorModeContext) => { mode = value; }, options: () => options };
}
const summary = (view: BtwOverlayComponent) => view.render(80)[2];

test("factory discovery is synchronous/versioned and optional; throws or non-function answers fall back", () => {
  const p = provider();
  expect(requestEditorFactory(undefined)).toBeUndefined();
  expect(requestEditorFactory({ emit: () => {} })).toBeUndefined();
  expect(requestEditorFactory({ emit: () => { throw new Error("missing"); } })).toBeUndefined();
  const request = requestEditorFactory({ emit: (channel, data) => {
    expect(channel).toBe("pi-plugins.editor-factory.v1");
    expect(data).toEqual({ version: 1 });
    Object.assign(data!, { factory: p.factory, provider: "synthetic" });
  } });
  expect(request?.factory).toBe(p.factory); expect(request?.provider).toBe("synthetic");
  const warn = vi.fn();
  const { view } = overlay({ editorFactory: () => { throw new Error("broken"); }, notify: warn });
  expect(view.composer.kind).toBe("native"); expect(warn).toHaveBeenCalledTimes(1);
});

test("native Ctrl+U/D only scroll an empty, focused composer; typed Ctrl+U reaches Input", () => {
  const { view } = overlay();
  const bottom = summary(view);
  view.handleInput("\x15"); expect(summary(view)).not.toBe(bottom);
  view.handleInput("\x04"); expect(summary(view)).toBe(bottom);
  view.setDraft("typed text"); view.handleInput("\x05"); // move Input's cursor to the end
  view.handleInput("\x15"); expect(view.getDraft()).toBe(""); expect(summary(view)).toBe(bottom);
  view.focused = false;
  view.handleInput("\x15"); view.handleInput("x"); expect(view.getDraft()).toBe(""); expect(summary(view)).toBe(bottom);
});

test("native submit/cancel/clear, focus and width shortcuts stay owned by the overlay", () => {
  const { view, options } = overlay();
  view.setDraft("q"); view.handleInput("\r"); expect(options.onSubmit).toHaveBeenCalledWith("q");
  view.handleInput("\x03"); expect(view.getDraft()).toBe("");
  view.handleInput("\x03"); view.handleInput("\x1b"); expect(options.onDismiss).toHaveBeenCalledTimes(2);
  view.handleInput("\x1b/"); expect(options.onUnfocus).toHaveBeenCalledTimes(1);
  view.handleInput("\x1bw"); expect(options.onToggleWidth).toHaveBeenCalledTimes(1);
});

test("suite editors receive the exact embedded callbacks and own all modal text/selection/autocomplete keys", () => {
  const p = provider();
  const { view, options } = overlay({ editorFactory: p.factory, editorProvider: "synthetic", initialDraft: "initial" });
  expect(p.options()).toMatchObject({ surface: "embedded", initialText: "initial", initialMode: "insert", paddingX: 0, keybindings });
  expect(p.editor.focused).toBe(true); view.focused = false; expect(p.editor.focused).toBe(false); view.focused = true;
  expect(view[INPUT_CONTEXT]()).toBe("editor"); expect(view[EDITOR_SURFACE]).toBe("embedded");
  for (const state of ["insert", "visual", "ex", "pending", "normal"] as const) {
    const mode: EditorModeContext = { state, mode: state === "insert" ? "insert" : state === "visual" ? "visual" : "normal", pending: state === "pending" ? "2d" : "", ex: state === "ex" ? "w" : null, autocomplete: true };
    p.setMode(mode); expect(view[EDITOR_MODE]()).toEqual(mode);
    const before = summary(view);
    for (const key of ["\x15", "\x04", "\x03", "\x1b", "\x1b[A", "\x1b[B", "\t", "\r", "d", "u"]) view.handleInput(key);
    expect(summary(view)).toBe(before);
  }
  expect(p.editor.handleInput).toHaveBeenCalledTimes(50);
  expect(options.onDismiss).not.toHaveBeenCalled(); expect(view.getDraft()).toBe("initial");
  p.setMode({ state: "normal", mode: "normal", pending: "", ex: null, autocomplete: false });
  const bottom = summary(view); view.handleInput("\x15"); expect(summary(view)).not.toBe(bottom);
  p.options().onSubmit?.("submitted"); expect(options.onSubmit).toHaveBeenCalledWith("submitted");
  p.options().onCancel?.(); expect(options.onDismiss).toHaveBeenCalledTimes(1);
  view.dispose(); view.dispose(); expect(p.editor.dispose).toHaveBeenCalledTimes(1);
});

test("narrow/wide/unicode rendering preserves cursor markers and fits every supplied width", () => {
  const { view } = overlay(); view.setDraft("界 é long draft");
  for (const width of [0, 1, 2, 5, 24, 80, 120]) {
    const lines = view.render(width);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    if (width >= 24) expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
  }
  view.focused = false; expect(view.render(80).join("\n")).not.toContain(CURSOR_MARKER);
});

test("multiline composers are bounded without losing the focused cursor row", () => {
  const p = provider(); p.editor.render = () => Array.from({ length: 50 }, (_, i) => `${i === 40 ? CURSOR_MARKER : ""}editor ${i}`);
  const { view } = overlay({ editorFactory: p.factory });
  const lines = view.render(80);
  expect(lines.length).toBeLessThanOrEqual(23); // floor(30 terminal rows * 0.78)
  expect(lines.join("\n")).toContain(`${CURSOR_MARKER}editor 40`);
});

test("short-terminal Pi height clipping never hides native or suite composer cursors", () => {
  for (const rows of [2, 3, 4, 6, 8, 10, 12, 16, 18, 20]) {
    const piHeight = Math.max(1, Math.min(Math.floor(rows * 0.78), rows - 1));
    for (const widthMode of ["window", "full"] as const) {
      for (const suite of [false, true]) {
        const p = provider();
        p.editor.render = () => Array.from({ length: 50 }, (_, i) => `${i === 40 ? CURSOR_MARKER : ""}editor ${i}`);
        const { view } = overlay({ tui: fakeTui("fullscreen", rows), getWidthMode: () => widthMode, initialDraft: "native draft", editorFactory: suite ? p.factory : undefined });
        const lines = view.render(60);
        expect(lines.length, `${rows} rows, ${widthMode}, suite=${suite}`).toBeLessThanOrEqual(piHeight);
        // Pi clips from the bottom; exercise that exact behavior, not only line widths.
        const visible = lines.slice(0, piHeight).join("\n");
        expect(visible).toContain(CURSOR_MARKER);
        if (suite) expect(visible).toContain("editor 40");
        else expect(stripVTControlCharacters(visible)).toContain("native draft");
        view.dispose();
      }
    }
  }
});

test("fullscreen normalized wheel scrolls locally; regular mode reporting is disposed exactly once", () => {
  const full = overlay();
  const before = summary(full.view);
  expect(full.view.handleMouse({ type: "wheel", wheelDelta: -3 } as TuiMouseEvent)).toMatchObject({ handled: true });
  expect(summary(full.view)).not.toBe(before);
  expect(full.options.tui.terminal.write).not.toHaveBeenCalled();
  expect(full.view.handleMouse({ type: "press" } as TuiMouseEvent)).toBeUndefined();
  const regular = overlay({ tui: fakeTui("regular") });
  expect(regular.options.tui.terminal.write).toHaveBeenCalledTimes(1);
  regular.view.dispose(); regular.view.dispose(); expect(regular.options.tui.terminal.write).toHaveBeenCalledTimes(2);
});

test("invalidate rebuilds cached transcript with the current theme and invalidates the editor", () => {
  const p = provider(); let current = theme;
  const { view } = overlay({ editorFactory: p.factory, getTheme: () => current });
  const old = view.render(80).join("\n");
  current = Object.assign(Object.create(theme) as typeof theme, { fg: (_token: string, text: string) => `new:${text}` });
  view.invalidate(); expect(p.editor.invalidate).toHaveBeenCalledTimes(1);
  expect(view.render(80).join("\n")).not.toBe(old);
  expect(p.options().theme.borderColor("test")).toBe("new:test");
});
