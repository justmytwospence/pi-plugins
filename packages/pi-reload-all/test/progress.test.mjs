import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ackFolder, markReloaded, parseAcks, pruneAcks, readAcks, remoteReadCommand, writeAck } from '../src/acks.ts';
import { Progress, PROGRESS_LIMIT_MS, SETTLE_MS, summarize } from '../src/progress.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'reload-acks-'));
const ack = (session, state, extra = {}) => ({ session, host: 'mac', name: session, state, at: 1, ...extra });

test('acks round-trip locally and through the remote shell read', () => {
  const dir = tmp();
  try {
    writeAck('req-1', { session: 's1', name: 'pi-plugins', state: 'pending', reason: 'typing' }, dir);
    writeAck('req-1', { session: 's2', name: 'uplft', state: 'reloaded' }, dir);
    const local = readAcks('req-1', dir).sort((a, b) => a.session.localeCompare(b.session));
    assert.deepEqual(local.map((a) => [a.name, a.state, a.reason]), [['pi-plugins', 'pending', 'typing'], ['uplft', 'reloaded', undefined]]);
    const out = execFileSync('sh', ['-c', remoteReadCommand('req-1')], { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: 'utf8' });
    assert.equal(parseAcks(out).length, 2);
    assert.equal(execFileSync('sh', ['-c', remoteReadCommand('none')], { env: { ...process.env, PI_CODING_AGENT_DIR: dir }, encoding: 'utf8' }), '');
  } finally { rmSync(dir, { recursive: true }); }
});

test('the next runtime marks its reloading reports reloaded, and old folders are pruned', () => {
  const dir = tmp();
  try {
    writeAck('a', { session: 's1', name: 'x', state: 'reloading' }, dir);
    writeAck('b', { session: 's1', name: 'x', state: 'pending' }, dir);
    markReloaded('s1', dir);
    assert.equal(readAcks('a', dir)[0].state, 'reloaded');
    assert.equal(readAcks('b', dir)[0].state, 'pending', 'only reloading reports');
    utimesSync(ackFolder('a', dir), 1, 1);
    pruneAcks(dir);
    assert.deepEqual(readdirSync(join(dir, 'reload-acks')), ['b']);
  } finally { rmSync(dir, { recursive: true }); }
});

test('summary: counts, pending first, not answering, and when it is done', () => {
  const t = { id: 'r', at: 0, machines: [], expected: 3 };
  let s = summarize(t, [ack('a', 'reloaded'), ack('b', 'pending', { reason: 'typing' })], 1000, 1000);
  assert.equal(s.title, 'reload-all · 1/3 reloaded');
  assert.match(s.lines[1], /b\s+pending: typing/);
  assert.equal(s.done, false);
  s = summarize(t, [ack('a', 'reloaded'), ack('b', 'failed', { reason: 'x' })], SETTLE_MS + 10, 5);
  assert.equal(s.done, true);
  assert.equal(s.title, 'reload-all · 1/3 reloaded · 1 failed · 1 not answering');
  s = summarize(t, [ack('a', 'reloaded'), ack('b', 'reloaded'), ack('c', 'reloaded')], 10, 10);
  assert.equal(s.done, true, 'everyone expected answered');
  s = summarize(t, [ack('a', 'pending')], PROGRESS_LIMIT_MS, 0);
  assert.equal(s.done, true);
  assert.match(s.title, /stopped watching/);
});

test('Progress polls local and remote reports, paints them, and finishes once', async () => {
  const widgets = [];
  const remote = [JSON.stringify({ session: 'n1', host: 'nuc', name: 'homelab', state: 'pending', reason: 'draft' })];
  let local = [ack('m1', 'reloading')];
  const finals = [];
  const id = (s) => s;
  const p = new Progress({ id: 'r', at: 0, machines: [{ label: 'NUC', target: 'nuc' }], expected: 2 },
    { setWidget: (k, l) => widgets.push(l), dim: id, accent: id, warn: id, ok: id },
    { now: () => 1000, exec: async (file, args) => { assert.equal(file, 'ssh'); assert.ok(args.includes('nuc')); return remote.join('\n'); } },
    (lines) => finals.push(lines), () => local);
  await p.tick();
  p.stop();
  assert.equal(widgets.at(-1)[0], 'reload-all · 0/2 reloaded');
  assert.equal(widgets.at(-1).length, 3);
  local = [ack('m1', 'reloaded')];
  remote[0] = JSON.stringify({ session: 'n1', host: 'nuc', name: 'homelab', state: 'reloaded' });
  const q = new Progress({ id: 'r', at: 0, machines: [{ label: 'NUC', target: 'nuc' }], expected: 2 },
    { setWidget: (k, l) => widgets.push(l), dim: id, accent: id, warn: id, ok: id },
    { now: () => 2000, exec: async () => remote.join('\n') }, (lines) => finals.push(lines), () => local);
  await q.tick();
  assert.equal(finals.length, 1);
  assert.equal(finals[0][0], 'reload-all · 2/2 reloaded');
  assert.equal(widgets.at(-1), undefined, 'view cleared when done');
});
