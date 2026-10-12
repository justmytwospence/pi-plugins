import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INPUT_CONTEXT, routeInput } from '../src/index.ts';
const editor = (focused) => ({ render: () => [], getText: () => '', setText() {}, focused });
test('active and ambiguous nested prose editors own control editing keys', () => {
  for (const focused of [true, undefined]) for (const data of ['\n', '\x0b', 'j', 'k']) {
    assert.equal(routeInput(data, { render: () => [], child: editor(focused) }), undefined);
  }
});
test('inactive embedded editors do not prevent third-party list controls', () => {
  assert.deepEqual(routeInput('\n', { render: () => [], child: editor(false) }), { data: '\x1b[B' });
});
test('explicit contexts are never rendered or rewritten', () => {
  for (const context of ['editor', 'filter', 'list', 'viewer']) {
    const component = { [INPUT_CONTEXT]: () => context, render() { throw Error('must not render'); } };
    for (const key of ['j', 'k', '\n', '\x0b']) assert.equal(routeInput(key, component), undefined);
  }
});
test('Kitty releases and bare editors pass unchanged', () => {
  assert.equal(routeInput('\x1b[106;5:3u', { render: () => [] }), undefined);
  assert.equal(routeInput('\n', editor(true)), undefined);
});
