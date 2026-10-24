import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setKeybindings } from '@earendil-works/pi-tui';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { clearHandlerOf, routeCtrlC, routeEscape } from '../src/interrupt.ts';
setKeybindings(new KeybindingsManager());

const CTRL_C = '\x03';
const ESC = '\x1b';
const MODE = Symbol.for('pi-plugins.editor-mode.v1');
function editor(extra = {}) {
  const calls = [];
  const clear = () => calls.push('clear');
  const component = {
    actionHandlers: new Map([['app.clear', clear], ['app.message.dequeue', () => calls.push('dequeue')]]),
    onEscape: () => calls.push('interrupt'),
    ...extra,
  };
  return { calls, clear, component };
}
const state = (main, overrides = {}) => ({ focused: main.component, mainClear: main.clear, busy: true, queued: false, ...overrides });

test('Ctrl+C interrupts through main\'s editor while the agent is busy', () => {
  const main = editor();
  assert.deepEqual(routeCtrlC(CTRL_C, state(main)), { consume: true });
  assert.deepEqual(main.calls, ['interrupt']);
});
test('idle, Ctrl+C keeps Pi\'s clear/exit behavior', () => {
  const main = editor();
  assert.equal(routeCtrlC(CTRL_C, state(main, { busy: false })), undefined);
  assert.deepEqual(main.calls, []);
});
test('another focused component (a dialog, Sidebar) keeps its own Ctrl+C and Esc', () => {
  const main = editor();
  const other = editor();
  for (const focused of [other.component, { handleInput() {} }]) {
    assert.equal(routeCtrlC(CTRL_C, state(main, { focused, queued: true })), undefined);
    assert.equal(routeEscape(ESC, state(main, { focused, queued: true })), undefined);
  }
  assert.deepEqual([...main.calls, ...other.calls], []);
});
test('a custom prompt editor counts as main when Pi copied main\'s handlers onto it', () => {
  const main = editor();
  const calls = [];
  const custom = { actionHandlers: new Map([['app.clear', main.clear], ['app.interrupt', () => calls.push('interrupt')]]) };
  assert.equal(clearHandlerOf(custom), main.clear);
  assert.deepEqual(routeCtrlC(CTRL_C, state(main, { focused: custom })), { consume: true });
  assert.deepEqual(calls, ['interrupt']);
});
test('other keys pass through', () => {
  const main = editor();
  assert.equal(routeCtrlC('a', state(main, { queued: true })), undefined);
  assert.equal(routeEscape('a', state(main, { queued: true })), undefined);
});

test('Esc with prompts queued restores them and keeps the turn running', () => {
  const main = editor();
  assert.deepEqual(routeEscape(ESC, state(main, { queued: true })), { consume: true });
  assert.deepEqual(main.calls, ['dequeue']);
});
test('Esc with nothing queued, or idle, is left to Pi (it stops the turn)', () => {
  const main = editor();
  assert.equal(routeEscape(ESC, state(main)), undefined);
  assert.equal(routeEscape(ESC, state(main, { busy: false, queued: true })), undefined);
  assert.deepEqual(main.calls, []);
});
test('Ctrl+C with prompts queued restores them first, then stops the turn', () => {
  const main = editor();
  assert.deepEqual(routeCtrlC(CTRL_C, state(main, { queued: true })), { consume: true });
  assert.deepEqual(routeCtrlC(CTRL_C, state(main)), { consume: true });
  assert.deepEqual(main.calls, ['dequeue', 'interrupt']);
});
test('an open autocomplete popup keeps its Esc', () => {
  const main = editor({ isShowingAutocomplete: () => true });
  assert.equal(routeEscape(ESC, state(main, { queued: true })), undefined);
  assert.deepEqual(main.calls, []);
});
test('pi-vim: Insert and Normal restore the queue; Visual, pending, EX and its autocomplete keep Esc', () => {
  for (const [mode, restores] of [
    [{ state: 'insert' }, true],
    [{ state: 'normal' }, true],
    [{ state: 'visual' }, false],
    [{ state: 'pending' }, false],
    [{ state: 'ex' }, false],
    [{ state: 'insert', autocomplete: true }, false],
  ]) {
    const main = editor({ [MODE]: () => mode });
    assert.equal(routeEscape(ESC, state(main, { queued: true }))?.consume === true, restores, JSON.stringify(mode));
    assert.deepEqual(main.calls, restores ? ['dequeue'] : []);
  }
});
