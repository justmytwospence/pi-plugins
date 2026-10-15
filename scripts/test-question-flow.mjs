// Question/Vim composition through real Pi renderers and terminal input routing.
// Transport only is in memory; these are not full AgentSession lifecycle tests.
import assert from 'node:assert/strict';
import { stripVTControlCharacters } from 'node:util';
import { createJiti } from 'jiti';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { getKeybindings, setKeybindings, TuiMainScreen, TuiAltScreen } from '@earendil-works/pi-tui';
const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
const jiti = createJiti(import.meta.url);
const { QuestionDialog } = await jiti.import('../packages/pi-ask-user-question/src/dialog.ts');
const { embeddedEditorFactory } = await jiti.import('../packages/pi-ask-user-question/src/editor.ts');
const { EmbeddedEditor } = await jiti.import('../packages/pi-vim/src/embedded-editor.ts');
const themeModule = await import(new URL('./modes/interactive/theme/theme.js', sdkUrl));
const MODE = Symbol.for('pi-plugins.editor-mode.v1');
const CONTEXT = Symbol.for('pi-plugins.input-context.v1');
const ESC = '\x1b';

class MemoryTerminal {
  columns = 80;
  rows = 40;
  kittyProtocolActive = false;
  writes = [];
  start(onInput) { this.input = onInput; }
  stop() { this.input = undefined; }
  async drainInput() {}
  write(data) { this.writes.push(data); }
  moveBy(lines) { if (lines) this.write(`\x1b[${Math.abs(lines)}${lines > 0 ? 'B' : 'A'}`); }
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
  send(...keys) { assert.ok(this.input); for (const key of keys) this.input(key); }
}

const question = (multiSelect = false) => ({ question: 'Which approach?', header: 'Approach', multiSelect,
  options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second', preview: '**Second approach**' }] });
const previous = getKeybindings();
try {
  initTheme('dark', false);
  for (const fullscreen of [false, true]) {
    for (const modal of [false, true]) {
      for (const multiSelect of [false, true]) {
        const kb = new KeybindingsManager({ 'tui.select.up': ['up', 'ctrl+k'], 'tui.select.down': ['down', 'ctrl+j'] });
        setKeybindings(kb);
        const terminal = new MemoryTerminal();
        terminal.columns = fullscreen ? 40 : 120;
        const tui = fullscreen ? new TuiAltScreen(terminal, false, undefined, { mouse: false }) : new TuiMainScreen(terminal);
        const editors = [];
        const create = modal ? embeddedEditorFactory({ events: { emit(channel, request) {
          assert.equal(channel, 'pi-plugins.editor-factory.v1');
          request.factory = options => {
            assert.equal(options.initialMode, 'insert');
            const editor = new EmbeddedEditor(options);
            editors.push(editor);
            return editor;
          };
        } } }) : undefined;
        let result;
        const dialog = new QuestionDialog(tui, themeModule.theme, kb, [question(multiSelect)], value => { result = value; }, undefined, create);
        const screen = () => dialog.render(terminal.columns).map(stripVTControlCharacters).join('\n');
        try {
          tui.addChild(dialog);
          tui.setFocus(dialog);
          tui.start();
          // Notes also reopen in Insert and retain their draft across local Escape.
          terminal.send('n', 'd', ESC);
          if (modal) terminal.send(ESC);
          assert.equal(dialog[CONTEXT](), 'list');
          terminal.send('n', 'r', 'a', 'f', 't', '\r');
          assert.equal(dialog[CONTEXT](), 'list');
          // Highlighting the custom row, then n, must compose an answer, never notes.
          terminal.send('\x1b[B', '\x1b[B', 'n', 'o');
          assert.equal(dialog[CONTEXT](), 'editor');
          // The Type something row is the field itself, with no editor rules around it.
          assert.match(screen(), /❯ 3\. (\[ \] )?no/);
          assert.doesNotMatch(screen(), /Type something\./);
          assert.equal(screen().split('\n').filter((line) => /^\s*─+\s*$/.test(line)).length, 2);
          if (modal) {
            assert.equal(editors[0][MODE]().state, 'insert');
            terminal.send(ESC);
            assert.equal(dialog[CONTEXT](), 'editor');
            assert.match(screen(), /NORMAL.*i insert/);
            terminal.send(ESC);
          } else terminal.send(ESC);
          assert.equal(dialog[CONTEXT](), 'list');
          assert.equal(result, undefined);
          // Reopen without asking the user to discover i; the first letter is retained.
          terminal.send('t', '\x1b[200~ these\x1b[201~', '\r');
          assert.equal(result.cancelled, false);
          assert.equal(result.answers[0].kind, multiSelect ? 'multi' : 'custom');
          assert.equal(result.answers[0].answer, 'not these');
          if (multiSelect) assert.deepEqual(result.answers[0].selected, ['not these']);
          assert.equal(result.answers[0].notes, 'draft');
          for (const editor of editors) assert.equal(editor.isDisposed(), true);
        } finally { tui.stop(); }
      }
    }
  }
  console.log('PASS question free-text ownership, drafts, Vim re-entry and disposal through regular/fullscreen TUI input');
} finally { setKeybindings(previous); }
