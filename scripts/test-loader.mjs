import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A supplied SDK module lets us validate against the actual installed Pi version.
const { DefaultResourceLoader, SettingsManager } = await import(process.env.PI_TEST_SDK || '@earendil-works/pi-coding-agent');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(readFileSync(resolve(root, 'source-pins.json'))).plugins;
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json')));
const temp = mkdtempSync(resolve(tmpdir(), 'pi-suite-loader-'));
function signature(extension) {
  return {
    tools: [...extension.tools.keys()].sort(),
    commands: [...extension.commands.keys()].sort(),
    flags: [...extension.flags.keys()].sort(),
    shortcuts: [...extension.shortcuts.keys()].sort(),
    handlers: [...extension.handlers].map(([event, handlers]) => [event, handlers.length]).sort(),
  };
}
async function load(packages) {
  const loader = new DefaultResourceLoader({
    cwd: temp, agentDir: temp, settingsManager: SettingsManager.inMemory({ packages }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], 'extension loading must not report errors');
  return result.extensions;
}
try {
  const all = await load([root]);
  assert.equal(all.length, pins.length);
  assert.deepEqual(all.map(e => e.path), manifest.pi.extensions.map(p => resolve(root, p)));
  const seen = { tools: new Set(), commands: new Set(), flags: new Set(), shortcuts: new Set() };
  for (const extension of all) {
    for (const kind of Object.keys(seen)) for (const key of extension[kind].keys()) {
      assert(!seen[kind].has(key), `duplicate ${kind}: ${key}`);
      seen[kind].add(key);
    }
  }
  for (const [i, plugin] of pins.entries()) {
    const standalone = await load([resolve(root, 'packages', plugin.name)]);
    const selected = await load([{ source: root, extensions: manifest.pi.extensions.slice(i, i + 1).map(p => p.replace(/^\.\//, '')), skills: [], prompts: [], themes: [] }]);
    assert.equal(standalone.length, 1);
    assert.equal(selected.length, 1);
    assert.deepEqual(signature(selected[0]), signature(standalone[0]));
    assert.deepEqual(signature(selected[0]), signature(all[i]));
    console.log(`PASS ${plugin.name}: standalone, filtered, suite registrations match`);
  }
  if (process.env.PI_ORIGINAL_ROOT) {
    const originals = await load(pins.map(p => resolve(process.env.PI_ORIGINAL_ROOT, p.name)));
    assert.deepEqual(originals.map(signature), all.map(signature), 'original installed registrations must match suite');
    console.log('PASS original installed plugin registration parity');
  }
  assert.equal((await load([{ source: root, extensions: [], skills: [], prompts: [], themes: [] }])).length, 0);
  console.log(`PASS ${all.length} extensions; no duplicate registrations; empty selection loads nothing`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
// Factory validation does not bind session_start or make model calls.
process.exit(0);
