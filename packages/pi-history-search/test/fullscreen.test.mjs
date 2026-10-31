import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import headless from '@xterm/headless';

// Resolve *all* SDK and TUI imports against the requested installation, including
// the TS editors loaded by jiti. Mixing a 1.2 Editor with a 1.4 renderer is not a
// reproduction of the installed paint path.
const sdk = process.env.PI_TEST_SDK
  ? pathToFileURL(process.env.PI_TEST_SDK).href
  : import.meta.resolve('@earendil-works/pi-coding-agent');
const requireSdk = createRequire(sdk);
const tuiPath = requireSdk.resolve('@earendil-works/pi-tui');
const { Container, CURSOR_MARKER, TuiAltScreen, getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } = await import(pathToFileURL(tuiPath));
const { initTheme } = await import(sdk);
initTheme('dark', false);
const { InteractiveMode } = await import(new URL('./modes/interactive/interactive-mode.js', sdk));
const { createChatViewport } = await import(new URL('./modes/interactive/chat-viewport.js', sdk));
const { createInteractiveTuiReference } = await import(new URL('./modes/interactive/tui-renderer.js', sdk));
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdk));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-tui': tuiPath,
  '@earendil-works/pi-coding-agent': fileURLToPath(sdk),
} });
const { default: install } = await jiti.import(fileURLToPath(new URL('../src/index.ts', import.meta.url)));
const { MainEditor } = await jiti.import(fileURLToPath(new URL('../../pi-vim/src/main-editor.ts', import.meta.url)));
const { setPiVimSettingsReaderForTests } = await jiti.import(fileURLToPath(new URL('../../pi-vim/src/engine/settings.ts', import.meta.url)));
const identity = text => text;
const editorTheme = { borderColor: identity, selectList: {
  selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity,
} };
const plain = lines => lines.map(stripTerminalSequences);


function assertOrderedResults(lines, selected, query, normalScreen) {
  const queryRow = lines.findIndex(line => /^search:(?: |$)/.test(line));
  assert.ok(queryRow >= 0, lines.join('\n'));
  const headerRow = lines.findIndex(line => line.startsWith('╭ '));
  if (normalScreen) assert.ok(headerRow >= 0, 'normal screens retain the header');
  if (headerRow >= 0) {
    assert.match(lines[headerRow], /^╭ Prompt history .*╮$/);
    assert.equal(queryRow, headerRow + 1, 'header immediately precedes query');
  }
  const rows = lines.flatMap((line, row) => {
    const match = /^(› |  )history result (\d+)$/.exec(line);
    return match ? [{ row, id: Number(match[2]), selected: match[1] === '› ' }] : [];
  });
  assert.ok(rows.length <= 8);
  assert.equal(lines.filter(line => line.startsWith('› ')).length, selected === null || !rows.length ? 0 : 1);
  if (selected === null) {
    assert.equal(lines[queryRow + 1], 'No matches', lines.join('\n'));
    assert.equal(rows.length, 0);
  } else {
    assert.ok(rows.length > 0, 'the selected result remains visible');
    assert.deepEqual(rows.map(result => result.row),
      Array.from({ length: rows.length }, (_, i) => queryRow + 1 + i),
      'results form a contiguous block immediately after query');
    assert.equal(rows.find(result => result.selected)?.id, selected, lines.join('\n'));
    if (query === '') {
      const index = 19 - selected;
      const start = Math.max(0, Math.min(index - Math.floor(rows.length / 2), 20 - rows.length));
      assert.deepEqual(rows.map(result => result.id),
        Array.from({ length: rows.length }, (_, i) => 19 - start - i),
        'empty-query results remain newest-first with a centered, boundary-clamped window');
      assert.equal(rows.findIndex(result => result.selected), index - start,
        'the chevron stays at the selected result’s actual ordered position');
    }
  }
  if (normalScreen && selected !== null) assert.equal(rows.length, 8, 'normal screens show eight results');
  const countRow = lines.findIndex(line => /^\d+\/\d+$/.test(line));
  if (countRow >= 0) {
    assert.ok(countRow > queryRow + rows.length, 'count follows the result block');
    if (query === '') assert.equal(lines[countRow], `${selected === null ? 0 : 20 - selected}/20`);
  }
  return queryRow;
}

for (const hardwareCursor of [false, true]) for (const width of [46, 120, 180]) for (const footerRows of [0, 5, 13]) {
  test(`fullscreen native custom dock terminal writes (${width} columns, ${footerRows} footer rows, setting ${hardwareCursor})`, async t => {
    const previousKeys = getKeybindings();
    const keys = new KeybindingsManager();
    setKeybindings(keys);
    const restoreSettings = setPiVimSettingsReaderForTests(() => ({}));
    const writes = [];
    const xterm = new headless.Terminal({ cols: width, rows: 40, allowProposedApi: true });
    const write = data => { writes.push(data); xterm.write(data); };
    const terminal = {
      columns: width, rows: 40,
      write,
      hideCursor: () => write('\x1b[?25l'),
      showCursor: () => write('\x1b[?25h'),
      start() {}, stop() {},
    };
    const renderer = new TuiAltScreen(terminal, hardwareCursor);
    // Keep painting deterministic, but execute the real start/renderNow/stop and
    // fullscreen doRender implementation, not renderLayoutFrame alone.
    renderer.requestRender = () => {};
    const ui = createInteractiveTuiReference(() => renderer);
    const main = new MainEditor(ui, editorTheme, keys);
    const dock = new Container();
    dock.addChild(main);
    const footer = { render: () => Array.from({ length: footerRows }, (_, i) => `footer ${i}`), invalidate() {} };
    const { root } = createChatViewport({
      document: { render: () => ['CONVERSATION'], invalidate() {} },
      pendingMessages: new Container(), status: new Container(), editor: dock, footer, scrollbar: 'hidden',
    });
    renderer.setLayoutRoot(root);
    ui.setFocus(main);
    renderer.start();
    t.after(() => {
      main.dispose();
      renderer.stop();
      xterm.dispose();
      restoreSettings();
      setKeybindings(previousKeys);
    });
    const host = Object.setPrototypeOf({
      editor: main, defaultEditor: main, editorContainer: dock, keybindings: keys, ui,
      extensionDialogs: [], programStatus: { setBlocked() {} }, disposeActiveSelector() {},
    }, InteractiveMode.prototype);
    const handlers = new Map(), commands = new Map();
    const prompts = Array.from({ length: 20 }, (_, i) => `history result ${i}`);
    const ctx = { mode: 'tui', sessionManager: {
      getSessionId: () => 'session', getLeafId: () => 'leaf',
      getBranch: () => prompts.map((text, i) => ({ type: 'message', id: String(i),
        message: { role: 'user', content: [{ type: 'text', text }] } })),
    }, ui: {
      notify: message => assert.fail(message),
      getEditorText: () => main.getExpandedText(), setEditorText: text => main.setText(text),
      setWidget: (_key, factory) => factory?.(ui),
      onTerminalInput: listener => ui.addInputListener(listener),
      custom: (factory, options) => host.showExtensionCustom(factory, options),
    } };
    install({ on: (event, handler) => handlers.set(event, handler), registerShortcut() {},
      registerCommand: (name, command) => commands.set(name, command) });
    await handlers.get('session_start')({}, ctx);
    t.after(() => handlers.get('session_shutdown')({}, ctx));
    renderer.renderNow();
    assert.equal(ui.getShowHardwareCursor(), true, 'MainEditor owns a hardware cursor before opening');
    ui.setShowHardwareCursor(hardwareCursor);
    const before = ui.getShowHardwareCursor();
    const pending = commands.get('history-search').handler('', ctx);
    await Promise.resolve(); // real showExtensionCustom installs the returned component asynchronously
    const picker = ui.getFocusedComponent();
    assert.notEqual(picker, main);
    assert.deepEqual(dock.children, [picker]);
    assert.equal(main.focused, false, 'native setFocus releases the editor');
    assert.equal(ui.hasOverlay(), false);
    assert.equal(ui.getShowHardwareCursor(), before);

    async function paint(selected, height, query = '', column = 9) {
      terminal.rows = height;
      xterm.resize(width, height);
      writes.length = 0;
      // A preflight render of the actual unfocused main editor must not acquire
      // the cursor. Keep this separate from the dock render, as in UI probes.
      main.render(width);
      assert.equal(ui.getShowHardwareCursor(), before, 'unfocused MainEditor cannot change the cursor preference');
      renderer.renderNow();
      const output = writes.join('');
      assert.match(output, before ? /\x1b\[\?25h/ : /\x1b\[\?25l/, 'native paint honors cursor preference');
      assert.equal(ui.getShowHardwareCursor(), before);
      await new Promise(resolve => xterm.write('', resolve));
      const screen = renderer.getScreenLines();
      const buffer = xterm.buffer.active;
      const painted = Array.from({ length: height }, (_, row) => buffer.getLine(buffer.viewportY + row).translateToString(true));
      const paintedQuery = painted.findIndex(line => /^search:(?: |$)/.test(line));
      if (height >= 3) {
        assert.ok(paintedQuery >= 0, painted.join('\n'));
        assertOrderedResults(painted, selected, query, height - footerRows - 1 >= 13);
      }
      assert.doesNotMatch(screen.join('\n'), /\x1b\[4(?::\d+)?m/, 'no software underline is painted');
      for (const line of screen) {
        if (!stripTerminalSequences(line).startsWith('search: ')) {
          assert.doesNotMatch(line, /\x1b\[7m/, 'the selection and clipping anchor have no fake cursor');
        }
      }
      const queryRow = plain(screen).findIndex(line => query === null
        ? line.startsWith('search: ') : line.trimEnd() === `search: ${query}`.trimEnd());
      assert.ok(queryRow >= 0, plain(screen).join('\n'));
      if (height <= 3) assert.equal(queryRow, 1, 'query occupies terminal row 2 after the native transcript minimum');
      if (height >= 3) assertOrderedResults(plain(screen), selected, query, height - footerRows - 1 >= 13);
      assert.deepEqual([buffer.cursorY, buffer.cursorX], [paintedQuery, column - 1],
        'actual terminal cursor stays at the query editing position');
      // Cursor hiding alone cannot prevent multiplexers from exposing its
      // position. Inspect the actual final terminal CUP, not just ?25l.
      const positions = [...output.matchAll(/\x1b\[(\d+);(\d+)H/g)];
      assert.ok(positions.length, 'paint must position the host cursor');
      const position = positions.at(-1);
      assert.deepEqual([Number(position[1]), Number(position[2])], [queryRow + 1, column],
        'host cursor is exactly at the editing position in the query, never on a result');
      const carets = screen.filter(line => /\x1b\[7m/.test(line));
      assert.equal(carets.length, before ? 0 : 1, 'hardware cursor replaces, not duplicates, the fake query caret');
      if (height === 40) {
        assert.ok(plain(screen).includes('CONVERSATION'));
        if (selected !== null) assert.equal(plain(screen).filter(line => /^.[ ]history result/.test(line)).length, 8);
      }
    }
    for (const height of [24, 40, 50]) await paint(19, height);
    for (let selected = 18; selected >= 0; selected--) {
      picker.handleInput('\x1b[B');
      await paint(selected, 40);
      await paint(selected, 8);
    }
    for (const height of [40, 6, 4, 3, 2, 8, 40]) await paint(0, height);
    picker.handleInput('history result 1');
    await paint(19, 8, 'history result 1', 25);
    picker.handleInput('\x1b[D');
    await paint(19, 3, 'history result 1', 24);
    picker.handleInput('x');
    await paint(null, 3, 'history result x1', 25);
    picker.handleInput('\r'); // No match is inert and focus stays in the query.
    assert.equal(ui.getFocusedComponent(), picker);
    picker.handleInput('\x7f');
    await paint(19, 4, 'history result 1', 24);
    picker.handleInput('\x15');
    picker.handleInput(`\x1b[200~${'界🙂e\u0301'.repeat(100)}\x1b[201~`);
    for (const height of [40, 8, 3, 2]) {
      for (let i = 0; i < 3; i++) {
        const queryLine = picker.render(width).find(line => stripTerminalSequences(line).startsWith('search: '));
        const column = visibleWidth(queryLine.slice(0, queryLine.indexOf(CURSOR_MARKER))) + 1;
        await paint(null, height, null, column);
        picker.handleInput('\x1b[D');
      }
    }
    // Exact native lower bound: the transcript owns the only row at height 1.
    // An ordinary custom component cannot reclaim that row through public APIs.
    terminal.rows = 1;
    writes.length = 0;
    renderer.renderNow();
    assert.ok(!plain(renderer.getScreenLines()).some(line => line.startsWith('search: ')));
    assert.doesNotMatch(writes.join(''), /\x1b\[\?25h/, 'no visible cursor when native layout clips the entire dock');
    assert.equal(ui.getFocusedComponent(), picker, 'resize does not lose filter focus');
    terminal.rows = 3;
    renderer.renderNow();
    assert.ok(plain(renderer.getScreenLines()).some(line => line.startsWith('search: ')));
    picker.handleInput('\x1b');
    assert.equal(ui.getShowHardwareCursor(), before, 'preserve the opening value synchronously');
    await pending;
    assert.deepEqual(dock.children, [main]);
    assert.equal(ui.getFocusedComponent(), main);
    assert.equal(main.getText(), '');
    terminal.rows = 40;
    writes.length = 0;
    renderer.renderNow();
    assert.match(writes.join(''), /\x1b\[\?25h/, 'main editor cursor returns on the closing paint');
  });
}
