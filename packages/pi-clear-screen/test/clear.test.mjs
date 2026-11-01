import assert from 'node:assert/strict';
import { test } from 'node:test';
import clearScreen from '../src/index.ts';
import { Container, getKeybindings, setKeybindings } from '@earendil-works/pi-tui';
import { TRANSCRIPT_BLOCK, TRANSCRIPT_ROWS } from '../src/transcript-contract.ts';
import { KeybindingsManager } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js';
import { createJiti } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/jiti-loader.js';
// Exercise the canonical helper through Pi's loader (it uses non-erasable TypeScript syntax).
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { indexTranscript, indexTranscriptChildren, spliceTranscriptRows } = await jiti.import('../../../shared/transcript/transcript-index.ts');
setKeybindings(new KeybindingsManager());
function setup(nested = false) {
  const handlers = new Map(); let shortcut;
  clearScreen({ on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerShortcut: (key, def) => { assert.equal(key, 'ctrl+l'); shortcut = def; } });
  const chat = new Container();
  const doc = new Container();
  doc.addChild({ render: () => ['history'] });
  doc.addChild(chat);
  const original = doc.render;
  const scroll = { child: doc, viewportHeight: 10, scrollToEnd() {} };
  const main = { entries: [{ component: scroll }] };
  const tui = { children: [doc], layoutRoot: nested ? { entries: [{ component: main }, { component: { render: () => [] } }] } : main, requestRender() {} };
  const notices = [];
  const ctx = { sessionManager: {}, mode: 'tui', ui: { notify: text => notices.push(text), setWidget: (key, factory) => factory?.(tui) } };
  handlers.get('session_start')({}, ctx);
  return { handlers, shortcut, ctx, doc, chat, scroll, tui, original, notices };
}
function block(lines, id) {
  return {
    render: () => lines,
    [TRANSCRIPT_BLOCK]: () => ({ kind: 'user', userText: id, checkpoint: { id, kind: 'prompt' } }),
  };
}
function rowsContext(doc, width = 80) {
  return { width, lines: doc.render(width), index: indexTranscriptChildren, splice: spliceTranscriptRows };
}
function indexed(doc, width = 80) {
  const index = indexTranscript(doc, width);
  assert.deepEqual(index.lines, doc.render(width));
  return index;
}
test('clear keeps original transcript and releases its own renderer', () => {
  const h = setup();
  h.shortcut.handler(h.ctx);
  assert.equal(h.doc.render(80)[0], 'history');
  assert.equal(h.doc.render(80).length, 11);
  h.handlers.get('session_shutdown')({}, h.ctx);
  assert.equal(h.doc.render, h.original);
  assert.deepEqual(h.doc.render(80), ['history']);
});
test('clear finds the transcript when another extension nests the layout root', () => {
  const h = setup(true);
  h.shortcut.handler(h.ctx);
  assert.equal(h.doc.render(80).length, 11);
});
test('teardown does not overwrite a newer renderer wrapper', () => {
  const h = setup(); h.shortcut.handler(h.ctx);
  const old = h.doc.render;
  const newer = width => old(width);
  h.doc.render = newer;
  h.handlers.get('session_shutdown')({}, h.ctx);
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

test('repeated clear and shrinking padding preserve exact rows and checkpoint ranges', () => {
  for (const width of [46, 120, 180]) {
    const h = setup();
    const promptLines = ['\u001b[31mprompt\u001b[0m', ''];
    const prompt = block(promptLines, 'prompt');
    h.chat.addChild(prompt);
    h.shortcut.handler(h.ctx);
    const render = h.doc.render;
    const rows = h.doc[TRANSCRIPT_ROWS];
    const answerLines = ['answer', '', '\u001b_Gimage\u001b\\'];
    const answer = block(answerLines, 'answer');
    h.chat.addChild(answer);
    let index = indexed(h.doc, width);
    assert.deepEqual(index.lines, ['history', ...promptLines, ...answerLines, ...Array(7).fill('')]);
    assert.deepEqual(index.horizons, [3]);
    assert.deepEqual(index.blocks.filter(b => b.checkpoint).map(b => [b.start, b.end, b.checkpoint.id]), [[1, 3, 'prompt'], [3, 6, 'answer']]);
    assert.ok(!index.blocks.some(b => b.source === h.chat.children.find(c => c !== prompt && c !== answer)));
    // Rendering/indexing may not mutate cached component rows, even at another width.
    assert.deepEqual(promptLines, ['\u001b[31mprompt\u001b[0m', '']);
    assert.deepEqual(answerLines, ['answer', '', '\u001b_Gimage\u001b\\']);
    answerLines.push(...Array(8).fill('more'));
    index = indexed(h.doc, width);
    assert.deepEqual(index.lines, ['history', ...promptLines, ...answerLines]);
    assert.deepEqual(index.horizons, [3]);
    assert.equal(index.blocks.find(b => b.source === answer).end, index.lines.length);
    h.shortcut.handler(h.ctx);
    assert.equal(h.doc.render, render);
    assert.equal(h.doc[TRANSCRIPT_ROWS], rows);
    assert.equal(h.chat.children.length, 3);
    index = indexed(h.doc, width);
    assert.deepEqual(index.horizons, [14]);
    assert.deepEqual(index.lines, ['history', ...promptLines, ...answerLines, ...Array(10).fill('')]);
    h.scroll.viewportHeight = 4;
    assert.deepEqual(indexed(h.doc, width).lines, ['history', ...promptLines, ...answerLines, '', '', '', '']);
    h.handlers.get('session_shutdown')({}, h.ctx);
    assert.equal(Object.hasOwn(h.doc, TRANSCRIPT_ROWS), false);
    assert.deepEqual(indexed(h.doc, width).horizons, []);
  }
});

test('the clear horizon is zero-row even in an empty document or without fullscreen padding', () => {
  const h = setup();
  h.doc.removeChild(h.doc.children[0]);
  h.shortcut.handler(h.ctx);
  let index = indexed(h.doc);
  assert.deepEqual(index.horizons, [0]);
  assert.deepEqual(index.blocks, []);
  assert.deepEqual(index.lines, Array(10).fill(''));
  h.tui.layoutRoot = undefined;
  index = indexed(h.doc);
  assert.deepEqual(index, { lines: [], blocks: [], horizons: [0] });
  h.handlers.get('session_shutdown')({}, h.ctx);
});

test('indexing uses the actual render width and rejects nonmatching final or child rows', () => {
  const h = setup();
  h.chat.addChild({ render: width => width < 80 ? ['narrow', 'wrapped'] : ['wide'] });
  h.shortcut.handler(h.ctx);
  assert.deepEqual(indexed(h.doc, 46).horizons, [3]);
  assert.deepEqual(indexed(h.doc, 120).horizons, [2]);
  const context = rowsContext(h.doc);
  assert.equal(h.doc[TRANSCRIPT_ROWS]({ ...context, lines: ['not the final render'] }), undefined);
  assert.equal(h.doc[TRANSCRIPT_ROWS]({ ...context, index: () => ({ lines: ['not the children'], blocks: [], horizons: [] }) }), undefined);
  h.handlers.get('session_shutdown')({}, h.ctx);
});

test('a preceding rows hook sees pre-transform lines and its descriptors are restored exactly', () => {
  const h = setup();
  let called = 0;
  const precedingRender = function (width) { return ['prefix', ...h.original.call(this, width)]; };
  const precedingRows = function (context) {
    called++;
    assert.equal(this, h.doc);
    assert.equal(context.width, 46);
    assert.deepEqual(context.lines, precedingRender.call(this, context.width));
    let index = context.index(this.children, context.width);
    index = context.splice(index, 0, 0, ['prefix']);
    return { ...index, horizons: [1] };
  };
  const renderDescriptor = { value: precedingRender, writable: false, enumerable: false, configurable: true };
  const rowsDescriptor = { get: () => precedingRows, set: undefined, enumerable: false, configurable: true };
  Object.defineProperty(h.doc, 'render', renderDescriptor);
  Object.defineProperty(h.doc, TRANSCRIPT_ROWS, rowsDescriptor);
  h.shortcut.handler(h.ctx);
  const answer = block(['after'], 'after');
  h.chat.addChild(answer);
  const index = indexed(h.doc, 46);
  assert.equal(called, 1);
  assert.deepEqual(index.horizons, [1, 2]);
  assert.deepEqual(index.lines, ['prefix', 'history', 'after', ...Array(9).fill('')]);
  assert.deepEqual(index.blocks.filter(b => b.checkpoint).map(b => [b.start, b.end]), [[2, 3]]);
  h.handlers.get('session_shutdown')({}, h.ctx);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.doc, 'render'), renderDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.doc, TRANSCRIPT_ROWS), rowsDescriptor);
});

test('cleanup drops own properties when render and rows were inherited', () => {
  const h = setup();
  const precedingRows = function (context) { return context.index(this.children, context.width); };
  const prototype = Object.create(Object.getPrototypeOf(h.doc), {
    [TRANSCRIPT_ROWS]: { value: precedingRows, configurable: true, writable: false },
  });
  Object.setPrototypeOf(h.doc, prototype);
  h.shortcut.handler(h.ctx);
  assert.deepEqual(indexed(h.doc).horizons, [1]);
  h.handlers.get('session_shutdown')({}, h.ctx);
  assert.equal(Object.hasOwn(h.doc, 'render'), false);
  assert.equal(Object.hasOwn(h.doc, TRANSCRIPT_ROWS), false);
  assert.equal(h.doc[TRANSCRIPT_ROWS], precedingRows);
});

test('shutdown leaves newer render/rows owners intact and deactivates chained old hooks', () => {
  const h = setup();
  h.shortcut.handler(h.ctx);
  const render = h.doc.render;
  const rows = h.doc[TRANSCRIPT_ROWS];
  const newerRender = function (width) { return render.call(this, width); };
  const newerRows = function (context) { return rows.call(this, context); };
  Object.defineProperty(h.doc, 'render', { value: newerRender, writable: false, enumerable: false, configurable: true });
  Object.defineProperty(h.doc, TRANSCRIPT_ROWS, { value: newerRows, writable: false, enumerable: false, configurable: true });
  const renderDescriptor = Object.getOwnPropertyDescriptor(h.doc, 'render');
  const rowsDescriptor = Object.getOwnPropertyDescriptor(h.doc, TRANSCRIPT_ROWS);
  h.handlers.get('session_shutdown')({}, h.ctx);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.doc, 'render'), renderDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.doc, TRANSCRIPT_ROWS), rowsDescriptor);
  assert.deepEqual(indexed(h.doc), { lines: ['history'], blocks: [{ start: 0, end: 1, kind: 'other', error: false, source: h.doc.children[0] }], horizons: [] });
});

test('cleanup leaves descriptors re-owned with the same method value untouched', () => {
  const h = setup();
  h.shortcut.handler(h.ctx);
  Object.defineProperty(h.doc, 'render', { value: h.doc.render, writable: false, configurable: false });
  Object.defineProperty(h.doc, TRANSCRIPT_ROWS, { value: h.doc[TRANSCRIPT_ROWS], writable: false, configurable: false });
  const renderDescriptor = Object.getOwnPropertyDescriptor(h.doc, 'render');
  const rowsDescriptor = Object.getOwnPropertyDescriptor(h.doc, TRANSCRIPT_ROWS);
  assert.doesNotThrow(() => h.handlers.get('session_shutdown')({}, h.ctx));
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.doc, 'render'), renderDescriptor);
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.doc, TRANSCRIPT_ROWS), rowsDescriptor);
  assert.deepEqual(indexed(h.doc).lines, ['history']);
  assert.deepEqual(indexed(h.doc).horizons, []);
});

test('render and rows ownership are restored independently', () => {
  for (const replaced of ['render', TRANSCRIPT_ROWS]) {
    const h = setup();
    h.shortcut.handler(h.ctx);
    const old = h.doc[replaced];
    const newer = function (...args) { return old.apply(this, args); };
    h.doc[replaced] = newer;
    h.handlers.get('session_shutdown')({}, h.ctx);
    assert.equal(h.doc[replaced], newer);
    if (replaced === 'render') assert.equal(Object.hasOwn(h.doc, TRANSCRIPT_ROWS), false);
    else assert.equal(h.doc.render, h.original);
    assert.deepEqual(indexed(h.doc).lines, ['history']);
    assert.deepEqual(indexed(h.doc).horizons, []);
  }
});

test('session restart releases the old hooks before installing a fresh clear', async () => {
  const h = setup();
  h.shortcut.handler(h.ctx);
  const oldRows = h.doc[TRANSCRIPT_ROWS];
  await h.handlers.get('session_start')({}, h.ctx);
  assert.equal(h.doc.render, h.original);
  assert.equal(Object.hasOwn(h.doc, TRANSCRIPT_ROWS), false);
  assert.deepEqual(oldRows(rowsContext(h.doc)).horizons, []);
  h.shortcut.handler(h.ctx);
  assert.notEqual(h.doc[TRANSCRIPT_ROWS], oldRows);
  assert.deepEqual(indexed(h.doc).horizons, [1]);
  h.handlers.get('session_shutdown')({}, h.ctx);
});

test('an unmeasurable preceding transform stays opaque instead of guessing child offsets', () => {
  const h = setup();
  const precedingRows = () => undefined;
  Object.defineProperty(h.doc, TRANSCRIPT_ROWS, { value: precedingRows, configurable: true });
  h.shortcut.handler(h.ctx);
  assert.equal(h.doc[TRANSCRIPT_ROWS](rowsContext(h.doc)), undefined);
  h.handlers.get('session_shutdown')({}, h.ctx);
  assert.equal(h.doc[TRANSCRIPT_ROWS], precedingRows);
});

test('an unwrappable rows descriptor rolls back the renderer without leaving a marker', () => {
  const h = setup();
  Object.defineProperty(h.doc, TRANSCRIPT_ROWS, { value: () => undefined, configurable: false, writable: false });
  h.shortcut.handler(h.ctx);
  assert.equal(h.doc.render, h.original);
  assert.equal(Object.hasOwn(h.doc, 'render'), false);
  assert.deepEqual(h.doc.render(80), ['history']);
  assert.deepEqual(h.chat.children, []);
  assert.match(h.notices.join('\n'), /cannot be wrapped/);
});
