import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, test, vi } from "vitest";

// Keep SDK class identities consistent, including imports inside the actual Sidebar/Vim sources.
// PI_TEST_SDK_ROOT also exercises the installed SDK without changing package dependencies.
const sdk = process.env.PI_TEST_SDK_ROOT ?? fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent", import.meta.url));
const requireSdk = createRequire(path.join(sdk, "package.json"));
const tuiPath = requireSdk.resolve("@earendil-works/pi-tui");
const sdkPath = path.join(sdk, "dist/index.js");
const { createJiti } = await import(pathToFileURL(path.join(sdk, "dist/core/extensions/jiti-loader.js")));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-tui": tuiPath, "@earendil-works/pi-coding-agent": sdkPath,
} });
const { createFooterComponent, createFooterActionController } = await jiti.import(fileURLToPath(new URL("../src/interactions.ts", import.meta.url)));
const footerModule = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const { MainEditor } = await jiti.import(fileURLToPath(new URL("../../pi-vim/src/main-editor.ts", import.meta.url)));
const { SplitRoot } = await jiti.import(fileURLToPath(new URL("../../pi-sidebar/src/layout.ts", import.meta.url)));
const { Container, ScrollView, VStack, TuiAltScreen, TuiMainScreen, visibleWidth, getKeybindings, setKeybindings } = await import(pathToFileURL(tuiPath));
const { CustomEditor } = await import(pathToFileURL(sdkPath));
const { KeybindingsManager } = await import(pathToFileURL(path.join(sdk, "dist/core/keybindings.js")));
const { ModelSelectorComponent } = await import(pathToFileURL(path.join(sdk, "dist/modes/interactive/components/model-selector.js")));
const { initTheme, getEditorTheme } = await import(pathToFileURL(path.join(sdk, "dist/modes/interactive/theme/theme.js")));

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
const leaf = (...lines) => ({ render: () => lines, invalidate() {} });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const mouse = (x, y, width, extra = {}) => ({ type: "click", button: "left", x, y, screenX: x, screenY: y,
  width, height: 2, shift: false, alt: false, ctrl: false, ...extra });

// A deterministic, ANSI/wide/combining-cell layout isolates the controller contract from
// index.ts's fitting policy (covered by footer.test.mjs). No post-render string hit parsing.
function layout(width) {
  if (width < 20) return { lines: ["model…"], hits: [] };
  const value = "  ◇ \x1b[1m界é\x1b[22m · high";
  const hint = "alt+p";
  return {
    lines: [value + " · " + hint, "  Cache cold"],
    hits: [
      { row: 0, startCol: 4, endCol: 7, action: "model.open" },
      { row: 0, startCol: 10, endCol: 14, action: "reasoning.cycle" },
      { row: 0, startCol: visibleWidth(value) + 3, endCol: visibleWidth(value) + 3 + hint.length, action: "model.open" },
      { row: 1, startCol: 2, endCol: 12, action: "cache.status" },
    ],
  };
}

class MemoryTerminal {
  constructor(columns = 120) { this.columns = columns; this.rows = 60; this.kittyProtocolActive = false; this.writes = []; }
  start(input, resize) { this.input = input; this.onResize = resize; }
  stop() { this.input = undefined; }
  async drainInput() {}
  write(data) { this.writes.push(data); }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
  send(...keys) { assert.ok(this.input); for (const key of keys) this.input(key); }
  pointer(button, x, y, release = false) { this.send(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`); }
  click(x, y, button = 0) { this.pointer(button, x, y); this.pointer(button, x, y, true); }
}

function fixture({ width = 120, sidebar = false, vim = false, regular = false, bindings = {} } = {}) {
  initTheme("dark", false);
  const previousKb = getKeybindings();
  const kb = new KeybindingsManager({ "app.model.select": "alt+p", ...bindings });
  setKeybindings(kb);
  const terminal = new MemoryTerminal(width);
  const tui = regular ? new TuiMainScreen(terminal, false) : new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
  const editor = vim ? new MainEditor(tui, getEditorTheme(), kb) : new CustomEditor(tui, getEditorTheme(), kb);
  if (vim) editor.setClipboardMirrorPolicy("never");
  editor.setText("unsent 界 draft\nsecond line");
  const state = { generation: 1, active: true, blocked: 0, promptDepth: 0, idle: true, linked: false, editor, tui, actions: {} };
  const calls = [];
  const cancellations = [];
  const scopes = [];
  const reasoningTriggers = [];
  const captureCycleTrigger = vi.fn(() => state.keyTrigger);
  const withCycleTrigger = (trigger, run) => {
    const previous = state.cycleTrigger;
    state.cycleTrigger = trigger;
    scopes.push(trigger);
    try { return run(); } finally { state.cycleTrigger = previous; }
  };
  const notify = vi.fn();
  const refresh = vi.fn();
  const controller = createFooterActionController({
    getEditor: () => state.editor, getTui: () => state.tui, getGeneration: () => state.generation,
    isCurrent: () => state.active, getBlocked: () => state.blocked, getPromptDepth: () => state.promptDepth,
    isIdle: () => state.idle, isLinked: () => state.linked, getActions: () => state.actions, notify, refresh,
    cycleReasoning: () => { calls.push("native.reasoning"); reasoningTriggers.push(state.cycleTrigger); },
    captureCycleTrigger, withCycleTrigger,
    cancelSettings: reason => { cancellations.push(reason); },
  });
  const originalInput = editor.handleInput;
  const release = controller.wrapEditor(editor, tui);
  const dock = new Container();
  dock.addChild(editor);
  let selector;
  const physical = { provider: "test", id: "physical", name: "Physical", contextWindow: 200000, reasoning: true };
  const modelRuntime = {
    getAvailableSnapshot: () => [physical], getModel: () => physical, getError: () => undefined,
    refresh: async () => ({ errors: new Map(), aborted: false }),
  };
  function closeSelector() { selector?.dispose(); selector = undefined; dock.clear(); dock.addChild(editor); tui.setFocus(editor); tui.requestRender(); }
  const native = () => {
    calls.push("native.model");
    selector = new ModelSelectorComponent(tui, physical, modelRuntime, [], () => { calls.push("selected"); closeSelector(); }, closeSelector);
    dock.clear(); dock.addChild(selector); tui.setFocus(selector); tui.requestRender();
  };
  // Deliberately after wrapping: InteractiveMode installs/copies action handlers after factory creation.
  editor.actionHandlers.set("app.model.select", native);
  editor.actionHandlers.set("app.thinking.cycle", () => { calls.push("native.reasoning.immediate"); });
  state.actions = {
    "flow.open": { label: "Flow", run() { calls.push("flow"); } },
    "cache.status": { label: "Cache", run() { calls.push("cache"); } },
    "execution.status": { label: "Execution", run() { calls.push("execution"); } },
    "effort.toggle": { label: "Effort", active: false, run() { calls.push("effort"); } },
    "approvals.open": { label: "Approvals", run() { calls.push("approvals"); } },
    "context.open": { label: "Context", run() { calls.push("context"); } },
    "context.skills": { label: "Skills", run() { calls.push("skills"); } },
    "mcp.open": { label: "MCP", run() { calls.push("mcp"); } },
    "workflow.open": { label: "Workflow", run() { calls.push("workflow picker"); } },
    "workflow.cycle": { label: "Workflow", run() { calls.push("workflow cycle"); } },
  };
  let lastWidth;
  const component = createFooterComponent((w) => { lastWidth = w; return layout(w); },
    () => `${state.generation}:${terminal.columns}:${terminal.rows}`, controller.available, controller.activate);
  const footer = new Container();
  footer.addChild(leaf("activity", ""));
  footer.addChild(component);
  const document = new Container();
  document.addChild({ render: () => Array.from({ length: 100 }, (_, i) => `transcript ${i}: selection text`), invalidate() {} });
  const scroll = new ScrollView(document, { primary: true, follow: "end", scrollbar: "hidden" });
  const main = new VStack([{ component: scroll, basis: 0, grow: 1 }, { component: dock }, { component: footer }]);
  const side = leaf("Sidebar read-only");
  const splitState = { collapsed: false };
  const root = sidebar ? new SplitRoot(main, side, {
    ratio: () => 0.5, minColumns: 80, collapsed: () => splitState.collapsed, focused: () => false,
    divider: (orientation, _focused, w) => orientation === "right" ? Array(120).fill("│") : ["─".repeat(w)],
  }, () => tui.requestRender()) : main;
  tui.addChild(document); tui.addChild(dock); tui.addChild(footer);
  if (!regular) tui.setLayoutRoot(root);
  tui.setFocus(editor);
  tui.start();
  tui.renderNow();
  // Preserve the already-rendered screen: shutdown scrollback serialization is not this input fixture.
  cleanups.push(() => { selector?.dispose(); controller.dispose(); component.dispose(); editor.dispose?.(); tui.stop({ preserveScreen: true }); setKeybindings(previousKb); });
  function point(action = "reasoning.cycle") {
    tui.renderNow();
    const lines = tui.getScreenLines().map(plain);
    const row = lines.findIndex((line) => line.includes("界é"));
    assert.ok(row >= 0, `footer must be visible at ${width}:\n${lines.join("\n")}`);
    const hit = layout(lastWidth).hits.find((candidate) => candidate.action === action);
    return { x: hit.startCol, y: row + hit.row, width: lastWidth };
  }
  return { state, editor, tui, terminal, component, controller, calls, cancellations, notify, refresh, native, originalInput,
    release, dock, footer, kb, side, scroll, root, splitState, point, closeSelector, scopes, reasoningTriggers, captureCycleTrigger,
    get selector() { return selector; } };
}

test("half-open ANSI/Unicode cell ranges and inline hint exclude icons, separators, padding and omitted segments", () => {
  for (const width of [46, 120, 180]) {
    const activated = [];
    const component = createFooterComponent(layout, () => 1, () => true, (action) => { activated.push(action); });
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    for (let row = 0; row < lines.length; row++) {
      for (let x = 0; x < width; x++) {
        const hit = layout(width).hits.find((hit) => hit.row === row && x >= hit.startCol && x < hit.endCol);
        const result = component.handleMouse(mouse(x, row, width));
        if (hit) { assert.deepEqual(result, { handled: true, render: false }); assert.equal(activated.at(-1), hit.action); }
        else assert.equal(result, undefined, `padding at ${row}:${x}`);
      }
    }
    component.render(12);
    assert.equal(component.handleMouse(mouse(4, 0, 12)), undefined, "truncated text has no invented action");
    component.dispose();
  }
});

test("width, snapshot/theme invalidation, generation and disposal reject stale hit maps", () => {
  let generation = 1, currentLayout = layout(120), available = true;
  const activate = vi.fn();
  const component = createFooterComponent(() => currentLayout, () => generation, () => available, activate);
  component.render(120);
  assert.equal(component.handleMouse(mouse(4, 0, 46)), undefined);
  generation++;
  assert.equal(component.handleMouse(mouse(4, 0, 120)), undefined);
  component.render(120);
  component.render(46); // a different-width measurement cannot retire the visible 120-column layout
  assert.deepEqual(component.describe().layouts, [120, 46]);
  assert.deepEqual(component.handleMouse(mouse(4, 0, 120)), { handled: true, render: false });
  available = false;
  assert.equal(component.handleMouse(mouse(4, 0, 120)), undefined);
  available = true;
  component.invalidate(); // both theme invalidation and snapshot replacement use this hook
  assert.equal(component.handleMouse(mouse(4, 0, 120)), undefined);
  currentLayout = { lines: ["readonly"], hits: [] };
  component.render(120);
  assert.equal(component.handleMouse(mouse(4, 0, 120)), undefined);
  currentLayout = layout(46);
  component.render(46);
  assert.deepEqual(component.handleMouse(mouse(4, 0, 46)), { handled: true, render: false });
  component.dispose();
  assert.equal(component.handleMouse(mouse(4, 0, 46)), undefined);
  assert.deepEqual(component.render(46), []);
  assert.equal(activate.mock.calls.length, 2);
  const duringRender = createFooterComponent(() => { generation++; return layout(46); }, () => generation, () => true, activate);
  duringRender.render(46);
  assert.equal(duringRender.handleMouse(mouse(4, 0, 46)), undefined);
});

test("generic release is accepted only after a matching unmodified left press", () => {
  const activated = [];
  const component = createFooterComponent(layout, () => 1, () => true, (action) => activated.push(action));
  component.render(120);
  const at = (type, button, extra = {}) => mouse(4, 0, 120, { type, button, ...extra });
  assert.equal(component.handleMouse(at("click", "none")), undefined, "unpaired release is inert");
  component.handleMouse(at("press", "left"));
  component.handleMouse(at("release", "none"));
  assert.deepEqual(component.handleMouse(at("click", "none")), { handled: true, render: false });
  assert.deepEqual(activated, ["model.open"]);
  assert.equal(component.handleMouse(at("click", "none")), undefined, "a press can activate only once");
  for (const interruption of [at("drag", "left"), at("release", "none", { x: 5 }), at("press", "left", { shift: true })]) {
    component.handleMouse(at("press", "left"));
    component.handleMouse(interruption);
    assert.equal(component.handleMouse(at("click", "none")), undefined);
  }
  component.handleMouse(at("press", "left"));
  component.invalidate();
  component.render(120);
  assert.equal(component.handleMouse(at("click", "none")), undefined);
  component.dispose();
});

test("normalized non-click, modified, double/triple, out-of-bounds and fractional gestures remain unhandled", () => {
  const activate = vi.fn();
  const component = createFooterComponent(layout, () => 1, () => true, activate);
  component.render(120);
  for (const extra of [
    ...["press", "release", "drag", "move", "wheel"].map((type) => ({ type })),
    { button: "right" }, { button: "middle" }, { button: "none" }, { clickCount: 2 }, { clickCount: 3 },
    { shift: true }, { alt: true }, { ctrl: true }, { x: -1 }, { x: 120 }, { y: -1 }, { y: 2 },
    { x: NaN }, { x: 4.5 }, { y: 0.5 }, { height: 0 },
  ]) assert.equal(component.handleMouse(mouse(4, 0, 120, extra)), undefined);
  assert.equal(activate.mock.calls.length, 0);
});

for (const width of [46, 120, 180]) for (const sidebar of [false, true]) {
  test(`actual terminal/fullscreen/Container routing at ${width} columns, Sidebar ${sidebar ? "open" : "absent"}`, async () => {
    const f = fixture({ width, sidebar });
    const draft = f.editor.getText();
    const { x, y, width: paneWidth } = f.point();
    assert.equal(paneWidth, sidebar && width === 180 ? 89 : width);
    if (sidebar) assert.equal(f.root.orientation, width === 180 ? "right" : "down");
    f.terminal.click(x, y);
    await tick();
    assert.deepEqual(f.calls, ["native.reasoning"]);
    assert.equal(f.editor.getText(), draft);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    assert.equal(f.tui.mouseCapture, undefined);
    assert.equal(f.tui.mousePressTarget, undefined);
    // A second click at the same point is a selection gesture, not a second action.
    f.terminal.click(x, y);
    await tick();
    assert.deepEqual(f.calls, ["native.reasoning"]);
    assert.equal(f.tui.hasActiveSelection(), true);
    f.tui.resetTextSelection();
    // The footer never claims a press or drag: the renderer selects its text.
    f.terminal.pointer(0, x, y);
    f.terminal.pointer(32, x + 3, y);
    f.terminal.pointer(0, x + 3, y, true);
    assert.equal(f.tui.hasActiveSelection(), true);
    assert.deepEqual(f.calls, ["native.reasoning"]);
    f.tui.resetTextSelection();
    for (const modifier of [4, 8, 16]) f.terminal.click(x, y, modifier);
    f.terminal.click(0, y); // icon/padding
    f.terminal.click(paneWidth - 7, y); // whitespace beyond the inline hint
    if (sidebar) {
      const sideRow = f.tui.getScreenLines().findIndex((line) => plain(line).includes("Sidebar"));
      f.terminal.click(width === 180 ? 93 : 3, sideRow);
    }
    assert.deepEqual(f.calls, ["native.reasoning"]);
    const top = f.tui.viewportTop;
    f.terminal.pointer(64, 3, 2); // native wheel pipeline, not an action
    f.tui.renderNow();
    assert.ok(f.tui.viewportTop < top);
    assert.equal(f.editor.getText(), draft);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    if (sidebar) {
      f.splitState.collapsed = true;
      assert.equal(f.point().width, width, "collapsed Sidebar restores the real main width");
    }
  });
}

test("actual resize rejects old-width clicks before repaint and rebuilds Sidebar-local coordinates", async () => {
  const f = fixture({ width: 180, sidebar: true });
  const old = f.point();
  f.terminal.columns = 46;
  f.terminal.onResize();
  // The SDK still dispatches against the old component box until repaint. The viewport
  // token, not a fabricated event width, prevents those stale coordinates activating.
  f.terminal.click(old.x, old.y);
  await tick();
  assert.deepEqual(f.calls, []);
  assert.equal(f.component.handleMouse(mouse(old.x, 0, 46)), undefined);
  const next = f.point();
  assert.equal(next.width, 46);
  assert.equal(f.component.handleMouse(mouse(old.x, 0, old.width)), undefined);
  f.terminal.click(next.x, next.y);
  await tick();
  assert.deepEqual(f.calls, ["native.reasoning"]);
});

test("native selector focus (without prompt events), overlay, prompts and blocked holds own all input", async () => {
  const f = fixture();
  const draft = f.editor.getText();
  await f.controller.activate("model.open");
  assert.ok(f.selector instanceof ModelSelectorComponent);
  assert.equal(f.state.promptDepth, 0, "native selector emits no extension prompt lifecycle");
  assert.equal(f.tui.hasOverlay(), false);
  assert.equal(f.tui.getFocusedComponent(), f.selector);
  for (const action of ["model.open", "reasoning.cycle", "cache.status", "effort.toggle"]) {
    assert.equal(f.controller.available(action), false);
    await f.controller.activate(action);
  }
  f.terminal.send("\x1b");
  assert.equal(f.selector, undefined);
  assert.equal(f.tui.getFocusedComponent(), f.editor);
  assert.equal(f.editor.getText(), draft);
  // Even a nonfocused overlay blocks footer dispatch; focus alone is insufficient.
  const overlay = f.tui.showOverlay(leaf("dialog"), { width: 30, anchor: "top-left" });
  f.tui.setFocus(f.editor);
  f.tui.renderNow();
  assert.equal(f.tui.hasOverlay(), true);
  const p = f.point();
  f.terminal.click(p.x, p.y);
  await f.controller.activate("reasoning.cycle");
  assert.deepEqual(f.calls, ["native.model"]);
  overlay.hide();
  f.tui.setFocus(f.editor);
  for (const [key, value] of [["promptDepth", 2], ["promptDepth", 1], ["blocked", 2], ["blocked", 1]]) {
    f.state[key] = value;
    assert.equal(f.controller.available("reasoning.cycle"), false);
    await f.controller.activate("reasoning.cycle");
    f.state[key] = 0;
  }
  await f.controller.activate("reasoning.cycle");
  assert.deepEqual(f.calls, ["native.model", "native.reasoning"]);
  assert.equal(f.editor.getText(), draft);
});

for (const vim of [false, true]) {
  test(`${vim ? "pi-vim" : "CustomEditor"}: actual keyboard routes current model action in Linked, native picker in Independent`, async () => {
    const f = fixture({ vim });
    const draft = f.editor.getText();
    f.state.linked = true;
    const updatedNative = () => { f.calls.push("replacement native"); f.native(); };
    f.editor.actionHandlers.set("app.model.select", updatedNative);
    f.terminal.send("\x1bp");
    assert.equal(f.editor.actionHandlers.get("app.model.select"), updatedNative, "restored immediately, not after the dialog promise");
    await tick();
    assert.deepEqual(f.calls, ["flow"]);
    f.state.actions["flow.open"] = { label: "Fresh provider", run() { f.calls.push("fresh flow"); } };
    if (vim) f.terminal.send("\x1b"); // normal mode uses the same native action path
    f.terminal.send("\x1bp");
    await tick();
    assert.deepEqual(f.calls, ["flow", "fresh flow"]);
    f.state.linked = false;
    f.terminal.send("\x1bp");
    await tick();
    assert.deepEqual(f.calls, ["flow", "fresh flow", "replacement native", "native.model"]);
    assert.equal(f.tui.getFocusedComponent(), f.selector);
    assert.equal(f.controller.available("model.open"), false);
    f.terminal.send("\x1b");
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    assert.equal(f.editor.getText(), draft);
    // Native thinking path, never synthesizing or replacing the draft.
    await f.controller.activate("reasoning.cycle");
    assert.equal(f.calls.at(-1), "native.reasoning");
    assert.equal(f.editor.getText(), draft);
  });
}

for (const vim of [false, true]) {
  test(`${vim ? "pi-vim" : "CustomEditor"}: rapid reasoning keys stage without invoking the native setter or locking input`, async () => {
    const f = fixture({ vim, bindings: { "app.thinking.cycle": "ctrl+t" } });
    const draft = f.editor.getText();
    const native = vi.fn();
    f.editor.actionHandlers.set("app.thinking.cycle", native);
    f.terminal.send("\x14", "\x14");
    assert.deepEqual(f.calls, ["native.reasoning", "native.reasoning"]);
    assert.equal(native.mock.calls.length, 0);
    assert.equal(f.editor.actionHandlers.get("app.thinking.cycle"), native);
    assert.equal(f.controller.describe().opening, false);
    await f.controller.activate("reasoning.cycle");
    assert.equal(f.calls.length, 3, "mouse activation shares the staging callback");
    assert.equal(f.editor.getText(), draft);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    await f.controller.activate("approvals.open");
    assert.ok(f.cancellations.includes("opened settings picker"));
    f.release();
    assert.equal(f.editor.actionHandlers.get("app.thinking.cycle"), native);
  });
}

for (const vim of [false, true]) for (const regular of [false, true]) {
  test(`${vim ? "pi-vim" : "CustomEditor"} ${regular ? "main screen" : "fullscreen"}: native key scope, release filtering and explicit pointer isolation`, async () => {
    const f = fixture({ vim, regular, bindings: { "app.thinking.cycle": "ctrl+t" } });
    const draft = f.editor.getText();
    const trigger = { kind: "keyboard", epoch: 1, serial: 1, modifiers: 4, event: "press" };
    f.state.keyTrigger = trigger;
    f.terminal.send("\x1b[116;5u");
    assert.deepEqual(f.reasoningTriggers, [trigger], "the original native action captures the current raw-key token");
    assert.equal(f.captureCycleTrigger.mock.calls.length, 1);
    f.terminal.send("\x1b[116;5:3u", "\x1b[57442;1:3u");
    assert.equal(f.reasoningTriggers.length, 1, "ordinary and modifier release cannot invoke the native action again");
    await f.controller.activate("reasoning.cycle");
    assert.deepEqual(f.reasoningTriggers.at(-1), { kind: "pointer" }, "pointer must not inherit even a still-visible keyboard token");
    assert.equal(f.captureCycleTrigger.mock.calls.length, 1, "pointer origin does not ask for a key token");
    assert.equal(f.state.cycleTrigger, undefined, "scope exits synchronously");
    f.state.keyTrigger = undefined;
    await f.controller.activate("reasoning.cycle", "keyboard");
    assert.deepEqual(f.reasoningTriggers.at(-1), { kind: "programmatic" }, "missing raw key evidence is not fabricated");
    f.tui.setFocus(f.side);
    const scopes = f.scopes.length;
    await f.controller.activate("reasoning.cycle", "keyboard");
    await f.controller.activate("effort.toggle");
    assert.equal(f.scopes.length, scopes, "Sidebar/non-main focus never enters a settings scope");
    f.tui.setFocus(f.editor);
    f.state.promptDepth++;
    await f.controller.activate("reasoning.cycle", "keyboard");
    assert.equal(f.scopes.length, scopes, "a native dialog blocks even an explicitly supplied keyboard origin");
    assert.equal(f.editor.getText(), draft);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
  });
}

test("pointer provider scope covers only synchronous invocation, not an awaited picker lifetime", async () => {
  const f = fixture();
  const pending = deferred();
  const observations = [];
  f.state.keyTrigger = { kind: "keyboard", epoch: 1, serial: 8, modifiers: 4, event: "repeat" };
  f.state.actions["approvals.open"].run = async () => {
    observations.push(f.state.cycleTrigger);
    await pending.promise;
    observations.push(f.state.cycleTrigger);
  };
  const opening = f.controller.activate("approvals.open");
  assert.deepEqual(observations, [{ kind: "pointer" }]);
  assert.equal(f.state.cycleTrigger, undefined);
  assert.equal(f.captureCycleTrigger.mock.calls.length, 0);
  pending.resolve();
  await opening;
  assert.deepEqual(observations, [{ kind: "pointer" }, undefined]);
  f.state.actions["effort.toggle"].run = () => { assert.deepEqual(f.state.cycleTrigger, { kind: "pointer" }); throw new Error("scope failure"); };
  await f.controller.activate("effort.toggle");
  assert.equal(f.state.cycleTrigger, undefined, "throwing providers cannot leak a scope");
  assert.match(f.notify.mock.calls.at(-1)[0], /scope failure/);
});

test("native history and registered shortcut precedence are retained; unrelated model cycle is untouched", async () => {
  const f = fixture({ bindings: { "tui.editor.historyPrevious": "alt+p" } });
  f.state.linked = true;
  f.editor.addToHistory("previous prompt");
  f.terminal.send("\x1bp");
  await tick();
  assert.equal(f.editor.getText(), "previous prompt");
  assert.deepEqual(f.calls, []);
  f.editor.onExtensionShortcut = (data) => { if (data === "\x1bp") { f.calls.push("shortcut"); return true; } return false; };
  f.terminal.send("\x1bp");
  f.editor.actionHandlers.set("app.model.cycleForward", () => f.calls.push("cycle"));
  f.terminal.send("\x10");
  assert.deepEqual(f.calls, ["shortcut", "cycle"]);
  assert.deepEqual(f.scopes, [], "history and explicit shortcuts never enter the settings-cycle scope");
  assert.equal(f.captureCycleTrigger.mock.calls.length, 0);
});

test("native autocomplete Escape precedence survives a colliding Linked model binding", async () => {
  const f = fixture({ bindings: { "app.model.select": "escape" } });
  f.state.linked = true;
  f.editor.setText("");
  f.editor.setAutocompleteProvider({
    getSuggestions: async () => ({ prefix: "", items: [{ label: "alpha", value: "alpha" }, { label: "beta", value: "beta" }] }),
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  });
  f.terminal.send("\t");
  await vi.waitFor(() => assert.equal(f.editor.isShowingAutocomplete(), true));
  f.terminal.send("\x1b");
  assert.equal(f.editor.isShowingAutocomplete(), false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.editor.getText(), "");
  assert.equal(f.editor.actionHandlers.get("app.model.select"), f.native);
  assert.deepEqual(f.scopes, [], "autocomplete Escape never captures a settings trigger");
});

test("pi-vim Normal commands retain precedence over a colliding model binding", async () => {
  const f = fixture({ vim: true, bindings: { "app.model.select": "x" } });
  f.state.linked = true;
  f.terminal.send("\x1b", "0", "x");
  await tick();
  assert.deepEqual(f.calls, []);
  assert.notEqual(f.editor.getText(), "unsent 界 draft\nsecond line", "Vim x remains an edit, not a flow picker");
  assert.deepEqual(f.scopes, [], "Vim edits never enter the settings scope");
});

test("Linked keyboard routing denies unavailable/busy/prompt/blocked actions rather than falling through to native", async () => {
  const f = fixture();
  f.state.linked = true;
  for (const [key, value] of [["idle", false], ["blocked", 1], ["promptDepth", 1]]) {
    const old = f.state[key]; f.state[key] = value;
    f.terminal.send("\x1bp"); await tick(); f.state[key] = old;
  }
  delete f.state.actions["flow.open"];
  f.terminal.send("\x1bp"); await tick();
  assert.deepEqual(f.calls, []);
  assert.match(f.notify.mock.calls.at(-1)[0], /\/flow/);
  assert.equal(f.editor.actionHandlers.get("app.model.select"), f.native);
});

test("regular-terminal mouse is not intercepted, while linked keyboard routing remains usable", async () => {
  const f = fixture({ regular: true });
  f.state.linked = true;
  f.terminal.click(4, 8);
  f.terminal.pointer(64, 4, 8);
  assert.deepEqual(f.calls, []);
  assert.equal(f.terminal.writes.some((write) => /\x1b\[\?100[0236]h/.test(write)), false, "no mouse ownership enabled");
  f.terminal.send("\x1bp"); await tick();
  assert.deepEqual(f.calls, ["flow"]);
});

test("busy controls explain why pickers wait; reversible settings and inspections remain usable", async () => {
  const f = fixture();
  f.state.idle = false;
  for (const action of ["model.open", "workflow.cycle", "workflow.open", "flow.open", "approvals.open", "context.open", "context.skills", "mcp.open"]) {
    assert.equal(f.controller.available(action), true, action);
    await f.controller.activate(action);
    assert.match(f.notify.mock.calls.at(-1)[0], /Wait for the current turn/);
  }
  assert.deepEqual(f.calls, []);
  for (const action of ["reasoning.cycle", "effort.toggle", "cache.status", "execution.status"]) {
    assert.equal(f.controller.available(action), true, action);
    await f.controller.activate(action);
  }
  assert.deepEqual(f.calls, ["native.reasoning", "effort", "cache", "execution"]);
});

test("serialization, errors, stale completion and recaptured generation are session-owned", async () => {
  const f = fixture();
  const pending = deferred();
  f.state.actions["approvals.open"].run = () => { f.calls.push("pending"); return pending.promise; };
  const opening = f.controller.activate("approvals.open");
  assert.equal(f.controller.available("cache.status"), false);
  await f.controller.activate("cache.status");
  assert.deepEqual(f.calls, ["pending"]);
  f.state.generation++;
  pending.reject(new Error("late failure"));
  await opening;
  assert.equal(f.refresh.mock.calls.length, 0);
  assert.equal(f.notify.mock.calls.length, 0);
  assert.equal(f.controller.available("cache.status"), false);
  f.controller.wrapEditor(f.editor, f.tui);
  f.state.actions["cache.status"].run = () => { throw new Error("current failure"); };
  await f.controller.activate("cache.status");
  assert.match(f.notify.mock.calls.at(-1)[0], /current failure/);
  assert.equal(f.refresh.mock.calls.length, 1);
  const late = deferred();
  f.state.actions["cache.status"].run = () => late.promise;
  const last = f.controller.activate("cache.status");
  f.controller.dispose();
  late.resolve(); await last;
  assert.equal(f.refresh.mock.calls.length, 1);
  assert.equal(f.editor.handleInput, f.originalInput);
  assert.equal(f.controller.available("cache.status"), false);
});

test("actual captured editor and TUI identities plus active/current generation are required", async () => {
  const f = fixture();
  for (const [key, other] of [["active", false], ["editor", new CustomEditor(f.tui, getEditorTheme(), new KeybindingsManager())], ["tui", {}], ["generation", 2]]) {
    const previous = f.state[key]; f.state[key] = other;
    assert.equal(f.controller.available("effort.toggle"), false);
    await f.controller.activate("effort.toggle");
    f.state[key] = previous;
  }
  f.tui.setFocus(f.side); // read-only child/Sidebar chrome must not mutate main
  await f.controller.activate("effort.toggle");
  assert.deepEqual(f.calls, []);
  f.tui.setFocus(f.editor);
  await f.controller.activate("effort.toggle");
  assert.deepEqual(f.calls, ["effort"]);
});

test("absent native handlers/focus API omit controls and report command paths on programmatic invocation", async () => {
  const f = fixture();
  for (const [action, native, command] of [["model.open", "app.model.select", "/model"], ["reasoning.cycle", "app.thinking.cycle", "/thinking"]]) {
    f.editor.actionHandlers.delete(native);
    assert.equal(f.controller.available(action), false);
    await f.controller.activate(action);
    assert.ok(f.notify.mock.calls.at(-1)[0].includes(command));
  }
  f.state.linked = true;
  assert.equal(f.controller.available("model.open"), false, "a flow provider without the native model entry cannot advertise the model key");
  await f.controller.activate("model.open");
  assert.match(f.notify.mock.calls.at(-1)[0], /\/flow/);
  assert.deepEqual(f.calls, [], "missing native Linked entry must not invoke its flow provider");
  f.tui.getFocusedComponent = undefined;
  assert.equal(f.controller.available("cache.status"), false);
  await f.controller.activate("cache.status");
  assert.match(f.notify.mock.calls.at(-1)[0], /\/cache-guard/);
  assert.deepEqual(f.calls, []);
});

test("temporary action-map ownership is reentrancy-safe and restored on throw without clobbering later owners", async () => {
  const f = fixture();
  f.release();
  const original = f.editor.handleInput;
  let nested = false;
  f.editor.handleInput = function (data) {
    if (!nested) { nested = true; this.handleInput(data); nested = false; }
    else original.call(this, data);
  };
  const beforeWrap = f.editor.handleInput;
  f.controller.wrapEditor(f.editor, f.tui);
  f.state.linked = true;
  f.terminal.send("\x1bp"); await tick();
  assert.deepEqual(f.calls, ["flow"]);
  assert.equal(f.editor.actionHandlers.get("app.model.select"), f.native);
  f.controller.dispose();
  assert.equal(f.editor.handleInput, beforeWrap);

  const g = fixture();
  g.release();
  const nextNative = () => {};
  let throws = true;
  g.editor.handleInput = function () {
    if (throws) throw new Error("input error");
    this.actionHandlers.set("app.model.select", nextNative);
  };
  const thirdPartyInput = g.editor.handleInput;
  const undo = g.controller.wrapEditor(g.editor, g.tui);
  g.state.linked = true;
  assert.throws(() => g.terminal.send("\x1bp"), /input error/);
  assert.equal(g.editor.actionHandlers.get("app.model.select"), g.native);
  throws = false;
  g.terminal.send("\x1bp");
  assert.equal(g.editor.actionHandlers.get("app.model.select"), nextNative);
  g.editor.handleInput = thirdPartyInput;
  undo();
  assert.equal(g.editor.handleInput, thirdPartyInput, "release must not clobber a newer wrapper");
});

for (const width of [46, 120, 180]) for (const sidebar of [false, true]) {
  test(`index factory: actual layout, deferred capability snapshots and native input at ${width}, Sidebar ${sidebar}`, async () => {
    const f = fixture({ width, sidebar });
    f.release(); f.component.dispose(); f.footer.clear();
    const handlers = new Map(), listeners = new Map();
    const paint = { fg: (_color, text) => text, bold: (text) => text };
    const entries = [{ type: "custom", customType: "personal-status-footer", data: { working: false, mcp: false } }];
    const statuses = new Map([["workflow-mode", "workflow: work (alt+w to cycle)"], ["permission-mode", "⏵⏵ auto mode on (alt+a to cycle)"]]);
    let renderDepth = 0, discoveries = 0, mounted, editorFactory = () => f.editor;
    const flow = { version: 1, operatingMode: "independent", revision: 0, workflow: "work", ready: true, guardAvailable: true, transitioning: false };
    const bus = {
      on(channel, listener) { listeners.set(channel, [...(listeners.get(channel) ?? []), listener]); return () => {}; },
      emit(channel, request) {
        if (channel === "pi-plugins.workflow-flow.v1" || channel === "pi-plugins.footer-actions.v1") {
          assert.equal(renderDepth, 0, "provider discovery must never run on the footer render stack");
          discoveries++;
          if (channel === "pi-plugins.workflow-flow.v1") request.snapshot = { ...flow };
          else Object.assign(request.actions, f.state.actions);
        }
        for (const listener of listeners.get(channel) ?? []) listener(request);
      },
    };
    const ctx = {
      mode: "tui", cwd: process.env.TMPDIR ?? "/tmp",
      model: { provider: "test", id: "physical", contextWindow: 200000, reasoning: true },
      sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "interaction-test", getLeafId: () => null },
      modelRegistry: { isUsingOAuth: () => false, getApiKeyForProvider: async () => { throw new Error("no credential discovery in this fixture"); } },
      isIdle: () => f.state.idle, hasPendingMessages: () => false, isProjectTrusted: () => false,
      getContextUsage: () => ({ tokens: 2000, percent: 1, contextWindow: 200000 }),
      ui: {
        theme: paint, notify: f.notify, setWorkingMessage() {},
        getEditorComponent: () => editorFactory,
        setEditorComponent(factory) {
          editorFactory = factory;
          if (!factory) return;
          const nativeEntries = [...f.editor.actionHandlers];
          f.editor.actionHandlers.clear();
          assert.equal(factory(f.tui, paint, f.kb), f.editor);
          for (const [action, run] of nativeEntries) f.editor.actionHandlers.set(action, run);
        },
        setFooter(factory) {
          mounted?.dispose(); f.footer.clear(); mounted = undefined;
          if (!factory) return;
          mounted = factory(f.tui, paint, {
            getGitBranch: () => "main", getExtensionStatuses: () => statuses, onBranchChange: () => () => {},
          });
          const render = mounted.render;
          mounted.render = (w) => { renderDepth++; try { return render(w); } finally { renderDepth--; } };
          f.footer.addChild(leaf("activity", "")); f.footer.addChild(mounted);
        },
      },
    };
    footerModule.default({
      events: bus, on(name, handler) {
        const previous = handlers.get(name);
        handlers.set(name, previous ? (...args) => {
          const result = previous(...args);
          return result?.then ? result.then(() => handler(...args)) : handler(...args);
        } : handler);
        return () => {};
      }, registerCommand() {}, registerEntryRenderer() {},
      getThinkingLevel: () => "high", getSessionName: () => "", appendEntry() {},
      getCommands() { assert.equal(renderDepth, 0, "command discovery is outside render"); return []; },
      getAllTools: () => [],
    });
    cleanups.push(() => handlers.get("session_shutdown")({}, ctx));
    await handlers.get("session_start")({}, ctx);
    const flush = async () => { f.tui.renderNow(); await tick(); f.tui.renderNow(); await tick(); };
    await flush();
    function pointFor(text) {
      const screen = f.tui.getScreenLines().map(plain);
      const y = screen.findIndex((line) => line.includes(text));
      assert.ok(y >= 0, `${text} should be visible:\n${screen.join("\n")}`);
      return { x: visibleWidth(screen[y].slice(0, screen[y].indexOf(text))), y };
    }
    const nativePaint = f.tui.getScreenLines().map(plain).join("\n");
    assert.match(nativePaint, /physical/);
    assert.match(nativePaint, /alt\+p/);
    const beforeRender = discoveries;
    mounted.render(width);
    assert.equal(discoveries, beforeRender, "no synchronous render-time bus query");
    await tick();
    assert.ok(discoveries > beforeRender, "native-frame discovery occurs in the deferred microtask");
    // Rerender the real pane width after the direct component probe.
    await flush();
    const draft = f.editor.getText();
    const point = pointFor("physical");
    f.terminal.click(point.x, point.y); await tick();
    assert.equal(f.calls.at(-1), "native.model");
    assert.equal(f.tui.getFocusedComponent(), f.selector);
    assert.equal(f.editor.getText(), draft);
    f.terminal.send("\x1b");
    // Change the live flow without rendering. The keyboard must not use the old painted mode.
    flow.operatingMode = "linked";
    flow.revision++;
    flow.selectedFlow = { provider: "test", anchorModel: "physical", roles: Object.fromEntries(["work", "chat", "plan", "exec"].map((role) => [role, { provider: "test", modelId: "physical" }])) };
    f.terminal.send("\x1bp"); await tick();
    assert.equal(f.calls.at(-1), "flow");
    await flush();
    const linkedPaint = f.tui.getScreenLines().map(plain).join("\n");
    assert.match(linkedPaint, /work/);
    assert.equal((linkedPaint.match(/physical/g) ?? []).length, 1, "combined linked row has no duplicated model");
    const request = { version: 1 };
    bus.emit(footerModule.SESSION_CHROME_CHANNEL, request);
    assert.ok(request.service);
    const beforeChild = discoveries;
    renderDepth++;
    let child;
    try {
      child = request.service.footer({ cwd: ctx.cwd, provider: "child", model: "child-model", thinking: "low", context: ctx.getContextUsage(),
        totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, compactions: 0, started: Date.now() } }, width, paint);
    } finally { renderDepth--; }
    assert.equal(discoveries, beforeChild);
    assert.doesNotMatch(child.join("\n"), /alt\+p|alt\+w|alt\+a|work|physical/);
    // Native prompts are nested, and only the final end permits activation again.
    handlers.get("ui_prompt_start")({}, ctx); handlers.get("ui_prompt_start")({}, ctx);
    handlers.get("ui_prompt_end")({}, ctx);
    const count = f.calls.length;
    f.terminal.send("\x1bp"); await tick();
    assert.equal(f.calls.length, count);
    handlers.get("ui_prompt_end")({}, ctx);
    bus.emit("herdr:blocked", { active: true });
    await flush();
    assert.equal(mounted.render(width).length, 1, "blocked footer stays one line");
    f.terminal.send("\x1bp"); await tick();
    assert.equal(f.calls.length, count);
    bus.emit("herdr:blocked", { active: false });
    await flush();
    f.terminal.send("\x1bp"); await tick();
    assert.equal(f.calls.length, count + 1);
    assert.equal(f.editor.getText(), draft);
    assert.equal(f.tui.getFocusedComponent(), f.editor);
    // A real branch change keeps this editor, but retires the old action's
    // ownership. A late rejection cannot notify or hold the new branch's lock.
    const pending = deferred();
    f.state.actions["flow.open"] = { label: "Pending flow", run() { f.calls.push("old branch action"); return pending.promise; } };
    await flush();
    f.terminal.send("\x1bp"); await tick();
    assert.equal(f.calls.at(-1), "old branch action");
    const notices = f.notify.mock.calls.length;
    flow.revision++;
    f.state.actions["flow.open"] = { label: "New branch flow", run() { f.calls.push("new branch action"); } };
    await handlers.get("session_tree")({}, ctx);
    f.terminal.send("\x1bp"); await tick();
    assert.equal(f.calls.at(-1), "new branch action");
    pending.reject(new Error("outgoing branch failed")); await tick();
    assert.equal(f.notify.mock.calls.length, notices);
    assert.equal(f.editor.getText(), draft);
    await flush();
    // Dispatch using the SDK's real previous-layout bounds before resize repaint.
    const oldRail = pointFor("alt+p"), beforeResize = f.calls.length;
    f.terminal.columns = width + 7; f.terminal.onResize();
    f.terminal.click(oldRail.x, oldRail.y); await tick();
    assert.equal(f.calls.length, beforeResize, "viewport change retires cached hits before repaint");
    const outgoing = mounted;
    await handlers.get("session_shutdown")({}, ctx);
    assert.deepEqual(outgoing.render(width), []);
    assert.equal(outgoing.handleMouse(mouse(point.x, 0, width)), undefined);
  });
}
