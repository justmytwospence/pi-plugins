import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrefixHistory, sessionPrompts } from '../src/history.ts';

const message = (content, role = 'user') => ({ type: 'message', message: { role, content } });
const text = (value) => ({ type: 'text', text: value });

test('extracts only nonblank user text, preserving full text and newest distinct occurrence', () => {
  const entries = [
    message('old'), message('duplicate'), message('assistant', 'assistant'),
    { type: 'custom', data: 'ignored' }, message([text(' a '), { type: 'image', data: 'image' }, text('\nb\t')]),
    message([text(' \n\t')]), message([{ type: 'image' }]), message('duplicate'), message(' old '),
  ];
  assert.deepEqual(sessionPrompts(entries), [' old ', 'duplicate', ' a \n\nb\t', 'old']);
});

test('has no 100 entry limit and only sees supplied branch entries', () => {
  const entries = Array.from({ length: 150 }, (_, i) => message(`prompt ${i}`));
  assert.equal(sessionPrompts(entries).length, 150);
  assert.equal(sessionPrompts(entries).at(-1), 'prompt 0');
  assert.deepEqual(sessionPrompts(entries.slice(0, 2)), ['prompt 1', 'prompt 0']);
});

test('freezes full case-sensitive prefix and candidates; excludes exact draft and never wraps', () => {
  const history = new PrefixHistory();
  const prompts = ['work', 'work newer', 'Work wrong case', 'unrelated work', 'work older'];
  assert.deepEqual(history.navigate(-1, 'work', prompts), { consume: true, text: 'work newer' });
  assert.deepEqual(history.navigate(-1, 'work newer', ['work added']), { consume: true, text: 'work older' });
  assert.deepEqual(history.navigate(-1, 'work older', prompts), { consume: true });
  assert.deepEqual(history.navigate(1, 'work older', prompts), { consume: true, text: 'work newer' });
  assert.deepEqual(history.navigate(1, 'work newer', prompts), { consume: true, text: 'work' });
  assert.deepEqual(history.navigate(1, 'work', prompts), { consume: true });
  assert.deepEqual(history.navigate(-1, 'work', []), { consume: true, text: 'work newer' });
});

test('restores exact multiline whitespace draft and restarts on an external edit', () => {
  const history = new PrefixHistory();
  const draft = ' x\n ';
  assert.equal(history.navigate(-1, draft, [draft + 'one']).text, draft + 'one');
  assert.equal(history.navigate(1, draft + 'one', []).text, draft);
  assert.equal(history.navigate(-1, 'new', ['new result']).text, 'new result');
});

test('no match and newer-before-older are consumed without returning text', () => {
  const history = new PrefixHistory();
  assert.deepEqual(history.navigate(1, 'x', ['xyz']), { consume: true });
  assert.deepEqual(history.navigate(-1, 'x', ['other', 'x']), { consume: true });
  assert.deepEqual(history.navigate(-1, 'x', ['xyz']), { consume: true });
  history.reset();
  assert.equal(history.navigate(-1, 'x', ['xyz']).text, 'xyz');
});

test('empty native passthrough persists through recalled text until reset, in either direction', () => {
  for (const first of [-1, 1]) {
    const history = new PrefixHistory();
    assert.deepEqual(history.navigate(first, '', ['old']), { consume: false });
    assert.deepEqual(history.navigate(-1, 'old', ['older']), { consume: false });
    assert.deepEqual(history.navigate(1, 'older', ['old']), { consume: false });
    history.reset();
    assert.deepEqual(history.navigate(-1, 'old', ['older']), { consume: true, text: 'older' });
  }
});
