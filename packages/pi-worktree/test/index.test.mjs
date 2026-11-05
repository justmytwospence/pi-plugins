import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorktree, completions } from '../src/index.ts';
import { nodeRun } from '../src/git.ts';
import { defaultSessionDir, writeEmptySession } from '../src/sessions.ts';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pi-worktree-index-')));
  const origin = join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const root = join(tmp, 'root');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'remote', 'set-head', 'origin', '-a');
  return { tmp, root, agentDir: join(tmp, 'agent') };
}

function fakePi() {
  const listeners = new Map();
  const commands = new Map();
  const handlers = new Map();
  const sent = [];
  const entries = [];
  const order = [];
  let tool;
  const pi = {
    events: {
      on: (ch, fn) => { listeners.set(ch, [...(listeners.get(ch) ?? []), fn]); },
      emit: (ch, data) => { for (const fn of listeners.get(ch) ?? []) fn(data); },
    },
    registerCommand: (name, spec) => commands.set(name, spec),
    registerTool: (t) => { tool = t; },
    registerEntryRenderer: () => {},
    on: (event, fn) => handlers.set(event, fn),
    appendEntry: (type, data) => { entries.push([type, data]); order.push(`entry:${type}`); },
    sendUserMessage: (...args) => { sent.push(args); },
    getSessionName: () => 'task',
    getThinkingLevel: () => 'low',
  };
  return { pi, commands, handlers, sent, entries, order, get tool() { return tool; }, listeners };
}

function fakeCtx(root, agentDir, extra = {}) {
  const dir = defaultSessionDir(root, agentDir);
  const file = writeEmptySession(dir, root);
  appendFileSync(file, `${JSON.stringify({ type: 'session_info', id: 'a1', parentId: null, timestamp: new Date().toISOString(), name: 't' })}\n`);
  const notes = [];
  const switched = [];
  return {
    notes, switched, file,
    ctx: {
      cwd: root, mode: 'tui', hasUI: true, model: { provider: 'p', id: 'm' },
      isIdle: () => true,
      sessionManager: { getSessionFile: () => file, getCwd: () => root, getSessionDir: () => dir },
      ui: { notify: (m, level) => notes.push([m, level]), confirm: async () => true },
      switchSession: async (f, opts) => {
        switched.push(f);
        await opts?.withSession?.({ ui: { notify: (m, level) => notes.push([m, level]) }, sendUserMessage: async (p) => { switched.push(['prompt', p]); } });
        return { cancelled: false };
      },
      ...extra,
    },
  };
}

const header = (file) => JSON.parse(readFileSync(file, 'utf8').split('\n')[0]);
const provider = (bus, pi, result) => {
  const requests = [];
  pi.events.on('worktree:place', (e) => {
    if (!e.claim('fake')) return;
    if (!e.request) return;
    requests.push(e.request);
    e.done(result(e.request));
  });
  return requests;
};
const tick = () => new Promise((r) => setTimeout(r, 5));

test('registers its commands, tool and hooks', () => {
  const f = fakePi();
  createWorktree(f.pi, {});
  assert.deepEqual([...f.commands.keys()].sort(), ['worktree', 'worktree-continue']);
  assert.equal(f.tool.name, 'worktree');
  assert.equal(typeof f.handlers.get('agent_settled'), 'function');
  assert.equal(typeof f.handlers.get('session_shutdown'), 'function');
});

test('completes subcommands', async () => {
  assert.deepEqual((await completions('')).map((c) => c.value), ['new', 'move', 'open', 'done', 'ls']);
  assert.deepEqual((await completions('d')).map((c) => c.value), ['done']);
  assert.equal(await completions('zzz'), null);
});

test('the tool creates a worktree, moves through a provider after the turn, and closes last', async () => {
  const { tmp, root, agentDir } = setup();
  try {
    const f = fakePi();
    createWorktree(f.pi, { run: nodeRun, agentDir, env: {} });
    const requests = provider(null, f.pi, (req) => ({ ok: true, detail: 'placed', close: async () => { f.order.push('close'); } }));
    const { ctx, notes } = fakeCtx(root, agentDir);
    const res = await f.tool.execute('1', { action: 'new', branch: 'try-move' }, undefined, undefined, ctx);
    const wt = join(root, '.worktrees', 'try-move');
    assert.ok(existsSync(wt));
    assert.match(res.content[0].text, /When this turn ends/);
    assert.match(res.content[0].text, /this pane closes/);
    f.handlers.get('agent_settled')({ aborted: false }, ctx);
    await tick();
    assert.equal(f.sent.length, 1);
    const [text, opts] = f.sent[0];
    assert.match(text, /^\/worktree-continue [\w-]+$/);
    assert.deepEqual(opts, { expandPromptTemplates: true });
    await f.commands.get('worktree-continue').handler(text.split(' ')[1], ctx);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].kind, 'move');
    assert.equal(requests[0].path, wt);
    assert.equal(header(requests[0].file).cwd, wt);
    assert.match(requests[0].prompt, /^\[pi-worktree\] This conversation moved from /);
    assert.deepEqual(f.order, ['entry:pi-worktree:moved', 'close']);
    assert.ok(notes.some(([m]) => m === 'placed'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('an aborted turn cancels the pending move', async () => {
  const { tmp, root, agentDir } = setup();
  try {
    const f = fakePi();
    createWorktree(f.pi, { run: nodeRun, agentDir, env: {} });
    provider(null, f.pi, () => ({ ok: true, detail: 'x' }));
    const { ctx, notes } = fakeCtx(root, agentDir);
    await f.tool.execute('1', { action: 'new', branch: 'gone' }, undefined, undefined, ctx);
    f.handlers.get('agent_settled')({ aborted: true }, ctx);
    await tick();
    assert.equal(f.sent.length, 0);
    assert.ok(notes.some(([m, l]) => /cancelled/.test(m) && l === 'warning'));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('background work blocks a move before anything is created', async () => {
  const { tmp, root, agentDir } = setup();
  try {
    const f = fakePi();
    createWorktree(f.pi, { run: nodeRun, agentDir, env: {} });
    provider(null, f.pi, () => ({ ok: true, detail: 'x' }));
    f.pi.events.emit('herdr:background', { active: true, label: 'child x', id: 'c' });
    const { ctx } = fakeCtx(root, agentDir);
    await assert.rejects(f.tool.execute('1', { action: 'new', branch: 'held' }, undefined, undefined, ctx), /Background work is still running/);
    assert.equal(existsSync(join(root, '.worktrees', 'held')), false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('under Switchyard the worktree is created but nothing moves', async () => {
  const { tmp, root, agentDir } = setup();
  try {
    const f = fakePi();
    createWorktree(f.pi, { run: nodeRun, agentDir, env: { SWITCHYARD_CONTROL_SOCKET: '/s' } });
    const { ctx } = fakeCtx(root, agentDir);
    const res = await f.tool.execute('1', { action: 'new', branch: 'sy' }, undefined, undefined, ctx);
    assert.ok(existsSync(join(root, '.worktrees', 'sy')));
    assert.match(res.content[0].text, /Switchyard/);
    f.handlers.get('agent_settled')({ aborted: false }, ctx);
    await tick();
    assert.equal(f.sent.length, 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('a subagent cannot create or move, but can list', async () => {
  const { tmp, root, agentDir } = setup();
  try {
    const f = fakePi();
    createWorktree(f.pi, { run: nodeRun, agentDir, env: { PI_SUBAGENT: '1' } });
    const { ctx } = fakeCtx(root, agentDir);
    await assert.rejects(f.tool.execute('1', { action: 'new', branch: 'sub' }, undefined, undefined, ctx), /subagent/);
    const res = await f.tool.execute('1', { action: 'list' }, undefined, undefined, ctx);
    assert.match(res.content[0].text, /No linked worktrees/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('without a provider an interactive Pi switches the session in place', async () => {
  const { tmp, root, agentDir } = setup();
  try {
    const f = fakePi();
    createWorktree(f.pi, { run: nodeRun, agentDir, env: {} });
    const { ctx, switched } = fakeCtx(root, agentDir);
    await f.commands.get('worktree').handler('new other', ctx);
    const wt = join(root, '.worktrees', 'other');
    assert.ok(existsSync(wt));
    assert.equal(typeof switched[0], 'string');
    assert.equal(header(switched[0]).cwd, wt);
    assert.equal(switched.length, 1, 'a user-started move sends no prompt');
    // an agent-started move carries a prompt into the new session
    await f.tool.execute('1', { action: 'new', branch: 'agent' }, undefined, undefined, ctx);
    f.handlers.get('agent_settled')({ aborted: false }, ctx);
    await tick();
    await f.commands.get('worktree-continue').handler(f.sent[0][0].split(' ')[1], ctx);
    const prompt = switched.find((s) => Array.isArray(s));
    assert.match(prompt[1], /^\[pi-worktree\]/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('done refuses an unmerged branch and removes a merged one after the provider is ok', async () => {
  const { tmp, root, agentDir } = setup();
  try {
    let merged = false;
    const run = async (cmd, args, opts) => {
      if (cmd !== 'gh') return nodeRun(cmd, args, opts);
      const branch = args[args.indexOf('--head') + 1];
      const tip = git(root, 'rev-parse', branch);
      return { code: 0, stdout: JSON.stringify(merged ? [{ headRefOid: tip }] : []), stderr: '' };
    };
    const f = fakePi();
    createWorktree(f.pi, { run, agentDir, env: {} });
    let ok = true;
    const requests = provider(null, f.pi, () => (ok ? { ok: true, detail: 'back', close: async () => { f.order.push('close'); } } : { ok: false, error: 'no space' }));
    git(root, 'worktree', 'add', '-q', '--no-track', '-b', 'fin', join(root, '.worktrees', 'fin'), 'origin/main');
    const wt = join(root, '.worktrees', 'fin');
    const { ctx } = fakeCtx(wt, agentDir);
    await assert.rejects(f.tool.execute('1', { action: 'done' }, undefined, undefined, ctx), /has no merged pull request/);
    merged = true;
    await f.tool.execute('1', { action: 'done' }, undefined, undefined, ctx);
    f.handlers.get('agent_settled')({ aborted: false }, ctx);
    await tick();
    ok = false;
    await f.commands.get('worktree-continue').handler(f.sent[0][0].split(' ')[1], ctx);
    assert.ok(existsSync(wt), 'a failed placement keeps the worktree');
    await f.tool.execute('1', { action: 'done' }, undefined, undefined, ctx);
    f.handlers.get('agent_settled')({ aborted: false }, ctx);
    await tick();
    ok = true;
    await f.commands.get('worktree-continue').handler(f.sent[1][0].split(' ')[1], ctx);
    assert.equal(existsSync(wt), false);
    assert.throws(() => git(root, 'rev-parse', '--verify', 'refs/heads/fin'));
    assert.equal(requests.at(-1).path, root);
    assert.deepEqual(f.order.filter((o) => o === 'close'), ['close']);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
