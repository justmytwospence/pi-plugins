import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const spec = process.env.PI_TEST_SDK || '@earendil-works/pi-coding-agent';
const sdkUrl = spec.startsWith('/') ? pathToFileURL(spec).href : import.meta.resolve(spec);
const { DefaultResourceLoader, SettingsManager } = await import(sdkUrl);
const { ExtensionRunner } = await import(new URL('./core/extensions/runner.js', sdkUrl));
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(resolve(tmpdir(), 'pi-suite-shortcuts-'));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
  process.env.PI_CODING_AGENT_DIR = temp;
  // This deliberately exercises awaited asynchronous plan configuration before registration.
  mkdirSync(resolve(temp, '.pi'), { recursive: true });
  writeFileSync(resolve(temp, 'pi-plan-mode.json'), JSON.stringify({ thinkingLevel: 'inherit', toggleShortcut: 'shift+tab' }));
  const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp,
    settingsManager: SettingsManager.inMemory({ packages: [root] }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const resolved = bindings => {
    const runner = { extensions: result.extensions, hasUI: () => true, shortcutDiagnostics: [] };
    const shortcuts = ExtensionRunner.prototype.getShortcuts.call(runner, new KeybindingsManager(bindings).getResolvedBindings());
    return { shortcuts, diagnostics: runner.shortcutDiagnostics };
  };
  const stock = resolved({});
  assert(!stock.shortcuts.has('ctrl+l'), 'stock model picker must not be displaced');
  assert(stock.diagnostics.some(d => d.message.includes('ctrl+l') && d.message.includes('Skipping')), 'stock clearing conflict is visible');
  const profile = {
    'app.model.select': ['alt+p', 'alt+m'], 'app.model.cycleForward': [], 'app.model.cycleBackward': [],
    'app.thinking.cycle': [], 'tui.editor.historyPrevious': 'ctrl+p', 'tui.editor.historyNext': 'ctrl+n',
    'tui.select.down': ['down', 'ctrl+j'], 'tui.select.up': ['up', 'ctrl+k'],
    'tui.altScreen.halfPageUp': [], 'tui.altScreen.halfPageDown': [],
  };
  const personal = resolved(profile);
  assert(personal.shortcuts.has('ctrl+l'), 'clear is reachable after model picker remap');
  assert(personal.shortcuts.has('shift+tab'), 'async configured plan shortcut registered before startup completes');
  const kb = new KeybindingsManager(profile);
  assert.deepEqual(kb.getKeys('app.model.select'), ['alt+p', 'alt+m']);
  assert.deepEqual(kb.getKeys('app.model.cycleForward'), []);
  assert.deepEqual(kb.getKeys('tui.altScreen.halfPageUp'), [], 'no global key stealing');
  assert(!personal.diagnostics.some(d => /ctrl\+l.*Skipping/.test(d.message)));
  console.log('PASS actual Pi shortcut resolution: stock-safe conflict diagnostics and personal Ctrl+L/Alt+P profile');
} finally {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
