import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { Container, KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences } from '@earendil-works/pi-tui';
import { HistoryPicker } from '../src/picker.ts';
import { pickerHeight } from '../src/index.ts';

const { createChatViewport } = await import(new URL('./modes/interactive/chat-viewport.js',
  process.env.PI_TEST_SDK ? pathToFileURL(process.env.PI_TEST_SDK) : import.meta.resolve('@earendil-works/pi-coding-agent')));
const { renderLayoutFrame } = await import(new URL('./layout.js', import.meta.resolve('@earendil-works/pi-tui')));
const theme = { fg: (_color, text) => text, bold: text => text };
const prompts = Array.from({ length: 20 }, (_, i) => `history result ${i}`);

function fixture(footerRows = 5) {
  const ui = { mode: 'fullscreen', terminal: { rows: 40 }, getMountedRoots: () => [root] };
  const picker = new HistoryPicker(prompts, '', theme, new KeybindingsManager(TUI_KEYBINDINGS), () => {}, () => {},
    width => pickerHeight(ui, picker, width));
  picker.focused = true;
  // The SDK's ordinary-custom dock is a Container, not a VStack or overlay.
  const editor = new Container();
  editor.addChild(picker);
  const document = { render: () => ['CONVERSATION'], invalidate() {} };
  const footer = { render: () => Array.from({ length: footerRows }, (_, i) => `footer ${i}`), invalidate() {} };
  const { root } = createChatViewport({ document, editor, footer,
    pendingMessages: new Container(), status: new Container(), scrollbar: 'hidden' });
  const paint = (height, width) => {
    ui.terminal.rows = height;
    return renderLayoutFrame(root, width, height, () => {});
  };
  return { picker, editor, paint };
}

function boxes(box) { return [box, ...box.children.flatMap(boxes)]; }
function assertSelected(frame, index) {
  const lines = frame.lines.map(stripTerminalSequences);
  assert.equal(lines.filter(line => line.startsWith('› ')).length, 1, lines.join('\n'));
  assert.ok(lines.includes(`› history result ${index}`), lines.join('\n'));
  const allocated = boxes(frame.root).find(box => box.component.children?.some(child => child instanceof HistoryPicker));
  const height = allocated.rect.height;
  const queryRow = lines.findIndex(line => line.startsWith('search: '));
  assert.ok(queryRow >= 0, lines.join('\n'));
  assert.equal(lines.some(line => line.startsWith('╭ Prompt history ')), height >= 4,
    `header must fit the ${height}-row editor allocation:\n${lines.join('\n')}`);
  if (height >= 4) assert.match(lines[queryRow - 1], /^╭ Prompt history .*╮$/);
  const capacity = Math.max(1, Math.min(8, height - (height >= 4 ? 2 : 1)
    - Number(height >= 3) - Number(height >= 5) - Number(height >= 6)));
  const start = Math.max(0, Math.min(index - Math.floor(capacity / 2), prompts.length - capacity));
  const results = prompts.slice(start, start + capacity).map((prompt, offset) =>
    `${start + offset === index ? '› ' : '  '}${prompt}`);
  assert.deepEqual(lines.filter(line => /^(› |  )history result /.test(line)), results);
  assert.deepEqual(lines.slice(queryRow + 1, queryRow + 1 + capacity), results);
  assert.ok(frame.lines.filter(line => line.includes('\x1b_pi:c\x07')).every(line => stripTerminalSequences(line).startsWith('search: ')));
}

for (const width of [46, 120, 180]) for (const footerRows of [0, 5, 13]) {
  test(`allocated dock reveals on first navigation/resize paint (${width} columns, ${footerRows} footer rows)`, () => {
    const { picker, paint } = fixture(footerRows);
    assertSelected(paint(40, width), 0);
    for (let i = 1; i < prompts.length; i++) {
      picker.handleInput('\x1b[B');
      assertSelected(paint(8, width), i);
    }
    for (const height of [40, 6, 4, 3, 8, 40]) assertSelected(paint(height, width), 19);
    for (let i = 18; i >= 0; i--) {
      picker.handleInput('\x1b[A');
      assertSelected(paint(8, width), i);
    }
  });
}

test('eight-row terminal with five-row footer reveals result 19/20 in allocated editor space', () => {
  const { picker, editor, paint } = fixture();
  for (let i = 0; i < 19; i++) picker.handleInput('\x1b[B');
  const frame = paint(8, 46);
  const allocated = boxes(frame.root).find(box => box.component === editor);
  assert.ok(allocated.rect.height < 8);
  assert.ok(frame.lines.some(line => line.startsWith('footer ')), 'footer occupies actual allocated space');
  assertSelected(frame, 19);
});

for (const width of [46, 120, 180]) {
  test(`ordinary natural rendering remains compact and exact (${width} columns)`, () => {
    const { picker, editor, paint } = fixture();
    const frame = paint(40, width);
    const allocated = boxes(frame.root).find(box => box.component === editor);
    assert.ok(frame.lines.includes('CONVERSATION'));
    assert.equal(allocated.rect.height, 13);
    assert.deepEqual(frame.lines.slice(allocated.rect.y, allocated.rect.y + 13), picker.render(width));
    assert.equal(frame.lines.map(stripTerminalSequences).filter(line => /^.[ ]history result/.test(line)).length, 8);
  });
}
