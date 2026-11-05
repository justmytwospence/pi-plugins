import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addWorktree, defaultBase, fetchOrigin, isClean, isManaged, isMerged, listWorktrees, nodeRun,
  parseWorktrees, removeWorktree, verifyRef, worktreePath,
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

test('parseWorktrees reads branches, detached and prunable entries', () => {
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
  const { tmp, root } = setup();
  try {
    assert.equal(await defaultBase(nodeRun, root), 'origin/main');
    assert.equal(await verifyRef(nodeRun, root, 'origin/main'), true);
    assert.equal(await verifyRef(nodeRun, root, 'nope'), false);
    const added = await addWorktree(nodeRun, root, 'feat', 'origin/main');
    assert.deepEqual(added, { ok: true, path: worktreePath(root, 'feat'), existing: false });
    const wt = added.path;
    assert.throws(() => git(wt, 'rev-parse', '--abbrev-ref', 'feat@{u}'), 'no upstream');
    assert.equal(await isClean(nodeRun, wt), true);
    writeFileSync(join(wt, 'x.txt'), 'x');
    assert.equal(await isClean(nodeRun, wt), false);
    rmSync(join(wt, 'x.txt'));
    const listed = (await listWorktrees(nodeRun, root)).find((w) => w.branch === 'feat');
    assert.deepEqual(await removeWorktree(nodeRun, root, listed), { ok: true });
    assert.equal(existsSync(wt), false);
    assert.throws(() => git(root, 'rev-parse', '--verify', 'refs/heads/feat'));
    assert.equal((await fetchOrigin(nodeRun, root)), true);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('addWorktree checks out an existing branch and reports failures', async () => {
  const { tmp, root } = setup();
  try {
    git(root, 'branch', 'old', 'origin/main');
    const added = await addWorktree(nodeRun, root, 'old', 'origin/main');
    assert.equal(added.ok, true);
    assert.equal(added.existing, true);
    assert.equal(git(added.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'old');
    const again = await addWorktree(nodeRun, root, 'old', 'origin/main');
    assert.equal(again.ok, false);
    assert.ok(again.error.length > 0);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
