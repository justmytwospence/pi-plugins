import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Holds } from '../src/holds.ts';

test('holds by id, oldest first without one, per channel', () => {
  const h = new Holds();
  h.apply('herdr:background', { active: true, label: 'child a', id: 'a' });
  h.apply('herdr:background', { active: true, label: 'child b', id: 'b' });
  h.apply('herdr:working', { active: true });
  assert.deepEqual(h.labels(), ['child a', 'child b', 'background']);
  h.apply('herdr:background', { active: false, id: 'b' });
  assert.deepEqual(h.labels(), ['child a', 'background']);
  h.apply('herdr:background', { active: false });
  assert.deepEqual(h.labels(), ['background']);
  h.apply('herdr:background', { active: false });
  assert.deepEqual(h.labels(), ['background'], 'a release on another channel leaves it');
  h.apply('herdr:working', { active: false });
  assert.deepEqual(h.labels(), []);
});
