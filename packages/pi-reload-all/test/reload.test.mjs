import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import reloadAll, { countPi, parseMachines, PENDING_COMMAND, signalMachines, waitUntilSafe } from '../src/index.ts';
import { FILE_NAME, isFresh, makeRequest, readRequest, remoteWriteCommand, writeRequest } from '../src/signal.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'reload-all-'));

test('a request is written atomically and read back with its local mtime', () => {
  const dir = tmp();
  try {
    const request = makeRequest('mac', 1);
    writeRequest(request, dir);
    const read = readRequest(dir);
    assert.equal(read.id, request.id);
    assert.equal(read.origin, 'mac');
    assert.ok(read.seen > 1, 'seen is the mtime, not the writer clock');
  } finally { rmSync(dir, { recursive: true }); }
});

test('freshness uses the local mtime and skips handled ids', () => {
  const dir = tmp();
  try {
    writeRequest(makeRequest('nuc', 0), dir);
    utimesSync(join(dir, FILE_NAME), 2000, 2000);
    const read = readRequest(dir);
    assert.equal(isFresh(read, 1_000_000, new Set()), true);
    assert.equal(isFresh(read, 3_000_000, new Set()), false, 'written before the session started');
    assert.equal(isFresh(read, 1_000_000, new Set([read.id])), false);
    assert.equal(isFresh(undefined, 0, new Set()), false);
  } finally { rmSync(dir, { recursive: true }); }
});

test('the remote shell command writes the same file, quoting included', () => {
  const dir = tmp();
  try {
    const request = { id: "it's", at: 5, origin: 'a"b' };
    execFileSync('sh', ['-c', remoteWriteCommand(request)], { env: { ...process.env, PI_CODING_AGENT_DIR: join(dir, 'agent') } });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'agent', FILE_NAME), 'utf8')), request);
  } finally { rmSync(dir, { recursive: true }); }
});

test('machines: enabled ones with a target', () => {
  assert.deepEqual(parseMachines(JSON.stringify([
    { label: 'NUC', target: 'nuc', enabled: true },
    { label: 'Off', target: 'off', enabled: false },
    { target: 'bare' },
  ])), [{ label: 'NUC', target: 'nuc' }, { label: 'bare', target: 'bare' }]);
  assert.deepEqual(parseMachines('not json'), []);
  assert.equal(countPi(JSON.stringify({ result: { agents: [{ agent: 'pi' }, { agent: 'codex' }, { agent: 'pi' }] } })), 2);
  assert.equal(countPi('{}'), undefined);
});

test('signalMachines reports ssh failures and counts per machine', async () => {
  const calls = [];
  const deps = {
    now: () => 0, sleep: async () => {},
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (file === 'herdr' && args[0] === 'machine') return JSON.stringify([{ label: 'NUC', target: 'nuc' }, { label: 'Down', target: 'down' }]);
      if (file === 'ssh' && args.includes('down')) throw Object.assign(new Error('x'), { stderr: '** WARNING: pq\nssh: connect to host down: refused\n' });
      if (file === 'herdr') return JSON.stringify({ result: { agents: [{ agent: 'pi' }] } });
      return '';
    },
  };
  const reports = await signalMachines(makeRequest(), deps);
  assert.deepEqual(reports, [
    { machine: 'NUC', ok: true, sessions: 1 },
    { machine: 'Down', ok: false, error: 'ssh: connect to host down: refused' },
  ]);
  assert.ok(calls.some((c) => c[0] === 'ssh' && c.includes('BatchMode=yes')));
});

function fakeCtx(states) {
  let i = 0;
  const state = () => states[Math.min(i, states.length - 1)];
  return {
    waits: 0,
    async waitForIdle() { this.waits++; },
    isIdle: () => state().idle,
    hasPendingMessages: () => !!state().queued,
    ui: { getEditorText: () => state().draft ?? '' },
    advance() { i++; },
  };
}

test('waitUntilSafe waits out a running turn, a queued message and a draft', async () => {
  const ctx = fakeCtx([{ idle: false }, { idle: true, queued: true }, { idle: true, draft: 'half' }, { idle: true, draft: '  ' }]);
  let sleeps = 0;
  const ok = await waitUntilSafe(ctx, () => false, { sleep: async () => { sleeps++; ctx.advance(); } });
  assert.equal(ok, true);
  assert.equal(sleeps, 3);
});

test('waitUntilSafe gives up once the runtime is stale', async () => {
  let stale = false;
  const ctx = fakeCtx([{ idle: true, draft: 'keep' }]);
  const ok = await waitUntilSafe(ctx, () => stale, { sleep: async () => { stale = true; } });
  assert.equal(ok, false);
});

test('a fresh request makes the session dispatch its own reload command once', async () => {
  const dir = tmp();
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const statuses = [];
  try {
    reloadAll({
      on: (n, h) => handlers.set(n, h),
      registerCommand: (n, c) => commands.set(n, c),
      registerEntryRenderer() {},
      appendEntry() {},
      sendUserMessage: (text, options) => sent.push([text, options]),
    }, { now: () => 0, sleep: async () => {}, exec: async () => { throw new Error('no herdr'); } });
    assert.ok(commands.has('reload-all') && commands.has(PENDING_COMMAND));
    const ctx = { mode: 'tui', hasUI: true, ui: { setStatus: (k, v) => statuses.push([k, v]) } };
    handlers.get('session_start')({}, ctx);
    writeRequest(makeRequest(), dir);
    for (let i = 0; i < 50 && !sent.length; i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sent, [[`/${PENDING_COMMAND}`, { expandPromptTemplates: true }]]);
    assert.deepEqual(statuses, [['reload-all', 'reload pending']]);
    let reloaded = 0;
    await commands.get(PENDING_COMMAND).handler('', { ...fakeCtx([{ idle: true }]), reload: async () => { reloaded++; } });
    assert.equal(reloaded, 1);
    handlers.get('session_shutdown')({}, ctx);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true });
  }
});

test('print and RPC sessions do not watch', () => {
  const handlers = new Map();
  reloadAll({ on: (n, h) => handlers.set(n, h), registerCommand() {}, registerEntryRenderer() {}, appendEntry() {}, sendUserMessage() { throw new Error('no'); } });
  handlers.get('session_start')({}, { mode: 'rpc', hasUI: true, ui: {} });
  handlers.get('session_shutdown')({}, {});
});

test('/reload-all reports first, then reloads its own session once, and nothing after', async () => {
  const dir = tmp();
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const order = [];
  let stale = false;
  const live = (name) => { assert.ok(!stale, `${name} used after reload`); };
  try {
    let release;
    const slow = new Promise((r) => { release = r; });
    reloadAll({
      on: (n, h) => handlers.set(n, h),
      registerCommand: (n, c) => commands.set(n, c),
      registerEntryRenderer() {},
      appendEntry: () => { live('pi.appendEntry'); order.push('report'); },
      sendUserMessage: (t) => sent.push(t),
    }, { now: () => 0, sleep: async () => {}, exec: async (file, args) => { if (args[0] === 'machine') { await slow; return '[]'; } throw new Error('no'); } });
    const ctx = { mode: 'tui', hasUI: true, ...fakeCtx([{ idle: true }]), ui: { setStatus() {}, getEditorText: () => '', notify() { live('notify'); } },
      reload: async () => { live('reload'); order.push('reload'); handlers.get('session_shutdown')({}, ctx); stale = true; } };
    handlers.get('session_start')({}, ctx);
    const running = commands.get('reload-all').handler('', ctx);
    // The watcher sees the request while ssh/herdr calls are still out: it must not act.
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(sent, []);
    release();
    await running;
    assert.deepEqual(order, ['report', 'reload']);
  } finally {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true });
  }
});
