// Shared real-Pi integration fixture. Only terminal transport, session-independent run data,
// and service answers live in memory. Never dispatch directly to a component: send() enters
// TuiAltScreen's native viewport listener, extension listeners, then the actual focused owner.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createJiti } from 'jiti';

export const KEY = { enter: '\r', escape: '\x1b', down: '\x1b[B', up: '\x1b[A', left: '\x1b[D',
  pageUp: '\x1b[5~', pageDown: '\x1b[6~', top: '\x1b[1;5H', bottom: '\x1b[1;5F' };
export const MAIN_DRAFT = 'Main draft kept';
export const CHILD_DRAFT = 'Child draft kept';
export const SIDEBAR_DRAFT = 'Sidebar draft kept';
export const CHOICE = 'Dialog choice';
export const QUESTION = { question: 'Which dialog choice?', header: 'Focus', multiSelect: false,
  options: [{ label: CHOICE }, { label: 'Not this choice' }] };
export const plain = lines => lines.map(stripVTControlCharacters).join('\n');

export async function bounded(label, promise, ms = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
export async function waitFor(label, check) {
  const until = Date.now() + 1500;
  while (!check()) {
    if (Date.now() >= until) throw new Error(`Timed out: ${label}`);
    await delay(5);
  }
}

class MemoryTerminal {
  kittyProtocolActive = false;
  constructor(columns, rows) { this.columns = columns; this.rows = rows; }
  start(onInput) { this.input = onInput; }
  stop() { this.input = undefined; }
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
  send(data) {
    assert.ok(this.input, 'terminal input dispatcher must be started');
    this.input(data);
  }
}

const versions = new Map();
async function modules(version) {
  assert.ok(['1.2', '1.4'].includes(version), `unsupported SDK fixture: ${version}`);
  if (!versions.has(version)) versions.set(version, (async () => {
    // The package's ordinary lockfile is Pi 1.2; the named aliases are Pi 1.4.
    const base = resolve('packages/pi-sidebar/node_modules');
    const sdkPath = `${base}/${version === '1.4' ? 'pi-coding-agent-1-4' : '@earendil-works/pi-coding-agent'}/dist/index.js`;
    const tuiPath = `${base}/${version === '1.4' ? 'pi-tui-1-4' : '@earendil-works/pi-tui'}/dist/index.js`;
    const sdkUrl = pathToFileURL(sdkPath);
    const sdk = await import(sdkUrl);
    const tui = await import(tuiPath);
    const internal = path => import(new URL(path, sdkUrl));
    // Do not let Node's shared CJS cache give the second version the first version's aliases.
    const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
      '@earendil-works/pi-coding-agent': sdkPath, '@earendil-works/pi-tui': tuiPath,
    } });
    const production = path => jiti.import(resolve('packages', path));
    const result = { sdk, tui, internal, production,
      ...await internal('./core/extensions/loader.js'),
      ...await internal('./core/keybindings.js'),
      theme: await internal('./modes/interactive/theme/theme.js'),
      ...await internal('./modes/interactive/chat-viewport.js'),
      ...await internal('./modes/interactive/tui-renderer.js'),
    };
    for (const path of ['pi-sidebar/src/family/view-host.ts', 'pi-sidebar/src/layout.ts',
      'pi-sidebar/src/panel.ts', 'pi-ask-user-question/src/dialog.ts', 'pi-tool-gate/src/prompt.ts',
      'pi-subagents/src/ui/fleet.ts', 'pi-subagents/src/ui/viewer.ts', 'pi-subagents/src/conversation.ts',
      'pi-subagents/src/child.ts']) Object.assign(result, await production(path));
    sdk.initTheme('dark', false);
    return result;
  })());
  return versions.get(version);
}

/** Observe a real handler without changing ownership, rewriting, or consumption. */
export function observeInput(component) {
  const inputs = [];
  const original = component.handleInput.bind(component);
  let depth = 0;
  component.handleInput = data => {
    // pi-vim can leave EX and reprocess the same key internally. Count delivery by the
    // dispatcher, not that recursive implementation detail.
    if (depth++ === 0) inputs.push(data);
    try { return original(data); } finally { depth--; }
  };
  return inputs;
}

let sequence = 0;
export async function createDialogFixture({ sdkVersion = '1.4', width = 120, height = 40,
  sidebarOpen = false, handlerOrder = 'footer-first', awaitedHandler = false,
  stableProxy = false, bindings = {}, footer, idleFooter, sessionFooter, vim = false, selectNavOrder } = {}) {
  const m = await modules(sdkVersion);
  const { Container, Text, TuiAltScreen, getKeybindings, setKeybindings } = m.tui;
  const { ExtensionRunner, InteractiveMode, CustomEditor, SessionManager, createEventBus, createExtensionRuntime } = m.sdk;
  const previous = getKeybindings();
  const kb = new m.KeybindingsManager(bindings);
  setKeybindings(kb);
  const terminal = new MemoryTerminal(width, height);
  const renderer = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const tui = stableProxy ? m.createInteractiveTuiReference(() => renderer) : renderer;
  const editor = new CustomEditor(tui, m.theme.getEditorTheme(), kb);
  editor.setText(MAIN_DRAFT);
  const mainInputs = observeInput(editor);
  const state = { mainSubmits: 0, fleetOpens: 0, starts: 0, ends: 0, footerBlocked: false,
    trace: [], events: [], errors: [], steers: [], stops: 0 };
  editor.onSubmit = () => { state.mainSubmits++; };
  // Avoid only InteractiveMode's terminal/session startup, not its UI methods.
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: tui, renderer, editor, defaultEditor: editor, keybindings: kb,
    editorContainer: new Container(), extensionDialogs: [],
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(), widgetContainerBelow: new Container(),
    extensionTerminalInputSubscriptions: new Set(), programStatus: { setBlocked() {} },
    runtimeHost: { session: { settingsManager: { getExternalEditorCommand: () => undefined } } },
  });
  mode.editorContainer.addChild(editor);
  const empty = () => new Container();
  const { root, ...viewport } = m.createChatViewport({
    document: new Text(Array.from({ length: 100 }, (_, i) => `Main transcript line ${i}`).join('\n'), 0, 0),
    pendingMessages: empty(), status: empty(), widgetsAbove: mode.widgetContainerAbove,
    editor: mode.editorContainer, widgetsBelow: mode.widgetContainerBelow,
    footer: { render: w => (state.footerBlocked ? footer : idleFooter)?.(w) ?? ['Focus regression footer'], invalidate() {} },
    scrollbar: 'never',
  });
  tui.setLayoutRoot(root);
  tui.setFocus(editor);
  const host = new m.FamilyViewHost(tui, m.theme.theme, kb);
  const panel = new m.SidebarPanel(tui, () => m.theme.theme, {
    status: () => [{ text: 'main: idle' }], submit() {}, confirm() {}, abort() {},
    focusMain: () => host.focusPrimary(), focusSidebar: () => tui.setFocus(panel.input), close: () => host.unmountSplit(),
    isBusy: () => false, matchesToggle: () => false, matchesFocusSwitch: () => false,
    toggleLabel: "ctrl+'", mainHidesThinking: () => false, cwd: process.cwd(),
  });
  panel.input.setText(SIDEBAR_DRAFT);
  const layout = new m.SplitLayout(tui, panel.root, {
    ratio: () => 0.5, minColumns: 80, collapsed: () => false, focused: () => false,
    divider: (orientation, focused, columns, length) => m.dividerLines(orientation, columns,
      text => m.theme.theme.fg('borderAccent', text), {
        sidebar: focused, length, pointer: text => m.theme.theme.bold(m.theme.theme.fg('accent', text)),
      }),
  });
  const runtime = createExtensionRuntime();
  const bus = createEventBus();
  let fleet, release, hosted = false;
  const footerExtension = pi => {
    pi.on('ui_prompt_start', async () => {
      state.trace.push('footer:start'); state.footerBlocked = true; tui.requestRender();
      if (awaitedHandler) await nextTurn();
    });
    pi.on('ui_prompt_end', () => {
      state.trace.push('footer:end'); state.footerBlocked = false; tui.requestRender();
    });
  };
  const sidebarExtension = pi => {
    pi.on('ui_prompt_start', event => {
      state.trace.push('sidebar:start'); state.events.push(event);
      state.startFocus = tui.getFocusedComponent();
      fleet.setPromptActive(true);
      release = host.suspend('native'); state.starts++;
    });
    pi.on('ui_prompt_end', event => {
      state.trace.push('sidebar:end'); state.events.push(event);
      state.endFocus = tui.getFocusedComponent();
      release?.(); release = undefined;
      fleet.setPromptActive(false); state.ends++;
    });
  };
  const extensions = [];
  for (const factory of handlerOrder === 'footer-first' ? [footerExtension, sidebarExtension] : [sidebarExtension, footerExtension]) {
    extensions.push(await m.loadExtensionFromFactory(factory, process.cwd(), bus, runtime, `<focus-${factory.name}>`));
  }
  if (selectNavOrder) {
    const { default: selectNav } = await m.production('pi-select-nav/src/index.ts');
    extensions.push(await m.loadExtensionFromFactory(selectNav, process.cwd(), bus, runtime, '<focus-select-nav>'));
  }
  const runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), {});
  runner.onError(error => state.errors.push(error));
  runner.setUIContext(mode.createExtensionUIContext(), 'tui');
  const ctx = runner.createContext();
  const runs = [];
  if (sessionFooter) bus.on('pi-plugins.session-chrome.v1', request => {
    // Supply in-memory session metadata to the production footer renderer, just as main's
    // footer callbacks above do. This avoids launching the footer's network/account probes.
    request.service = { footer: sessionFooter, gauge: () => false };
  });
  if (vim) {
    const { EmbeddedEditor } = await m.production('pi-vim/src/embedded-editor.ts');
    bus.on('pi-plugins.editor-factory.v1', request => {
      request.factory = options => {
        const editor = new EmbeddedEditor(options);
        editor.setClipboardMirrorPolicy('off');
        return editor;
      };
    });
  }
  const actions = () => ({ events: bus, steer: message => { state.steers.push(message); return true; }, stop: () => { state.stops++; } });
  fleet = new m.FleetView({ runs: () => runs, enabled: () => true, actions,
    family: () => hosted ? host : undefined,
    sections: () => [{ id: 'focus-target', title: 'Tasks', entries: () => [], open: async () => {},
      pill: () => ({ label: 'Actionable Fleet target' }), openDialog: async () => { state.fleetOpens++; },
    }],
  });
  if (selectNavOrder === 'before') await runner.emit({ type: 'session_start' });
  fleet.setUI(ctx.ui); fleet.update();
  if (selectNavOrder === 'after') await runner.emit({ type: 'session_start' });
  // Keep a host in the closed case: a previously opened/closed Sidebar owns one too.
  host.mountSplit(layout);
  if (!sidebarOpen) host.unmountSplit();
  tui.start();
  const frame = () => { renderer.doRender(); return renderer.getScreenLines(); };
  const send = (...keys) => { for (const key of keys) terminal.send(key); frame(); };
  const snapshot = () => frame().map(line => line.replace(/\x1b_pi:[^\x07]*\x07/gu, ''));
  frame();
  // Pi 1.2 replaces the editor dock directly; 1.4 has an explicit dialog stack.
  const dialogs = () => sdkVersion === '1.4' ? mode.extensionDialogs
    : mode.editorContainer.children.filter(component => component !== editor).map(component => ({ component }));
  const pending = new Set();
  const aborts = new Set();
  const closes = new Set();
  const track = promise => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  function makeRun({ status = 'running', long = true } = {}) {
    const conversation = new m.Conversation();
    const message = { role: 'assistant', content: [{ type: 'text', text: long
      ? Array.from({ length: 120 }, (_, i) => `Child transcript line ${i}`).join('\n\n') : 'Child transcript ready.' }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'fixture', stopReason: 'stop', timestamp: 0 };
    conversation.apply({ type: 'message_start', message }); conversation.apply({ type: 'message_end', message });
    return { id: `dialog-fixture-${++sequence}`, agent: 'scout', task: 'Inspect the child transcript',
      model: 'anthropic/claude-haiku-5', thinking: 'low', cwd: '/tmp', async: true,
      byJev: { agent: false, model: false, thinking: false }, conversation, outputPath: '/tmp/unused',
      child: status === 'running' ? {} : undefined,
      state: { status, output: '', usage: m.emptyUsage(), turns: 1, startedAt: Date.now(),
        ...(status === 'running' ? {} : { endedAt: Date.now() }) } };
  }
  async function openView({ hosted: family = false, status = 'running', draft = CHILD_DRAFT, run = makeRun({ status }) } = {}) {
    hosted = family;
    if (!runs.includes(run)) runs.push(run);
    fleet.update();
    const closed = track(fleet.show(ctx.ui, run));
    await waitFor('real SessionView installed', () => tui.getFocusedComponent()?.constructor.name === 'SessionView');
    const view = tui.getFocusedComponent();
    // Jiti's isolated imports give classes distinct identities; inspect the actual instance,
    // not instanceof a second import. Nothing here manufactures a SessionView substitute.
    assert.equal(view.current, run);
    if (status === 'running' && draft) send(draft);
    frame();
    return { view, closed, run, inputs: observeInput(view) };
  }
  function prompt(kind, options = {}) {
    const abort = new AbortController(); aborts.add(abort);
    const opts = { signal: abort.signal };
    let promise;
    if (kind === 'select') promise = ctx.ui.select('Native select focus?', [CHOICE, 'Not this choice'], opts);
    else if (kind === 'confirm') promise = ctx.ui.confirm('Native confirm focus?', 'Confirm the dialog, not Fleet.', opts);
    else if (kind === 'input') promise = ctx.ui.input('Native input focus?', 'Dialog answer', opts);
    else if (kind === 'editor') promise = ctx.ui.editor('Native editor focus?', '');
    else if (kind === 'question') promise = ctx.ui.custom((t, theme, keys, done) => {
      closes.add(done); return new m.QuestionDialog(t, theme, keys, [options.question ?? QUESTION], done, abort.signal);
    });
    else if (kind === 'approval') promise = m.askApproval(ctx, {
      view: { tool: 'bash', body: { kind: 'code', text: 'printf focus', lang: 'bash' } },
      options: options.choices ?? ['Allow once', 'Block'],
      ...(options.editRow ? { editRow: options.editRow, editText: options.editText ?? '' } : {}),
    }, 'Approval fallback must not be used');
    else throw new Error(`Unknown prompt kind: ${kind}`);
    return track(promise);
  }
  async function dispose() {
    try {
      for (const abort of aborts) abort.abort();
      for (const done of closes) done(undefined);
      // Cancellation uses the same terminal route as the test. Do not invoke handleInput on
      // an unfocused dialog to turn a broken ownership assertion into a passing answer.
      for (let i = 0; i < 8 && dialogs().length; i++) { send(KEY.escape); await nextTurn(); }
      await runner.emit({ type: 'session_shutdown', reason: 'quit' });
      release?.(); fleet.dispose(); host.dispose(); panel.dispose();
      await bounded('fixture promises settle', Promise.allSettled([...pending]), 500);
      await nextTurn();
    } finally {
      mode.clearExtensionTerminalInputListeners(); mode.clearExtensionWidgets(); editor.dispose?.();
      tui.stop(); runtime.invalidate('Focus fixture disposed'); setKeybindings(previous);
    }
  }
  return { ...m, tuiModule: m.tui, sdkVersion, width, tui, renderer, terminal, editor, mainInputs, panel, mode, host, layout, root,
    viewport, fleet, runner, runtime, bus, ctx, ui: ctx.ui, kb, state, runs, actions,
    send, snapshot, frame, makeRun, openView, prompt, track, dispose, get dialogs() { return dialogs(); } };
}
