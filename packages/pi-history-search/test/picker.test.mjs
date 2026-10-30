import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, getKeybindings, setKeybindings, visibleWidth } from '@earendil-works/pi-tui';
import { HistoryPicker } from '../src/picker.ts';

const theme = { fg: (_color, text) => text, bold: (text) => text };
const keys = { up: '\x1b[A', down: '\x1b[B', enter: '\r', escape: '\x1b', backspace: '\x7f', pageDown: '\x1b[6~', pageUp: '\x1b[5~' };
function fixture(prompts = ['recent', 'older'], query = '', config = {}) {
  const results = [];
  let renders = 0;
  const picker = new HistoryPicker(prompts, query, theme, new KeybindingsManager(TUI_KEYBINDINGS, config), () => renders++, (value) => results.push(value));
  const send = (...data) => data.forEach((value) => picker.handleInput(keys[value] ?? value));
  return { picker, send, results, renders: () => renders };
}

test('empty query keeps recency; fuzzy query ranks best first with stable recency ties', () => {
  const recent = fixture(['a___b', 'ab', 'Ab']);
  recent.send('enter');
  assert.deepEqual(recent.results, ['a___b']);
  const fuzzy = fixture(['a___b', 'ab', 'Ab'], 'ab');
  fuzzy.send('enter');
  assert.deepEqual(fuzzy.results, ['ab']);
  const tied = fixture(['AB', 'ab'], 'ab');
  tied.send('enter');
  assert.deepEqual(tied.results, ['AB']);
});

test('seeded query edits at end; returns complete original multiline text', () => {
  const full = 'alpha\n  beta\tend ';
  const f = fixture(['other', full], 'alph');
  f.send('a', 'enter');
  assert.deepEqual(f.results, [full]);
});

test('seed matching a remapped cancel action stays literal with the cursor at the end', () => {
  const previous = getKeybindings();
  const config = { 'tui.select.cancel': 'q', 'tui.editor.cursorLineEnd': [] };
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, config));
  try {
    const f = fixture(['other', 'qa', 'aq'], 'q', config);
    f.picker.focused = true;
    assert.ok(f.picker.render(46).some((line) => line.includes(`search: q${CURSOR_MARKER}`)));
    assert.deepEqual(f.results, []);
    f.send('a', 'enter');
    assert.deepEqual(f.results, ['qa']);
    const seeded = fixture(['other', 'q'], 'q', config);
    seeded.send('enter');
    assert.deepEqual(seeded.results, ['q']);
  } finally {
    setKeybindings(previous);
  }
});

test('j/k remain literal filter input and query changes reset selection', () => {
  const f = fixture(['joke', 'jk', 'other']);
  f.send('down', 'j', 'k', 'enter');
  assert.deepEqual(f.results, ['jk']);
  assert.equal(f.picker[Symbol.for('pi-plugins.input-context.v1')](), 'filter');
});

test('public Input handles cursor editing, backspace, and bracketed paste in chunks', () => {
  const f = fixture(['alpha', 'alpa']);
  f.send('alpx', 'backspace', '\x1b[200~h', 'a\x1b[201~', 'enter');
  assert.deepEqual(f.results, ['alpha']);
  const editing = fixture(['ac', 'abc'], 'ac');
  editing.send('\x1b[D', 'b', 'enter');
  assert.deepEqual(editing.results, ['abc']);
});

test('resolved actions honor remapping, including disabled default confirmation', () => {
  const f = fixture(['one', 'two', 'three'], '', {
    'tui.select.up': 'alt+u', 'tui.select.down': 'alt+d',
    'tui.select.confirm': 'alt+a', 'tui.select.cancel': 'alt+x',
  });
  f.send('down', 'enter');
  assert.deepEqual(f.results, []);
  f.send('\x1bd', '\x1bd', '\x1bu', '\x1ba');
  assert.deepEqual(f.results, ['two']);
  const cancel = fixture(['one'], 'query', { 'tui.select.cancel': 'alt+x' });
  cancel.send('\x1bx');
  assert.deepEqual(cancel.results, [undefined]);
});

test('local control navigation, repeated Ctrl+R, and paging move without wrapping', () => {
  for (const down of ['\x0e', '\x0a', '\x12']) {
    const f = fixture();
    f.send(down, down, 'enter');
    assert.deepEqual(f.results, ['older']);
  }
  for (const up of ['\x10', '\x0b']) {
    const f = fixture();
    f.send('down', up, up, 'enter');
    assert.deepEqual(f.results, ['recent']);
  }
  const prompts = Array.from({ length: 22 }, (_, i) => `prompt ${i}`);
  const f = fixture(prompts);
  f.send('pageDown', 'pageDown', 'pageUp', 'enter');
  assert.deepEqual(f.results, ['prompt 8']);
  const mapped = fixture(prompts, '', { 'tui.select.pageDown': 'alt+d' });
  mapped.send('\x1bd', 'enter');
  assert.deepEqual(mapped.results, ['prompt 8']);
});

test('height-aware windows keep selection visible through navigation, resize and filtering', () => {
  const prompts = Array.from({ length: 30 }, (_, i) => `prompt ${i}`);
  const f = fixture(prompts);
  for (const height of [13, 8, 6, 5, 4, 3, 2, 1, 0, 8, 40]) {
    for (let i = 0; i < 35; i++) {
      const lines = f.picker.render(46, height);
      assert.ok(lines.length <= height, `height ${height}`);
      if (height > 0) assert.equal(lines.filter(line => line.startsWith('› ')).length, 1);
      f.send('down');
    }
    for (let i = 0; i < 35; i++) {
      f.send('up');
      const lines = f.picker.render(46, height);
      if (height > 0) assert.equal(lines.filter(line => line.startsWith('› ')).length, 1);
    }
  }
  f.picker.render(46, 8); // five chrome rows leave a three-result page
  f.send('pageDown');
  assert.ok(f.picker.render(46, 8).includes('› prompt 3'));
  f.picker.render(46, 6);
  f.send('pageDown');
  assert.ok(f.picker.render(46, 6).includes('› prompt 4'));
  f.send('pageUp');
  assert.ok(f.picker.render(46, 6).includes('› prompt 3'));
  f.send('prompt 29');
  assert.ok(f.picker.render(46, 1).includes('› prompt 29'));
  f.send('enter');
  assert.deepEqual(f.results, ['prompt 29']);
  const empty = fixture([], '');
  for (const height of [0, 1, 2, 3, 8]) {
    const lines = empty.picker.render(46, height);
    assert.ok(lines.length <= height);
    if (height > 0) assert.ok(lines.includes('No matches'));
  }
});

test('Escape and Ctrl+C cancel immediately with a nonempty query; completion is single-shot', () => {
  for (const key of ['escape', '\x03']) {
    const f = fixture(['alpha'], 'alpha');
    f.send(key, 'enter');
    assert.deepEqual(f.results, [undefined]);
  }
});

test('Enter with no match is inert and releases neither navigate nor edit nor cancel', () => {
  const f = fixture(['alpha'], 'none');
  f.send('enter', '\x1b[27;1:3u', '\x1b[106;1:3u');
  assert.deepEqual(f.results, []);
  assert.match(f.picker.render(46).join('\n'), /No matches/);
  const move = fixture();
  move.send('\x1b[110;5:3u', 'enter');
  assert.deepEqual(move.results, ['recent']);
});

test('focus propagates cursor marker and every row fits narrow/wide Unicode widths', () => {
  const f = fixture(['界🧑‍💻e\u0301 '.repeat(100)], '界');
  f.picker.focused = true;
  assert.ok(f.picker.render(46).some((line) => line.includes(CURSOR_MARKER)));
  f.picker.focused = false;
  assert.ok(f.picker.render(46).every((line) => !line.includes(CURSOR_MARKER)));
  for (const width of [1, 20, 46, 120]) {
    for (const line of f.picker.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
  }
});

test('previews cannot inject ANSI, OSC, C0/C1, cursor markers, or multiline text', () => {
  const full = 'hi\x1b[31m red\x1b[0m\n\t\x1b]52;c;payload\x07end\x00\x9b31m';
  const f = fixture([full]);
  f.picker.focused = false;
  const rendered = f.picker.render(120).join('\n');
  const resultRow = f.picker.render(120).find((line) => line.startsWith('›'));
  assert.ok(resultRow);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/u.test(resultRow));
  assert.ok(!rendered.includes('payload'));
  f.send('enter');
  assert.deepEqual(f.results, [full]);
});
