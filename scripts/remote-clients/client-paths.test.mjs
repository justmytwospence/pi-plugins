import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertRemoteClientsPresent, resolveOvisDirectory } from '../lib/remote-client-paths.mjs';

const home = '/fake-home';
const legacy = path.join(home, '.local/share/herdr-web-ui');
const renamed = path.join(home, '.local/share/ovis');
const prompt = dir => path.join(dir, 'server/prompt.ts');
const bun = dir => path.join(dir, 'bin/bun');
const bundleResult = directory => ({ directory, kind: 'bundle', bun: bun(directory) });

function fakeFs() {
  const files = new Set();
  const executables = new Set();
  const children = new Map();
  return {
    files, executables, children,
    bundle(dir) {
      files.add(prompt(dir));
      executables.add(bun(dir));
    },
    source(dir) {
      files.add(prompt(dir));
      files.add(path.join(dir, 'package.json'));
      files.add(path.join(dir, 'scripts/check.ts'));
    },
    root(dir, names) {
      files.add(dir);
      children.set(dir, names);
    },
    resolve(env = {}) {
      return resolveOvisDirectory({
        env, home,
        exists: file => files.has(file),
        list: dir => {
          assert.ok(children.has(dir), `unexpected directory listing: ${dir}`);
          return children.get(dir);
        },
        isExecutable: file => executables.has(file),
      });
    },
  };
}

test('explicit OVIS_DIR takes precedence over legacy override and runtime discovery', () => {
  const fs = fakeFs();
  const ovis = '/explicit/ovis';
  const old = '/explicit/legacy';
  fs.bundle(ovis);
  fs.bundle(old);
  fs.root(legacy, ['remote-v99']);
  fs.bundle(path.join(legacy, 'remote-v99'));
  assert.deepEqual(fs.resolve({ OVIS_DIR: ovis, HERDR_WEB_UI_DIR: old }), bundleResult(ovis));
});

test('legacy override precedes discovery and an empty OVIS_DIR', () => {
  const fs = fakeFs();
  const dir = '/explicit/legacy';
  fs.bundle(dir);
  fs.root(renamed, ['remote-v99']);
  fs.bundle(path.join(renamed, 'remote-v99'));
  assert.deepEqual(fs.resolve({ OVIS_DIR: '', HERDR_WEB_UI_DIR: dir }), bundleResult(dir));
});

test('explicit source checkout uses bun from PATH, but bundle validity wins', () => {
  const fs = fakeFs();
  const dir = '/checkout/ovis';
  fs.source(dir);
  assert.deepEqual(fs.resolve({ OVIS_DIR: dir }), { directory: dir, kind: 'source', bun: 'bun' });
  assert.deepEqual(fs.resolve({ HERDR_WEB_UI_DIR: dir }), { directory: dir, kind: 'source', bun: 'bun' });
  fs.bundle(dir);
  assert.deepEqual(fs.resolve({ OVIS_DIR: dir }), bundleResult(dir));
});

test('discovers numeric newest bundle across both runtime roots', () => {
  const fs = fakeFs();
  fs.root(legacy, ['remote-v9', 'remote-v10', 'remote-v100-old']);
  fs.root(renamed, ['remote-v11', 'remote-v2', 'remote-v100x']);
  for (const dir of [path.join(legacy, 'remote-v9'), path.join(legacy, 'remote-v10'), path.join(renamed, 'remote-v11'), path.join(renamed, 'remote-v2')]) fs.bundle(dir);
  assert.deepEqual(fs.resolve(), bundleResult(path.join(renamed, 'remote-v11')));
  fs.children.set(renamed, ['remote-v2']);
  assert.deepEqual(fs.resolve(), bundleResult(path.join(legacy, 'remote-v10')));
});

test('equal versions prefer the authoritative legacy root', () => {
  const fs = fakeFs();
  fs.root(legacy, ['remote-v10']);
  fs.root(renamed, ['remote-v10']);
  fs.bundle(path.join(legacy, 'remote-v10'));
  fs.bundle(path.join(renamed, 'remote-v10'));
  assert.deepEqual(fs.resolve(), bundleResult(path.join(legacy, 'remote-v10')));
});

test('invalid nonempty overrides throw instead of falling back', () => {
  const fs = fakeFs();
  const good = '/good';
  const bad = '/invalid';
  fs.bundle(good);
  fs.root(legacy, ['remote-v1']);
  fs.bundle(path.join(legacy, 'remote-v1'));
  for (const env of [{ OVIS_DIR: bad, HERDR_WEB_UI_DIR: good }, { HERDR_WEB_UI_DIR: bad }]) {
    assert.throws(() => fs.resolve(env), { message: `Ovis parser directory is invalid: ${bad}` });
  }
});

test('incomplete bundles and source checkouts are rejected; discovery falls back to a complete bundle', () => {
  const fs = fakeFs();
  const noPrompt = path.join(legacy, 'remote-v13');
  const noBun = path.join(legacy, 'remote-v12');
  const source = path.join(renamed, 'remote-v11');
  const valid = path.join(renamed, 'remote-v9');
  fs.root(legacy, ['remote-v13', 'remote-v12']);
  fs.root(renamed, ['remote-v11', 'remote-v9']);
  fs.executables.add(bun(noPrompt));
  fs.files.add(prompt(noBun));
  fs.source(source);
  fs.bundle(valid);
  assert.deepEqual(fs.resolve(), bundleResult(valid));
  for (const dir of [noPrompt, noBun]) {
    assert.throws(() => fs.resolve({ OVIS_DIR: dir }), { message: `Ovis parser directory is invalid: ${dir}` });
  }
  fs.children.set(renamed, ['remote-v11']);
  assert.equal(fs.resolve(), undefined);
});

test('empty or absent runtime roots yield undefined', () => {
  const fs = fakeFs();
  assert.equal(fs.resolve(), undefined);
  fs.root(legacy, []);
  fs.root(renamed, ['not-a-runtime']);
  assert.equal(fs.resolve(), undefined);
});

test('strict client detection reports missing names in order; optional mode never throws', () => {
  for (const ovis of [false, true]) {
    for (const collie of [false, true]) {
      assert.doesNotThrow(() => assertRemoteClientsPresent({ ovis, collie }, false));
    }
  }
  assert.doesNotThrow(() => assertRemoteClientsPresent({ ovis: true, collie: true }, true));
  for (const [clients, missing] of [
    [{ ovis: false, collie: true }, 'Ovis'],
    [{ ovis: true, collie: false }, 'Collie'],
    [{ ovis: false, collie: false }, 'Ovis, Collie'],
  ]) {
    assert.throws(() => assertRemoteClientsPresent(clients, true), { message: `Required remote client parsers missing: ${missing}` });
  }
});
