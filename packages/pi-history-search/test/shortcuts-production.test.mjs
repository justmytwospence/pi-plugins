import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

// Match scripts/test-shortcuts.mjs: PI_TEST_SDK can select the installed Pi
// dist/index.js, including its real production loader and public SDK aliases.
const spec = process.env.PI_TEST_SDK || '@earendil-works/pi-coding-agent';
const sdkUrl = spec.startsWith('/') ? pathToFileURL(spec).href : import.meta.resolve(spec);
const { DefaultResourceLoader, ExtensionRunner, SessionManager, SettingsManager } = await import(sdkUrl);
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));

test('production loader leaves history Ctrl+R conflict-free and native session rename unchanged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-history-shortcuts-'));
  const originalEnv = Object.fromEntries(
    ['HOME', 'XDG_CONFIG_HOME', 'PI_CODING_AGENT_DIR'].map(key => [key, process.env[key]]),
  );
  try {
    process.env.HOME = dir;
    process.env.XDG_CONFIG_HOME = join(dir, 'xdg');
    process.env.PI_CODING_AGENT_DIR = dir;
    // No local node_modules or custom transpiler aliases: imports must resolve
    // through Pi's production loader, as they do for an installed extension.
    const extension = join(dir, 'extension');
    cpSync(new URL('../src', import.meta.url), join(extension, 'src'), { recursive: true });
    cpSync(new URL('../package.json', import.meta.url), join(extension, 'package.json'));
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir,
      settingsManager: SettingsManager.inMemory({ packages: [extension] }),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, [], 'history search loads through production SDK aliases');
    assert.equal(result.extensions.length, 1);
    const [history] = result.extensions;
    assert.ok(history.commands.has('history-search'), 'the real history extension was loaded');

    const keys = new KeybindingsManager({});
    assert.deepEqual(keys.getKeys('app.session.rename'), ['ctrl+r']);
    const runner = new ExtensionRunner(result.extensions, result.runtime, dir, SessionManager.inMemory(dir));
    const shortcuts = runner.getShortcuts(keys.getResolvedBindings());
    assert.deepEqual(runner.getShortcutDiagnostics(), [], 'history Ctrl+R must not cause a built-in shortcut conflict');
    assert.ok(!history.shortcuts.has('ctrl+r'), 'history must not register Ctrl+R as an extension shortcut');
    assert.ok(!shortcuts.has('ctrl+r'), 'resolved extension shortcuts must not claim Ctrl+R');
    assert.deepEqual(keys.getKeys('app.session.rename'), ['ctrl+r'], 'native session rename keeps its default binding');
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
