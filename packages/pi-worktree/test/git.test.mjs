import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  defaultBase, fastForwardRoot, fetchOrigin, inUse, isClean, isManaged, isMerged, listWorktrees, nodeRun,
  parseLockReason, parseWorktrees, pruneMerged, removeWorktree, worktreePath,
} from '../src/git.ts';

const PORCELAIN = `worktree /r
HEAD aaa
branch refs/heads/main

worktree /r/.worktrees/a
HEAD bbb
branch refs/heads/a
locked pi-worktree pid 12 host mac

worktree /r/.worktrees/b
HEAD ccc
branch refs/heads/b
locked

worktree /r/.worktrees/d
HEAD ddd
detached
prunable gitdir file points to non-existent location

worktree /bare
bare
`;

test('parseWorktrees reads branches, locks, detached and prunable entries', () => {
  const list = parseWorktrees(PORCELAIN);
  assert.equal(list.length, 4);
  assert.deepEqual(list[0], { path: '/r', head: 'aaa', branch: 'main', detached: false, locked: false, prunable: false });
  assert.equal(list[1].locked, true);
  assert.equal(list[1].lockReason, 'pi-worktree pid 12 host mac');
  assert.equal(list[2].locked, true);
  assert.equal(list[2].lockReason, undefined);
  assert.equal(list[3].detached, true);
  assert.equal(list[3].prunable, true);
  assert.equal(list[3].branch, undefined);
});

test('paths and managed worktrees', () => {
  assert.equal(worktreePath('/r', 'a/b'), join('/r', '.worktrees', 'a-b'));
  const w = (path) => ({ path, detached: false, locked: false, prunable: false });
  assert.equal(isManaged('/r', w('/r/.worktrees/x')), true);
  assert.equal(isManaged('/r', w('/r/.worktrees/subagent-x')), false);
  assert.equal(isManaged('/r', w('/elsewhere/x')), false);
});

test('lock reasons and in-use detection', () => {
  assert.deepEqual(parseLockReason('pi-worktree pid 12 host mac'), { pid: 12, host: 'mac' });
  assert.equal(parseLockReason('something else'), undefined);
  const w = (locked, lockReason) => ({ path: '/x', detached: false, locked, lockReason, prunable: false });
  const reason = 'pi-worktree pid 12 host mac';
  assert.equal(inUse(w(true, reason), 'mac', () => true).busy, true, 'own host, live pid');
  assert.equal(inUse(w(true, reason), 'mac', () => false).busy, false, 'own host, dead pid');
  assert.equal(inUse(w(true, reason), 'nuc', () => false).busy, true, 'other host');
  assert.equal(inUse(w(true, 'manual lock'), 'mac', () => false).busy, true, 'foreign reason');
  assert.equal(inUse(w(true, undefined), 'mac', () => false).busy, true, 'bare lock');
  assert.equal(inUse(w(false, undefined), 'mac', () => true).busy, false, 'unlocked');
});

const fakeRun = (sha, gh) => async (cmd, args) => {
  if (cmd === 'git') return sha ? { code: 0, stdout: `${sha}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
  return gh;
};

test('isMerged needs a merged PR at the exact branch tip', async () => {
  const ok = { code: 0, stdout: JSON.stringify([{ headRefOid: 'abc' }]), stderr: '' };
  assert.deepEqual(await isMerged(fakeRun('abc', ok), '/r', 'x'), { merged: true, sha: 'abc' });
  assert.equal((await isMerged(fakeRun('def', ok), '/r', 'x')).merged, false);
  const failed = await isMerged(fakeRun('abc', { code: 1, stdout: '', stderr: 'not logged in\nmore' }), '/r', 'x');
  assert.equal(failed.merged, false);
  assert.equal(failed.note, 'gh could not check pull requests: not logged in');
  assert.equal((await isMerged(fakeRun(undefined, ok), '/r', 'x')).note, 'no such branch');
  assert.equal((await isMerged(fakeRun('abc', { code: 0, stdout: 'nope', stderr: '' }), '/r', 'x')).note, 'unreadable gh output');
});

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function setup() {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'pi-worktree-')));
  const origin = join(tmp, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const root = join(tmp, 'root');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  writeFileSync(join(root, 'package-lock.json'), '{}\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'remote', 'set-head', 'origin', '-a');
  return { tmp, origin, root };
}

test('worktree lifecycle against real git', async () => {
  const { tmp, origin, root } = setup();
  try {
    assert.equal(await defaultBase(nodeRun, root), 'origin/main');
    const wt = worktreePath(root, 'feat');
    git(root, 'worktree', 'add', '-q', '--no-track', '-b', 'feat', wt, 'origin/main');
    assert.throws(() => git(wt, 'rev-parse', '--abbrev-ref', '@{u}'), 'no upstream');
    assert.equal(await isClean(nodeRun, wt), true);
    writeFileSync(join(wt, 'x.txt'), 'x');
    assert.equal(await isClean(nodeRun, wt), false);
    rmSync(join(wt, 'x.txt'));

    git(root, 'worktree', 'lock', '--reason', 'pi-worktree pid 1 host h', wt);
    const listed = (await listWorktrees(nodeRun, root)).find((w) => w.branch === 'feat');
    assert.equal(listed.locked, true);
    assert.equal(listed.lockReason, 'pi-worktree pid 1 host h');
    assert.deepEqual(await removeWorktree(nodeRun, root, listed), { ok: true });
    assert.equal(existsSync(wt), false);
    assert.throws(() => git(root, 'rev-parse', '--verify', 'refs/heads/feat'));

    const other = join(tmp, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    writeFileSync(join(other, 'package-lock.json'), '{"v":2}\n');
    git(other, 'commit', '-qam', 'lock');
    git(other, 'push', '-q');
    assert.equal(await fetchOrigin(nodeRun, root), true);
    writeFileSync(join(root, 'dirty.txt'), 'x');
    assert.equal((await fastForwardRoot(nodeRun, root, 'origin/main')).updated, false, 'dirty root is left alone');
    rmSync(join(root, 'dirty.txt'));
    assert.deepEqual(await fastForwardRoot(nodeRun, root, 'origin/main'), { updated: true, lockfileChanged: true });
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('pruneMerged removes only clean, merged, unused worktrees', async () => {
  const { tmp, root } = setup();
  try {
    const add = (b) => { const p = worktreePath(root, b); git(root, 'worktree', 'add', '-q', '--no-track', '-b', b, p, 'origin/main'); return p; };
    const merged = add('merged');
    const here = add('here');
    const busy = add('busy');
    const dirty = add('dirty');
    add('open');
    git(root, 'worktree', 'lock', '--reason', `pi-worktree pid ${process.pid} host ${(await import('node:os')).hostname()}`, busy);
    writeFileSync(join(dirty, 'x.txt'), 'x');
    const tips = Object.fromEntries(['merged', 'here', 'busy', 'dirty'].map((b) => [b, git(root, 'rev-parse', b)]));
    const run = async (cmd, args, opts) => {
      if (cmd !== 'gh') return nodeRun(cmd, args, opts);
      const branch = args[args.indexOf('--head') + 1];
      return { code: 0, stdout: JSON.stringify(tips[branch] ? [{ headRefOid: tips[branch] }] : []), stderr: '' };
    };
    const res = await pruneMerged(run, root, here);
    assert.deepEqual(res, { removed: ['merged'], failed: [] });
    assert.equal(existsSync(merged), false);
    for (const p of [here, busy, dirty]) assert.equal(existsSync(p), true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
