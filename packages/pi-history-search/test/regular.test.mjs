import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import headless from '@xterm/headless';

// Keep the native custom lifecycle, renderer, and TS editor on the same SDK,
// including when running against an installed SDK with PI_TEST_SDK.
const sdk = process.env.PI_TEST_SDK
  ? pathToFileURL(process.env.PI_TEST_SDK).href
  : import.meta.resolve('@earendil-works/pi-coding-agent');
const requireSdk = createRequire(sdk);
const tuiPath = requireSdk.resolve('@earendil-works/pi-tui');
const { Container, TuiMainScreen, getKeybindings, setKeybindings } = await import(pathToFileURL(tuiPath));
const { initTheme } = await import(sdk);
initTheme('dark', false);
const { InteractiveMode } = await import(new URL('./modes/interactive/interactive-mode.js', sdk));
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
const component = render => ({ render, invalidate() {} });

for (const hardwareCursor of [false, true]) for (const width of [46, 120]) {
  for (const [smallHeight, initialFooterRows] of [[8, 0], [8, 5], [20, 13]]) {
    test(`regular native custom xterm viewport (${width} columns, ${smallHeight} rows, ${initialFooterRows} footer rows, hardware ${hardwareCursor})`, async t => {
      const previousKeys = getKeybindings();
      const keys = new KeybindingsManager();
      setKeybindings(keys);
      const restoreSettings = setPiVimSettingsReaderForTests(() => ({}));
      const xterm = new headless.Terminal({ cols: width, rows: 40, allowProposedApi: true, logLevel: 'off', scrollback: 1000 });
      const writes = [];
      const write = data => { writes.push(data); xterm.write(data); };
      const terminal = {
        columns: width, rows: 40, write,
        hideCursor: () => write('\x1b[?25l'), showCursor: () => write('\x1b[?25h'),
        start() {}, stop() {},
      };
      const renderer = new TuiMainScreen(terminal, hardwareCursor);
      renderer.requestRender = () => {};
      const ui = createInteractiveTuiReference(() => renderer);
      const main = new MainEditor(ui, editorTheme, keys);
      const dock = new Container();
      dock.addChild(main);
      let footerRows = initialFooterRows;
      let belowRows = 1;
      const below = new Container();
      below.addChild(component(() => Array.from({ length: belowRows }, (_, i) => `below ${i}`)));
      const footer = new Container();
      footer.addChild(component(() => Array.from({ length: footerRows }, (_, i) => `footer ${i}`)));
      // InteractiveMode's regular mount is a flat component tree, not the
      // fullscreen layout root. Include a real suffix after the editor dock so
      // index.ts must compute its live availableHeight rather than just rows.
      const document = new Container();
      document.addChild(component(() => Array.from({ length: 50 }, (_, i) => `CONVERSATION ${i}`)));
      for (const child of [document, new Container(), new Container(), new Container(), dock, below, footer]) ui.addChild(child);
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
      await new Promise(resolve => xterm.write('', resolve));
      assert.equal(ui.getShowHardwareCursor(), true, 'MainEditor initially owns the hardware cursor');
      ui.setShowHardwareCursor(hardwareCursor);
      const pending = commands.get('history-search').handler('', ctx);
      await Promise.resolve();
      const picker = ui.getFocusedComponent();
      assert.notEqual(picker, main);
      assert.deepEqual(dock.children, [picker]);
      assert.equal(main.focused, false);
      assert.equal(ui.hasOverlay(), false);

      async function paint(selected, height, query = '', column = 8) {
        if (terminal.rows !== height) {
          terminal.rows = height;
          xterm.resize(width, height);
        }
        writes.length = 0;
        main.render(width);
        assert.equal(ui.getShowHardwareCursor(), hardwareCursor, 'unfocused editor preserves cursor preference');
        renderer.renderNow();
        // Read only after xterm has consumed every actual renderer write.
        await new Promise(resolve => xterm.write('', resolve));
        const buffer = xterm.buffer.active;
        assert.equal(buffer.viewportY, buffer.baseY, 'inspect the bottom viewport, not stale scrollback');
        const lines = Array.from({ length: height }, (_, row) => buffer.getLine(buffer.viewportY + row));
        const text = lines.map(line => line.translateToString(true).trimEnd());
        const queryRow = text.indexOf(`search: ${query}`.trimEnd());
        assert.ok(queryRow >= 0, text.join('\n'));
        assert.equal(text[queryRow + 1], selected === null ? 'No matches' : `› history result ${selected}`, text.join('\n'));
        assert.deepEqual([buffer.cursorY, buffer.cursorX], [queryRow, column],
          'actual terminal cursor stays at the search editing column, never on the selection');
        assert.equal(ui.getShowHardwareCursor(), hardwareCursor);
        assert.match(writes.join(''), hardwareCursor ? /\x1b\[\?25h/ : /\x1b\[\?25l/);
        const carets = [];
        for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
          const cell = lines[row].getCell(col);
          if (cell.isInverse()) carets.push([row, col]);
          assert.equal(cell.isUnderline(), 0, 'no duplicate underline caret');
        }
        assert.deepEqual(carets, hardwareCursor ? [] : [[queryRow, column]],
          'software caret appears exactly once on the query only when hardware is disabled');
        const suffix = [
          ...Array.from({ length: belowRows }, (_, i) => `below ${i}`),
          ...Array.from({ length: footerRows }, (_, i) => `footer ${i}`),
        ];
        const suffixRow = text.indexOf(suffix[0]);
        assert.ok(suffixRow > queryRow, text.join('\n'));
        assert.deepEqual(text.slice(suffixRow, suffixRow + suffix.length), suffix,
          'live below-editor/footer suffix remains visible (native shrink may leave trailing blank rows)');
        if (height === 40) {
          assert.ok(text.some(line => line.startsWith('CONVERSATION ')));
          if (selected !== null) assert.equal(text.filter(line => /^(› |  )history result \d+$/.test(line)).length, 8,
            'a full-sized viewport preserves all eight results');
        }
        assert.equal(ui.getFocusedComponent(), picker);
      }

      await paint(19, 40);
      await paint(19, smallHeight);
      for (let selected = 18; selected >= 0; selected--) {
        picker.handleInput('\x1b[B');
        await paint(selected, smallHeight);
      }
      await paint(0, 40);
      // Resize and change suffix height independently. Never demand that a
      // thirteen-row footer fit in an eight-row terminal.
      for (const rows of [0, 5, 13, initialFooterRows]) {
        footerRows = rows;
        belowRows = rows === 13 ? 2 : 1;
        await paint(0, 40);
      }
      belowRows = 1;
      await paint(0, smallHeight);
      footerRows = initialFooterRows === 0 ? 5 : 0;
      await paint(0, smallHeight);
      footerRows = initialFooterRows;
      await paint(0, smallHeight);
      await paint(0, 40);
      picker.handleInput('history result 1');
      await paint(19, smallHeight, 'history result 1', 24);
      picker.handleInput('\x1b[D');
      await paint(19, smallHeight, 'history result 1', 23);
      picker.handleInput('x');
      await paint(null, smallHeight, 'history result x1', 24);
      picker.handleInput('\x7f');
      await paint(19, 40, 'history result 1', 23);
      picker.handleInput('\x1b');
      assert.equal(ui.getShowHardwareCursor(), hardwareCursor);
      await pending;
      assert.deepEqual(dock.children, [main]);
      assert.equal(ui.getFocusedComponent(), main);
      assert.equal(main.getText(), '');
      renderer.renderNow();
      await new Promise(resolve => xterm.write('', resolve));
      assert.equal(ui.getShowHardwareCursor(), true, 'closing returns cursor ownership to MainEditor');
    });
  }
}
