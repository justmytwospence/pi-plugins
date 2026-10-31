import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import { Container, Editor, getKeybindings, setKeybindings, matchesKey, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
const { TuiBase } = await import(new URL('./tui.js', import.meta.resolve('@earendil-works/pi-tui')));
import { CustomEditor } from '@earendil-works/pi-coding-agent';
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
const { InteractiveMode } = await import(new URL('./modes/interactive/interactive-mode.js',
  process.env.PI_TEST_SDK ? pathToFileURL(process.env.PI_TEST_SDK) : import.meta.resolve('@earendil-works/pi-coding-agent')));

// Test-only sibling loading: runtime code has no dependency on pi-vim.
const jiti = createJiti(import.meta.url, { alias: Object.fromEntries(
  ['@earendil-works/pi-tui', '@earendil-works/pi-coding-agent'].map(name => [name, fileURLToPath(import.meta.resolve(name))]),
) });
const { default: install } = await jiti.import(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const sibling = (...parts) => fileURLToPath(new URL(['..', '..', ...parts].join('/'), import.meta.url));
const { MainEditor } = await jiti.import(sibling('pi-vim', 'src', 'main-editor.ts'));
const { EmbeddedEditor } = await jiti.import(sibling('pi-vim', 'src', 'embedded-editor.ts'));
const { setPiVimSettingsReaderForTests } = await jiti.import(sibling('pi-vim', 'src', 'engine', 'settings.ts'));
setPiVimSettingsReaderForTests(() => ({}));

const SURFACE = Symbol.for('pi-plugins.editor-surface.v1');
const MODE = Symbol.for('pi-plugins.editor-mode.v1');
const SNAPSHOT = Symbol.for('pi-plugins.editor-snapshot.v1');
const PREV = '\x10', NEXT = '\x0e', SEARCH = '\x12', ESC = '\x1b';
const identity = text => text;
const editorTheme = { borderColor: identity, selectList: {
  selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity,
} };
const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: identity };
const entries = texts => texts.map((text, index) => ({
  type: 'message', id: String(index), parentId: index ? String(index - 1) : null,
  timestamp: new Date(0).toISOString(), message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 },
}));

async function fixture(t, { vim = false, mode = 'tui', bindings = {}, draft = 'al', sdk = false, hardwareCursor = true } = {}) {
  const previous = getKeybindings();
  const keys = new KeybindingsManager({ 'tui.editor.historyPrevious': 'ctrl+p', 'tui.editor.historyNext': 'ctrl+n', ...bindings });
  setKeybindings(keys);
  t.after(() => setKeybindings(previous));
  const events = new Map(), shortcuts = new Map(), commands = new Map(), listeners = new Set();
  const notices = [], widgets = [], submissions = [];
  let focus, main, picker, close, pending, customOptions, opens = 0, renders = 0, removed = 0, reads = 0;
  let branch = entries(['alpha old', 'unrelated', 'alpha new']), session = 'session', leaf = 'leaf';
  // Delegate cursor state to the real public TuiBase API, including its hide
  // side effect, without starting a terminal or scheduling render timers.
  const terminal = { rows: 30, columns: 80, hideCursor() {} };
  const cursorUi = new TuiBase(terminal, hardwareCursor);
  cursorUi.requestRender = () => { renders++; };
  const tui = {
    requestRender() { renders++; }, getFocusedComponent: () => focus, terminal,
    getShowHardwareCursor: () => cursorUi.getShowHardwareCursor(),
    setShowHardwareCursor: enabled => cursorUi.setShowHardwareCursor(enabled),
  };
  function wire(editor) {
    editor.focused = true;
    editor.onSubmit = text => submissions.push(text);
    // The SDK installs exactly this extension-shortcut callback on CustomEditor.
    editor.onExtensionShortcut = data => {
      for (const [key, shortcut] of shortcuts) if (matchesKey(data, key)) {
        pending = Promise.resolve(shortcut.handler(ctx));
        return true;
      }
      return false;
    };
    return editor;
  }
  main = wire(vim ? new MainEditor(tui, editorTheme, keys) : new CustomEditor(tui, editorTheme, keys));
  assert.ok(main instanceof Editor, 'use the actual native Editor base, not a text stub');
  main.setText(draft);
  focus = main;
  const dock = new Container();
  dock.addChild(main);
  const sdkHost = Object.setPrototypeOf({
    get editor() { return main; }, set editor(value) { main = wire(value); },
    defaultEditor: main, editorContainer: dock, keybindings: keys,
    ui: { ...tui, setFocus(component) { focus = component; } },
    extensionDialogs: [], programStatus: { setBlocked() {} },
    disposeActiveSelector() {},
  }, InteractiveMode.prototype);
  const ctx = { mode, sessionManager: {
    getBranch: () => { reads++; return branch; }, getSessionId: () => session, getLeafId: () => leaf,
  }, ui: {
    notify: (message, type) => notices.push({ message, type }),
    getEditorText: () => main.getExpandedText(), setEditorText: text => main.setText(text),
    setEditorComponent: () => assert.fail('history-search must not replace the editor'),
    getEditorComponent: () => assert.fail('getEditorComponent is a factory, not focus inspection'),
    setWidget: (key, factory) => { widgets.push([key, !!factory]); if (factory) factory(tui); },
    onTerminalInput: handler => { listeners.add(handler); let active = true; return () => {
      if (active) { removed++; active = false; listeners.delete(handler); }
    }; },
    custom: (factory, options) => {
      opens++; customOptions = options;
      if (sdk) {
        // Execute the SDK's real asynchronous factory/done/dispose path against
        // the same native editor and dock used by dispatch and rendering tests.
        return sdkHost.showExtensionCustom((...args) => {
          picker = factory(...args);
          const component = picker;
          close = value => component.done(value);
          return component;
        }, options);
      }
      return new Promise(resolve => {
        const savedText = main.getText();
        let finished = false;
        const nativeDone = value => {
          if (finished) return;
          finished = true;
          dock.clear(); dock.addChild(main);
          main.setText(savedText);
          focus = main;
          resolve(value);
        };
        picker = factory(tui, theme, keys, nativeDone);
        const component = picker;
        close = value => component.done(value);
        dock.clear(); dock.addChild(picker);
        focus = picker;
        picker.focused = true;
      });
    },
  } };
  install({ on: (event, handler) => events.set(event, handler),
    registerShortcut: (key, value) => shortcuts.set(key, value), registerCommand: (key, value) => commands.set(key, value) });
  const emit = event => events.get(event)?.({}, ctx);
  await emit('session_start');
  t.after(async () => { await emit('session_shutdown'); main.dispose?.(); });
  const send = (...data) => {
    const results = [];
    for (const key of data) {
      let consumed = false;
      for (const listener of listeners) { const result = listener(key); results.push(result); if (result?.consume) { consumed = true; break; } }
      if (!consumed) focus?.handleInput?.(key);
    }
    return results;
  };
  return { ctx, tui, keys, get main() { return main; }, dock, notices, widgets, submissions, listeners, shortcuts, commands, emit, send, wire,
    command: args => commands.get('history-search').handler(args, ctx),
    get picker() { return picker; }, get close() { return close; }, get pending() { return pending; },
    get opens() { return opens; }, get reads() { return reads; }, get removed() { return removed; },
    get renders() { return renders; }, get customOptions() { return customOptions; },
    set focus(value) { focus = value; }, get focus() { return focus; },
    set branch(value) { branch = entries(value); }, set leaf(value) { leaf = value; }, set session(value) { session = value; },
    replace(editor) { main = wire(editor); focus = main; },
    sdkReplace(editor) { sdkHost.setCustomEditorComponent(() => editor); },
  };
}

test('factory registrations, probe removal and native prefix boundaries use configured actions', async t => {
  const f = await fixture(t);
  assert.equal(f.shortcuts.get('ctrl+r').description, 'Search session prompt history');
  assert.equal(f.commands.get('history-search').description, 'Search prompts from this session');
  assert.deepEqual(f.widgets.map(([, active]) => active), [true, false]);
  assert.equal(f.listeners.size, 1);
  assert.deepEqual(f.send(PREV), [{ consume: true }]);
  assert.equal(f.main.getText(), 'alpha new');
  f.branch = ['alpha changed']; // candidates are frozen until browsing ends
  f.send('\x1b[112;5:3u', PREV, PREV);
  assert.equal(f.main.getText(), 'alpha old');
  assert.equal(f.reads, 1);
  f.send(NEXT, NEXT);
  assert.equal(f.main.getText(), 'al');
  f.send(NEXT);
  assert.equal(f.main.getText(), 'al');
  assert.equal(f.submissions.length, 0);
  assert.ok(f.renders > 0);
});

test('empty native browsing remains native across repeated recalls; nonhistory and external edits restart', async t => {
  const f = await fixture(t, { draft: '' });
  f.main.addToHistory('native old'); f.main.addToHistory('native new');
  assert.deepEqual(f.send(PREV, PREV), [undefined, undefined]);
  assert.equal(f.main.getText(), 'native old');
  assert.equal(f.reads, 0);
  f.send(NEXT); assert.equal(f.main.getText(), 'native new');
  f.main.setText('al');
  f.send('\x1b[D', PREV); assert.equal(f.main.getText(), 'alpha new');
  f.main.setText('un');
  f.send(PREV); assert.equal(f.main.getText(), 'unrelated');
  assert.equal(f.reads, 2);
  f.send('\r'); await f.emit('input');
  f.main.setText('al'); f.send(NEXT);
  assert.equal(f.reads, 2, 'newer alone does not reconstruct a branch');
  f.branch = ['alpha after']; f.send(PREV);
  assert.equal(f.main.getText(), 'alpha after');
});

test('expanded collapsed-paste drafts seed search and prefix matching without dangling markers', async t => {
  const f = await fixture(t, { draft: '' });
  const draft = 'al\n' + 'x'.repeat(1100);
  f.send(`\x1b[200~${draft}\x1b[201~`);
  assert.match(f.main.getText(), /\[paste #/);
  assert.equal(f.main.getExpandedText(), draft);
  f.branch = [`${draft} old`, `${draft} new`];
  f.send(PREV); assert.equal(f.main.getText(), `${draft} new`);
  f.send(NEXT); assert.equal(f.main.getText(), draft);
  f.send(SEARCH);
  const rows = f.picker.render(2000).join('\n');
  assert.ok(rows.includes('search: al ' + 'x'.repeat(1100)), 'seed is expanded and flattened');
  f.send(ESC); await f.pending;
  assert.equal(f.main.getText(), draft);
});

test('tree navigation and submission reset frozen prefixes even when editor text stays unchanged', async t => {
  const f = await fixture(t);
  f.send(PREV); assert.equal(f.reads, 1);
  await f.emit('session_tree'); f.branch = ['alpha new follow-up'];
  f.send(PREV); assert.equal(f.main.getText(), 'alpha new follow-up'); assert.equal(f.reads, 2);
  await f.emit('input'); f.branch = ['alpha new follow-up again'];
  f.send(PREV); assert.equal(f.main.getText(), 'alpha new follow-up again'); assert.equal(f.reads, 3);
});

for (const mode of ['json', 'print']) {
  test(`${mode} never installs a terminal listener or opens a picker`, async t => {
    const f = await fixture(t, { mode });
    assert.equal(f.listeners.size, 0);
    await f.command('');
    assert.equal(f.opens, 0);
    assert.equal(f.notices.at(-1).message, 'Prompt history search requires the interactive terminal UI.');
  });
}

test('remapped and unassigned actions, ordinary arrows and unmatched nonempty prefixes', async t => {
  const f = await fixture(t, { bindings: { 'tui.editor.historyPrevious': 'ctrl+y', 'tui.editor.historyNext': [] } });
  assert.equal(f.send(PREV)[0], undefined);
  assert.equal(f.send(NEXT)[0], undefined);
  assert.equal(f.send('\x1b[A')[0], undefined);
  f.main.setText('al'); f.send('\x19'); assert.equal(f.main.getText(), 'alpha new');
  f.main.setText('no match');
  assert.deepEqual(f.send('\x19'), [{ consume: true }]);
  assert.equal(f.main.getText(), 'no match');
});

test('only actual focused main editors own history, never same-text dialogs or embedded surfaces', async t => {
  const f = await fixture(t);
  const other = new Editor(f.tui, editorTheme); other.setText('al');
  f.focus = other;
  assert.equal(f.send(PREV)[0], undefined); assert.equal(f.reads, 0);
  other[SURFACE] = 'embedded'; f.focus = other;
  assert.equal(f.send(PREV)[0], undefined);
  f.focus = f.main; f.send(PREV); assert.equal(f.main.getText(), 'alpha new');
  f.focus = other; f.send('x'); f.focus = f.main; f.main.setText('al'); f.send(PREV);
  assert.equal(f.reads, 2);
  const replacement = new CustomEditor(f.tui, editorTheme, f.keys);
  replacement[SURFACE] = 'main'; replacement.setText('un'); f.replace(replacement);
  f.send(PREV); assert.equal(replacement.getText(), 'unrelated');
  replacement.isShowingAutocomplete = () => true;
  assert.equal(f.send(PREV)[0], undefined);
});

test('non-TUI sessions, unavailable focus and repeated lifecycle cleanup leave native input alone', async t => {
  const f = await fixture(t, { mode: 'rpc' });
  assert.equal(f.listeners.size, 0); assert.equal(f.widgets.length, 0);
  await f.command(''); assert.match(f.notices.at(-1).message, /requires the interactive terminal UI/);
  await f.command('bad'); assert.equal(f.notices.at(-1).message, 'Usage: /history-search');
  f.ctx.mode = 'tui'; await f.emit('session_start'); assert.equal(f.listeners.size, 1);
  const retained = [...f.listeners][0];
  await f.emit('session_start'); assert.equal(f.listeners.size, 1); assert.equal(f.removed, 1);
  assert.equal(retained(PREV), undefined, 'retained callbacks from an old installation are inert');
  assert.equal(f.main.getText(), 'al');
  await f.emit('session_shutdown'); await f.emit('session_shutdown');
  assert.equal(f.listeners.size, 0); assert.equal(f.removed, 2);
  await f.emit('session_start'); assert.equal(f.listeners.size, 1);
  f.tui.getFocusedComponent = undefined;
  await f.emit('session_start'); assert.equal(f.listeners.size, 0);
  assert.equal(f.notices.at(-1).message, 'history-search: focus inspection unavailable; prefix navigation disabled');
});

test('native Ctrl+R dispatch opens one prompt dock, cancellation preserves text, accept never submits', async t => {
  const f = await fixture(t, { draft: '' });
  f.send(SEARCH); assert.equal(f.opens, 1);
  assert.equal(f.customOptions, undefined);
  await f.command(''); assert.equal(f.opens, 1, 'concurrent command cannot open a second picker');
  f.send(ESC); await f.pending;
  assert.equal(f.main.getText(), ''); assert.deepEqual(f.submissions, []);
  f.branch = ['full\nmultiline']; f.send(SEARCH, '\r'); await f.pending;
  assert.equal(f.main.getText(), 'full\nmultiline'); assert.deepEqual(f.submissions, []);
  f.branch = []; await f.command('');
  assert.equal(f.notices.at(-1).message, 'No prompts in this session yet.');
});

for (const columns of [46, 120]) for (const footerRows of [0, 12]) {
  test(`ordinary custom dock stays compact at ${columns} columns with ${footerRows} footer rows`, async t => {
    const draft = 'private unsent draft';
    const f = await fixture(t, { draft });
    const ui = new TuiBase({ rows: 40, columns, hideCursor() {} });
    ui.requestRender = () => {};
    ui.addChild({ render: () => ['CONVERSATION SENTINEL'], invalidate() {} });
    ui.addChild(f.dock);
    ui.addChild({ render: () => Array.from({ length: footerRows }, (_, i) => `footer ${i}`), invalidate() {} });
    f.branch = Array.from({ length: 24 }, (_, i) => `history result ${i}`);
    const pending = f.command('');
    assert.equal(f.picker.focused, true);
    f.send('\x15');
    for (let i = 0; i < 23; i++) f.send('\x1b[B');
    for (const rows of [30, 8, 6, 3, 2, 1, 40]) {
      const rendered = f.picker.render(columns, rows);
      assert.ok(rendered.length <= Math.min(13, rows));
      assert.ok(rendered.every(line => visibleWidth(line) <= columns));
      assert.ok(rendered.every(line => stripTerminalSequences(line).trim().length > 0), 'no blank padding');
      const text = rendered.map(stripTerminalSequences).join('\n');
      assert.ok(text.includes('search:'));
      if (rows >= 2) assert.ok(text.includes('› history result 0'));
      else assert.ok(!text.includes('history result'), 'one-row viewport shows only the query');
    }
    const screen = ui.render(columns).map(stripTerminalSequences).join('\n');
    assert.ok(screen.includes('CONVERSATION SENTINEL'));
    if (footerRows) assert.ok(screen.includes('footer 0'));
    assert.ok(!screen.includes(draft));
    f.send(ESC); await pending;
    assert.equal(f.focus, f.main);
    assert.equal(f.main.getExpandedText(), draft);
    assert.deepEqual(f.submissions, []);
  });
}

for (const draft of ['', 'multiline\ndraft', Array.from({ length: 12 }, (_, i) => `line ${i} ` + 'x'.repeat(100)).join('\n')]) {
  test(`native cancellation preserves expanded draft of ${draft.length} characters`, async t => {
    const f = await fixture(t, { draft: '' });
    if (draft) f.send(`\x1b[200~${draft}\x1b[201~`);
    if (draft.length > 1000) assert.match(f.main.getText(), /\[paste #/);
    f.send(SEARCH, ESC); await f.pending;
    assert.equal(f.main.getExpandedText(), draft);
    assert.ok(!f.main.getText().includes('[paste #'));
    assert.deepEqual(f.submissions, []);
  });
}

for (const accept of [false, true]) for (const paste of [false, true]) {
  test(`external ${paste ? 'collapsed paste' : 'draft'} survives ${accept ? 'stale acceptance' : 'cancel'}`, async t => {
    const f = await fixture(t, { draft: '' });
    f.send(SEARCH);
    const text = paste ? 'external\n' + 'x'.repeat(1200) : 'external draft';
    if (paste) f.main.handleInput(`\x1b[200~${text}\x1b[201~`);
    else f.main.setText(text);
    f.send(accept ? '\r' : ESC); await f.pending;
    assert.equal(f.main.getExpandedText(), text);
    assert.ok(!f.main.getText().includes('[paste #'));
    assert.deepEqual(f.submissions, []);
  });
}

for (const accept of [false, true]) for (const paste of [false, true]) {
  test(`post-close ${paste ? 'collapsed paste' : 'edits'} survive ${accept ? 'acceptance' : 'cancel'} before the promise continuation`, async t => {
    const f = await fixture(t, { draft: '', sdk: true });
    f.send(SEARCH);
    await Promise.resolve();
    f.main.setText('changed while open');
    f.send(accept ? '\r' : ESC);
    const text = paste ? 'post-close\n' + 'x'.repeat(1200) : 'typed immediately after close';
    f.main.setText('');
    if (paste) f.main.handleInput(`\x1b[200~${text}\x1b[201~`);
    else f.main.setText(text);
    await f.pending;
    assert.equal(f.main.getExpandedText(), text);
    if (paste) assert.match(f.main.getText(), /\[paste #/u, 'guard must be removed synchronously at close');
  });
}

for (const accept of [false, true]) {
  test(`replacement editor draft survives ${accept ? 'stale acceptance' : 'cancel'}`, async t => {
    const f = await fixture(t, { draft: 'al' });
    f.send(SEARCH);
    const close = f.close, pending = f.pending;
    const replacement = new CustomEditor(f.tui, editorTheme, f.keys);
    replacement[SURFACE] = 'main';
    f.replace(replacement);
    const draft = 'replacement\n' + 'x'.repeat(1200);
    replacement.handleInput(`\x1b[200~${draft}\x1b[201~`);
    close(accept ? 'stale selection' : undefined);
    await pending;
    assert.equal(replacement.getExpandedText(), draft);
    assert.doesNotMatch(replacement.getText(), /\[paste #/u);
  });
}

test('stacked ordinary custom UI cannot save dangling paste markers from history', async t => {
  const f = await fixture(t, { draft: '' });
  const draft = Array.from({ length: 12 }, (_, i) => `line ${i} ` + 'x'.repeat(100)).join('\n');
  f.send(`\x1b[200~${draft}\x1b[201~`);
  assert.match(f.main.getText(), /\[paste #/u);
  f.send(SEARCH);
  const closeHistory = f.close, pending = f.pending;
  let closeStacked;
  const stacked = f.ctx.ui.custom((_ui, _theme, _keys, done) => {
    closeStacked = done;
    return { render: () => ['another dialog'], invalidate() {} };
  });
  closeHistory(undefined);
  await pending;
  closeStacked(undefined);
  await stacked;
  assert.equal(f.main.getExpandedText(), draft);
  assert.doesNotMatch(f.main.getText(), /\[paste #/u);
});

test('real SDK editor replacement releases copied draft listener and forwards new text', async t => {
  const f = await fixture(t, { draft: '', sdk: true });
  const changes = [];
  const original = f.main.onChange = text => changes.push(text);
  const initial = f.main;
  f.send(SEARCH);
  await Promise.resolve();
  const closeHistory = f.close, pending = f.pending;
  const replacement = new CustomEditor(f.tui, editorTheme, f.keys);
  replacement[SURFACE] = 'main';
  f.sdkReplace(replacement);
  const draft = 'replacement\n' + 'x'.repeat(1200);
  replacement.handleInput(`\x1b[200~${draft}\x1b[201~`);
  assert.equal(replacement.getText(), draft);
  closeHistory(undefined);
  await pending;
  assert.equal(initial.onChange, original);
  assert.equal(replacement.onChange, original, 'remove guard copied by SDK replacement');
  assert.equal(replacement.getExpandedText(), draft);
  replacement.setText('!echo hello');
  assert.equal(changes.at(-1), '!echo hello', 'original listener must receive the new editor text');
});

for (const accept of [false, true]) {
  test(`fresh Vim SDK replacement retains external paste on ${accept ? 'stale acceptance' : 'cancel'}`, async t => {
    const f = await fixture(t, { draft: '', sdk: true });
    const changes = [];
    f.main.onChange = text => changes.push(text);
    f.send(SEARCH);
    await Promise.resolve();
    const closeHistory = f.close, pending = f.pending;
    const replacement = new MainEditor(f.tui, editorTheme, f.keys);
    t.after(() => replacement.dispose());
    // Do not send any input before replacement: the first paste installs Vim's
    // lazy hook around the SDK-copied listener and calls that listener unbound.
    f.sdkReplace(replacement);
    const draft = 'fresh Vim replacement\n' + 'x'.repeat(1200);
    assert.doesNotThrow(() => replacement.handleInput(`\x1b[200~${draft}\x1b[201~`));
    assert.equal(replacement.getText(), draft);
    assert.deepEqual(changes, [draft], 'forward the expanded change exactly once');
    let closeOther;
    const other = f.ctx.ui.custom((_ui, _theme, _keys, done) => {
      closeOther = done;
      return { render: () => ['other ordinary dialog'], invalidate() {} };
    });
    await Promise.resolve();
    closeHistory(accept ? 'stale selection' : undefined);
    await pending;
    closeOther(undefined);
    await other;
    assert.equal(replacement.getExpandedText(), draft);
    assert.doesNotMatch(replacement.getText(), /\[paste #/u);
    const later = '\npost-close ' + 'z'.repeat(1200);
    assert.doesNotThrow(() => replacement.handleInput(`\x1b[200~${later}\x1b[201~`));
    assert.equal(replacement.getExpandedText(), draft + later);
    assert.match(replacement.getText(), /\[paste #/u, 'inactive copied guard must not expand subsequent pastes');
    assert.equal(changes.at(-1), replacement.getText());
    assert.deepEqual(f.submissions, []);
    assert.deepEqual(f.notices, []);
  });
}

for (const vim of [false, true]) for (const accept of [false, true]) {
  test(`real SDK concurrent dialogs preserve external paste (${vim ? 'Vim' : 'native'}, ${accept ? 'stale accept' : 'cancel'})`, async t => {
    const f = await fixture(t, { draft: '', sdk: true, vim });
    const changes = [];
    f.main.onChange = text => changes.push(text);
    f.send(''); // Let optional Vim install its lazy change listener first.
    const original = f.main.onChange;
    f.send(SEARCH);
    await Promise.resolve(); // SDK installs the factory's component asynchronously.
    const closeHistory = f.close, pending = f.pending;
    const draft = 'external while history is open\n' + 'x'.repeat(1200);
    f.main.handleInput(`\x1b[200~${draft}\x1b[201~`);
    assert.equal(f.main.getText(), draft, 'no raw marker can enter another dialog snapshot');
    assert.deepEqual(changes, [draft], 'forward expanded change exactly once');
    let closeOther, disposed = false;
    const other = f.ctx.ui.custom((_ui, _theme, _keys, done) => {
      closeOther = done;
      return { render: () => ['other ordinary dialog'], invalidate() {}, dispose() { disposed = true; } };
    });
    await Promise.resolve();
    closeHistory(accept ? 'stale selection' : undefined);
    assert.equal(f.main.onChange, original, 'restore listener synchronously, not in the continuation');
    await pending;
    closeOther(undefined);
    await other;
    assert.ok(disposed, 'exercise SDK dispose path too');
    assert.equal(f.main.getExpandedText(), draft);
    assert.doesNotMatch(f.main.getText(), /\[paste #/u);
    assert.deepEqual(f.submissions, []);
    const later = '\npost-close ' + 'z'.repeat(1200);
    f.main.handleInput(`\x1b[200~${later}\x1b[201~`);
    assert.equal(f.main.getExpandedText(), draft + later);
    assert.match(f.main.getText(), /\[paste #/u, 'normal native collapsing resumes after close');
  });
}

for (const change of ['draft', 'session', 'leaf', 'editor', 'tree', 'input', 'shutdown', 'restart']) {
  test(`stale picker cannot overwrite after ${change}`, async t => {
    const f = await fixture(t, { draft: '' });
    const onChange = f.main.onChange;
    const originalEditor = f.main;
    f.send(SEARCH); const pending = f.pending, oldClose = f.close;
    if (change === 'draft') f.main.setText('new draft');
    if (change === 'session') f.session = 'different';
    if (change === 'leaf') f.leaf = 'different';
    if (change === 'editor') { const replacement = new CustomEditor(f.tui, editorTheme, f.keys); replacement[SURFACE] = 'main'; f.replace(replacement); }
    if (change === 'tree') await f.emit('session_tree');
    if (change === 'input') await f.emit('input');
    if (change === 'shutdown') await f.emit('session_shutdown');
    if (change === 'restart') await f.emit('session_start');
    oldClose('stale selection'); await pending;
    assert.equal(originalEditor.onChange, onChange, 'release draft guard even on lifecycle cancellation');
    assert.notEqual(f.main.getText(), 'stale selection');
    assert.deepEqual(f.submissions, []);
  });
}

test('shutdown closes outstanding picker and UI failures release the open guard', async t => {
  const f = await fixture(t, { draft: '' });
  f.send(SEARCH); const pending = f.pending;
  await f.emit('session_shutdown'); await pending;
  await f.emit('session_start');
  const custom = f.ctx.ui.custom;
  const onChange = f.main.onChange;
  f.ctx.ui.custom = () => { throw new Error('UI failed'); };
  await f.command(''); assert.deepEqual(f.notices.at(-1), { message: 'history-search: UI failed', type: 'error' });
  assert.equal(f.main.onChange, onChange, 'release draft guard when custom UI throws');
  f.ctx.ui.custom = custom;
  f.send(SEARCH); assert.equal(f.opens, 2); f.close(undefined); await f.pending;
});

for (const hardwareCursor of [true, false]) {
  for (const sdk of [false, true]) for (const accept of [false, true]) {
    test(`hardware cursor preference stays unchanged through native done and continuation (${hardwareCursor}, ${sdk ? 'SDK' : 'fixture'}, ${accept ? 'accept' : 'cancel'})`, async t => {
      const f = await fixture(t, { draft: '', hardwareCursor, sdk });
      const setCursor = f.tui.setShowHardwareCursor;
      f.tui.setShowHardwareCursor = () => assert.fail('history-search must not set the hardware cursor preference');
      const custom = f.ctx.ui.custom;
      let doneCalls = 0, continued = false;
      f.ctx.ui.custom = (factory, options) => custom((ui, theme, keys, done) => {
        assert.equal(ui.getShowHardwareCursor(), hardwareCursor, 'preference is unchanged before the custom factory runs');
        const component = factory(ui, theme, keys, value => {
          doneCalls++;
          assert.equal(ui.getShowHardwareCursor(), hardwareCursor, 'preference is unchanged before native done');
          assert.equal(continued, false);
          done(value);
        });
        assert.equal(ui.getShowHardwareCursor(), hardwareCursor, 'preference is unchanged while the picker owns the dock');
        return component;
      }, options);
      f.send(SEARCH);
      if (sdk) await Promise.resolve();
      const pending = f.pending.then(() => { continued = true; });
      assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
      f.send(accept ? '\r' : ESC);
      assert.equal(doneCalls, 1);
      assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
      assert.equal(continued, false, 'native done must not wait for the pending search');
      assert.equal(f.main.getText(), '', 'acceptance is still pending');
      await pending;
      assert.equal(f.main.getText(), accept ? 'alpha new' : '');
      assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
      // A finally from the old search must not overwrite a subsequent setting.
      setCursor(!hardwareCursor);
      f.close(undefined);
      assert.equal(f.tui.getShowHardwareCursor(), !hardwareCursor, 'late duplicate close is inert');
    });
  }

  for (const event of ['input', 'session_tree', 'session_shutdown', 'session_start']) {
    test(`hardware cursor preference stays unchanged on ${event} (initial ${hardwareCursor})`, async t => {
      const f = await fixture(t, { draft: '', hardwareCursor });
      const setCursor = f.tui.setShowHardwareCursor;
      f.tui.setShowHardwareCursor = () => assert.fail('history-search must not set the hardware cursor preference');
      f.send(SEARCH);
      const pending = f.pending, close = f.close;
      assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
      const emitted = f.emit(event);
      assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor, 'event leaves preference unchanged before its promise continuation');
      setCursor(!hardwareCursor);
      await emitted;
      await pending;
      close('stale selection');
      assert.equal(f.tui.getShowHardwareCursor(), !hardwareCursor, 'finally and stale close cannot overwrite an external preference change');
      assert.equal(f.main.getText(), '');
    });
  }

  for (const failure of ['factory', 'async UI']) {
    test(`hardware cursor preference stays unchanged after ${failure} failure (initial ${hardwareCursor})`, async t => {
      const f = await fixture(t, { draft: '', hardwareCursor });
      const custom = f.ctx.ui.custom;
      f.tui.setShowHardwareCursor = () => assert.fail('history-search must not set the hardware cursor preference');
      const onChange = f.main.onChange;
      const error = new Error(`${failure} failed`);
      if (failure === 'factory') {
        f.ctx.ui.custom = (factory, options) => custom((...args) => {
          factory(...args);
          assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
          throw error;
        }, options);
      } else {
        f.ctx.ui.custom = async factory => {
          factory(f.tui, theme, f.keys, () => assert.fail('rejected UI must not call done'));
          assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
          await Promise.resolve();
          throw error;
        };
      }
      await f.command('');
      assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
      assert.deepEqual(f.notices.at(-1), { message: `history-search: ${error.message}`, type: 'error' });
      assert.equal(f.main.onChange, onChange, 'failure releases the draft guard');
      f.ctx.ui.custom = custom;
      f.send(SEARCH);
      assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor, 'reopening leaves preference unchanged');
      assert.equal(f.opens, failure === 'factory' ? 2 : 1, 'failure releases the open guard');
      f.send(ESC);
      await f.pending;
      assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
    });
  }

  test(`hardware cursor preference stays unchanged when native done throws (initial ${hardwareCursor})`, async t => {
    const f = await fixture(t, { draft: '', hardwareCursor });
    const setCursor = f.tui.setShowHardwareCursor;
    f.tui.setShowHardwareCursor = () => assert.fail('history-search must not set the hardware cursor preference');
    let picker;
    f.ctx.ui.custom = factory => new Promise(resolve => {
      picker = factory(f.tui, theme, f.keys, () => {
        assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor, 'preference is unchanged before throwing native done');
        resolve(undefined);
        throw new Error('native done failed');
      });
    });
    const pending = f.command('');
    assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
    assert.throws(() => picker.handleInput(ESC), /native done failed/);
    assert.equal(f.tui.getShowHardwareCursor(), hardwareCursor);
    setCursor(!hardwareCursor);
    await pending;
    assert.equal(f.tui.getShowHardwareCursor(), !hardwareCursor, 'finally cannot overwrite an external change after done throws');
  });
}

test('real Vim engine dispatch: Insert searches; Normal Ctrl+R redoes without invoking the shortcut', async t => {
  const f = await fixture(t, { vim: true, draft: '' });
  assert.equal(f.main[MODE]().state, 'insert');
  f.send(SEARCH); assert.equal(f.opens, 1); f.send(ESC); await f.pending;
  f.send('a', 'b', 'c', ESC, 'u');
  assert.equal(f.main[MODE]().state, 'normal'); assert.equal(f.main.getText(), '');
  f.send(SEARCH);
  assert.equal(f.main.getText(), 'abc', 'Normal redo must execute in the actual Vim engine');
  assert.equal(f.opens, 1);
  f.main.setText('al'); f.send(PREV); assert.equal(f.main.getText(), 'alpha new', 'idle Normal prefix browsing');
  const command = f.command(''); assert.equal(f.opens, 2, 'command also works in Normal');
  f.close(undefined); await command;
});

test('real Vim EX, Visual, pending, autocomplete and embedded focus retain local ownership', async t => {
  const f = await fixture(t, { vim: true });
  for (const sequence of [[ESC, ':'], [ESC, 'v'], [ESC, 'd'], [ESC, '2']]) {
    f.main[SNAPSHOT].restore({ version: 1, text: 'al', cursor: { line: 0, col: 0 }, mode: 'insert' });
    f.send(...sequence);
    assert.ok(['ex', 'visual', 'pending'].includes(f.main[MODE]().state));
    assert.equal(f.send(PREV)[0], undefined);
    await f.shortcuts.get('ctrl+r').handler(f.ctx); // explicit handler guard, in addition to actual engine dispatch
    f.send(SEARCH); assert.equal(f.opens, 0);
  }
  f.main[SNAPSHOT].restore({ version: 1, text: 'al', cursor: { line: 0, col: 0 }, mode: 'insert' });
  const autocomplete = f.main.isShowingAutocomplete;
  f.main.isShowingAutocomplete = () => true;
  assert.equal(f.send(PREV)[0], undefined);
  await f.shortcuts.get('ctrl+r').handler(f.ctx); assert.equal(f.opens, 0);
  f.main.isShowingAutocomplete = autocomplete;
  const embedded = new EmbeddedEditor({ surface: 'embedded', tui: f.tui, theme: editorTheme, keybindings: f.keys, initialText: 'al' });
  t.after(() => embedded.dispose()); f.wire(embedded); f.focus = embedded;
  assert.equal(f.send(PREV)[0], undefined); f.send(SEARCH);
  assert.equal(f.opens, 0); assert.equal(f.main.getText(), 'al');
});
