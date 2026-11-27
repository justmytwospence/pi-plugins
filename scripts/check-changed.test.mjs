import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectChangedFiles, runSelectedChecks } from './check-changed.mjs';
import { needsSwitchyard } from './lib/switchyard-changes.mjs';

test('selects compatibility conservatively for packages and root inputs', () => {
  for (const path of [
    'packages/pi-tasks/src/index.ts', 'packages/pi-web/bridge.ts', 'packages/new/assets/icon.svg',
    'packages/private-shared/package.json', 'packages/pi-tasks/test/foo.ts', 'packages/pi-tasks/README.md',
    'package.json', 'package-lock.json', '.nvmrc', '.github/compat-switchyard.json',
    '.github/workflows/switchyard.yml', 'scripts/check-switchyard.mjs', 'scripts/check-changed.mjs',
    'scripts/check-changed.test.mjs', 'scripts/lib/switchyard-changes.mjs', 'scripts/test-contracts.mjs',
  ]) assert.equal(needsSwitchyard([path]), true, path);
  assert.equal(needsSwitchyard([]), false);
  assert.equal(needsSwitchyard(['README.md', 'site/docs/a.md', 'scripts/other.mjs']), false);
});

test('collects NUL-delimited changes, including both move endpoints and untracked files', () => {
  const calls = [];
  const exec = (command, args, options) => {
    calls.push([command, args, options]);
    if (args[0] === 'merge-base') return 'abc123\n';
    if (args[0] === 'diff') return 'old/name\0new/name\0line\nbreak\0';
    return 'new/name\0untracked\0';
  };
  assert.deepEqual(collectChangedFiles('/repo', 'origin/main', exec), ['old/name', 'new/name', 'line\nbreak', 'untracked']);
  assert.deepEqual(calls.map((call) => call[1]), [
    ['merge-base', 'HEAD', 'origin/main'],
    ['diff', '--no-renames', '--name-only', '-z', 'abc123', '--'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]);
  assert.ok(calls.every(([command, , options]) => command === 'git' && options.cwd === '/repo' && options.encoding === 'utf8'));
});

test('propagates Git failures', () => {
  assert.throws(() => collectChangedFiles('/repo', 'main', () => { throw new Error('git failed'); }), /git failed/);
});

test('dispatches selected checks in order and continues after failures', () => {
  const calls = [];
  const selection = { tasks: ['contracts', 'changed-checks'], components: ['a', 'b'], switchyard: true };
  assert.equal(runSelectedChecks(selection, (args) => { calls.push(args); return calls.length === 1 ? 1 : 0; }), 1);
  assert.deepEqual(calls, [
    ['scripts/test-suite.mjs', '--only', 'contracts,changed-checks'],
    ['scripts/check-components.mjs', 'a', 'b'],
    ['scripts/check-switchyard.mjs'],
  ]);
  assert.equal(runSelectedChecks(selection, () => 0), 0);
  assert.equal(runSelectedChecks(selection, (args) => args[0] === 'scripts/check-switchyard.mjs' ? 1 : 0), 1);
  assert.equal(runSelectedChecks(selection, () => null), 1);
});

test('dispatches no commands for no work and supports compatibility alone', () => {
  const calls = [];
  const run = (args) => { calls.push(args); return 0; };
  assert.equal(runSelectedChecks({ tasks: [], components: [], switchyard: false }, run), 0);
  assert.deepEqual(calls, []);
  assert.equal(runSelectedChecks({ tasks: [], components: [], switchyard: true }, run), 0);
  assert.deepEqual(calls, [['scripts/check-switchyard.mjs']]);
});
