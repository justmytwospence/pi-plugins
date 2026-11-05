import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PLACE_EVENT, place } from '../src/place-contract.ts';

const bus = (...listeners) => ({ emit: (channel, data) => { assert.equal(channel, PLACE_EVENT); for (const l of listeners) l(data); } });

test('no listener means no provider', () => {
  assert.equal(place(bus()), undefined);
});

test('only the first claim wins', () => {
  const claims = [];
  const a = (e) => claims.push(['a', e.claim('a')]);
  const b = (e) => claims.push(['b', e.claim('b')]);
  const res = place(bus(a, b));
  assert.equal(res.provider, 'a');
  assert.deepEqual(claims, [['a', true], ['b', false]]);
});

test('a probe has no request, a request does, and done resolves the result', async () => {
  let seen;
  const l = (e) => { seen = e; e.claim('p'); };
  place(bus(l));
  assert.equal('request' in seen, false);
  const req = { kind: 'open', root: '/r', path: '/r/.worktrees/a', title: 'a' };
  const res = place(bus((e) => { seen = e; e.claim('p'); setTimeout(() => e.done({ ok: true, detail: 'ok' }), 0); }), req);
  assert.deepEqual(seen.request, req);
  assert.deepEqual(await res.result, { ok: true, detail: 'ok' });
});

test('a throwing emit means no provider', () => {
  assert.equal(place({ emit() { throw new Error('x'); } }), undefined);
});
