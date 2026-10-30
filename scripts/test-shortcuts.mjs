import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const spec = process.env.PI_TEST_SDK || '@earendil-works/pi-coding-agent';
const sdkUrl = spec.startsWith('/') ? pathToFileURL(spec).href : import.meta.resolve(spec);
const { DefaultResourceLoader, SettingsManager, ModelRuntime, SessionManager, createAgentSessionServices, createAgentSessionFromServices } = await import(sdkUrl);
const { ExtensionRunner } = await import(new URL('./core/extensions/runner.js', sdkUrl));
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(resolve(tmpdir(), 'pi-suite-shortcuts-'));
const originalCwd = process.cwd();
let session;
const originalEnv = Object.fromEntries(['HOME', 'XDG_CONFIG_HOME', 'PI_CODING_AGENT_DIR'].map(key => [key, process.env[key]]));
try {
  process.env.HOME = temp;
  process.env.XDG_CONFIG_HOME = resolve(temp, 'xdg');
  process.env.PI_CODING_AGENT_DIR = temp;
  // This deliberately exercises awaited asynchronous plan configuration before registration.
  mkdirSync(resolve(temp, '.pi'), { recursive: true });
  writeFileSync(resolve(temp, 'pi-plan-mode.json'), JSON.stringify({ thinkingLevel: 'inherit', toggleShortcut: 'shift+tab' }));
  const loader = new DefaultResourceLoader({ cwd: temp, agentDir: temp,
    settingsManager: SettingsManager.inMemory({ packages: [root] }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  let result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const resolved = bindings => {
    const runner = { extensions: result.extensions, hasUI: () => true, shortcutDiagnostics: [] };
    const shortcuts = ExtensionRunner.prototype.getShortcuts.call(runner, new KeybindingsManager(bindings).getResolvedBindings());
    return { shortcuts, diagnostics: runner.shortcutDiagnostics };
  };
  const stock = resolved({});
  assert(stock.shortcuts.has('ctrl+shift+t'), 'todo collapse is available under stock bindings');
  assert(!stock.shortcuts.has('ctrl+t'), 'todo must not displace stock thinking toggle');
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
  writeFileSync(resolve(temp, 'pi-todo.json'), JSON.stringify({ collapseKey: 'ctrl+t' }));
  await loader.reload();
  result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const customTodoStock = resolved({});
  assert(!customTodoStock.shortcuts.has('ctrl+t'), 'custom todo key must respect the native thinking conflict');
  const customTodoProfile = resolved({ ...profile, 'app.thinking.toggle': 'ctrl+shift+t' });
  assert(customTodoProfile.shortcuts.has('ctrl+t'), 'configured todo toggle becomes active after native thinking remap');
  console.log('PASS actual Pi shortcut resolution: stock-safe conflicts, configured todo toggle and personal Ctrl+L/Alt+P profile');

  // Isolated optional providers, now bound to a real ExtensionRunner/SessionManager so invoking
  // the resolved shortcut exercises actual workflow transitions, not just registration metadata.
  const models = await ModelRuntime.create({ agentDir: temp });
  models.classify = async () => { throw new Error('Shortcuts must not invoke a classifier'); };
  const thinkingProfile = { ...profile, 'app.thinking.cycle': 'alt+t' };
  const personalKeys = new KeybindingsManager(thinkingProfile);
  assert.deepEqual(personalKeys.getKeys('app.thinking.cycle'), ['alt+t']);
  const cases = [
    { names: ['tool-gate'], gate: {}, plan: {}, key: 'shift+tab' },
    { names: ['plan-mode'], gate: {}, plan: { toggleShortcut: 'alt+o' }, key: 'alt+o' },
    { names: ['tool-gate', 'plan-mode'], gate: {}, plan: { toggleShortcut: 'alt+o' }, key: 'shift+tab' },
    { names: ['plan-mode', 'tool-gate'], gate: {}, plan: { toggleShortcut: 'alt+o' }, key: 'shift+tab' },
    // Do not negotiate ownership: stock Pi diagnoses collisions and chooses one handler.
    { names: ['tool-gate', 'plan-mode'], gate: {}, plan: { toggleShortcut: 'shift+tab' }, key: 'shift+tab', duplicate: true },
    { names: ['plan-mode', 'tool-gate'], gate: {}, plan: { toggleShortcut: 'shift+tab' }, key: 'shift+tab', duplicate: true },
    { names: ['tool-gate'], gate: { workflowShortcut: 'alt+o', approvalShortcut: 'alt+o' }, plan: {}, key: 'alt+o', duplicateAxes: true },
  ];
  for (const [index, test] of cases.entries()) {
    const dir = resolve(temp, `case-${index}`);
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    writeFileSync(resolve(temp, 'pi-plan-mode.json'), JSON.stringify({ thinkingLevel: 'inherit', ...test.plan }));
    mkdirSync(resolve(dir, '.pi'), { recursive: true });
    writeFileSync(resolve(dir, '.pi/tool-gate.json'), JSON.stringify(test.gate));
    const statuses = new Map();
    const notifications = [];
    const events = [];
    const errors = [];
    const services = await createAgentSessionServices({ cwd: dir, agentDir: temp, modelRuntime: models,
      settingsManager: SettingsManager.inMemory({ cacheWarming: 'off' }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: test.names.map(name => resolve(root, `packages/pi-${name}/src/index.ts`)),
        extensionFactories: [pi => { pi.events.on('workflow-mode:changed', event => events.push(event)); }] } });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir),
      model: models.getModel('anthropic', 'claude-opus-4-5'), thinkingLevel: 'off' }));
    const ui = new Proxy({
      setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
      notify(message) { notifications.push(message); },
    }, { get(target, key) { return key in target ? target[key] : () => {}; } });
    await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: error => errors.push(error) });
    const runner = session.extensionRunner;
    assert(runner instanceof ExtensionRunner);
    const native = runner.getShortcuts(new KeybindingsManager({}).getResolvedBindings());
    if (test.key === 'shift+tab') {
      assert(!native.has('shift+tab'), 'stock thinking cycle remains authoritative');
      assert(runner.getShortcutDiagnostics().some(d => d.message.includes('shift+tab') && d.message.includes('Skipping')));
    }
    const shortcuts = runner.getShortcuts(personalKeys.getResolvedBindings());
    assert(shortcuts.has(test.key), `${test.names}: configured workflow key is reachable`);
    if (test.duplicate) {
      assert.equal(runner.getShortcutDiagnostics().filter(d => d.message.includes('shift+tab') && d.message.includes('registered by both')).length, 1);
    }
    if (test.duplicateAxes) {
      assert(notifications.some(message => /duplicate workflow and approval shortcut/i.test(message)));
      assert(!shortcuts.has('alt+a'));
    }
    const hasGate = test.names.includes('tool-gate');
    const before = events.length;
    await shortcuts.get(test.key).handler(runner.createContext());
    const workflow = () => /workflow: (\w+)/.exec(statuses.get('workflow-mode') ?? '')?.[1];
    assert.equal(workflow(), hasGate ? 'chat' : 'plan');
    if (hasGate) assert.equal(events.length - before, 1, 'one resolved key invokes exactly one workflow transition');
    if (hasGate && !test.duplicateAxes) {
      assert(shortcuts.has('alt+a'), 'approvals key is independent, including under stock bindings');
      assert(native.has('alt+a'));
      const previousWorkflow = workflow();
      const previousEvents = events.length;
      await shortcuts.get('alt+a').handler(runner.createContext());
      assert.equal(workflow(), previousWorkflow);
      assert.equal(events.length, previousEvents, 'approvals do not publish workflow transitions');
      assert.match(statuses.get('permission-mode'), /yolo.*alt\+a/);
      if (test.plan.toggleShortcut === 'alt+o') {
        await shortcuts.get('alt+o').handler(runner.createContext());
        assert.equal(workflow(), 'plan', 'separate plan key forwards the gate workflow cycle');
      }
    } else if (!hasGate) {
      assert(!shortcuts.has('alt+a'), 'standalone plan does not claim approvals');
      assert(!statuses.has('permission-mode'));
      await shortcuts.get(test.key).handler(runner.createContext());
      assert.equal(workflow(), 'work', 'standalone configured plan key toggles locally');
    }
    assert.deepEqual(errors, []);
    await session.dispose();
    session = undefined;
  }
  console.log('PASS real ExtensionRunner workflow/approval keys, stock Shift+Tab conflict, Alt+T remap, standalone plan and single-invocation duplicate resolution');
} finally {
  await session?.dispose();
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}
process.exit(0);
