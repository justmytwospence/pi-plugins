import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CURRENT_SESSION_VERSION, SessionManager } from '@earendil-works/pi-coding-agent';
import { defaultSessionDir, sessionDirFor, sessionInto, writeEmptySession } from '../src/sessions.ts';

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'pi-worktree-sessions-')));
const lines = (file) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('default session directories mirror Pi', () => {
  assert.equal(defaultSessionDir('/a/b', '/agent'), join('/agent', 'sessions', '--a-b--'));
  const def = { cwd: '/a', sessionDir: defaultSessionDir('/a', '/agent') };
  assert.equal(sessionDirFor('/a/.worktrees/x', def, '/agent'), defaultSessionDir('/a/.worktrees/x', '/agent'));
  assert.equal(sessionDirFor('/a/.worktrees/x', { cwd: '/a', sessionDir: '/custom' }, '/agent'), '/custom');
});

test('an empty session file opens in its cwd', () => {
  const dir = tmp();
  try {
    const target = join(dir, 'wt');
    const file = writeEmptySession(join(dir, 'sessions'), target);
    const [header] = lines(file);
    assert.equal(header.type, 'session');
    assert.equal(header.cwd, target);
    assert.equal(header.version, CURRENT_SESSION_VERSION);
    assert.equal(SessionManager.open(file).getCwd(), target);
  } finally { rmSync(dir, { recursive: true }); }
});

test('sessionInto forks the conversation or starts empty', () => {
  const dir = tmp();
  try {
    const agentDir = join(dir, 'agent');
    const source = writeEmptySession(defaultSessionDir(join(dir, 'root'), agentDir), join(dir, 'root'));
    appendFileSync(source, `${JSON.stringify({ type: 'session_info', id: 'a1', parentId: null, timestamp: new Date().toISOString(), name: 't' })}\n`);
    const current = { file: source, cwd: join(dir, 'root'), sessionDir: defaultSessionDir(join(dir, 'root'), agentDir) };
    const target = join(dir, 'root', '.worktrees', 'x');

    const forked = sessionInto(target, current, agentDir, false);
    const forkedLines = lines(forked);
    assert.equal(forkedLines.length, 2);
    assert.equal(forkedLines[0].cwd, target);
    assert.equal(forkedLines[0].parentSession, source);
    assert.ok(forked.startsWith(defaultSessionDir(target, agentDir)));

    const fresh = sessionInto(target, current, agentDir, true);
    assert.equal(lines(fresh).length, 1);
    assert.equal(lines(fresh)[0].cwd, target);
  } finally { rmSync(dir, { recursive: true }); }
});
