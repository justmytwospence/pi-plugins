import assert from 'node:assert/strict';
import { test } from 'node:test';
import worktree, { completions } from '../src/index.ts';

test('registers /worktree and its session hooks', () => {
  const commands = new Map();
  const events = new Map();
  worktree({
    registerCommand: (name, spec) => commands.set(name, spec),
    on: (event, handler) => events.set(event, handler),
  });
  assert.deepEqual([...commands.keys()], ['worktree']);
  assert.equal(typeof commands.get('worktree').handler, 'function');
  assert.equal(typeof events.get('session_start'), 'function');
  assert.equal(typeof events.get('session_shutdown'), 'function');
});

test('completes subcommands', async () => {
  assert.equal((await completions('')).length, 6);
  assert.deepEqual((await completions('d')).map((c) => c.value), ['done']);
  assert.equal(await completions('zzz'), null);
});
