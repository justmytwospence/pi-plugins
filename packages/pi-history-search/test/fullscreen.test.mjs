import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';

// Resolve *all* SDK and TUI imports against the requested installation, including
// the TS editors loaded by jiti. Mixing a 1.2 Editor with a 1.4 renderer is not a
// reproduction of the installed paint path.
const sdk = process.env.PI_TEST_SDK
  ? pathToFileURL(process.env.PI_TEST_SDK).href
  : import.meta.resolve('@earendil-works/pi-coding-agent');
const requireSdk = createRequire(sdk);
const tuiPath = requireSdk.resolve('@earendil-works/pi-tui');
const { Container, TuiAltScreen, getKeybindings, setKeybindings, stripTerminalSequences } = await import(pathToFileURL(tuiPath));
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

for (const hardwareCursor of [false, true]) for (const width of [46, 120]) {
  test(`fullscreen native custom dock terminal writes (${width} columns, setting ${hardwareCursor})`, async t => {
    const previousKeys = getKeybindings();
    const keys = new KeybindingsManager();
    setKeybindings(keys);
    const restoreSettings = setPiVimSettingsReaderForTests(() => ({}));
    const writes = [];
    const terminal = {
      columns: width, rows: 40,
      write: data => writes.push(data),
      hideCursor: () => writes.push('\x1b[?25l'),
      showCursor: () => writes.push('\x1b[?25h'),
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
    const footer = { render: () => Array.from({ length: 5 }, (_, i) => `footer ${i}`), invalidate() {} };
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
    const before = ui.getShowHardwareCursor();
    const pending = commands.get('history-search').handler('', ctx);
    await Promise.resolve(); // real showExtensionCustom installs the returned component asynchronously
    const picker = ui.getFocusedComponent();
    assert.notEqual(picker, main);
    assert.deepEqual(dock.children, [picker]);
    assert.equal(main.focused, false, 'native setFocus releases the editor');
    assert.equal(ui.hasOverlay(), false);
    assert.equal(ui.getShowHardwareCursor(), false);

    function paint(selected, height) {
      terminal.rows = height;
      writes.length = 0;
      // A preflight render of the actual unfocused main editor must not acquire
      // the cursor. Keep this separate from the dock render, as in UI probes.
      main.render(width);
      assert.equal(ui.getShowHardwareCursor(), false, 'unfocused MainEditor preflight cannot re-enable the cursor');
      renderer.renderNow();
      const output = writes.join('');
      assert.doesNotMatch(output, /\x1b\[\?25h/, 'never show the hardware cursor while the picker is open');
      assert.match(output, /\x1b\[\?25l/, 'the actual fullscreen paint hides it');
      assert.equal(ui.getShowHardwareCursor(), false);
      const screen = renderer.getScreenLines();
      assert.doesNotMatch(screen.join('\n'), /\x1b\[4(?::\d+)?m/, 'no software underline is painted');
      for (const line of screen) {
        if (!stripTerminalSequences(line).startsWith('search: ')) {
          assert.doesNotMatch(line, /\x1b\[7m/, 'the selection and clipping anchor have no fake cursor');
        }
      }
      const selectedRow = plain(screen).findIndex(line => line === `› history result ${selected}`);
      assert.ok(selectedRow >= 0, plain(screen).join('\n'));
      // Cursor hiding alone cannot prevent multiplexers from exposing its
      // position. Inspect the actual final terminal CUP, not just ?25l.
      const positions = [...output.matchAll(/\x1b\[(\d+);(\d+)H/g)];
      assert.ok(positions.length, 'paint must position the host cursor');
      const position = positions.at(-1);
      assert.deepEqual([Number(position[1]), Number(position[2])], [selectedRow + 1, 1],
        'host cursor is exactly on the selected chevron, never the row below');
      if (height === 40) {
        assert.ok(plain(screen).includes('CONVERSATION'));
        assert.ok(screen.some(line => /search: .*\x1b\[7m/.test(line)), 'filter retains its software caret');
        assert.equal(plain(screen).filter(line => /^.[ ]history result/.test(line)).length, 8);
      }
    }
    paint(19, 40);
    for (let selected = 18; selected >= 0; selected--) {
      picker.handleInput('\x1b[B');
      paint(selected, 8);
    }
    for (const height of [40, 6, 4, 3, 8, 40]) paint(0, height);
    picker.handleInput('\x1b');
    assert.equal(ui.getShowHardwareCursor(), before, 'restore the opening value synchronously');
    await pending;
    assert.deepEqual(dock.children, [main]);
    assert.equal(ui.getFocusedComponent(), main);
    assert.equal(main.getText(), '');
    writes.length = 0;
    renderer.renderNow();
    assert.match(writes.join(''), /\x1b\[\?25h/, 'main editor cursor returns on the closing paint');
  });
}
