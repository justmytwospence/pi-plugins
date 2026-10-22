import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setKeybindings } from '@earendil-works/pi-tui';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { clearHandlerOf, routeCtrlC } from '../src/interrupt.ts';
setKeybindings(new KeybindingsManager());

const CTRL_C = '\x03';
function editor() {
  const calls = [];
  const clear = () => calls.push('clear');
  return { calls, clear, component: { actionHandlers: new Map([['app.clear', clear]]), onEscape: () => calls.push('interrupt') } };
}

test('Ctrl+C interrupts through main\'s editor while the agent is busy', () => {
  const main = editor();
  assert.deepEqual(routeCtrlC(CTRL_C, main.component, main.clear, true), { consume: true });
  assert.deepEqual(main.calls, ['interrupt']);
});
test('idle, Ctrl+C keeps Pi\'s clear/exit behavior', () => {
  const main = editor();
  assert.equal(routeCtrlC(CTRL_C, main.component, main.clear, false), undefined);
  assert.deepEqual(main.calls, []);
});
test('another focused component (a dialog, Sidebar) keeps its own Ctrl+C', () => {
  const main = editor();
  const other = editor();
  assert.equal(routeCtrlC(CTRL_C, other.component, main.clear, true), undefined);
  assert.equal(routeCtrlC(CTRL_C, { handleInput() {} }, main.clear, true), undefined);
  assert.deepEqual([...main.calls, ...other.calls], []);
});
test('a custom prompt editor counts as main when Pi copied main\'s handlers onto it', () => {
  const main = editor();
  const calls = [];
  const custom = { actionHandlers: new Map([['app.clear', main.clear], ['app.interrupt', () => calls.push('interrupt')]]) };
  assert.equal(clearHandlerOf(custom), main.clear);
  assert.deepEqual(routeCtrlC(CTRL_C, custom, main.clear, true), { consume: true });
  assert.deepEqual(calls, ['interrupt']);
});
test('other keys pass through', () => {
  const main = editor();
  assert.equal(routeCtrlC('a', main.component, main.clear, true), undefined);
});
