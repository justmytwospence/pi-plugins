import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setVersion } from './set-version.mjs';

const OLD = '0.1.2';
const json = (value, unit) => JSON.stringify(value, null, unit) + '\n';

function fixture({ brokenLock = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'set-version-'));
  const write = (rel, text) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  write('package.json', json({ name: 'root', version: OLD }, 2));
  const rootLock = {
    name: 'root', version: OLD, lockfileVersion: 3,
    packages: {
      '': { name: 'root', version: OLD },
      'packages/pi-subscription-usage': { name: 'u', version: OLD },
      'node_modules/dep': { version: OLD },
    },
  };
  write('package-lock.json', json(rootLock, 2));
  write('packages/a/package.json', json({ name: 'a', version: OLD }, 2));
  const lockA = {
    name: 'a', version: OLD, lockfileVersion: 3,
    packages: brokenLock
      ? { 'node_modules/dep': { version: OLD } }
      : { '': { name: 'a', version: OLD }, 'node_modules/dep': { version: OLD } },
  };
  write('packages/a/package-lock.json', json(lockA, 2));
  write('packages/b/package.json', json({ name: 'b', version: OLD }, '\t'));
  write('packages/b/package-lock.json', json({
    name: 'b', version: OLD, lockfileVersion: 3, packages: { '': { name: 'b', version: OLD } },
  }, '\t'));
  return root;
}

const snapshot = (root) => ['package.json', 'package-lock.json', 'packages/a/package.json',
  'packages/a/package-lock.json', 'packages/b/package.json', 'packages/b/package-lock.json']
  .map((rel) => readFileSync(join(root, rel), 'utf8'));

test('bumps every version field and nothing else', () => {
  const root = fixture();
  const before = snapshot(root);
  try {
    const changed = setVersion(root, '0.1.3');
    assert.equal(changed.length, 6);
    const after = snapshot(root);
    after.forEach((text, i) => {
      assert.equal(text, before[i].split(`"version": "${OLD}"`).join('"version": "0.1.3"')
        .replace(/("node_modules\/dep": \{\s*"version": ")0\.1\.3/, `$1${OLD}`));
    });
    const lock = JSON.parse(after[1]);
    assert.equal(lock.version, '0.1.3');
    assert.equal(lock.packages[''].version, '0.1.3');
    assert.equal(lock.packages['packages/pi-subscription-usage'].version, '0.1.3');
    assert.equal(lock.packages['node_modules/dep'].version, OLD);
    assert.equal(JSON.parse(after[3]).packages['node_modules/dep'].version, OLD);
    assert.ok(after[4].startsWith('{\n\t"name"'), 'tabs preserved');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects a malformed or unchanged version', () => {
  const root = fixture();
  const before = snapshot(root);
  try {
    assert.throws(() => setVersion(root, '1.2'), /invalid version/);
    assert.throws(() => setVersion(root, OLD), /already at/);
    assert.deepEqual(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('leaves files untouched when one file would change unexpectedly', () => {
  const root = fixture({ brokenLock: true });
  const before = snapshot(root);
  try {
    assert.throws(() => setVersion(root, '0.1.3'), /package-lock\.json/);
    assert.deepEqual(snapshot(root), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
