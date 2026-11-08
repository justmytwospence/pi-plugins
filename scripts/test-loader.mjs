import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A supplied SDK module lets us validate against the actual installed Pi version.
const { DefaultResourceLoader, SettingsManager } = await import(process.env.PI_TEST_SDK || '@earendil-works/pi-coding-agent');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json')));
const plugins = manifest.pi.extensions.map(entry => ({ name: entry.split('/')[2] }));
assert.equal(new Set(plugins.map(p => p.name)).size, plugins.length, 'one entry per component');
const temp = mkdtempSync(resolve(tmpdir(), 'pi-suite-loader-'));
const originalEnv = Object.fromEntries(['HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME'].map(key => [key, process.env[key]]));
process.env.HOME = temp;
process.env.PI_CODING_AGENT_DIR = temp;
process.env.XDG_CONFIG_HOME = resolve(temp, 'xdg');
// The first participating extension owns one runtime-shared coordinator. Normalize
// only those known hooks, and assert its ownership separately rather than weakening
// per-component registration parity for ordinary handlers.
const cycleParticipants = new Set(['pi-plan-mode', 'pi-tool-gate', 'pi-status-footer']);
const cycleEvents = new Set(['session_start', 'session_tree', 'session_before_switch', 'session_before_fork',
  'session_before_tree', 'session_before_compact', 'ui_prompt_start', 'session_shutdown', 'before_agent_start',
  'model_select', 'thinking_level_select', 'message_start', 'input']);
const ownsCycles = extension => extension.entryRenderers?.has('settings:cycle') === true;
function signature(extension) {
  const shared = ownsCycles(extension);
  if (shared) for (const event of cycleEvents) assert.ok(extension.handlers.get(event)?.length, `cycle owner registers ${event}`);
  return {
    tools: [...extension.tools.keys()].sort(),
    commands: [...extension.commands.keys()].sort(),
    flags: [...extension.flags.keys()].sort(),
    shortcuts: [...extension.shortcuts.keys()].sort(),
    entryRenderers: [...(extension.entryRenderers?.keys() ?? [])].filter(type => type !== 'settings:cycle').sort(),
    handlers: [...extension.handlers].map(([event, handlers]) => [event, handlers.length - Number(shared && cycleEvents.has(event))])
      .filter(([, count]) => count > 0).sort(),
  };
}
async function load(packages, noSkills = true, reloads = 1) {
  const loader = new DefaultResourceLoader({
    cwd: temp, agentDir: temp, settingsManager: SettingsManager.inMemory({ packages }),
    noSkills, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  for (let pass = 0; pass < reloads; pass++) {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, [], `extension reload ${pass + 1} must not report errors`);
  }
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, [], 'extension loading must not report errors');
  return noSkills ? result.extensions : { extensions: result.extensions, skills: loader.getSkills() };
}
try {
  const all = await load([root]);
  assert.equal(all.length, plugins.length);
  assert.deepEqual(all.map(e => e.path), manifest.pi.extensions.map(p => resolve(root, p)));
  assert.equal(all.filter(ownsCycles).length, 1, 'suite registers exactly one shared settings coordinator');
  assert.ok(cycleParticipants.has(plugins[all.findIndex(ownsCycles)].name), 'a participating plugin owns it');
  const seen = { tools: new Set(), commands: new Set(), flags: new Set(), shortcuts: new Set() };
  for (const extension of all) {
    for (const kind of Object.keys(seen)) for (const key of extension[kind].keys()) {
      assert(!seen[kind].has(key), `duplicate ${kind}: ${key}`);
      seen[kind].add(key);
    }
  }
  for (const [i, plugin] of plugins.entries()) {
    const standalone = await load([resolve(root, 'packages', plugin.name)]);
    const selected = await load([{ source: root, extensions: manifest.pi.extensions.slice(i, i + 1).map(p => p.replace(/^\.\//, '')), skills: [], prompts: [], themes: [] }]);
    assert.equal(standalone.length, 1);
    assert.equal(selected.length, 1);
    assert.equal(ownsCycles(standalone[0]), cycleParticipants.has(plugin.name), `${plugin.name} standalone coordinator ownership`);
    assert.equal(ownsCycles(selected[0]), cycleParticipants.has(plugin.name), `${plugin.name} filtered coordinator ownership`);
    assert.deepEqual(signature(selected[0]), signature(standalone[0]));
    assert.deepEqual(signature(selected[0]), signature(all[i]));
    const isolated = resolve(temp, `isolated-${plugin.name}`, plugin.name);
    mkdirSync(dirname(isolated), { recursive: true });
    cpSync(resolve(root, 'packages', plugin.name), isolated, {
      recursive: true, filter: path => !path.split('/').includes('node_modules') && !path.split('/').includes('.git'),
    });
    const dependencies = resolve(root, 'packages', plugin.name, 'node_modules');
    if (existsSync(dependencies)) symlinkSync(dependencies, resolve(isolated, 'node_modules'), 'dir');
    const isolatedExtensions = await load([isolated]);
    assert.equal(isolatedExtensions.length, 1);
    assert.equal(ownsCycles(isolatedExtensions[0]), cycleParticipants.has(plugin.name), `${plugin.name} isolated coordinator ownership`);
    assert.deepEqual(signature(isolatedExtensions[0]), signature(all[i]));
    console.log(`PASS ${plugin.name}: isolated, standalone, filtered, suite registrations match`);
  }
  for (const order of [['pi-model-waterfall', 'pi-status-footer'], ['pi-status-footer', 'pi-model-waterfall']]) {
    const pair = await load(order.map(name => resolve(root, 'packages', name)), true, 2);
    assert.equal(pair.length, 2);
    assert.deepEqual(pair.map(e => e.path), order.map(name => resolve(root, 'packages', name, 'src/index.ts')));
    assert.equal(pair.filter(e => e.commands.has('waterfall')).length, 1, 'only the standalone router registers /waterfall');
    assert.equal(pair.filter(e => e.commands.has('status')).length, 1, 'only the footer registers /status');
  }
  console.log('PASS router/footer in either load order, including reload; only one owner per command');
  const none = await load([{ source: root, extensions: [], skills: [], prompts: [], themes: [] }], false);
  assert.equal(none.extensions.length, 0);
  assert.equal(none.skills.skills.length, 0);
  assert.equal((await load([{ source: root, extensions: [], skills: [], prompts: [], themes: [] }])).length, 0);
  console.log(`PASS ${all.length} extensions; no duplicate registrations; empty selection loads nothing`);
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}
// Factory validation does not bind session_start or make model calls.
process.exit(0);
