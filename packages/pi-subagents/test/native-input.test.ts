import { CustomEditor, initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { setKeybindings } from "@earendil-works/pi-tui";
import { KeybindingsManager as KeybindingsManager14 } from "../node_modules/pi-coding-agent-1-4/dist/core/keybindings.js";
import { beforeEach, expect, test, vi } from "vitest";
import { FleetView } from "../src/ui/fleet.ts";
import { SessionView, openViewer } from "../src/ui/viewer.ts";
import { mountViewerOverlay, ViewerPromptState } from "../src/ui/viewer-overlay.ts";
import { acquireViewportInput } from "../src/ui/viewport-input.ts";
import { EDITOR_FACTORY_CHANNEL, EDITOR_MODE, INPUT_CONTEXT } from "../src/editor-contract.ts";
import { fakeRun, fakeUI, fakeTui, KEY, normalFocus, plain } from "./ui-helpers.ts";
beforeEach(() => { initTheme("dark"); setKeybindings(new KeybindingsManager()); });
const theme = { borderColor: (s: string) => s, selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s } };

test("actual native Editor retains h/j/k/l and Ctrl-U/D while Fleet is virtually selected", () => {
  const ui = fakeUI();
  const editor = new CustomEditor(ui.tui as never, theme, new KeybindingsManager());
  ui.tui.focused = editor;
  const fleet = new FleetView({ runs: () => [fakeRun()], enabled: () => true, actions: () => ({}) });
  fleet.setUI(ui); fleet.update();
  try {
    for (const key of ["h", "j", "k", "l", "x", "b"]) {
      editor.setText("");
      expect(ui.press(KEY.down)).toBe(true);
      expect(ui.press(key)).toBe(false);
      editor.handleInput(key);
      expect(editor.getText()).toBe(key);
    }
    editor.setText("draft");
    expect(ui.press(KEY.down)).toBe(true);
    expect(ui.press("\x15")).toBe(false);
    editor.handleInput("\x15");
    expect(editor.getText()).toBe("");
    editor.setText("abc");
    expect(ui.press(KEY.down)).toBe(true);
    expect(ui.press("\x04")).toBe(false);
    editor.handleInput("\x1b[H"); editor.handleInput("\x04");
    expect(editor.getText()).toBe("bc");
  } finally { fleet.dispose(); }
});

test.each([false, true])("native steering keeps edit keys and scrolls its allocated viewport (hosted: %s)", (hosted) => {
  const tui = fakeTui(27);
  const run = fakeRun({ child: {} as never });
  const message = { role: "assistant", content: [{ type: "text", text: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n\n") }] };
  run.conversation.apply({ type: "message_start", message });
  run.conversation.apply({ type: "message_end", message });
  let steered = "";
  const viewer = new SessionView(tui as never, run, plain, () => undefined, { steer: (message) => { steered = message; return true; } }, new KeybindingsManager(), undefined, undefined, undefined, hosted ? () => ({ width: 100, height: 19 }) : undefined);
  viewer.focused = true;
  try {
    viewer.render(100);
    const bottom = (viewer as any).scrollTop;
    const page = Math.max(1, (viewer as any).lastViewport - 1);
    viewer.handleInput("\x1b[5~"); expect((viewer as any).scrollTop).toBe(bottom - page);
    viewer.handleInput("\x1b[6~"); expect((viewer as any).scrollTop).toBe(bottom);
    expect(viewer[INPUT_CONTEXT]()).toBe("editor");
    for (const key of "draft") viewer.handleInput(key);
    viewer.handleInput("\x15");
    for (const key of "abc") viewer.handleInput(key);
    viewer.handleInput("\x01"); viewer.handleInput("\x04");
    viewer.handleInput(KEY.enter);
    expect(steered).toBe("bc");
    expect(viewer[INPUT_CONTEXT]()).toBe("editor");
  } finally { viewer.dispose(); }
});

test("input callbacks contain asynchronous and synchronous stop/dismiss failures", async () => {
  const ui = fakeUI();
  normalFocus(ui);
  const run = fakeRun({ child: {} as never });
  const fleet = new FleetView({ runs: () => [run], enabled: () => true, actions: () => ({ stop: async () => { throw new Error("failed stop"); } }), dismissedAt: () => 0, dismiss: async () => { throw new Error("failed dismiss"); } });
  fleet.setUI(ui); fleet.update();
  ui.press(KEY.down); expect(ui.press("x")).toBe(true); expect(ui.press("x")).toBe(true);
  run.state.status = "failed"; run.state.endedAt = Date.now();
  expect(ui.press("x")).toBe(true);
  const viewer = new SessionView(fakeTui() as never, fakeRun({ child: {} as never }), plain, () => undefined, { steer: () => true, stop: async () => { throw new Error("failed viewer stop"); } });
  expect(() => { viewer.handleInput("\x03"); viewer.handleInput("\x03"); }).not.toThrow();
  await Promise.resolve(); await Promise.resolve();
  fleet.dispose(); viewer.dispose();
});

// These lifecycle cases use explicit prompt notifications and a fake focus stack.
// They do not establish runner prompt-depth, terminal dispatch or visual correctness.
test("prompt holds notify only on effective changes; reconcile retries without releasing holds", () => {
  const state = new ViewerPromptState();
  const changed = vi.fn();
  const unsubscribe = state.subscribe(changed);
  state.setPromptActive(true); state.setPromptActive(true);
  state.setBlocked("a", true); state.setBlocked("b", true);
  state.setPromptActive(false); state.setBlocked("a", false);
  expect(state.blocked).toBe(true);
  expect(changed).toHaveBeenCalledTimes(1);
  state.reconcile();
  expect(state.blocked).toBe(true);
  expect(changed).toHaveBeenCalledTimes(2);
  state.setBlocked("b", false);
  expect(changed).toHaveBeenCalledTimes(3);
  state.setBlocked("a", true); state.reset(); state.reset();
  expect(state.blocked).toBe(false);
  expect(changed).toHaveBeenCalledTimes(5);
  unsubscribe(); state.reconcile();
  expect(changed).toHaveBeenCalledTimes(5);
});

test.each([false, true])("owned viewer suspends with early/late prompt-start (late=%s), restoring only to its owner", async late => {
  const ui = fakeUI();
  const custom = vi.spyOn(ui, "custom");
  const state = new ViewerPromptState();
  let close!: () => void;
  const run = fakeRun({ child: {} as never });
  const actions = { steer: () => true };
  const work = openViewer(ui, run, actions, fn => { close = fn; }, { runs: () => [run], enabled: () => true, actions: () => actions }, undefined, undefined, state);
  const entry = ui.overlays[0]!;
  const view = entry.component as SessionView;
  const dispose = vi.spyOn(view, "dispose");
  ui.dispatch("draft");
  (view as any).follow = false; (view as any).scrollTop = 7;
  ui.dispatch(KEY.down);
  const dialog = { handleInput: vi.fn() };
  if (late) ui.tui.setFocus(dialog);
  state.setPromptActive(true);
  if (!late) ui.tui.setFocus(dialog);
  expect(entry.hidden).toBe(true);
  expect(ui.tui.focused).toBe(dialog);
  state.setBlocked("approval", true);
  state.setPromptActive(false);
  state.reconcile();
  expect(entry.hidden).toBe(true);
  state.setBlocked("approval", false);
  expect(entry.hidden).toBe(true); // A different owner still has focus.
  ui.dispatch(KEY.enter);
  expect(dialog.handleInput).toHaveBeenCalledWith(KEY.enter);
  ui.tui.setFocus(ui.mainEditor);
  state.reconcile();
  expect(entry.hidden).toBe(false);
  expect(ui.tui.focused).toBe(view);
  expect((view as any).composer.getText()).toBe("draft");
  expect((view as any).scrollTop).toBe(7);
  expect(view[INPUT_CONTEXT]()).toBe("list");
  expect(dispose).not.toHaveBeenCalled();
  expect(custom).not.toHaveBeenCalled();
  close(); close(); await work;
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(ui.widgets.size).toBe(0);
});

test("closing hidden viewer retargets only its own handle and never revives", async () => {
  const ui = fakeUI();
  const state = new ViewerPromptState();
  let close!: () => void;
  const work = openViewer(ui, fakeRun(), {}, fn => { close = fn; }, undefined, undefined, undefined, state);
  const view = ui.overlays[0]!.component;
  const dispose = vi.spyOn(view, "dispose");
  const dialog = {};
  const other = ui.tui.showOverlay(dialog);
  state.setPromptActive(true);
  close(); close(); await work;
  state.setPromptActive(false); state.reconcile();
  expect(ui.overlays.map(entry => entry.component)).toEqual([dialog]);
  expect(ui.tui.focused).toBe(dialog);
  other.hide();
  expect(ui.tui.focused).toBe(ui.mainEditor);
  expect(dispose).toHaveBeenCalledTimes(1);
});

test.each(["close", "stale", "install"])("blocked initial mount does not capture focus before %s", async outcome => {
  const ui = fakeUI();
  const state = new ViewerPromptState(); state.setPromptActive(true);
  let close!: () => void;
  let eligible = true;
  const installed = vi.spyOn(ui.tui, "showOverlay");
  const work = openViewer(ui, fakeRun(), {}, fn => { close = fn; }, undefined, undefined, () => eligible, state);
  const settled = work.then(() => "closed", error => error.message);
  expect(close).toBeTypeOf("function");
  expect(installed).not.toHaveBeenCalled();
  expect(ui.tui.focused).toBe(ui.mainEditor);
  if (outcome === "close") close();
  if (outcome === "stale") eligible = false;
  state.setPromptActive(false);
  if (outcome === "install") { expect(installed).toHaveBeenCalledTimes(1); close(); }
  else expect(installed).not.toHaveBeenCalled();
  expect(await settled).toBe(outcome === "stale" ? "Viewer opening cancelled" : "closed");
  expect(ui.widgets.size).toBe(0);
});

test("cancellation before probing, probe failure and mount failure settle without leaked components", async () => {
  const ui = fakeUI();
  const factory = vi.fn(() => ({ render: () => [], invalidate() {}, dispose: vi.fn() }));
  await mountViewerOverlay(ui, factory, { height: 100, onOpen: close => close() });
  expect(ui.calls).toEqual([]);
  expect(factory).not.toHaveBeenCalled();
  const widget = ui.setWidget;
  ui.setWidget = (key, content) => { widget(key, content); if (content) throw new Error("probe failed"); };
  await expect(mountViewerOverlay(ui, factory, { height: 100 })).rejects.toThrow("probe failed");
  expect(ui.widgets.size).toBe(0);
  ui.setWidget = widget;
  ui.tui.showOverlay = () => { throw new Error("mount failed"); };
  await expect(mountViewerOverlay(ui, factory, { height: 100 })).rejects.toThrow("mount failed");
  expect(factory.mock.results[0]!.value.dispose).toHaveBeenCalledTimes(1);
});

test("fake dispatch preserves data rewrites and final focus, unlike interception-only press", () => {
  const ui = fakeUI();
  const recipient = { handleInput: vi.fn() };
  ui.inputHandlers.add(data => ({ data: `${data}!` }));
  ui.inputHandlers.add(data => { expect(data).toBe("x!"); ui.tui.setFocus(recipient); return undefined; });
  expect(ui.dispatch("x")).toBe(false);
  expect(recipient.handleInput).toHaveBeenCalledWith("x!");
  ui.inputHandlers.clear();
  ui.press("ignored");
  expect(recipient.handleInput).toHaveBeenCalledTimes(1);
  ui.inputHandlers.add(() => ({ consume: true }));
  expect(ui.dispatch("consumed")).toBe(true);
  expect(recipient.handleInput).toHaveBeenCalledTimes(1);
});

function viewportHost() {
  const host = Object.assign(Object.create({ shouldDeferViewportInputToOverlay() { return false; } }), {
    focused: undefined as unknown, getFocusedComponent() { return this.focused; },
  });
  return host;
}

test.each([false, true])("viewport adapter shares owners and restores the original descriptor (own=%s)", own => {
  const host = viewportHost();
  if (own) Object.defineProperty(host, "shouldDeferViewportInputToOverlay", { value: () => false, configurable: true, writable: true, enumerable: false });
  const descriptor = Object.getOwnPropertyDescriptor(host, "shouldDeferViewportInputToOverlay");
  const owner = {}, other = {};
  const first = acquireViewportInput(host, owner);
  const duplicate = acquireViewportInput(host, owner);
  const second = acquireViewportInput(host, other);
  host.focused = owner; expect(host.shouldDeferViewportInputToOverlay()).toBe(true);
  first(); first(); expect(host.shouldDeferViewportInputToOverlay()).toBe(true);
  duplicate(); expect(host.shouldDeferViewportInputToOverlay()).toBe(false);
  host.focused = other; expect(host.shouldDeferViewportInputToOverlay()).toBe(true);
  host.focused = {}; expect(host.shouldDeferViewportInputToOverlay()).toBe(false);
  second();
  expect(Object.getOwnPropertyDescriptor(host, "shouldDeferViewportInputToOverlay")).toEqual(descriptor);
});

test("viewport adapter resolves the stable proxy and preserves foreign wrappers and original true", () => {
  const host = viewportHost();
  host.shouldDeferViewportInputToOverlay = () => true;
  const proxy = new Proxy({}, {
    get: (_target, key) => typeof host[key] === "function" ? host[key].bind(host) : host[key],
    set: (_target, key, value) => Reflect.set(host, key, value),
  });
  const release = acquireViewportInput(proxy, {});
  expect(host.shouldDeferViewportInputToOverlay()).toBe(true);
  expect(Reflect.ownKeys(host).some(key => typeof key === "symbol")).toBe(false);
  const wrapper = host.shouldDeferViewportInputToOverlay;
  const foreign = () => wrapper();
  host.shouldDeferViewportInputToOverlay = foreign;
  release();
  expect(host.shouldDeferViewportInputToOverlay).toBe(foreign);
});

test("unsupported/frozen renderers safely return no-op releases", () => {
  for (const host of [undefined, null, 1, {}, Object.freeze({ shouldDeferViewportInputToOverlay: () => false, getFocusedComponent: () => undefined })]) {
    expect(() => { const release = acquireViewportInput(host, {}); release(); release(); }).not.toThrow();
  }
});

test.each([false, true])("SessionView acquires exact-owner viewport guard only when hosted (%s)", hosted => {
  const tui = Object.assign(fakeTui(), { shouldDeferViewportInputToOverlay: () => false });
  const original = tui.shouldDeferViewportInputToOverlay;
  const view = new SessionView(tui as never, fakeRun({ state: { status: "done" } }), plain, () => {}, {}, undefined, undefined, undefined, undefined, hosted ? () => ({ width: 100, height: 20 }) : undefined);
  tui.setFocus(view);
  expect(tui.shouldDeferViewportInputToOverlay()).toBe(hosted);
  tui.setFocus({}); expect(tui.shouldDeferViewportInputToOverlay()).toBe(false);
  view.dispose(); view.dispose();
  expect(tui.shouldDeferViewportInputToOverlay).toBe(original);
});

test.each([KeybindingsManager, KeybindingsManager14])("viewport uses the supplied SDK defaults and honors disabled/remapped actions", Manager => {
  const keys = new Manager();
  const view = new SessionView(fakeTui() as never, fakeRun(), plain, () => {}, {}, keys);
  (view as any).lastViewport = 20;
  const scroll = vi.spyOn(view, "scrollBy");
  view.handleInput("\x1b[5~");
  const halfPage = keys.matches("\x1b[5~", "tui.altScreen.halfPageUp");
  expect(scroll).toHaveBeenLastCalledWith(halfPage ? -10 : -19);
  view.dispose();
  const disabled = new SessionView(fakeTui() as never, fakeRun(), plain, () => {}, {}, { matches: () => false });
  const disabledScroll = vi.spyOn(disabled, "scrollBy");
  disabled.handleInput("\x1b[5~"); expect(disabledScroll).not.toHaveBeenCalled(); disabled.dispose();
  const remapped = new SessionView(fakeTui() as never, fakeRun(), plain, () => {}, {}, new Manager({ "tui.altScreen.halfPageUp": ["alt+p"], "tui.altScreen.pageUp": [] }));
  const remappedScroll = vi.spyOn(remapped, "scrollBy");
  remapped.handleInput("\x1b[5~"); expect(remappedScroll).not.toHaveBeenCalled();
  remapped.handleInput("\x1bp"); expect(remappedScroll).toHaveBeenCalledTimes(1); remapped.dispose();
});

// Contract-level ownership tests; the sibling tests exercise the actual pi-vim editor.
test.each(["ex", "pending", "visual", "autocomplete"])("composer-owned %s bypasses session and viewport shortcuts", state => {
  const run = fakeRun({ child: {} as never });
  const other = fakeRun();
  const composer = {
    focused: false, getText: () => "", setText() {}, render: () => [], invalidate() {}, handleInput: vi.fn(),
    [EDITOR_MODE]: () => ({ state: state === "autocomplete" ? "insert" : state, autocomplete: state === "autocomplete" }),
  };
  const keys = { matches: vi.fn(() => true) };
  const done = vi.fn();
  const interaction = vi.fn();
  const actions = { steer: () => true, events: { emit: (channel: string, request: any) => { if (channel === EDITOR_FACTORY_CHANNEL) request.factory = () => composer; } } };
  const view = new SessionView(fakeTui() as never, run, plain, done, actions, keys, { runs: () => [run, other], actions: () => actions }, undefined, interaction);
  const inputs = ["\t", "\x1b[Z", "\n", "\x0b", "\x1b[5~", "\x1b[1;5H", "\x15", "\x04", "\x03", KEY.escape];
  for (const input of inputs) view.handleInput(input);
  expect(composer.handleInput.mock.calls.map(([input]) => input)).toEqual(inputs);
  expect(keys.matches).not.toHaveBeenCalled();
  expect(view.current).toBe(run);
  expect(done).not.toHaveBeenCalled();
  view.handleInput("\x1b[97;1:3u"); // Kitty release, ignored before interaction callbacks.
  expect(interaction).toHaveBeenCalledTimes(inputs.length);
  view.dispose();
});

test("unsupported action lookup can use physical fallback, explicit non-match cannot", () => {
  const view = new SessionView(fakeTui() as never, fakeRun(), plain, () => {}, {}, { matches: () => { throw new Error("unknown action"); } });
  const scroll = vi.spyOn(view, "scrollBy");
  view.handleInput("\x1b[5~"); expect(scroll).toHaveBeenCalledTimes(1);
  view.dispose();
});

test("a prompt started by the factory defers mounting the same component until its owner returns", async () => {
  const ui = fakeUI();
  const state = new ViewerPromptState();
  const component = { render: () => [], invalidate() {}, dispose: vi.fn() };
  const factory = vi.fn(() => { state.setPromptActive(true); return component; });
  let close!: () => void;
  const work = mountViewerOverlay(ui, factory, { height: 100, promptState: state, onOpen: fn => { close = fn; } });
  expect(ui.overlays).toHaveLength(0);
  const dialog = {};
  ui.tui.setFocus(dialog);
  state.setPromptActive(false);
  expect(ui.tui.focused).toBe(dialog);
  expect(ui.overlays).toHaveLength(0);
  ui.tui.setFocus(ui.mainEditor); state.reconcile();
  expect(ui.overlays[0]?.component).toBe(component);
  expect(factory).toHaveBeenCalledTimes(1);
  close(); await work;
  expect(component.dispose).toHaveBeenCalledTimes(1);
});
