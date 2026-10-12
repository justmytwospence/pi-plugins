import assert from 'node:assert/strict';
import { test } from 'node:test';
import clearScreen from '../src/index.ts';
import { getKeybindings, setKeybindings } from '@earendil-works/pi-tui';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
setKeybindings(new KeybindingsManager());
function setup() {
  const handlers = new Map(); let shortcut;
  clearScreen({ on: (name, fn) => handlers.set(name, fn), registerShortcut: (key, def) => { assert.equal(key, 'ctrl+l'); shortcut = def; } });
  const chat = { children: [], render: () => chat.children.flatMap(c => c.render()), addChild: c => chat.children.push(c), removeChild: c => { chat.children = chat.children.filter(v => v !== c); } };
  const doc = { children: [chat], render: () => ['history', ...chat.render()] };
  const original = doc.render;
  const scroll = { child: doc, viewportHeight: 10, scrollToEnd() {} };
  const tui = { children: [doc], layoutRoot: { entries: [{ component: scroll }] }, requestRender() {} };
  const notices = [];
  const ctx = { mode: 'tui', ui: { notify: text => notices.push(text), setWidget: (key, factory) => factory?.(tui) } };
  handlers.get('session_start')({}, ctx);
  return { handlers, shortcut, ctx, doc, original, notices };
}
test('clear keeps original transcript and releases its own renderer', () => {
  const h = setup();
  h.shortcut.handler(h.ctx);
  assert.equal(h.doc.render(80)[0], 'history');
  assert.equal(h.doc.render(80).length, 11);
  h.handlers.get('session_shutdown')();
  assert.equal(h.doc.render, h.original);
  assert.deepEqual(h.doc.render(80), ['history']);
});
test('teardown does not overwrite a newer renderer wrapper', () => {
  const h = setup(); h.shortcut.handler(h.ctx);
  const old = h.doc.render;
  const newer = width => old(width);
  h.doc.render = newer;
  h.handlers.get('session_shutdown')();
  assert.equal(h.doc.render, newer);
  assert.deepEqual(h.doc.render(80), ['history']);
});
test('a conflicting native picker gives an actionable diagnostic', () => {
  const kb = getKeybindings(); const bindings = kb.getUserBindings();
  try {
    kb.setUserBindings({ ...bindings, 'app.model.select': 'ctrl+l' });
    const h = setup();
    assert.match(h.notices.join('\n'), /app.model.select.*alt\+p/);
  } finally { kb.setUserBindings(bindings); }
});
