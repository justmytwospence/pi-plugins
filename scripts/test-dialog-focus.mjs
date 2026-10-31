// Pi 1.4 prompt/focus integration. Only the terminal transport and session-independent
// fixture data are in memory: the runner, dialog stack, dialogs, Fleet and input dispatcher
// are real. This does not exercise a complete AgentSession or Sidebar controller lifecycle.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createJiti } from 'jiti';

const sdkPath = resolve('packages/pi-sidebar/node_modules/pi-coding-agent-1-4/dist/index.js');
const tuiPath = resolve('packages/pi-sidebar/node_modules/pi-tui-1-4/dist/index.js');
const sdkUrl = pathToFileURL(sdkPath);
const sdk = await import(sdkUrl);
const { Container, Text, TuiAltScreen, getKeybindings, setKeybindings } = await import(tuiPath);
const { ExtensionRunner, InteractiveMode, CustomEditor, ExtensionSelectorComponent,
  SessionManager, createEventBus, createExtensionRuntime, initTheme } = sdk;
const { loadExtensionFromFactory } = await import(new URL('./core/extensions/loader.js', sdkUrl));
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
const themeModule = await import(new URL('./modes/interactive/theme/theme.js', sdkUrl));
const { createChatViewport } = await import(new URL('./modes/interactive/chat-viewport.js', sdkUrl));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': sdkPath,
  '@earendil-works/pi-tui': tuiPath,
} });
const { FamilyViewHost } = await jiti.import('../packages/pi-sidebar/src/family/view-host.ts');
const { SplitLayout, dividerLines } = await jiti.import('../packages/pi-sidebar/src/layout.ts');
const { QuestionDialog } = await jiti.import('../packages/pi-ask-user-question/src/dialog.ts');
const { askApproval } = await jiti.import('../packages/pi-tool-gate/src/prompt.ts');
const { FleetView } = await jiti.import('../packages/pi-subagents/src/ui/fleet.ts');

const ENTER = '\r';
const ESCAPE = '\x1b';
const DRAFT = 'Main draft kept';
const CHOICE = 'Dialog choice';
const QUESTION = { question: 'Which dialog choice?', header: 'Focus', multiSelect: false,
  options: [{ label: CHOICE }, { label: 'Not this choice' }] };

class MemoryTerminal {
  columns;
  rows = 40;
  kittyProtocolActive = false;
  constructor(columns) { this.columns = columns; }
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

async function bounded(label, promise, ms = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function waitFor(label, check) {
  const until = Date.now() + 1500;
  while (!check()) {
    if (Date.now() >= until) throw new Error(`Timed out: ${label}`);
    await delay(5);
  }
}
const plain = lines => lines.map(stripVTControlCharacters).join('\n');

async function testPrompt({ width, open, primary, footerFirst, kind }) {
  const kb = new KeybindingsManager();
  setKeybindings(kb);
  const terminal = new MemoryTerminal(width);
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const editor = new CustomEditor(tui, themeModule.getEditorTheme(), kb);
  editor.setText(DRAFT);
  const mainInputs = [], primaryInputs = [];
  let mainSubmits = 0, fleetOpens = 0, primaryDisposals = 0;
  const originalInput = editor.handleInput.bind(editor);
  editor.handleInput = data => { mainInputs.push(data); originalInput(data); };
  editor.onSubmit = () => { mainSubmits++; };

  // Avoid InteractiveMode's constructor (real terminal/session startup), not its UI methods.
  // All dialog installation, focus changes and restoration below are Pi's own methods.
  const mode = Object.assign(Object.create(InteractiveMode.prototype), {
    ui: tui, editor, defaultEditor: editor, keybindings: kb,
    editorContainer: new Container(), extensionDialogs: [],
    extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
    widgetContainerAbove: new Container(), widgetContainerBelow: new Container(),
    extensionTerminalInputSubscriptions: new Set(),
    // Program-status publication is unrelated to keyboard focus; no terminal process is owned.
    programStatus: { setBlocked() {} },
  });
  mode.editorContainer.addChild(editor);
  const empty = () => new Container();
  const { root } = createChatViewport({
    document: new Text('Main transcript stays in the native layout', 0, 0),
    pendingMessages: empty(), status: empty(), widgetsAbove: mode.widgetContainerAbove,
    editor: mode.editorContainer, widgetsBelow: mode.widgetContainerBelow,
    footer: new Text('Focus regression footer', 0, 0), scrollbar: 'never',
  });
  tui.setLayoutRoot(root);
  tui.setFocus(editor);
  // Keep a host even in the closed case: a previously opened/closed Sidebar owns one too.
  const host = new FamilyViewHost(tui, themeModule.theme, kb);
  const panel = new Text('Sidebar family panel', 0, 0);
  const layout = new SplitLayout(tui, panel, {
    ratio: () => 0.5, minColumns: 80, collapsed: () => false, focused: () => false,
    divider: (orientation, _focused, columns) => dividerLines(orientation, columns, text => text),
  });
  const activePrimary = {
    focused: false,
    render: () => ['Active family primary view'],
    invalidate() {},
    handleInput: data => { primaryInputs.push(data); },
    dispose: () => { primaryDisposals++; },
  };

  const runtime = createExtensionRuntime();
  const bus = createEventBus();
  const trace = [], events = [], errors = [];
  let release, startFocus, endFocus, footerBlocked = false, starts = 0, ends = 0;
  const footer = pi => {
    // A synchronous earlier handler is enough: ExtensionRunner.emit awaits each handler,
    // adding the microtask in which showExtensionCustom installs its component.
    pi.on('ui_prompt_start', () => {
      trace.push('footer:start');
      footerBlocked = true;
      tui.requestRender();
    });
    pi.on('ui_prompt_end', () => {
      trace.push('footer:end');
      footerBlocked = false;
      tui.requestRender();
    });
  };
  const sidebar = pi => {
    pi.on('ui_prompt_start', event => {
      trace.push('sidebar:start');
      events.push(event);
      startFocus = tui.getFocusedComponent();
      release = host.suspend('native');
      starts++;
    });
    pi.on('ui_prompt_end', event => {
      trace.push('sidebar:end');
      events.push(event);
      endFocus = tui.getFocusedComponent();
      release?.();
      release = undefined;
      ends++;
    });
  };
  let fleet, runner, prompt, primaryClosed, primaryDone;
  const abort = new AbortController();
  try {
    const extensions = [];
    for (const factory of footerFirst ? [footer, sidebar] : [sidebar, footer]) {
      extensions.push(await loadExtensionFromFactory(factory, process.cwd(), bus, runtime, `<focus-${factory.name}>`));
    }
    runner = new ExtensionRunner(extensions, runtime, process.cwd(), SessionManager.inMemory(), {});
    runner.onError(error => errors.push(error));
    runner.setUIContext(mode.createExtensionUIContext(), 'tui');
    const ctx = runner.createContext();
    // A real, actionable Fleet pill, not an empty roster or an inert mock. Its global
    // listener goes through InteractiveMode.onTerminalInput and the real TUI dispatcher.
    fleet = new FleetView({ runs: () => [], enabled: () => true, actions: () => ({}),
      sections: () => [{ id: 'focus-target', title: 'Tasks', entries: () => [], open: async () => {},
        pill: () => ({ label: 'Actionable Fleet target' }),
        openDialog: async () => { fleetOpens++; },
      }],
    });
    fleet.setUI(ctx.ui);
    fleet.update();
    tui.start();
    const selectFleet = () => {
      terminal.send('\x1b[B');
      const widget = mode.extensionWidgetsBelow.get('subagents-fleet');
      assert.ok(widget, 'real Fleet widget must be mounted');
      assert.match(plain(widget.render(width)), /● Actionable Fleet target/u, 'Fleet must really be preselected');
    };
    // Positive control: the same Enter really opens this row when main owns focus.
    selectFleet();
    terminal.send(ENTER);
    await waitFor('Fleet positive control', () => fleetOpens === 1 && !fleet.viewer);
    selectFleet();
    assert.equal(mainSubmits, 0);
    assert.deepEqual(mainInputs, [], 'Fleet selection must consume navigation/Enter before main');

    // Exercise an existing-but-closed host as well as the open split.
    assert.equal(host.mountSplit(layout), true);
    if (!open) host.unmountSplit();
    assert.equal(host.sidebarRequestedOpen, open);
    if (primary) {
      primaryClosed = host.view({ factory: (_tui, _theme, _kb, done) => {
        primaryDone = done;
        return activePrimary;
      } });
      await waitFor('active primary installed by FamilyViewHost', () => tui.getFocusedComponent() === activePrimary);
    }
    const expectedPrimary = primary ? activePrimary : root;
    assert.equal(host.currentPrimary, expectedPrimary);

    if (kind === 'select') prompt = ctx.ui.select('Native select focus?', [CHOICE, 'Not this choice'], { signal: abort.signal });
    else if (kind === 'confirm') prompt = ctx.ui.confirm('Native confirm focus?', 'Confirm the dialog, not Fleet.', { signal: abort.signal });
    else if (kind === 'question') prompt = ctx.ui.custom((t, theme, keys, done) =>
      new QuestionDialog(t, theme, keys, [QUESTION], done, abort.signal));
    else if (kind === 'approval') prompt = askApproval(ctx, {
      view: { tool: 'bash', body: { kind: 'code', text: 'printf focus', lang: 'bash' } },
      options: ['Allow once', 'Block'],
    }, 'Approval fallback must not be used');
    else assert.fail(`Unknown prompt kind: ${kind}`);
    // Handle rejection even if an earlier ownership assertion fails.
    void prompt.catch(() => {});
    let resolutions = 0;
    void prompt.then(() => { resolutions++; }, () => {});
    await waitFor('real prompt-start dispatch and native dialog installation', () => starts === 1 && mode.extensionDialogs.length === 1);
    const dialog = mode.extensionDialogs[0].component;
    if (kind === 'select' || kind === 'confirm') assert.ok(dialog instanceof ExtensionSelectorComponent);
    else if (kind === 'question') assert.ok(dialog instanceof QuestionDialog);
    else assert.equal(dialog.constructor.name, 'ApprovalDialog', 'askApproval must use its actual custom dialog, not fallback select');
    if (footerFirst) assert.equal(startFocus, dialog, 'footer-first dispatch must reach Sidebar after Pi installed/focused the dialog');
    assert.equal(footerBlocked, true);
    assert.equal(host.suspended, true);
    assert.equal(layout.mounted, false);
    assert.equal(tui.layoutRoot, root, 'native prompt must use the original editor dock, not the family primary');
    assert.equal(resolutions, 0);
    const marker = { select: 'Native select focus?', confirm: 'Native confirm focus?',
      question: QUESTION.question, approval: 'Allow bash printf focus?' }[kind];
    await waitFor('native dialog rendered in the real fullscreen dock', () => plain(tui.getScreenLines()).includes(marker));

    const dialogInputs = [];
    const input = dialog.handleInput.bind(dialog);
    dialog.handleInput = data => { dialogInputs.push(data); input(data); };
    const focusBeforeEnter = tui.getFocusedComponent();
    // Do not refocus the dialog here: this is the production regression. Terminal input
    // runs Fleet's global listener first, then whatever component Pi/Sidebar left focused.
    terminal.send(ENTER);
    await nextTurn();
    assert.equal(fleetOpens, 1, 'dialog Enter must not dispatch the preselected Fleet action');
    assert.deepEqual(mainInputs, [], 'dialog Enter must not reach the main editor handler');
    assert.deepEqual(primaryInputs, [], 'dialog Enter must not reach the active primary handler');
    assert.deepEqual(dialogInputs, [ENTER], 'exactly the dialog must receive Enter');
    assert.equal(focusBeforeEnter, dialog, 'native suspension must preserve live dialog focus');
    const result = await bounded('dialog answer', prompt);
    if (kind === 'select') assert.equal(result, CHOICE);
    else if (kind === 'confirm') assert.equal(result, true);
    else if (kind === 'question') assert.deepEqual(result, { cancelled: false,
      answers: [{ index: 0, header: QUESTION.header, question: QUESTION.question, kind: 'option', answer: CHOICE }] });
    else assert.deepEqual(result, { choice: 'Allow once' });
    await waitFor('real prompt-end dispatch', () => ends === 1 && !footerBlocked);
    assert.equal(resolutions, 1);
    assert.equal(mainSubmits, 0);
    assert.deepEqual(errors, [], 'ExtensionRunner must not swallow a failing event handler');
    assert.deepEqual(trace, footerFirst
      ? ['footer:start', 'sidebar:start', 'footer:end', 'sidebar:end']
      : ['sidebar:start', 'footer:start', 'sidebar:end', 'footer:end']);
    assert.deepEqual(events.map(({ type, kind, reason }) => ({ type, kind, reason })), [
      { type: 'ui_prompt_start', kind: kind === 'question' || kind === 'approval' ? 'custom' : kind, reason: 'ui_prompt' },
      { type: 'ui_prompt_end', kind: kind === 'question' || kind === 'approval' ? 'custom' : kind, reason: 'ui_prompt' },
    ]);
    assert.equal(mode.extensionDialogs.length, 0, 'native stack must remove the completed dialog');
    assert.deepEqual(mode.editorContainer.children, [editor], 'Pi must restore its editor dock');
    assert.equal(endFocus, editor, 'Pi restores editor focus before delivering ui_prompt_end');
    assert.equal(host.suspended, false);
    assert.equal(host.currentPrimary, expectedPrimary);
    assert.equal(layout.mounted, open, 'restore the requested split state');
    assert.equal(host.sidebarRequestedOpen, open);
    const expectedFocus = primary ? activePrimary : editor;
    assert.notEqual(tui.getFocusedComponent(), dialog, 'prompt end must never resurrect a finished/disposed dialog');
    assert.equal(tui.getFocusedComponent(), expectedFocus, 'restore editor/active-primary focus after prompt end');
    assert.equal(editor.getText(), DRAFT, 'dialog must preserve the main draft');
    assert.equal(primaryDisposals, 0, 'native prompt must not dispose the active primary');
    terminal.send('z');
    await nextTurn();
    assert.deepEqual(dialogInputs, [ENTER], 'later input must not return to the finished dialog');
    assert.equal(tui.getFocusedComponent(), expectedFocus, 'a later render/input must preserve restored focus');
    assert.deepEqual(mainInputs, primary ? [] : ['z']);
    assert.deepEqual(primaryInputs, primary ? ['z'] : []);
    assert.equal(editor.getText(), primary ? DRAFT : `${DRAFT}z`);
    assert.equal(fleetOpens, 1);
  } finally {
    // Emergency cancellation is cleanup only, after the tested Enter path. Native selectors
    // and QuestionDialog use their real abort handlers; ApprovalDialog has no abort option.
    abort.abort();
    for (const { component } of [...mode.extensionDialogs].reverse()) component.handleInput?.(ESCAPE);
    try {
      if (prompt) await bounded('prompt cleanup', prompt.catch(() => {}), 500);
      await nextTurn(); // let the runner finish queued prompt-end handlers before disposing host
    } finally {
      try {
        release?.();
        fleet?.dispose();
        primaryDone?.();
        host.dispose();
        if (primaryClosed) await bounded('primary cleanup', primaryClosed, 500);
      } finally {
        try {
          mode.clearExtensionTerminalInputListeners();
          mode.clearExtensionWidgets();
          editor.dispose?.();
        } finally {
          tui.stop();
          runtime.invalidate('Focus fixture disposed');
        }
      }
    }
  }
}

const previous = getKeybindings();
const failures = [];
let cases = 0;
try {
  initTheme('dark', false);
  for (const footerFirst of [true, false]) {
    for (const width of [46, 120, 180]) for (const open of [false, true]) for (const primary of [false, true]) {
      for (const kind of ['select', 'confirm', 'question', 'approval']) {
        const label = `${kind}, ${width} columns, Sidebar ${open ? 'open' : 'closed'}, ${primary ? 'active primary' : 'main'}, ${footerFirst ? 'footer' : 'Sidebar'} handler first`;
        try {
          await testPrompt({ width, open, primary, footerFirst, kind });
        } catch (error) {
          failures.push(new Error(label, { cause: error }));
          console.error(`FAIL ${label}: ${error.message}`);
        }
        cases++;
      }
    }
    if (!failures.length) console.log(`PASS real Pi 1.4 select/confirm/QuestionDialog/ApprovalDialog focus with ${footerFirst ? 'footer' : 'Sidebar'} handler first; closed/open Sidebar and main/active primary at 46/120/180 columns`);
  }
  if (failures.length) throw new AggregateError(failures, `${failures.length}/${cases} dialog focus cases failed`);
  console.log(`PASS ${cases} dialog focus cases; real terminal Enter never escapes to main/Fleet, and prompt end never resurrects a finished dialog`);
} finally { setKeybindings(previous); }
