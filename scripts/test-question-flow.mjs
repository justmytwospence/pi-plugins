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
const { FleetView } = await jiti.import('../packages/pi-subagents/src/ui/fleet.ts');
const { PillView } = await jiti.import('../packages/pi-bg/src/pill.ts');
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

// Kitty-protocol Ctrl+J/Ctrl+K: unambiguous, unlike legacy LF, which some keybindings read as Enter.
const CTRL_J = '\x1b[106;5u';
const CTRL_K = '\x1b[107;5u';
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
          assert.match(screen(), /→ 3\.\s+(Other: )?no/);
          assert.doesNotMatch(screen(), /Type something\./);
          // Only the dialog's bottom border is a bare rule: the top one carries the Ask user title.
          assert.equal(screen().split('\n').filter((line) => /^\s*─+\s*$/.test(line)).length, 1);
          if (modal) {
            assert.equal(editors[0][MODE]().state, 'insert');
            terminal.send(ESC);
            assert.equal(dialog[CONTEXT](), 'editor');
            // No mode badge: the cursor shape shows the mode.
            assert.doesNotMatch(screen(), /NORMAL|INSERT/);
            terminal.send(ESC);
          } else terminal.send(ESC);
          assert.equal(dialog[CONTEXT](), 'list');
          assert.equal(result, undefined);
          // Ctrl+J/Ctrl+K leave an open field for the rows, in Insert and Normal mode alike.
          terminal.send('\r');
          assert.equal(dialog[CONTEXT](), 'editor');
          terminal.send(CTRL_J);
          assert.equal(dialog[CONTEXT](), 'list');
          assert.match(screen(), /→ 1\./);
          terminal.send(CTRL_K);
          assert.match(screen(), /→ 3\./);
          if (modal) {
            terminal.send('\r', ESC);
            assert.equal(editors[0][MODE]().state, 'normal');
            terminal.send(CTRL_K);
            assert.equal(dialog[CONTEXT](), 'list');
            assert.match(screen(), /→ 2\./);
            terminal.send(CTRL_J);
          }
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

  // Global task listeners must not mistake an open answer/note for main's prompt:
  // otherwise Down selects a task and the next Enter opens it instead of answering.
  for (const fullscreen of [false, true]) for (const host of ['fleet', 'pill']) for (const field of ['custom', 'notes']) {
    const kb = new KeybindingsManager();
    setKeybindings(kb);
    const terminal = new MemoryTerminal();
    const tui = fullscreen ? new TuiAltScreen(terminal, false, undefined, { mouse: false }) : new TuiMainScreen(terminal);
    let opened = 0;
    let result;
    const ui = {
      getEditorText: () => '',
      onTerminalInput: listener => tui.addInputListener(listener),
      setWidget: (_key, factory) => factory?.(tui, themeModule.theme),
      custom: () => { opened++; return Promise.resolve(); },
      theme: themeModule.theme,
    };
    const run = { id: 'running', agent: 'worker', state: { status: 'running', startedAt: Date.now() } };
    const tasks = host === 'fleet'
      ? new FleetView({ runs: () => [run], enabled: () => true, actions: () => ({}) })
      : new PillView({ pill: () => ({ label: '1 task' }), open: () => { opened++; } }, 'question-test');
    tasks.setUI(ui);
    tasks.update();
    const dialog = new QuestionDialog(tui, themeModule.theme, kb, [question()], value => { result = value; });
    try {
      tui.addChild(dialog);
      tui.setFocus(dialog);
      tui.start();
      terminal.send(field === 'custom' ? '3' : 'n', ...(field === 'custom' ? ['\r'] : []));
      assert.equal(dialog[CONTEXT](), 'editor');
      if (host === 'fleet') assert.equal(tasks.autoOpen(run, { onDismiss() {}, onInteraction() {} }), false, 'an open field must block automatic subagent viewing');
      terminal.send('\x1b[B', 'x', '\x1b[B', '\r');
      assert.equal(opened, 0, `${host} stole Enter from ${field}`);
      if (field === 'notes') terminal.send('\r');
      assert.equal(result?.cancelled, false, `${host} blocked ${field} submission`);
      assert.equal(field === 'custom' ? result.answers[0].answer : result.answers[0].notes, 'x');
    } finally { tasks.dispose(); tui.stop(); }
  }
  console.log('PASS task panel and pill leave question-field navigation, Enter and auto-view ownership alone');
} finally { setKeybindings(previous); }
