import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { Editor, getKeybindings, setKeybindings, matchesKey, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
const { TuiBase } = await import(new URL('./tui.js', import.meta.resolve('@earendil-works/pi-tui')));
import { CustomEditor } from '@earendil-works/pi-coding-agent';
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', import.meta.resolve('@earendil-works/pi-coding-agent')));

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

async function fixture(t, { vim = false, mode = 'tui', bindings = {}, draft = 'al' } = {}) {
  const previous = getKeybindings();
  const keys = new KeybindingsManager({ 'tui.editor.historyPrevious': 'ctrl+p', 'tui.editor.historyNext': 'ctrl+n', ...bindings });
  setKeybindings(keys);
  t.after(() => setKeybindings(previous));
  const events = new Map(), shortcuts = new Map(), commands = new Map(), listeners = new Set();
  const notices = [], widgets = [], submissions = [];
  let focus, main, picker, close, pending, customOptions, opens = 0, renders = 0, removed = 0, reads = 0;
  let branch = entries(['alpha old', 'unrelated', 'alpha new']), session = 'session', leaf = 'leaf';
  const tui = { requestRender() { renders++; }, getFocusedComponent: () => focus, terminal: { rows: 30, columns: 80 } };
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
      return new Promise(resolve => {
        const originalFocus = focus;
        close = value => { focus = originalFocus; resolve(value); };
        picker = factory(tui, theme, keys, value => close(value));
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
  return { ctx, tui, keys, main, notices, widgets, submissions, listeners, shortcuts, commands, emit, send, wire,
    command: args => commands.get('history-search').handler(args, ctx),
    get picker() { return picker; }, get close() { return close; }, get pending() { return pending; },
    get opens() { return opens; }, get reads() { return reads; }, get removed() { return removed; },
    get renders() { return renders; }, get customOptions() { return customOptions; },
    set focus(value) { focus = value; }, get focus() { return focus; },
    set branch(value) { branch = entries(value); }, set leaf(value) { leaf = value; }, set session(value) { session = value; },
    replace(editor) { main = wire(editor); focus = main; },
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

test('native Ctrl+R dispatch opens one full-width overlay, cancellation is inert, accept never submits', async t => {
  const f = await fixture(t, { draft: '' });
  f.send(SEARCH); assert.equal(f.opens, 1);
  assert.deepEqual(f.customOptions, { overlay: true, overlayOptions: { width: '100%' } });
  await f.command(''); assert.equal(f.opens, 1, 'concurrent command cannot open a second picker');
  f.send(ESC); await f.pending;
  assert.equal(f.main.getText(), ''); assert.deepEqual(f.submissions, []);
  f.branch = ['full\nmultiline']; f.send(SEARCH, '\r'); await f.pending;
  assert.equal(f.main.getText(), 'full\nmultiline'); assert.deepEqual(f.submissions, []);
  f.branch = []; await f.command('');
  assert.equal(f.notices.at(-1).message, 'No prompts in this session yet.');
});

for (const columns of [46, 120]) for (const footerRows of [0, 12]) {
  test(`actual overlay hides populated native editor at ${columns} columns with ${footerRows} footer rows`, async t => {
    const draft = 'private unsent draft';
    const f = await fixture(t, { draft });
    const terminal = { rows: 30, columns, hideCursor() {} };
    const ui = new TuiBase(terminal);
    // Exercise the real TUI's layout/compositor without starting terminal I/O.
    ui.requestRender = () => {};
    ui.addChild(f.main);
    ui.addChild({ render: () => Array.from({ length: footerRows }, (_, i) => `footer ${i}`), invalidate() {} });
    ui.setFocus(f.main);
    const plain = lines => lines.map(stripTerminalSequences);
    const baseline = plain(ui.render(columns)).join('\n');
    assert.ok(baseline.includes(draft));
    assert.ok(baseline.includes('─'.repeat(columns)), 'the native editor frame is actually present underneath');
    const setText = f.main.setText;
    let writes = 0;
    f.main.setText = function (text) { writes++; return setText.call(this, text); };
    f.ctx.ui.custom = (factory, options) => new Promise(resolve => {
      const picker = factory(ui, theme, f.keys, value => {
        handle.hide();
        f.focus = f.main;
        resolve(value);
      });
      const handle = ui.showOverlay(picker, options.overlayOptions);
      f.focus = picker;
    });
    f.branch = Array.from({ length: 24 }, (_, i) => `history result ${i}`);
    const pending = f.command('');
    const picker = ui.getFocusedComponent();
    assert.equal(picker.focused, true);
    assert.equal(picker[Symbol.for('pi-plugins.input-context.v1')](), 'filter');
    picker.handleInput('\x15'); // clear the seeded filter, not the underlying draft
    for (let i = 0; i < 23; i++) picker.handleInput('\x1b[B');
    for (const rows of [30, 8, 6, 3, 1, 40]) {
      terminal.rows = rows;
      const rendered = picker.render(columns);
      assert.equal(rendered.length, rows, 'cover full height and clamp on short terminals after resize');
      assert.ok(rendered.every(line => visibleWidth(line) === columns), 'including blank rows, cover full width');
      const screen = plain(ui.compositeOverlays(ui.render(columns), columns, rows).slice(-rows)).join('\n');
      if (rows >= 4) assert.ok(screen.includes('Prompt history'));
      assert.ok(screen.includes('› history result 0'), 'selected last result stays visible after resize');
      assert.ok(!screen.includes(draft), 'underlying unsent draft is obscured');
      assert.ok(!screen.includes('─'.repeat(columns)), 'no native editor rule survives compositing');
      assert.ok(!screen.includes('footer '), 'even high footers are covered');
    }
    picker.handleInput(ESC);
    await pending;
    assert.equal(ui.getFocusedComponent(), f.main);
    assert.equal(f.main.getText(), draft);
    assert.equal(writes, 0, 'cancel does not even restore the editor through setText');
    assert.deepEqual(f.submissions, []);
  });
}

for (const change of ['draft', 'session', 'leaf', 'editor', 'tree', 'input', 'shutdown', 'restart']) {
  test(`stale picker cannot overwrite after ${change}`, async t => {
    const f = await fixture(t, { draft: '' });
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
  f.ctx.ui.custom = () => { throw new Error('UI failed'); };
  await f.command(''); assert.deepEqual(f.notices.at(-1), { message: 'history-search: UI failed', type: 'error' });
  f.ctx.ui.custom = custom;
  f.send(SEARCH); assert.equal(f.opens, 2); f.close(undefined); await f.pending;
});

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
