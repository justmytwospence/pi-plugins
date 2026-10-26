import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INPUT_CONTEXT, routeShortcut } from '../src/index.ts';
const CTRL_T = '\x14';
const main = (handled = true) => {
  const seen = [];
  return { seen, render: () => [], getText: () => '', setText() {}, onExtensionShortcut: (data) => (seen.push(data), handled) };
};
const dialog = { render: () => [] };
test('a dialog-safe shortcut reaches extension handlers while a dialog has focus', () => {
  const editor = main();
  assert.deepEqual(routeShortcut(CTRL_T, dialog, editor), { consume: true });
  assert.deepEqual(editor.seen, [CTRL_T]);
});
test('the prompt editor and shortcut-wired editors run shortcuts themselves', () => {
  const editor = main();
  assert.equal(routeShortcut(CTRL_T, editor, editor), undefined);
  assert.equal(routeShortcut(CTRL_T, main(), editor), undefined);
  assert.deepEqual(editor.seen, []);
});
test('a terminal context owns legacy and Kitty panel shortcuts without inspection', () => {
  const editor = main();
  const terminal = {
    context: 'terminal',
    [INPUT_CONTEXT]() { return this.context; },
    render() { throw Error('must not render'); },
  };
  for (const key of [CTRL_T, '\x1b[116;5u', '\x1b[116;6u', '\x1b[116;5:2u']) {
    assert.equal(routeShortcut(key, terminal, editor), undefined);
  }
  assert.deepEqual(editor.seen, []);
  terminal.context = 'list';
  assert.deepEqual(routeShortcut(CTRL_T, terminal, editor), { consume: true });
  assert.deepEqual(editor.seen, [CTRL_T]);
});
test('other explicit dialog contexts still allow dialog-safe shortcuts', () => {
  for (const context of ['editor', 'filter', 'list', 'viewer', undefined]) {
    const editor = main();
    assert.deepEqual(routeShortcut(CTRL_T, { ...dialog, [INPUT_CONTEXT]: () => context }, editor), { consume: true });
    assert.deepEqual(editor.seen, [CTRL_T]);
  }
});
test('other keys and unbound shortcuts stay with the dialog', () => {
  const editor = main(false);
  assert.equal(routeShortcut('\x1b[Z', dialog, editor), undefined); // shift+tab
  assert.equal(routeShortcut('j', dialog, editor), undefined);
  assert.deepEqual(editor.seen, []);
  assert.equal(routeShortcut(CTRL_T, dialog, editor), undefined);
  assert.equal(routeShortcut('\x1b[116;5:3u', dialog, main()), undefined); // key release
});
