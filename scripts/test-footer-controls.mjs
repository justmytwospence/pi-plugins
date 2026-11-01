// Regression fixture for the real interactive footer input route. No agent turn is started.
// Select another host with PI_TEST_SDK_ROOT=/absolute/path/to/pi-coding-agent.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { findPackageJSON, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = realpathSync(process.env.PI_TEST_SDK_ROOT
  ? resolve(process.env.PI_TEST_SDK_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..'));
assert.equal(JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).name,
  '@earendil-works/pi-coding-agent', 'PI_TEST_SDK_ROOT must be the SDK package root');
// Install the sandbox BEFORE importing the SDK or extensions: their module initializers
// must not see a host login, Keychain helper, CLI, or network transport.
const temp = mkdtempSync(join(tmpdir(), 'pi-footer-controls-'));
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;
const originalHttp = [http.request, http.get, https.request, https.get];
const originalChild = Object.fromEntries(['spawn', 'exec', 'execFile', 'spawnSync', 'execSync', 'execFileSync']
  .map(name => [name, childProcess[name]]));
const audit = { network: 0, forbiddenCli: 0, securityShim: 0, hostCredentialLookups: 0 };
const bin = join(temp, 'bin');
mkdirSync(bin);
// Only inert executables are resolvable via PATH. The security shim also proves
// that an attempted Keychain query never reaches the real macOS binary.
for (const name of ['security', 'git']) writeFileSync(join(bin, name),
  `#!/bin/sh\n${name === 'security' ? 'printf x >> "$PI_FOOTER_SECURITY_AUDIT"\n' : ''}exit 1\n`, { mode: 0o700 });
for (const name of Object.keys(process.env)) {
  if (/(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|ACCESS_KEY|PRIVATE_KEY)(?:_|$)/i.test(name))
    delete process.env[name];
}
Object.assign(process.env, {
  HOME: join(temp, 'home'), USERPROFILE: join(temp, 'home'),
  XDG_CONFIG_HOME: join(temp, 'config'), XDG_DATA_HOME: join(temp, 'data'),
  XDG_STATE_HOME: join(temp, 'state'), XDG_CACHE_HOME: join(temp, 'cache'),
  APPDATA: join(temp, 'data'), LOCALAPPDATA: join(temp, 'cache'), CLAUDE_CONFIG_DIR: join(temp, 'claude'),
  CODEX_HOME: join(temp, 'codex'), PI_CODING_AGENT_DIR: join(temp, 'agent'),
  PI_OFFLINE: '1', PATH: bin, PI_FOOTER_SECURITY_AUDIT: join(temp, 'security-audit'),
});
for (const name of ['PI_STATUS_FOOTER_CLAUDE_USAGE_CMD', 'PI_SIDEBAR_FAMILY', 'PI_SIDEBAR_GUARD',
  'AWS_PROFILE', 'AWS_CONFIG_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'AZURE_CONFIG_DIR']) delete process.env[name];
assert.equal(homedir(), join(temp, 'home'), 'SDK homedir must resolve inside the fixture');
for (const name of ['home', 'config', 'data', 'state', 'cache', 'claude', 'codex', 'agent'])
  mkdirSync(join(temp, name));
writeFileSync(join(temp, 'agent', 'settings.json'), JSON.stringify({ piVim: { clipboardMirror: false } }));
writeFileSync(join(temp, 'agent', 'keybindings.json'), JSON.stringify({
  'app.model.select': 'alt+p', 'app.thinking.cycle': 'ctrl+t',
}));
const noNetwork = () => { audit.network++; throw new Error('footer fixture forbids external network I/O'); };
globalThis.fetch = noNetwork;
net.Socket.prototype.connect = function (...args) {
  // Sidebar's process-local Unix sockets are part of the actual UI lifecycle.
  if (typeof args[0] === 'string' || (args[0] && typeof args[0] === 'object' &&
      typeof args[0].path === 'string' && args[0].port === undefined && args[0].host === undefined))
    return originalConnect.apply(this, args);
  return noNetwork();
};
for (const module of [http, https]) for (const name of ['request', 'get']) module[name] = noNetwork;
for (const name of Object.keys(originalChild)) childProcess[name] = function (file, ...args) {
  if ((name === 'spawn' || name === 'execFile' || name === 'spawnSync' || name === 'execFileSync') &&
      (file === 'git' || file === 'security')) {
    if (file === 'security') audit.securityShim++;
    return originalChild[name].call(this, file, ...args);
  }
  if (typeof file === 'string' && /(?:^|\/)security$/.test(file)) audit.hostCredentialLookups++;
  audit.forbiddenCli++;
  throw new Error(`footer fixture forbids external CLI: ${name}`);
};
syncBuiltinESMExports();

const sdkUrl = pathToFileURL(join(sdkRoot, 'dist/index.js'));
function hostDependency(name) {
  const manifestPath = findPackageJSON(name, sdkUrl);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, name);
  return pathToFileURL(resolve(dirname(manifestPath), manifest.exports?.['.']?.import ?? manifest.main));
}
const tuiUrl = hostDependency('@earendil-works/pi-tui');
const sdk = await import(sdkUrl.href);
const tui = await import(tuiUrl.href);
const { InteractiveMode } = await import(new URL('./modes/interactive/interactive-mode.js', sdkUrl));
const { createChatViewport } = await import(new URL('./modes/interactive/chat-viewport.js', sdkUrl));
const { initTheme } = await import(new URL('./modes/interactive/theme/theme.js', sdkUrl));
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
const { createEventBus, createAgentSessionServices, createAgentSessionFromServices, AgentSessionRuntime,
  ModelRuntime, SessionManager, SettingsManager } = sdk;
const { Container, TuiAltScreen, getKeybindings, setKeybindings } = tui;
const paths = ['pi-vim', 'pi-stash', 'pi-status-footer', 'pi-cc-render', 'pi-sidebar']
  .map(name => resolve(root, `packages/${name}/src/index.ts`));
const actionsChannel = 'pi-plugins.footer-actions.v1';
const flowChannel = 'pi-plugins.workflow-flow.v1';
const previousKeys = getKeybindings();
initTheme('dark', false);

class MemoryTerminal {
  constructor(columns) { this.columns = columns; this.rows = 44; this.kittyProtocolActive = false; this.writes = []; }
  start(input) { this.input = input; }
  stop() { this.input = undefined; }
  async drainInput() {}
  write(data) { this.writes.push(data); }
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  moveBy() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
  send(packet) {
    assert.equal(typeof this.input, 'function', 'Terminal.start must own input');
    this.input(packet);
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => stripVTControlCharacters(value).replace(/\x1b_pi:[^\x07]*\x07/gu, '');

async function fixture(width, flow, sidebar) {
  const cwd = join(temp, `project-${width}-${flow}-${sidebar}`);
  mkdirSync(cwd);
  const bus = createEventBus();
  const calls = [];
  let generation = 0;
  const flowState = () => flow === 'linked' ? {
    version: 1, operatingMode: 'linked', workflow: 'work', revision: 1,
    selectedFlow: { provider: 'anthropic', anchorModel: 'claude-sonnet-4-5', roles: {} },
    ready: true, guardAvailable: true, transitioning: false,
  } : undefined;
  bus.on(flowChannel, request => { if (request.kind === 'query') request.snapshot = flowState(); });
  bus.on(actionsChannel, request => {
    const ownerGeneration = generation;
    for (const [id, key] of [['flow.open', 'alt+f'], ['workflow.cycle', 'alt+w'],
      ['approvals.open', 'alt+a'], ['cache.status', undefined], ['execution.status', '/plan-exec']]) {
      request.actions[id] = { label: id, key, run() { calls.push({ generation: ownerGeneration, action: id }); } };
    }
  });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(temp, 'auth.json'), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  const settingsManager = SettingsManager.inMemory({
    theme: 'dark', quietStartup: true, showHardwareCursor: false,
    doubleEscapeAction: 'none', terminal: { showTerminalProgress: false },
  });
  const services = await createAgentSessionServices({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime, settingsManager,
    resourceLoaderOptions: { eventBus: bus, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: paths.slice(0, sidebar === 'absent' ? 4 : 5) },
  });
  const loaded = services.resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, [], 'real loader must accept every extension');
  assert.deepEqual(loaded.extensions.map(entry => entry.path), paths.slice(0, sidebar === 'absent' ? 4 : 5));
  const result = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.inMemory(cwd), tools: [],
    model: modelRuntime.getModels().find(model => model.provider === 'anthropic' && model.reasoning && !model.thinkingLevelMap) ?? modelRuntime.getModels().find(model => model.provider === 'anthropic' && model.reasoning), thinkingLevel: 'low',
  });
  const runtime = new AgentSessionRuntime(result.session, services, async () => {
    throw new Error('Session replacement is not part of this fixture');
  });
  const terminal = new MemoryTerminal(width);
  if (sidebar === 'open') terminal.rows = 110;
  const mode = new InteractiveMode(runtime, { terminal, tuiMode: 'fullscreen', initialThemeSetting: 'dark' });
  mode.shutdown = async () => {};
  mode.onInputCallback = () => assert.fail('A click must not submit a model request');
  mode.setupKeyHandlers();
  mode.setupEditorSubmitHandler();
  mode.defaultEditor.setText('Unsent draft');
  const viewport = createChatViewport({ document: mode.documentContainer,
    pendingMessages: mode.pendingMessagesContainer, status: mode.statusContainer,
    widgetsAbove: mode.widgetContainerAbove, editor: mode.editorContainer,
    widgetsBelow: mode.widgetContainerBelow, footer: mode.footerContainer });
  mode.transcriptScrollView = viewport.transcript;
  mode.fullscreenLayoutRoot = viewport.root;
  // Drag selection is real, but this fixture must not mutate the host clipboard.
  mode.renderer.copySelection = async () => true;
  for (const child of [mode.documentContainer, mode.pendingMessagesContainer,
    mode.statusContainer, mode.widgetContainerAbove, mode.editorContainer,
    mode.widgetContainerBelow, mode.footerContainer]) mode.renderer.addChild(child);
  assert.ok(mode.renderer instanceof TuiAltScreen);
  mode.renderer.setLayoutRoot(viewport.root);
  mode.ui.setFocus(mode.defaultEditor);
  mode.ui.start();
  const errors = [];
  try {
    await runtime.session.bindExtensions({ uiContext: mode.createExtensionUIContext(), mode: 'tui',
      onError: error => errors.push(error), shutdownHandler: () => {} });
    mode.setupExtensionShortcuts(runtime.session.extensionRunner);
    assert.deepEqual(errors, [], 'session_start must not reject native extension registration');
    mode.ui.setFocus(mode.editor);
    assert.ok(mode.editor.actionHandlers.get('app.model.select'), 'native model action copied to the wrapped editor');
    assert.ok(mode.editor.actionHandlers.get('app.thinking.cycle'), 'native reasoning action copied to the wrapped editor');
    assert.ok(mode.customFooter?.handleMouse, 'real SDK registers a mouse-capable footer');
    const mouseEvents = [];
    const nativeMouse = mode.customFooter.handleMouse;
    mode.customFooter.handleMouse = function (event) {
      const result = nativeMouse.call(this, event);
      mouseEvents.push({ type: event.type, button: event.button, x: event.x, y: event.y,
        width: event.width, clickCount: event.clickCount, handled: result?.handled === true });
      return result;
    };
    assert.ok(mode.ui.handleViewportInput !== TuiAltScreen.prototype.handleViewportInput,
      'cc-render installs its pre-SDK viewport input wrapper');
    if (sidebar === 'open') {
      const command = runtime.session.extensionRunner.getCommand('sidebar');
      assert.ok(command, `Sidebar must be registered through the native loader: ${JSON.stringify(runtime.session.extensionRunner.getRegisteredCommands().map(item => item.invocationName))}`);
      await command.handler('', runtime.session.extensionRunner.createContext());
      assert.notEqual(mode.ui.getFocusedComponent(), mode.editor, 'opening Sidebar focuses its real panel');
      mode.ui.setFocus(mode.editor);
      assert.equal(mode.ui.getFocusedComponent(), mode.editor, 'main regains focus while Sidebar stays open');
      assert.notEqual(mode.renderer.layoutRoot, viewport.root, 'Sidebar mounts a real split');
    } else assert.equal(mode.renderer.layoutRoot, viewport.root, 'closed Sidebar does not mount a split');
    mode.createExtensionUIContext().setStatus('workflow-mode', flow === 'exec' ? 'workflow: exec' : 'workflow: work');
    mode.createExtensionUIContext().setStatus('permission-mode', '⏵⏵ auto mode on (alt+a to cycle)');
    mode.createExtensionUIContext().setStatus('cache-guard', 'cache cold?');
    if (flow === 'exec') mode.createExtensionUIContext().setStatus('plan-exec', 'exec mode on · implementing');
    await tick();
    mode.renderer.renderNow();
    await tick();
    mode.renderer.renderNow();
    return { mode, runtime, terminal, calls, mouseEvents, bus, get generation() { return generation; },
      nextGeneration() { generation++; }, frame: () => mode.renderer.renderNow(),
      async close() {
        try { await runtime.dispose(); }
        finally { try { mode.stop(); } finally { mode.renderer.stop(); } }
      } };
  } catch (error) {
    try { await runtime.dispose(); } catch { /* Preserve the original setup failure. */ }
    try { mode.stop(); } catch { /* Preserve the original setup failure. */ }
    try { mode.renderer.stop(); } catch { /* Preserve the original setup failure. */ }
    throw error;
  }
}

// The actual rendered box, not a synthetic footer-local hit map, supplies terminal coordinates.
function footerBox(f) {
  const boxes = [];
  const visit = box => {
    if (!box || typeof box !== 'object') return;
    if (box.component === f.mode.footerContainer) boxes.push(box);
    for (const child of box.children ?? []) visit(child);
  };
  visit(f.mode.renderer.currentLayout?.root);
  assert.equal(boxes.length, 1, 'current SDK layout must expose one real footer box');
  return boxes[0];
}
function target(f, label) {
  const box = footerBox(f);
  const lines = box.lines.map(plain);
  const row = lines.findIndex(line => line.includes(label));
  assert.ok(row >= 0, `missing footer value ${label}: ${JSON.stringify(lines)}`);
  const x = lines[row].indexOf(label) + Math.min(2, label.length - 1);
  return { x: box.rect.x + x, y: box.rect.y + row - (box.lineOffset ?? 0), label };
}
function packet(button, point, suffix) {
  return `\x1b[<${button};${point.x + 1};${point.y + 1}${suffix}`;
}
function click(f, point, release = 0) {
  f.terminal.send(packet(0, point, 'M'));
  // No repaint and no manual repair of the footer's render width between press and release.
  f.terminal.send(packet(release, point, 'm'));
}
function assertUnchanged(f, before, label) {
  assert.equal(f.calls.length, before.calls, `${label} must not invoke a footer action`);
  assert.equal(f.runtime.session.thinkingLevel, before.thinking, `${label} must not cycle reasoning`);
  assert.equal(f.mode.editor.getExpandedText(), before.draft, `${label} must preserve the draft`);
  assert.equal(f.mode.ui.getFocusedComponent(), before.focus, `${label} must preserve focus`);
}
function snapshot(f) {
  return { calls: f.calls.length, thinking: f.runtime.session.thinkingLevel,
    draft: f.mode.editor.getExpandedText(), focus: f.mode.ui.getFocusedComponent() };
}
function requireOne(f, point, action, release = 0) {
  const before = f.calls.length;
  click(f, point, release);
  assert.equal(f.calls.length, before + 1,
    `idle footer click missed ${action} at ${point.label} (${f.terminal.columns} cols, ` +
    `press=${JSON.stringify(packet(0, point, 'M'))}, release=${JSON.stringify(packet(release, point, 'm'))}, ` +
    `footer events=${JSON.stringify(f.mouseEvents.slice(-6))}, ` +
    `footer diagnostics=${JSON.stringify(f.mode.customFooter.describe?.())}, ` +
    `footer render=${JSON.stringify(f.mode.customFooter.render(f.terminal.columns).map(plain))})`);
  assert.equal(f.calls.at(-1).action, action);
}

let failure;
try {
  for (const width of [46, 120, 180]) for (const flow of ['independent', 'linked', 'exec']) {
    for (const sidebar of ['absent', 'closed', 'open']) {
      const f = await fixture(width, flow, sidebar);
      let caseFailure;
      try {
        const cache = target(f, 'Cache');
        requireOne(f, cache, 'cache.status', sidebar === 'closed' ? 3 : 0);
        await tick(); f.frame();
        // Real terminal gestures must pass through the renderer, including its selection owner.
        const stable = snapshot(f);
        f.terminal.send(packet(0, cache, 'M'));
        f.terminal.send(packet(32, { ...cache, x: cache.x + 1 }, 'M'));
        f.terminal.send(packet(0, { ...cache, x: cache.x + 1 }, 'm'));
        assertUnchanged(f, stable, 'drag');
        for (const modifier of [4, 8, 16]) {
          f.terminal.send(packet(modifier, cache, 'M'));
          f.terminal.send(packet(modifier, cache, 'm'));
          assertUnchanged(f, stable, `modifier ${modifier}`);
        }
        click(f, cache);
        assert.equal(f.calls.length, stable.calls + 1, 'first click of a double-click is ordinary');
        click(f, cache);
        assert.equal(f.calls.length, stable.calls + 1, 'second click must not activate');
        assert.equal(f.mode.editor.getExpandedText(), stable.draft);
        assert.equal(f.mode.ui.getFocusedComponent(), stable.focus);
        await tick(); f.frame();
        const approval = target(f, 'auto');
        requireOne(f, approval, 'approvals.open');
        await tick(); f.frame();
        const model = target(f, 'haiku-4.5');
        if (flow === 'linked') requireOne(f, model, 'flow.open');
        else {
          // The native selector is deliberately cancelled, never confirmed.
          const draft = f.mode.editor.getExpandedText();
          const originalFocus = f.mode.ui.getFocusedComponent();
          const before = f.mode.editorContainer.children[0];
          click(f, model);
          assert.notEqual(f.mode.editorContainer.children[0], before, 'model click opens the native selector');
          f.terminal.send('\x1b');
          assert.equal(f.mode.editorContainer.children[0], before, 'Escape restores the editor');
          assert.equal(f.mode.ui.getFocusedComponent(), originalFocus, 'Escape restores focus');
          assert.equal(f.mode.editor.getExpandedText(), draft, 'Escape preserves unsent draft');
        }
        // The native reasoning action is a reversible, idle-only operation; no model turn starts.
        await tick(); f.frame();
        const beforeReasoning = snapshot(f);
        const reasoningVisible = footerBox(f).lines.some(line => plain(line).includes(`reasoning ${beforeReasoning.thinking}`));
        if (reasoningVisible) {
          const reasoning = target(f, beforeReasoning.thinking);
          reasoning.x -= 2; // hit the first cell of the short (three-cell) level
          click(f, reasoning);
          assert.notEqual(f.runtime.session.thinkingLevel, beforeReasoning.thinking,
            `reasoning click cycles the real session (${width} ${flow} ${sidebar}, ` +
            `point=${JSON.stringify(reasoning)}, mouse=${JSON.stringify(f.mouseEvents.slice(-4))}, ` +
            `diagnostics=${JSON.stringify(f.mode.customFooter.describe?.())}, ` +
            `footer=${JSON.stringify(f.mode.customFooter.render(width).map(plain))})`);
          assert.equal(f.calls.length, beforeReasoning.calls, 'native reasoning needs no capability action');
          assert.equal(f.mode.editor.getExpandedText(), beforeReasoning.draft);
          assert.equal(f.mode.ui.getFocusedComponent(), beforeReasoning.focus);
          await tick();
        } else assert.equal(width, 46, 'only the narrow linked row may omit reasoning');
        const afterClick = f.runtime.session.thinkingLevel;
        f.terminal.send('\x14'); // configured ctrl+t, the same native app.thinking.cycle action
        assert.notEqual(f.runtime.session.thinkingLevel, afterClick, 'keyboard cycles the same native reasoning state');
        assert.equal(f.mode.editor.getExpandedText(), beforeReasoning.draft);
        assert.equal(f.mode.ui.getFocusedComponent(), beforeReasoning.focus);
        // The wrapper's native keyboard action uses the same routing as its visible model hint.
        const beforeKeyboard = f.calls.length;
        const beforeKeyboardEditor = f.mode.editorContainer.children[0];
        f.terminal.send('\x1bp');
        if (flow === 'linked') {
          assert.equal(f.calls.length, beforeKeyboard + 1);
          assert.equal(f.calls.at(-1)?.action, 'flow.open');
          assert.equal(f.mode.editorContainer.children[0], beforeKeyboardEditor, 'linked key routes to flow, not model');
        } else {
          assert.notEqual(f.mode.editorContainer.children[0], beforeKeyboardEditor, 'model key opens native selector');
          f.terminal.send('\x1b');
          assert.equal(f.mode.editorContainer.children[0], beforeKeyboardEditor, 'Escape closes keyboard selector');
        }
        assert.equal(f.mode.editor.getExpandedText(), beforeReasoning.draft);
        assert.equal(f.mode.ui.getFocusedComponent(), beforeReasoning.focus);
        // Use the SDK's actual /reload path: shutdown old owners, reload resources, bind new owners.
        const oldFooter = f.mode.customFooter;
        const oldEditor = f.mode.editor;
        f.nextGeneration();
        const stalePoint = target(f, 'Cache');
        const oldBox = footerBox(f);
        const reloadErrors = [];
        const showError = f.mode.showError;
        f.mode.showError = function (message) { reloadErrors.push(message); return showError.call(this, message); };
        try { await f.mode.handleReloadCommand(); }
        finally { f.mode.showError = showError; }
        assert.deepEqual(reloadErrors, [], 'real SDK reload must not report an error');
        assert.notEqual(f.mode.customFooter, oldFooter, 'reload replaces footer ownership');
        assert.notEqual(f.mode.editor, oldEditor, 'reload replaces editor ownership');
        assert.equal(f.mode.editor.getExpandedText(), beforeReasoning.draft, 'reload preserves the unsent draft');
        assert.equal(f.mode.ui.getFocusedComponent(), f.mode.editor, 'reload restores main editor focus');
        const callsBeforeStale = f.calls.length;
        oldFooter.handleMouse({ type: 'click', button: 'left', x: stalePoint.x - oldBox.rect.x,
          y: stalePoint.y - oldBox.rect.y, width: oldBox.rect.width, height: oldBox.rect.height,
          screenX: stalePoint.x, screenY: stalePoint.y, clickCount: 1 });
        assert.equal(f.calls.length, callsBeforeStale, 'retired footer cannot activate after reload');
        assert.deepEqual(oldFooter.render(width), [], 'retired footer cannot render after reload');
        await tick(); f.frame();
        requireOne(f, target(f, 'Cache'), 'cache.status');
        assert.equal(f.calls.at(-1).generation, 1, 'new owner must use the live generation');
        assert.equal(f.mode.editor.getExpandedText(), beforeReasoning.draft);
        assert.equal(f.mode.ui.getFocusedComponent(), f.mode.editor);
        await tick();
        const freshEditor = f.mode.editorContainer.children[0];
        const freshCalls = f.calls.length;
        f.terminal.send('\x1bp');
        if (flow === 'linked') {
          assert.equal(f.calls.length, freshCalls + 1, 'reloaded model key uses the new flow owner');
          assert.equal(f.calls.at(-1).generation, 1);
          assert.equal(f.mode.editorContainer.children[0], freshEditor);
        } else {
          assert.notEqual(f.mode.editorContainer.children[0], freshEditor, 'reloaded model key opens selector');
          f.terminal.send('\x1b');
          assert.equal(f.mode.editorContainer.children[0], freshEditor);
        }
        assert.equal(f.mode.editor.getExpandedText(), beforeReasoning.draft);
        assert.equal(f.mode.ui.getFocusedComponent(), f.mode.editor);
        console.log(`PASS footer ${width} ${flow} Sidebar ${sidebar}`);
      } catch (error) { caseFailure = error; }
      finally { try { await f.close(); } catch (error) { caseFailure ??= error; } }
      if (caseFailure) throw caseFailure;
    }
  }
} catch (error) { failure = error; }
finally {
  // Sidebar retains family kernels across SDK reloads by design. The fixture owns
  // the whole process and must dispose those process-local Unix socket servers.
  const registry = globalThis[Symbol.for('pi-sidebar.families.v1')];
  for (const [id, family] of registry?.families ?? []) {
    try { await family.dispose(); }
    catch (error) { failure ??= error; }
    registry.families.delete(id);
  }
  try {
    setKeybindings(previousKeys);
    assert.equal(audit.network, 0, 'no code may attempt an external network request');
    assert.equal(audit.hostCredentialLookups, 0, 'no real host Keychain executable may be invoked');
    assert.equal(audit.forbiddenCli, 0, 'no unapproved external CLI may run');
    if (process.platform === 'darwin') {
      assert.ok(audit.securityShim > 0, 'the real quota path must exercise the isolated security shim');
      const shimRuns = readFileSync(process.env.PI_FOOTER_SECURITY_AUDIT, 'utf8').length;
      assert.ok(shimRuns > 0 && shimRuns <= audit.securityShim,
        'Keychain attempts must use the inert shim (some pending children may be killed on reload)');
    } else assert.equal(audit.securityShim, 0, 'non-macOS hosts must not attempt a Keychain lookup');
  } catch (error) { failure ??= error; }
  finally {
    try {
      globalThis.fetch = originalFetch;
      net.Socket.prototype.connect = originalConnect;
      for (const [module, offset] of [[http, 0], [https, 2]]) {
        module.request = originalHttp[offset]; module.get = originalHttp[offset + 1];
      }
      Object.assign(childProcess, originalChild);
      syncBuiltinESMExports();
      for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
      Object.assign(process.env, originalEnv);
      rmSync(temp, { recursive: true, force: true });
    } catch (error) { failure ??= error; }
  }
}
if (failure) throw failure;
