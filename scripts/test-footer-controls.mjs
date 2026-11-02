// Regression fixture for the real interactive footer input route and UI-only settings journal.
// Only an explicitly scripted in-process stream may start a turn; no external inference is allowed.
// Select another host with PI_TEST_SDK_ROOT=/absolute/path/to/pi-coding-agent.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
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
const aiUrl = hostDependency('@earendil-works/pi-ai');
const { createAssistantMessageEventStream } = await import(aiUrl.href);
const { getSupportedThinkingLevels } = await import(new URL('./compat.js', aiUrl).href);
const sdk = await import(sdkUrl.href);
const tui = await import(tuiUrl.href);
const { InteractiveMode } = await import(new URL('./modes/interactive/interactive-mode.js', sdkUrl));
const { createChatViewport } = await import(new URL('./modes/interactive/chat-viewport.js', sdkUrl));
const { initTheme } = await import(new URL('./modes/interactive/theme/theme.js', sdkUrl));
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
const { createEventBus, createAgentSessionServices, createAgentSessionFromServices, AgentSessionRuntime,
  ModelRuntime, SessionManager, SettingsManager } = sdk;
const { Container, TuiAltScreen, getKeybindings, setKeybindings } = tui;
// Use the real package helper through the selected host's loader. Its snapshot schema
// and discovery protocol must not be reimplemented by the fixture.
const cycleFixture = join(temp, 'settings-cycle-fixture.ts');
writeFileSync(cycleFixture, `
import { settingsCycles } from ${JSON.stringify(resolve(root, 'packages/pi-status-footer/src/settings-cycle.ts'))};
export default function (pi) {
  // This extension is first in the real loader, so every sibling discovers this
  // coordinator and the same injected immediate-terminal transport.
  const transport = {};
  pi.events.emit('test:cycle-transport', transport);
  const cycles = settingsCycles(pi, { inputPorts: transport.inputPorts });
  const owner = {};
  const values = { workflow: 'work', 'auto-effort': false, approvals: 'auto' };
  const applied = [];
  let ctx, shortcut;
  pi.registerShortcut('alt+j', { description: 'Fixture approval cycle', handler(context) {
    const request = { type: 'stage', key: 'approvals', context };
    pi.events.emit('test:settings-cycle', request);
    shortcut = { context, result: request.result };
  } });
  pi.on('session_start', (_event, context) => { ctx = context; });
  pi.events.on('test:settings-cycle', request => {
    if (request.type === 'query') Object.assign(request, { cycles, applied, values, pi, shortcut });
    if (request.type === 'stage') {
      const key = request.key;
      request.result = cycles.stage(request.context ?? ctx, {
        key, owner, read: () => values[key],
        next: value => typeof value === 'boolean' ? !value
          : key === 'workflow' ? ({ work: 'chat', chat: 'plan', plan: 'work' })[value]
          : value === 'auto' ? 'yolo' : 'auto',
        format: value => typeof value === 'boolean' ? value ? 'on' : 'off' : value,
        validate: () => undefined, current: () => true,
        apply: value => { applied.push({ key, value }); values[key] = value; return true; },
      });
    }
  });
}
`);
const paths = ['pi-vim', 'pi-stash', 'pi-status-footer', 'pi-cc-render', 'pi-sidebar']
  .map(name => resolve(root, `packages/${name}/src/index.ts`));
const actionsChannel = 'pi-plugins.footer-actions.v1';
const flowChannel = 'pi-plugins.workflow-flow.v1';
const previousKeys = getKeybindings();
initTheme('dark', false);

class MemoryTerminal {
  constructor(columns, raw, transport = 'legacy') {
    this.columns = columns; this.rows = 44; this.raw = raw; this.transport = transport;
    this.kittyProtocolActive = transport !== 'legacy'; this.writes = [];
    this.flags = 7; this.frames = []; this.queries = 0; this.pushes = 0; this.pops = 0;
  }
  start(input) { this.input = input; }
  stop() { this.input = undefined; }
  async drainInput() {}
  write(data) {
    this.writes.push(data);
    for (const match of data.matchAll(/\x1b\[(?:\?u|>(\d+)u|<u)/gu)) {
      if (match[1]) { this.frames.push(this.flags); this.flags = Number(match[1]); this.pushes++; }
      else if (match[0] === '\x1b[<u') {
        assert.ok(this.frames.length, 'a matching extension frame must exist before pop');
        this.flags = this.frames.pop(); this.pops++;
      } else {
        const query = ++this.queries;
        if (['unknown', 'legacy'].includes(this.transport) || (this.transport === 'dropped' && query % 2 === 0)) continue;
        const flags = this.transport === 'unsupported' ? 0 : this.transport === 'partial' && this.frames.length ? 3 : this.flags;
        queueMicrotask(() => this.reply(`\x1b[?${flags}u`));
      }
    }
  }
  reply(data) { this.raw.emit('data', Buffer.from(data)); }
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  moveBy() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
  send(...packets) {
    assert.equal(typeof this.input, 'function', 'Terminal.start must own input');
    // The passive stdin observer sees exactly the bytes on this immediate link;
    // capability replies are consumed by the host before its public input hooks.
    for (const packet of packets) {
      this.raw.emit('data', Buffer.from(packet));
      this.input(packet);
    }
  }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label) => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await tick();
  }
};
const journalEntries = f => f.runtime.session.sessionManager.getBranch().filter(entry =>
  entry.type === 'custom' && ['settings:cycle', 'settings:cycle-state'].includes(entry.customType));
const historyLines = f => f.mode.chatContainer.render(f.terminal.columns).map(plain).filter(line => line.includes('Settings'));
const screenLines = f => f.mode.renderer.currentLayout.lines.map(plain);
const settings = f => { const request = { type: 'query' }; f.bus.emit('test:settings-cycle', request); return request; };
const stage = (f, key) => { const request = { type: 'stage', key }; f.bus.emit('test:settings-cycle', request); return request.result; };
const plain = value => stripVTControlCharacters(value).replace(/\x1b_pi:[^\x07]*\x07/gu, '');

async function fixture(width, flow, sidebar, { transport = 'legacy', mainScreen = false, vim = true } = {}) {
  const cwd = mkdtempSync(join(temp, `project-${width}-${flow}-${sidebar}-`));
  const bus = createEventBus();
  const raw = new EventEmitter(), exitSource = new EventEmitter();
  const terminal = new MemoryTerminal(width, raw, transport);
  bus.on('test:cycle-transport', request => {
    request.inputPorts = { stdin: raw, exitSource, isInputTTY: () => true, isOutputTTY: () => true,
      writeSync: data => terminal.write(data), queueMicrotask };
  });
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
  const extensionPaths = [cycleFixture, ...paths.slice(vim ? 0 : 1, sidebar === 'absent' ? 4 : 5)];
  const services = await createAgentSessionServices({
    cwd, agentDir: process.env.PI_CODING_AGENT_DIR, modelRuntime, settingsManager,
    resourceLoaderOptions: { eventBus: bus, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: extensionPaths },
  });
  const loaded = services.resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, [], 'real loader must accept every extension');
  assert.deepEqual(loaded.extensions.map(entry => entry.path), extensionPaths);
  const result = await createAgentSessionFromServices({
    services, sessionManager: SessionManager.inMemory(cwd), tools: [],
    model: modelRuntime.getModels().find(model => model.provider === 'anthropic' && model.reasoning && !model.thinkingLevelMap) ?? modelRuntime.getModels().find(model => model.provider === 'anthropic' && model.reasoning), thinkingLevel: 'low',
  });
  const runtime = new AgentSessionRuntime(result.session, services, async () => {
    throw new Error('Session replacement is not part of this fixture');
  });
  if (sidebar === 'open') terminal.rows = 110;
  const mode = new InteractiveMode(runtime, { terminal, tuiMode: mainScreen ? 'regular' : 'fullscreen', initialThemeSetting: 'dark' });
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
  assert.equal(mode.renderer instanceof TuiAltScreen, !mainScreen);
  if (!mainScreen) mode.renderer.setLayoutRoot(viewport.root);
  mode.ui.setFocus(mode.defaultEditor);
  mode.ui.start();
  const errors = [];
  try {
    await runtime.session.bindExtensions({ uiContext: mode.createExtensionUIContext(), mode: 'tui',
      onError: error => errors.push(error), shutdownHandler: () => {} });
    mode.setupExtensionShortcuts(runtime.session.extensionRunner);
    // Exercise appendEntry -> AgentSession.entry_appended -> the actual native transcript,
    // rather than calling a renderer directly or manually reinserting its anchor.
    mode.isInitialized = true;
    mode.subscribeToAgent();
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
    } else if (!mainScreen) assert.equal(mode.renderer.layoutRoot, viewport.root, 'closed Sidebar does not mount a split');
    mode.createExtensionUIContext().setStatus('workflow-mode', flow === 'exec' ? 'workflow: exec' : 'workflow: work');
    mode.createExtensionUIContext().setStatus('permission-mode', '⏵⏵ auto mode on (alt+a to cycle)');
    mode.createExtensionUIContext().setStatus('cache-guard', 'cache cold?');
    if (flow === 'exec') mode.createExtensionUIContext().setStatus('plan-exec', 'exec mode on · implementing');
    await tick();
    mode.renderer.renderNow();
    await tick();
    mode.renderer.renderNow();
    return { mode, runtime, terminal, raw, exitSource, calls, mouseEvents, bus, modelRuntime, errors, get generation() { return generation; },
      nextGeneration() { generation++; }, frame: () => mode.renderer.renderNow(),
      async close() {
        // Drain existing next-timer session_start registrations (cc-render's write
        // renderer) before tearing down a runtime immediately after native /reload.
        await pause(5);
        try { await runtime.dispose(); }
        finally { try { mode.stop(); } finally { mode.renderer.stop(); } }
        assert.equal(terminal.frames.length, 0, 'shutdown leaves no keyboard frame');
        assert.equal(raw.listenerCount('data'), 0, 'shutdown removes the passive reply observer');
        assert.equal(exitSource.listenerCount('exit'), 0, 'shutdown removes its emergency restoration listener');
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

const cycleAnchors = f => journalEntries(f).filter(entry => entry.customType === 'settings:cycle');
const nativeAnchor = f => f.mode.chatContainer.children.find(child => child.render(120).some(line => plain(line).includes('Settings')));
const reasoningRecords = f => f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'thinking_level_change');

async function terminalCycles() {
  for (const mainScreen of [false, true]) {
    const f = await fixture(120, 'independent', 'absent', { transport: 'supported', mainScreen, vim: false });
    try {
      const api = settings(f);
      const original = snapshot(f);
      const context = structuredClone(f.runtime.session.sessionManager.buildSessionContext().messages);
      const before = reasoningRecords(f).length;
      f.terminal.send('\x1b[116;5u'); // original configured ctrl+t through the real native editor action
      assert.equal(api.cycles.snapshot()?.phase, 'pending');
      const anchor = nativeAnchor(f);
      const savedAnchor = structuredClone(cycleAnchors(f)[0]);
      assert.ok(anchor, 'the actual native history component exists before negotiation finishes');
      assert.equal(api.cycles.inputStatus().mode, 'negotiating', `real editor transport capture: ${JSON.stringify({ status: api.cycles.inputStatus(), queries: f.terminal.queries, pushes: f.terminal.pushes, listeners: f.raw.listenerCount('data') })}`);
      await until(() => f.terminal.queries === 2, 'baseline, push and capability query');
      await tick();
      assert.equal(api.cycles.inputStatus().mode, 'negotiating', 'acknowledgement alone is not current held-state evidence');
      assert.equal(api.cycles.inputStatus().reason, 'unconfirmed');
      // Releasing the ordinary key still reports Ctrl held and proves the enhanced
      // frame is actually working after the push; it must not activate ctrl+t twice.
      f.terminal.send('\x1b[116;5:3;116u');
      assert.equal(api.cycles.inputStatus().mode, 'modifier-release');
      assert.deepEqual(api.cycles.inputStatus().modifiers, ['ctrl']);
      await pause(3100);
      assert.equal(api.cycles.snapshot()?.phase, 'pending', 'a negotiated multi-second hold has no watchdog');
      assert.equal(f.runtime.session.thinkingLevel, original.thinking);
      assert.equal(reasoningRecords(f).length, before, 'ordinary-key release and long hold invoke no setter');
      assert.equal(cycleAnchors(f).length, 1);
      f.terminal.send('\x1b[57442;1:3u');
      await until(() => api.cycles.snapshot()?.phase === 'applied', 'final Ctrl release applies immediately');
      assert.equal(reasoningRecords(f).length, before + 1, 'final participating release applies exactly once');
      assert.equal(f.terminal.frames.length, 0);
      assert.equal(f.terminal.pops, 1, 'the temporary frame is restored before effective application');
      assert.equal(f.terminal.flags, 7, 'the original native keyboard frame is preserved');
      assert.equal(api.cycles.inputStatus().mode, 'idle');
      assert.ok(f.mode.chatContainer.children.includes(anchor));
      assert.match(anchor.render(120).map(plain).join('\n'), /Settings · Effort/u);

      // New transactions settled by the timer still reuse the original component,
      // not merely the same persisted ID appended as a second native anchor.
      for (const key of ['workflow', 'auto-effort', 'workflow']) {
        const result = stage(f, key);
        assert.equal(api.cycles.inputStatus().mode, 'timer');
        assert.equal(await result, true);
        assert.equal(cycleAnchors(f).length, 1);
        assert.deepEqual(cycleAnchors(f)[0], savedAnchor, 'the first native anchor record stays immutable');
        assert.ok(f.mode.chatContainer.children.includes(anchor), 'completed batches retain the very same native component');
        assert.equal(historyLines(f).length, 1);
        assert.match(anchor.render(120).map(plain).join('\n'), /Settings ·/u);
      }
      if (!mainScreen) {
        f.terminal.send('\x1b[116;5u');
        await until(() => f.terminal.pushes === 2, 'second negotiated keyboard batch');
        await tick();
        f.terminal.send('\x1b[57442;5u');
        assert.equal(api.cycles.inputStatus().mode, 'modifier-release');
        await tick(); f.frame();
        const level = api.cycles.snapshot().settings.find(item => item.key === 'reasoning').target;
        const pointer = target(f, level);
        pointer.x -= 2;
        click(f, pointer);
        assert.equal(api.cycles.inputStatus().mode, 'timer', 'an actual footer click does not inherit the keyboard hold');
        assert.equal(api.cycles.inputStatus().reason, 'pointer');
        assert.equal(f.terminal.frames.length, 0, 'pointer activation closes the keyboard lease immediately');
        await until(() => api.cycles.snapshot()?.phase === 'applied', 'pointer fallback after held keyboard cycle');
        assert.equal(cycleAnchors(f).length, 1);
        assert.ok(f.mode.chatContainer.children.includes(anchor));
      }
      assert.deepEqual(f.runtime.session.sessionManager.buildSessionContext().messages, context, 'transport cycles never enter model context');
      assert.equal(f.mode.editor.getExpandedText(), original.draft, 'modifier normalization inserts no PUA glyph or release text');
      assert.equal(f.mode.ui.getFocusedComponent(), original.focus);

      const recovering = f.terminal.pushes + 1;
      const beforeRecovery = reasoningRecords(f).length;
      f.terminal.send('\x1b[116;5u');
      await until(() => f.terminal.pushes === recovering, 'lost-release recovery handshake');
      await tick();
      f.terminal.send('\x1b[57442;5u');
      assert.equal(api.cycles.inputStatus().mode, 'modifier-release');
      f.terminal.send('\x1b[120;1:3u'); // no modifier-release packet; later trustworthy mask says Ctrl is up
      await until(() => api.cycles.snapshot()?.phase === 'applied', 'later event mask recovers a dropped modifier release');
      assert.equal(reasoningRecords(f).length, beforeRecovery + 1);
      assert.equal(cycleAnchors(f).length, 1);
      assert.equal(f.mode.editor.getExpandedText(), original.draft);

      const focusLease = f.terminal.pushes + 1;
      const beforeFocus = reasoningRecords(f).length;
      f.terminal.send('\x1b[116;5u');
      await until(() => f.terminal.pushes === focusLease, 'focus-loss handshake');
      await tick();
      f.terminal.send('\x1b[57442;5u');
      assert.equal(api.cycles.inputStatus().mode, 'modifier-release');
      f.mode.ui.setFocus(new Container());
      f.terminal.send('\x1b[57442;1:3u');
      assert.equal(api.cycles.snapshot()?.phase, 'cancelled', 'a hidden main editor cannot commit a held shortcut');
      assert.equal(reasoningRecords(f).length, beforeFocus);
      assert.equal(f.terminal.frames.length, 0, 'focus loss restores the frame before cancellation');
      f.mode.ui.setFocus(f.mode.editor);

      // Associated Unicode/IME text must use the actual editor input path once,
      // including raw private-use text and bracketed paste, never draft replacement.
      f.mode.editor.setText('');
      f.terminal.send('\x1b[97;1;233:769u');
      f.terminal.send('\x1b[0;1;30028:128578u');
      f.terminal.send('\ue123');
      f.terminal.send('\x1b[200~pasted 界\x1b[201~');
      assert.equal(f.mode.editor.getExpandedText(), 'é́界🙂\ue123pasted 界');
      f.terminal.send('\x1b[57442;5u', '\x1b[57442;1:3u');
      assert.equal(f.mode.editor.getExpandedText(), 'é́界🙂\ue123pasted 界');
      assert.deepEqual(f.errors, []);
      console.log(`PASS real ${mainScreen ? 'main-screen' : 'fullscreen'} negotiated hold/release, native anchor reuse and enhanced text (${sdkRoot})`);
    } finally { await f.close(); }
  }

  for (const transport of ['legacy', 'unsupported', 'partial', 'unknown', 'dropped', 'supported']) {
    const f = await fixture(120, 'independent', 'absent', { transport, vim: false });
    try {
      const api = settings(f), before = reasoningRecords(f).length;
      const started = Date.now();
      f.terminal.send(transport === 'legacy' ? '\x14' : '\x1b[116;5u');
      await tick();
      assert.ok(['timer', 'negotiating'].includes(api.cycles.inputStatus().mode));
      await pause(700);
      assert.equal(api.cycles.snapshot()?.phase, 'pending', `${transport} does not retain the old 400 ms deadline`);
      // Unrelated input and a late capability reply must not restart the deadline.
      f.terminal.send(packet(35, { x: 0, y: 0 }, 'M'));
      await until(() => api.cycles.snapshot()?.phase === 'applied', `${transport} 1000 ms fallback`);
      assert.ok(Date.now() - started >= 990, `${transport} waits for the cycle fallback`);
      assert.ok(Date.now() - started < 1600, `${transport} noise does not extend the cycle fallback`);
      assert.equal(reasoningRecords(f).length, before + 1);
      assert.equal(f.terminal.frames.length, 0, `${transport} leaves no keyboard lease`);
      if (['legacy', 'unsupported', 'unknown'].includes(transport)) assert.equal(f.terminal.pushes, 0);
      else assert.equal(f.terminal.pushes, f.terminal.pops, `${transport} restores its exact pushed frame`);
      f.terminal.reply('\x1b[?31u');
      await tick();
      assert.equal(reasoningRecords(f).length, before + 1, 'orphan replies cannot revive a settled transaction');
      assert.equal(f.terminal.frames.length, 0);
      assert.deepEqual(f.errors, []);
      console.log(`PASS real terminal ${transport} fallback and lease cleanup (${sdkRoot})`);
    } finally { await f.close(); }
  }

  const f = await fixture(120, 'independent', 'absent', { transport: 'unknown', vim: false });
  try {
    const api = settings(f), before = reasoningRecords(f).length;
    f.terminal.send('\x1b[116;5u');
    f.terminal.send('\x1b[57442;1:3u'); // release before even the initial baseline reply
    await until(() => api.cycles.snapshot()?.phase === 'applied', 'release before initial handshake');
    f.terminal.reply('\x1b[?7u\x1b[?31u');
    await pause(1050);
    assert.equal(reasoningRecords(f).length, before + 1, 'late full acknowledgement cannot strand or relaunch an already released batch');
    assert.equal(f.terminal.frames.length, 0);
    assert.equal(f.terminal.pushes, 0, 'late replies cannot open an orphan lease');
  } finally { await f.close(); }
}

async function shortcutModelCancellation() {
  const f = await fixture(120, 'independent', 'absent');
  try {
    const original = f.runtime.session.model;
    f.terminal.send('\x1bj'); // The SDK constructs a real snapshot shortcut context.
    const shortcut = settings(f).shortcut;
    assert.ok(shortcut?.result, 'native terminal shortcut stages the preview');
    assert.equal(shortcut.context.model.id, original.id);
    await f.modelRuntime.setRuntimeApiKey(original.provider, 'offline-fixture-key');
    const replacement = f.modelRuntime.getModels().find(model => model.provider === original.provider && model.id !== original.id);
    assert.ok(replacement, 'fixture needs another built-in physical model');
    await f.runtime.session.setModel(replacement);
    assert.equal(shortcut.context.model.id, original.id, 'SDK shortcut context keeps its old snapshot');
    assert.equal(f.runtime.session.model.id, replacement.id, 'real setter changed the active model');
    assert.equal(await shortcut.result, false, 'current model_select context cancels the old shortcut burst');
    assert.equal(settings(f).values.approvals, 'auto');
    assert.deepEqual(settings(f).applied, []);
    assert.equal(settings(f).cycles.snapshot().phase, 'cancelled');
    assert.equal(settings(f).cycles.snapshot().reason, 'model changed');
    await pause(1025);
    assert.deepEqual(settings(f).applied, [], 'no late permission relaxation after the old deadline');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}

async function journalCheckpoint() {
  const f = await fixture(120, 'independent', 'absent');
  try {
    const api = settings(f);
    const beforeContext = structuredClone(f.runtime.session.sessionManager.buildSessionContext().messages);
    const first = stage(f, 'workflow');
    const anchor = f.mode.chatContainer.children.find(child => child.render(120).some(line => plain(line).includes('Settings pending')));
    assert.ok(anchor, 'appendEntry immediately inserts the native visible anchor');
    await pause(100);
    const second = stage(f, 'workflow');
    const mixed = stage(f, 'auto-effort');
    const lastStaged = Date.now();
    assert.equal(first, second, 'same-key callers await the same settled burst');
    assert.equal(second, mixed, 'mixed controls share one settled result');
    assert.deepEqual(api.applied, [], 'previews call no effective setter');
    assert.equal(api.values.workflow, 'work');
    assert.equal(api.values['auto-effort'], false);
    assert.equal(journalEntries(f).filter(entry => entry.customType === 'settings:cycle').length, 1);
    assert.ok(journalEntries(f).filter(entry => entry.customType === 'settings:cycle-state').length >= 2,
      'later previews append hidden snapshots, not replacement entries');
    await tick(); f.frame();
    assert.equal(historyLines(f).length, 1, 'one real transcript row for the entire mixed burst');
    assert.match(historyLines(f)[0], /Settings pending · Workflow plan · Auto on/u);
    assert.equal(screenLines(f).filter(line => line.includes('Settings pending')).length, 1,
      'the actual fullscreen frame shows exactly one immediate pending history row');
    assert.ok(f.mode.chatContainer.children.includes(anchor), 'snapshot appends keep the original anchor component');
    assert.match(anchor.render(120).map(plain).join('\n'), /Workflow plan · Auto on/u,
      'an already-created native component renders the latest hidden snapshot');
    await pause(250);
    assert.deepEqual(api.applied, [], 'no effective changes before the 1000 ms quiet period');
    assert.equal(await first, true);
    assert.ok(Date.now() - lastStaged >= 990, 'settlement waits for the quiet period after the latest mixed-control input');
    assert.deepEqual(api.applied, [{ key: 'workflow', value: 'plan' }, { key: 'auto-effort', value: true }]);
    assert.equal(historyLines(f).length, 1);
    assert.match(historyLines(f)[0], /Settings · Workflow plan · Auto on/u);
    assert.deepEqual(f.runtime.session.sessionManager.buildSessionContext().messages, beforeContext,
      'neither the anchor nor any hidden snapshot enters model context');
    const originalRow = api.cycles.snapshot().id;
    const originalRecord = structuredClone(cycleAnchors(f)[0]);
    for (let batch = 0; batch < 2; batch++) {
      const unchanged = stage(f, 'workflow');
      assert.notEqual(unchanged, first, 'a completed row gets a fresh per-batch transaction promise');
      assert.equal(stage(f, 'workflow'), unchanged);
      assert.equal(stage(f, 'workflow'), unchanged);
      assert.equal(await unchanged, true);
      assert.equal(api.cycles.snapshot().phase, 'unchanged');
      assert.equal(api.cycles.snapshot().id, originalRow);
      assert.equal(api.cycles.snapshot().settings.length, 1, 'latest no-op batch does not claim older committed auto-effort changes');
      assert.equal(api.cycles.snapshot().settings[0].baseline, 'plan', 'new batch validates against fresh effective baseline');
      assert.equal(cycleAnchors(f).length, 1);
      assert.deepEqual(cycleAnchors(f)[0], originalRecord);
      assert.ok(f.mode.chatContainer.children.includes(anchor));
      assert.match(anchor.render(120).map(plain).join('\n'), /Settings unchanged/u);
      assert.deepEqual(api.applied, [{ key: 'workflow', value: 'plan' }, { key: 'auto-effort', value: true }], 'unchanged batches invoke no setter');
    }
    api.cycles.cancel('explicit fixture selection'); // boundary even with no pending transaction
    const selected = stage(f, 'workflow');
    assert.equal(await selected, true);
    assert.equal(cycleAnchors(f).length, 2, 'explicit selection seals reuse even after settlement');
    assert.notEqual(api.cycles.snapshot().id, originalRow);
    assert.match(anchor.render(120).map(plain).join('\n'), /Settings unchanged/u, 'a sealed old native component never changes again');
    const selectedRow = api.cycles.snapshot().id;
    api.pi.appendEntry('fixture:unrelated-output', { visible: false });
    const separated = stage(f, 'workflow');
    assert.equal(await separated, true);
    assert.equal(cycleAnchors(f).length, 3, 'an unknown branch record is a conservative row boundary');
    assert.notEqual(api.cycles.snapshot().id, selectedRow);
    assert.deepEqual(f.runtime.session.sessionManager.buildSessionContext().messages, beforeContext);

    // A genuine local AgentSession stream drives InteractiveMode's streaming component.
    // This explicitly scripted transport is the only inference-shaped call allowed here.
    await f.modelRuntime.setRuntimeApiKey('anthropic', 'local-fixture-placeholder');
    let stream;
    let finish;
    const contexts = [];
    f.runtime.session.agent.streamFunction = (model, context) => {
      assert.equal(stream, undefined, 'only one local scripted request');
      contexts.push(structuredClone(context.messages));
      stream = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Local streamed reply.' }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now() };
      finish = () => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); };
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'Local streamed reply.', partial: message });
      });
      return stream;
    };
    const turn = f.runtime.session.prompt('Scripted local stream.');
    try {
      await until(() => f.runtime.session.isStreaming && f.mode.streamingComponent, 'real streaming transcript');
      const streaming = f.mode.streamingComponent;
      const count = historyLines(f).length;
      const pending = stage(f, 'approvals');
      assert.equal(f.runtime.session.isStreaming, true);
      assert.equal(historyLines(f).length, count + 1, 'preview is visible without waiting for the assistant to finish');
      const streamingAnchor = f.mode.chatContainer.children.find(child => child.render(120).some(line => plain(line).includes('Approvals yolo')));
      assert.ok(streamingAnchor);
      assert.ok(f.mode.chatContainer.children.indexOf(streamingAnchor) < f.mode.chatContainer.children.indexOf(streaming),
        'native entry insertion places the anchor before the active assistant component');
      const roundTrip = stage(f, 'approvals');
      await tick(); f.frame();
      assert.equal(historyLines(f).length, count + 1);
      assert.match(streamingAnchor.render(120).map(plain).join('\n'), /Approvals auto/u,
        'hidden snapshot redraws the same anchor during streaming');
      assert.equal(screenLines(f).filter(line => line.includes('Settings pending')).length, 1,
        'the real fullscreen stream frame shows only the latest preview, not each snapshot');
      assert.ok(screenLines(f).some(line => line.includes('Local streamed reply.')), 'the assistant stream remains visible');
      assert.equal(api.values.approvals, 'auto', 'streaming preview is not an approval grant');
      api.cycles.cancel('streaming checkpoint complete');
      assert.equal(await pending, false);
      assert.equal(await roundTrip, false);
      assert.doesNotMatch(JSON.stringify(contexts), /settings:cycle|Settings pending/u);
    } finally { finish?.(); await turn; }

    // Native /reload rebuilds chat before session_start and then reconciles the journal.
    // An abandoned pending record becomes cancelled; no timer or draft is restored.
    const pending = stage(f, 'workflow');
    const retiredRowId = api.cycles.snapshot().id;
    const savedEntries = structuredClone(journalEntries(f));
    const appliedBeforeReload = api.applied.length;
    const draft = f.mode.editor.getExpandedText();
    await f.mode.handleReloadCommand();
    assert.equal(await pending, false);
    await tick(); f.frame();
    assert.match(historyLines(f).at(-1), /Settings cancelled · interrupted/u);
    assert.deepEqual(journalEntries(f), savedEntries, 'reload does not rewrite append-only journal data');
    await pause(1050);
    assert.equal(api.applied.length, appliedBeforeReload, 'retired timer cannot apply after reload');
    assert.deepEqual(settings(f).applied, [], 'replacement coordinator does not replay the old preview');
    assert.equal(f.mode.editor.getExpandedText(), draft);
    assert.equal(f.mode.ui.getFocusedComponent(), f.mode.editor);

    // Persist an interrupted applying snapshot using the helper's actual versioned data.
    const anchorsBeforeRestage = cycleAnchors(f).length;
    const staged = stage(f, 'workflow');
    const current = settings(f);
    assert.notEqual(current.cycles.snapshot().id, retiredRowId, 'reload never reopens a restored row for live editing');
    assert.equal(cycleAnchors(f).length, anchorsBeforeRestage + 1, 'the replacement coordinator appends a fresh native anchor');
    const snapshot = current.cycles.snapshot();
    current.pi.appendEntry('settings:cycle-state', { version: 1, ...snapshot, phase: 'applying' });
    const applyingEntries = structuredClone(journalEntries(f));
    await f.mode.handleReloadCommand();
    assert.equal(await staged, false);
    await tick(); f.frame();
    assert.match(historyLines(f).at(-1), /Settings interrupted · check current settings/u);
    assert.deepEqual(journalEntries(f), applyingEntries, 'reload leaves applying evidence unchanged');
    assert.deepEqual(settings(f).applied, []);

    // The real footer's commit guard refuses a draft after main loses focus.
    const effective = f.runtime.session.thinkingLevel;
    f.terminal.send('\x14');
    const focusBurst = settings(f).cycles;
    assert.equal(focusBurst.snapshot()?.phase, 'pending');
    f.mode.ui.setFocus(new Container());
    assert.equal(await focusBurst.flush(), false, 'real main-focus guard blocks settlement');
    assert.equal(f.runtime.session.thinkingLevel, effective);
    assert.match(historyLines(f).at(-1), /Settings not applied.*main editor/u);
    f.mode.ui.setFocus(f.mode.editor);

    // Enter uses Pi's actual submit/history route. A failed input flush must not
    // start inference or replace a newer draft typed while the async hook settles.
    const release = settings(f).cycles.addGuard(() => 'fixture final validation failed');
    f.terminal.send('\x14');
    let submitted;
    let preflight;
    const recoverable = 'Recover this failed settings submission.';
    f.mode.onInputCallback = text => {
      assert.equal(text, recoverable);
      submitted = f.runtime.session.prompt(text, { preflightResult: result => { preflight = result; } });
    };
    f.mode.editor.setText(recoverable);
    f.terminal.send('\r');
    assert.ok(submitted, 'Terminal.start reaches the native main-editor submit callback');
    f.mode.editor.setText('Newer unsent draft');
    await submitted;
    release();
    assert.equal(preflight, 'handled', 'failed settlement consumes input instead of sending under old settings');
    assert.equal(contexts.length, 1, 'failed input makes no additional local model request');
    assert.equal(f.runtime.session.thinkingLevel, effective);
    assert.equal(f.mode.editor.getExpandedText(), 'Newer unsent draft', 'failed flush never overwrites a newer draft');
    assert.match(historyLines(f).at(-1), /message not sent.*recover it from prompt history/u);
    f.mode.editor.setText('');
    f.terminal.send('\x1b[A');
    assert.equal(f.mode.editor.getExpandedText(), recoverable, 'native prompt history recovers the unsent message');

    // Successful native submission flushes immediately; inference observes only
    // the final committed target, never a preview or custom-entry context message.
    const nextDraft = 'Submit with final settings.';
    f.runtime.session.agent.streamFunction = (model, context) => {
      contexts.push(structuredClone(context.messages));
      assert.equal(f.runtime.session.thinkingLevel, finalReasoning);
      const local = createAssistantMessageEventStream();
      const message = { role: 'assistant', content: [{ type: 'text', text: 'Flushed locally.' }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now() };
      queueMicrotask(() => { local.push({ type: 'done', reason: 'stop', message }); local.end(message); });
      return local;
    };
    f.terminal.send('\x14');
    const finalReasoning = settings(f).cycles.snapshot().settings.find(item => item.key === 'reasoning').target;
    assert.equal(f.runtime.session.thinkingLevel, effective);
    f.mode.onInputCallback = text => {
      assert.equal(text, nextDraft);
      submitted = f.runtime.session.prompt(text);
    };
    f.mode.editor.setText(nextDraft);
    f.terminal.send('\r');
    await submitted;
    assert.equal(settings(f).cycles.snapshot()?.phase, 'applied');
    assert.equal(contexts.length, 2, 'only the successful native submission starts the next local request');
    assert.doesNotMatch(JSON.stringify(contexts), /settings:cycle|Settings pending/u);
    assert.deepEqual(f.errors, [], 'entry notifications, streaming and reload have no swallowed extension errors');
    console.log(`PASS immediate native settings anchor, hidden snapshots, local streaming and reload (${sdkRoot})`);
  } finally { await f.close(); }
}

let failure;
try {
  await terminalCycles();
  await shortcutModelCancellation();
  await journalCheckpoint();
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
        // Mouse and the configured native action share one final-only reasoning burst.
        // Dispatch through Terminal.start, including cc-render's viewport and the Vim editor.
        await tick(); f.frame();
        const beforeReasoning = snapshot(f);
        const levels = getSupportedThinkingLevels(f.runtime.session.model);
        const nextReasoning = value => levels[(levels.indexOf(value) + 1) % levels.length];
        const beforeEntries = journalEntries(f).length;
        const beforeThinking = f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'thinking_level_change').length;
        const beforeAnchors = journalEntries(f).filter(entry => entry.customType === 'settings:cycle').length;
        const reasoningVisible = footerBox(f).lines.some(line => plain(line).includes(`reasoning ${beforeReasoning.thinking}`));
        let mouseTarget;
        if (reasoningVisible) {
          const reasoning = target(f, beforeReasoning.thinking);
          reasoning.x -= 2; // hit the first cell of the short (three-cell) level
          click(f, reasoning);
          assert.equal(f.runtime.session.thinkingLevel, beforeReasoning.thinking, 'mouse preview must not call the native setter');
          const preview = settings(f).cycles.snapshot();
          assert.equal(preview?.phase, 'pending', `reasoning click must stage: ${JSON.stringify(f.mode.customFooter.describe?.())}`);
          mouseTarget = preview.settings.find(item => item.key === 'reasoning')?.target;
          assert.equal(mouseTarget, nextReasoning(beforeReasoning.thinking), 'mouse uses the native supported-level order');
          assert.equal(f.calls.length, beforeReasoning.calls, 'reasoning needs no provider capability action');
        } else assert.equal(width, 46, 'only the narrow linked row may omit reasoning');
        f.terminal.send('\x14'); // configured ctrl+t, not a hardcoded wrapper shortcut
        assert.equal(f.runtime.session.thinkingLevel, beforeReasoning.thinking, 'keyboard preview also leaves effective reasoning unchanged');
        const preview = settings(f).cycles.snapshot();
        assert.equal(preview?.phase, 'pending');
        const finalTarget = preview.settings.find(item => item.key === 'reasoning')?.target;
        assert.ok(finalTarget);
        assert.equal(finalTarget, nextReasoning(mouseTarget ?? beforeReasoning.thinking), 'keyboard advances the pending target in native order, not committed reasoning');
        assert.equal(journalEntries(f).filter(entry => entry.customType === 'settings:cycle').length, beforeAnchors + 1,
          'mouse and key share one visible anchor');
        assert.equal(f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'thinking_level_change').length,
          beforeThinking, 'zero native reasoning changes during preview');
        await pause(250);
        assert.equal(f.runtime.session.thinkingLevel, beforeReasoning.thinking, 'reasoning remains effective-only until the quiet period ends');
        await until(() => settings(f).cycles.snapshot()?.phase !== 'pending', 'native reasoning settlement');
        await until(() => settings(f).cycles.snapshot()?.phase !== 'applying', 'native reasoning apply');
        assert.equal(settings(f).cycles.snapshot()?.phase, 'applied');
        assert.equal(f.runtime.session.thinkingLevel, finalTarget, 'only the final shared reasoning target reaches the native setter');
        assert.equal(f.runtime.session.sessionManager.getEntries().filter(entry => entry.type === 'thinking_level_change').length,
          beforeThinking + 1, 'exactly one native reasoning change for the burst');
        assert.ok(journalEntries(f).length > beforeEntries);
        assert.equal(f.mode.chatContainer.render(width).map(plain).some(line => line.includes('Thinking level:')), false,
          'the stock immediate reasoning notification must not duplicate the journal');
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
        const restoredReasoning = f.runtime.session.thinkingLevel;
        f.terminal.send('\x14');
        assert.equal(f.runtime.session.thinkingLevel, restoredReasoning, 'reloaded reasoning key stages without applying');
        const restoredTarget = settings(f).cycles.snapshot()?.settings.find(item => item.key === 'reasoning')?.target;
        assert.ok(restoredTarget, 'new footer owns native reasoning interception after reload');
        await until(() => settings(f).cycles.snapshot()?.phase === 'applied', 'reloaded reasoning cycle');
        assert.equal(f.runtime.session.thinkingLevel, restoredTarget);
        assert.equal(f.mode.editor.getExpandedText(), beforeReasoning.draft);
        assert.equal(f.mode.ui.getFocusedComponent(), f.mode.editor);
        assert.deepEqual(f.errors, [], 'native footer input and reload must not swallow extension errors');
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
