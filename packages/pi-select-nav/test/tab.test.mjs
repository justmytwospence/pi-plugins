import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCEPT_NEXT, TASK_TAB, explicitCompletion, routePromptTab } from '../src/prompt-tab.ts';
import selectNav from '../src/index.ts';

const surface = Symbol.for('pi-plugins.editor-surface.v1');
const mode = Symbol.for('pi-plugins.editor-mode.v1');
const editor = (text = '', autocomplete = false) => ({
  getText: () => text, getCursor: () => ({ line: text.split('\n').length - 1, col: text.split('\n').at(-1).length }),
  isShowingAutocomplete: () => autocomplete,
});

test('only explicit slash commands and @ mentions retain visible completion', () => {
  for (const text of ['/status', '/status on', '@src/', 'look at @src/', 'look at @"some file', 'look at @"some file"']) {
    const e = editor(text, true);
    assert.equal(explicitCompletion(e), true, text);
    assert.equal(routePromptTab('\t', e, e, () => assert.fail('must not dispatch')), undefined);
  }
  for (const text of ['', 'src/', './', '/tmp/file', '/tmp/', 'ordinary prose', 'https://example.com', 'email@example.com', 'look @file then prose']) {
    const e = editor(text, true);
    assert.equal(explicitCompletion(e), false, text);
    assert.deepEqual(routePromptTab('\t', e, e, () => assert.fail('popup owns other keys')), { consume: true });
  }
  const e = editor('look @src/ and later words', true);
  e.getCursor = () => ({ line: 0, col: 10 });
  assert.equal(explicitCompletion(e), true, 'check the cursor, not the suffix');
});

test('Tab priority is active task navigation, empty-editor suggestion, then tasks', () => {
  const e = editor();
  const calls = [];
  const emit = (channel, request) => { calls.push([channel, request.phase]); request.handled = channel === ACCEPT_NEXT; };
  assert.deepEqual(routePromptTab('\t', e, e, emit), { consume: true });
  assert.deepEqual(calls, [[TASK_TAB, 'active'], [ACCEPT_NEXT, undefined]]);
  calls.length = 0;
  routePromptTab('\t', e, e, (channel, request) => { calls.push([channel, request.phase]); request.handled = request.phase === 'active'; });
  assert.deepEqual(calls, [[TASK_TAB, 'active']]);
  calls.length = 0;
  routePromptTab('\t', e, e, (channel, request) => calls.push([channel, request.phase]));
  assert.deepEqual(calls, [[TASK_TAB, 'active'], [ACCEPT_NEXT, undefined], [TASK_TAB, 'enter']]);
});

test('a draft is never replaced; no targets means no implicit completion', () => {
  const e = editor('my draft');
  const calls = [];
  assert.deepEqual(routePromptTab('\t', e, e, (channel, request) => calls.push([channel, request.phase])), { consume: true });
  assert.deepEqual(calls, [[TASK_TAB, 'active'], [TASK_TAB, 'enter']]);
  assert.equal(e.getText(), 'my draft');
});

test('the extension installs the route only in TUI sessions and removes stale listeners', () => {
  const events = new Map(); const inputs = new Set(); const sent = [];
  const main = editor(); let focused = main;
  const tui = { getFocusedComponent: () => focused, terminal: { columns: 80 } };
  const ctx = { mode: 'tui', ui: {
    setWidget: (_key, factory) => { if (typeof factory === 'function') factory(tui); },
    onTerminalInput: handler => { inputs.add(handler); return () => inputs.delete(handler); },
  } };
  selectNav({ on: (name, fn) => events.set(name, fn), events: { emit: (name, request) => sent.push([name, request.phase]) } });
  events.get('session_start')({}, ctx);
  assert.equal(inputs.size, 1);
  assert.deepEqual([...inputs][0]('\t'), { consume: true });
  assert.deepEqual(sent, [[TASK_TAB, 'active'], [ACCEPT_NEXT, undefined], [TASK_TAB, 'enter']]);
  focused = { render() {} };
  assert.equal([...inputs][0]('\t'), undefined);
  events.get('session_start')({}, ctx);
  assert.equal(inputs.size, 1);
  events.get('session_shutdown')();
  assert.equal(inputs.size, 0);
  events.get('session_start')({}, { ...ctx, mode: 'rpc' });
  assert.equal(inputs.size, 0);
});

test('dialogs, embedded editors, modal operations, releases and Shift+Tab keep their keys', () => {
  const main = editor();
  const other = editor();
  assert.equal(routePromptTab('\t', other, main, () => assert.fail()), undefined);
  other[surface] = 'embedded';
  assert.equal(routePromptTab('\t', other, other, () => assert.fail()), undefined);
  for (const state of ['ex', 'visual', 'pending']) {
    main[mode] = () => ({ state });
    assert.equal(routePromptTab('\t', main, main, () => assert.fail()), undefined);
  }
  delete main[mode];
  for (const key of ['\x1b[Z', '\x1b[9;1:3u', '\x1b[200~text\tmore\x1b[201~', 'x']) {
    assert.equal(routePromptTab(key, main, main, () => assert.fail()), undefined);
  }
  other[surface] = 'main';
  assert.deepEqual(routePromptTab('\t', other, main, () => {}), { consume: true });
});
