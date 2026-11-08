// Real SDK loader, strict guard, provider flows and approved execution. All transports are local.
// Run with the root SDK or PI_TEST_SDK_ROOT=/absolute/path/to/pi-coding-agent.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { findPackageJSON, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guardPath = resolve(root, 'packages/pi-tool-gate/src/model-guard.ts');
assert(existsSync(guardPath), `Missing model guard: ${guardPath}`);
const sdkRoot = realpathSync(process.env.PI_TEST_SDK_ROOT
  ? resolve(process.env.PI_TEST_SDK_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..'));
const sdkManifest = JSON.parse(readFileSync(resolve(sdkRoot, 'package.json'), 'utf8'));
assert.equal(sdkManifest.name, '@earendil-works/pi-coding-agent', 'PI_TEST_SDK_ROOT must be the SDK package root');
const sdkUrl = pathToFileURL(resolve(sdkRoot, 'dist/index.js'));
// Resolve every Pi dependency from the selected host, never from a component's node_modules.
function hostDependency(name) {
  // pi-ai has import-only exports, so require.resolve would use the wrong conditions.
  const manifestPath = findPackageJSON(name, sdkUrl);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, name);
  return pathToFileURL(resolve(dirname(manifestPath), manifest.exports?.['.']?.import ?? manifest.main));
}
const aiUrl = hostDependency('@earendil-works/pi-ai');
const tuiUrl = hostDependency('@earendil-works/pi-tui');
const deniedMessage = 'Linked mode chooses the model for this workflow. Use /flow independent to choose a model.';
const patchSymbol = Symbol.for('pi-plugins.linked-model-guard.v1');
const bridgeSymbol = Symbol.for('pi-plugins.test-linked-flow.fixture');
const temp = mkdtempSync(resolve(tmpdir(), 'pi-suite-linked-flow-'));
const originalCwd = process.cwd();
const originalEnv = Object.fromEntries(['HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'PI_OFFLINE',
  'PI_SUBAGENT', 'PI_TOOL_GATE_APPROVAL', 'PI_TOOL_GATE_WORKFLOW']
  .map(key => [key, process.env[key]]));
const restores = [];
const sessions = [];
const leases = new Set();
const selectors = new Set();
const networkAttempts = [];
const inferenceAttempts = [];
const bridge = { policies: new WeakMap(), records: [], onModelSelect: undefined };
let proto;
let originals;
let emitSessionShutdownEvent;
let localResponses = 0;

function replace(object, key, value) {
  const previous = object[key];
  object[key] = value;
  restores.push(() => { object[key] = previous; });
}
function forbid(kind, attempts) {
  return () => {
    attempts.push(kind);
    throw new Error(`Linked integration forbids ${kind}`);
  };
}
function deferred() {
  let resolvePromise;
  let reject;
  const promise = new Promise((resolve, rejectPromise) => { resolvePromise = resolve; reject = rejectPromise; });
  return { promise, resolve: resolvePromise, reject };
}
async function deadline(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
}
const target = model => ({ provider: model.provider, id: model.id });
const modelRef = model => `${model.provider}/${model.id}`;

try {
  process.env.HOME = temp;
  process.env.PI_CODING_AGENT_DIR = temp;
  process.env.XDG_CONFIG_HOME = resolve(temp, 'xdg');
  process.env.PI_OFFLINE = '1';
  // The SDK fixtures are top-level sessions, not children of the test runner.
  for (const key of ['PI_SUBAGENT', 'PI_TOOL_GATE_APPROVAL', 'PI_TOOL_GATE_WORKFLOW']) delete process.env[key];
  process.chdir(temp);
  // Install tripwires before importing the SDK. Offline catalogs and in-memory auth
  // are not substitutes for failing a test that accidentally tries the network.
  replace(globalThis, 'fetch', forbid('fetch', networkAttempts));
  for (const [object, key] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
    [net.Socket.prototype, 'connect'], [tls, 'connect']]) {
    replace(object, key, forbid(`network ${key}`, networkAttempts));
  }
  syncBuiltinESMExports();
  globalThis[bridgeSymbol] = bridge;

  const sdk = await import(sdkUrl.href);
  const { createAssistantMessageEventStream } = await import(aiUrl.href);
  const { getKeybindings, setKeybindings } = await import(tuiUrl.href);
  const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
  const { AuthStorage } = await import(new URL('./core/auth-storage.js', sdkUrl));
  const { getEditorTheme } = await import(new URL('./modes/interactive/theme/theme.js', sdkUrl));
  const { ModelSelectorComponent } = await import(new URL('./modes/interactive/components/model-selector.js', sdkUrl));
  ({ emitSessionShutdownEvent } = await import(new URL('./core/extensions/runner.js', sdkUrl)));
  const { AgentSession, CustomEditor, InteractiveMode, ModelRuntime, SessionManager, SettingsManager,
    createAgentSessionServices, createAgentSessionFromServices, createAgentSessionRuntime, initTheme } = sdk;
  const productionStreamSimple = ModelRuntime.prototype.streamSimple;
  proto = AgentSession.prototype;
  originals = { setModel: proto.setModel, cycleModel: proto.cycleModel, _bindExtensionCore: proto._bindExtensionCore };
  assert.equal(Object.hasOwn(proto, patchSymbol), false, 'fresh process has no guard owner');
  initTheme('dark', false);
  const previousKeys = getKeybindings();
  const keybindings = new KeybindingsManager({
    'app.model.select': 'alt+p', 'app.model.cycleForward': 'ctrl+p', 'app.model.cycleBackward': 'alt+n',
    'app.thinking.cycle': 'shift+tab',
    'tui.editor.historyPrevious': [], 'tui.editor.historyNext': [], 'app.models.save': 'ctrl+s',
  });
  setKeybindings(keybindings);
  restores.push(() => setKeybindings(previousKeys));

  // This file must pass through the selected SDK's actual TypeScript extension
  // loader. In particular, the guard's bare SDK import must be host-aliased.
  const fixturePath = resolve(temp, 'guard-fixture.ts');
  writeFileSync(fixturePath, `
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { installModelGuard } from ${JSON.stringify(guardPath)};
export default function (pi) {
  const bridge = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(bridgeSymbol))})];
  let record;
  let manager;
  const lease = installModelGuard(undefined, () => bridge.policies.get(manager));
  pi.on('session_start', (_event, ctx) => {
    manager = ctx.sessionManager;
    lease.bind(manager);
    record = { AgentSession, createAssistantMessageEventStream, manager, lease, pi,
      installModelGuard, events: [], shutdowns: 0 };
    bridge.records.push(record);
  });
  pi.on('model_select', async event => {
    record.events.push({ source: event.source, model: event.model, previousModel: event.previousModel });
    await bridge.onModelSelect?.(record, event);
  });
  pi.on('session_shutdown', () => {
    if (record) { record.shutdowns++; record.lease.dispose(); }
  });
}
`);

  // Only private, local model descriptions and dummy auth enter the runtime. The
  // SDK's auth/catalog interfaces stay real; no paid provider is ever selected.
  const provider = 'linked-local';
  const modelDefinitions = ['work', 'plan', 'worker'].map(id => ({
    id, name: `Local ${id}`, reasoning: true, input: ['text'], contextWindow: 32768, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  const modelsPath = resolve(temp, 'models.json');
  writeFileSync(modelsPath, JSON.stringify({ providers: {
    [provider]: { api: 'anthropic-messages', baseUrl: 'http://linked-test.invalid', apiKey: 'local-test-placeholder', models: modelDefinitions },
    'linked-other': { api: 'anthropic-messages', baseUrl: 'http://linked-test.invalid', apiKey: 'local-test-placeholder', models: [modelDefinitions[0]] },
  } }));
  const models = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath, allowModelNetwork: false });
  const work = models.getModel(provider, 'work');
  const plan = models.getModel(provider, 'plan');
  const worker = models.getModel(provider, 'worker');
  const otherProvider = models.getModel('linked-other', 'work');
  for (const model of [work, plan, worker, otherProvider]) assert(model, 'local model registered');
  const localModels = [work, plan, worker, otherProvider];
  // Ambient API-key environment variables must not affect unscoped cycle order.
  const getAvailableSnapshot = models.getAvailableSnapshot.bind(models);
  models.getAvailableSnapshot = () => getAvailableSnapshot().filter(model => localModels.some(local => modelRef(local) === modelRef(model)));
  let authCalls = 0;
  let authHook;
  const checkAuth = models.checkAuth.bind(models);
  models.checkAuth = async (...args) => {
    authCalls++;
    await authHook?.();
    return checkAuth(...args);
  };
  for (const method of ['stream', 'complete', 'completeSimple', 'streamDeferred', 'fetchDeferred', 'generateImages']) {
    models[method] = forbid(`inference ${method}`, inferenceAttempts);
  }
  // Only replace the final classifier transport. Effort and unrelated permission
  // questions share System 1, so count by the question contract, not total calls.
  writeFileSync(resolve(temp, 'system1.json'), JSON.stringify({ waterfall: ['jev'] }));
  const effortCalls = [];
  const otherClassifierCalls = [];
  // On this authenticated private route, boundary quota demand reaches the real
  // registry's OAuth applicability check but never a subscription endpoint. None
  // of the loaded siblings has observational quota refreshes (no footer here).
  const quotaChecks = [];
  const nativeOAuth = models.isUsingOAuth.bind(models);
  models.isUsingOAuth = provider => { quotaChecks.push(provider); return nativeOAuth(provider); };
  let effortTransport;
  const effortAnswer = model => ({ model: model.id, stopReason: 'stop', answers: {
    effort: { type: 'choice', choice: 'high', confidence: 0.4,
      probabilities: { low: 0.3, medium: 0.25, high: 0.4, xhigh: 0.05 } },
  } });
  models.classify = async (model, context, options) => {
    if (Object.keys(context.questions).length === 1 && context.questions.effort?.type === 'choice') {
      assert(['general', 'plan', 'exec'].includes(context.state.phase), 'canonical effort phase');
      const call = { model, context: structuredClone(context), options };
      effortCalls.push(call);
      if (effortTransport) return effortTransport(call);
    } else otherClassifierCalls.push({ model, context: structuredClone(context) });
    return { answers: {}, stopReason: 'error', errorMessage: 'Offline classifier fixture' };
  };
  models.streamSimple = model => {
    assert(localModels.some(local => modelRef(local) === modelRef(model)), 'only a local transport can run');
    localResponses++;
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Local fixture response.' }],
      api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); });
    return stream;
  };

  async function createFixture(name) {
    const dir = resolve(temp, name);
    mkdirSync(dir);
    const policy = { linked: false, revision: 1 };
    const manager = SessionManager.inMemory(dir);
    bridge.policies.set(manager, policy);
    const settings = SettingsManager.inMemory({ defaultProvider: provider, defaultModel: 'work', defaultThinkingLevel: 'low',
      enabledModels: [modelRef(work), modelRef(plan)], cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } });
    const services = await createAgentSessionServices({ cwd: dir, agentDir: temp, modelRuntime: models, settingsManager: settings,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [fixturePath] } });
    assert.deepEqual(services.diagnostics, [], `${name}: service diagnostics`);
    const loaded = services.resourceLoader.getExtensions();
    assert.deepEqual(loaded.errors, [], `${name}: real extension loader errors`);
    assert.deepEqual(loaded.extensions.map(extension => extension.path), [fixturePath], 'only the temporary guard fixture is loaded');
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: work,
      thinkingLevel: 'high', scopedModels: [{ model: work }, { model: plan, thinkingLevel: 'medium' }], noTools: true });
    sessions.push(session);
    const errors = [];
    await session.bindExtensions({ mode: 'rpc', onError: error => errors.push(error) });
    const record = bridge.records.at(-1);
    assertIdentity(session, record);
    leases.add(record.lease);
    assert.deepEqual(errors, []);
    // Nonempty real conversation and representative branch-local state make
    // before-mutation assertions meaningful without loading gate/plan UI code.
    manager.appendCustomEntry('test:workflow', { workflow: 'plan', approvals: 'auto' });
    await deadline(session.prompt('Populate the local guard fixture.'), 'local transport');
    return { session, manager, policy, settings, errors, record };
  }
  function assertIdentity(session, record) {
    assert.equal(record.AgentSession, AgentSession, 'fixture SDK class is the selected host export');
    assert.equal(record.createAssistantMessageEventStream, createAssistantMessageEventStream, 'fixture pi-ai is the selected host dependency');
    assert.equal(Object.getPrototypeOf(session), proto, 'real session has the exact host prototype');
    assert.equal(record.manager, session.sessionManager, 'ExtensionContext exposes the actual manager, not a proxy/copy');
    assert.equal(record.lease.available, true, 'guard supports the selected host');
    assert.equal(record.lease.pauseAvailable, true, 'guard captured the selected host session before startup');
    assert.notEqual(proto.setModel, originals.setModel, 'host setModel was patched');
    assert.notEqual(proto.cycleModel, originals.cycleModel, 'host cycleModel was patched');
    assert.equal(session.setModel, proto.setModel, 'real setter dispatch uses the shared patch');
    assert.equal(session.cycleModel, proto.cycleModel, 'real cycle dispatch uses the shared patch');
    assert(Object.hasOwn(proto, patchSymbol), 'shared guard state lives on the host prototype');
  }
  function snapshot(test) {
    return structuredClone({ model: test.session.model, thinking: test.session.thinkingLevel,
      messages: test.session.messages, entries: test.manager.getEntries(), branch: test.manager.getBranch(), leaf: test.manager.getLeafId(),
      defaults: test.settings.getGlobalSettings(), project: test.settings.getProjectSettings(), settings: test.settings.getSettings(),
      scope: test.session.scopedModels, events: test.record.events, authCalls, policy: test.policy });
  }
  async function unchanged(test, label, run) {
    const before = snapshot(test);
    const model = test.session.model;
    const result = await deadline(Promise.resolve().then(run), label);
    assert.equal(test.session.model, model, `${label}: model identity unchanged`);
    assert.deepEqual(snapshot(test), before, `${label}: no model/thinking/transcript/default/scope/auth/policy mutation`);
    return result;
  }
  async function denied(test, label, run) {
    await unchanged(test, label, () => assert.rejects(Promise.resolve().then(run), { message: deniedMessage }, label));
  }
  function acquire(test, readPolicy = () => test.policy) {
    const lease = test.record.installModelGuard(test.manager, readPolicy);
    assert(lease.available);
    leases.add(lease);
    return lease;
  }

  const subject = await createFixture('guarded');
  const control = await createFixture('control');
  control.record.lease.dispose(); // The same host prototype, but no policy for this manager.
  const wrappers = { setModel: proto.setModel, cycleModel: proto.cycleModel };
  assert.equal(localResponses, 2);
  console.log(`PASS SDK ${sdkManifest.version}: real loader, host AgentSession/pi-ai identity and manager/prototype identity (${sdkRoot})`);

  // Independent must delegate without changing arguments, return values or SDK
  // persistence semantics. Compare against an unowned real session, not a mock.
  function parityState(test) {
    return structuredClone({ model: test.session.model, thinking: test.session.thinkingLevel,
      defaults: test.settings.getGlobalSettings(), scope: test.session.scopedModels, events: test.record.events,
      records: test.manager.getEntries().filter(entry => ['model_change', 'thinking_level_change'].includes(entry.type))
        .map(({ id, parentId, timestamp, ...entry }) => entry) });
  }
  async function parity(label, run) {
    const actual = await run(subject);
    const expected = await run(control);
    assert.deepEqual(actual, expected, `${label}: independent return value`);
    assert.deepEqual(parityState(subject), parityState(control), `${label}: independent native side effects`);
  }
  await parity('setter persist=false', test => test.session.setModel(plan, { persist: false }));
  assert.equal(subject.settings.getDefaultModel(), work.id);
  await parity('setter persist=true outside scope', test => test.session.setModel(worker, { persist: true }));
  assert.equal(subject.settings.getDefaultModel(), worker.id);
  assert(subject.session.scopedModels.some(({ model }) => model.id === worker.id));
  assert(subject.settings.getEnabledModels().includes(modelRef(worker)));
  await parity('same-model native setter', async test => {
    test.session.setThinkingLevel('high');
    return test.session.setModel(worker, { persist: true });
  });
  assert.equal(subject.session.thinkingLevel, 'low', 'unguarded same-model selection really resets effort from defaults');
  for (const persist of [false, true]) for (const direction of ['forward', 'backward']) {
    await parity(`scoped cycle ${direction} persist=${persist}`, test => test.session.cycleModel(direction, { persist }));
  }
  await parity('extension pi.setModel', test => test.record.pi.setModel(work));
  assert.equal(await subject.record.pi.setModel(work), true, 'successful adapter returns true');
  await control.record.pi.setModel(work);
  for (const test of [subject, control]) test.session.setScopedModels([]);
  for (const persist of [false, true]) for (const direction of ['forward', 'backward']) {
    await parity(`available cycle ${direction} persist=${persist}`, test => test.session.cycleModel(direction, { persist }));
  }
  console.log('PASS Independent: real setter/adapter/scoped and unscoped cycles preserve native results, thinking, defaults and scope');

  // A different target, an out-of-scope target and the current model must all
  // fail before auth, records, default persistence or same-model effort reset.
  subject.policy.linked = true;
  subject.session.setThinkingLevel('high');
  subject.session.setScopedModels([{ model: work }, { model: plan }]);
  for (const persist of [false, true]) for (const model of [work, plan, worker, subject.session.model]) {
    await denied(subject, `set ${modelRef(model)} persist=${persist}`, () => subject.session.setModel(model, { persist }));
  }
  await denied(subject, 'pi.setModel must reject, not return true/false', () => subject.record.pi.setModel(plan));
  for (const scope of [[], [{ model: work }], [{ model: work }, { model: plan }]]) {
    subject.session.setScopedModels(scope);
    for (const persist of [false, true]) for (const direction of ['forward', 'backward']) {
      await denied(subject, `cycle ${direction} scope=${scope.length} persist=${persist}`, () => subject.session.cycleModel(direction, { persist }));
    }
  }
  await control.session.setModel(plan, { persist: true });
  assert.equal(control.session.model, plan, 'Linked manager must not lock an unowned manager');
  console.log('PASS Linked: same/different-model setters, pi.setModel and all cycles deny before every native side effect');

  // Run actual InteractiveMode methods and CustomEditor/ModelSelector input,
  // replacing only terminal presentation. This does not claim full TUI coverage.
  const native = Object.create(InteractiveMode.prototype);
  const uiEffects = { footer: 0, border: 0, providers: 0, status: [] };
  let notice;
  let selector;
  native.runtimeHost = { session: subject.session };
  native.ui = { requestRender() {} };
  native.footer = { invalidate() { uiEffects.footer++; } };
  native.updateEditorBorderColor = () => { uiEffects.border++; };
  native.updateAvailableProviderCount = () => { uiEffects.providers++; };
  native.maybeWarnAboutAnthropicSubscriptionAuth = async () => {};
  native.showError = message => notice.resolve({ kind: 'error', message });
  native.showStatus = message => { uiEffects.status.push(message); notice.resolve({ kind: 'status', message }); };
  native.showSelector = factory => {
    const selected = factory(() => { selected.dispose?.(); selectors.delete(selected.component); });
    assert(selected.component instanceof ModelSelectorComponent, 'native factory constructs the actual host selector');
    selector = selected.component;
    selectors.add(selector);
  };
  native.defaultEditor = new CustomEditor(native.ui, getEditorTheme(), keybindings);
  native.editor = native.defaultEditor;
  native.setupKeyHandlers();
  native.editor.setText('Draft survives native model controls.');
  async function nativeDenied(label, run) {
    notice = deferred();
    const beforeUI = structuredClone(uiEffects);
    const draft = native.editor.getText();
    await unchanged(subject, label, async () => {
      await run();
      assert.deepEqual(await deadline(notice.promise, label), { kind: 'error', message: deniedMessage });
    });
    assert.deepEqual(uiEffects, beforeUI, `${label}: no success presentation`);
    assert.equal(native.editor.getText(), draft, `${label}: draft unchanged`);
  }
  subject.session.setScopedModels([{ model: work }, { model: plan }]);
  await nativeDenied('native /model exact match', () => native.handleModelCommand(modelRef(plan)));
  await nativeDenied('native /model same model', () => native.handleModelCommand(modelRef(subject.session.model)));
  for (const [name, key] of [['forward', '\u0010'], ['backward', '\u001bn']]) {
    await nativeDenied(`native ${name} editor cycle key`, () => native.editor.handleInput(key));
  }
  for (const [name, key] of [['Enter', '\r'], ['save default', '\u0013']]) {
    await nativeDenied(`native selector ${name}`, () => {
      native.editor.handleInput('\u001bp'); // Configured app.model.select, not an extension shortcut.
      assert(selector instanceof ModelSelectorComponent);
      selector.handleInput('\u001b[B');
      selector.handleInput(key);
    });
    subject.session.setScopedModels([{ model: subject.session.model }, { model: plan }]);
    await nativeDenied(`native same-model selector ${name}`, () => {
      native.handleModelCommand('');
      selector.handleInput(key);
    });
  }
  // The same native handlers remain usable after explicitly leaving Linked.
  subject.policy.linked = false;
  async function nativeSuccess(label, run, expected) {
    notice = deferred();
    await run();
    assert.equal((await deadline(notice.promise, label)).kind, 'status', `${label}: native success`);
    assert.deepEqual(target(subject.session.model), target(expected), `${label}: selected physical model`);
  }
  const nativeDefault = subject.settings.getDefaultModel();
  await nativeSuccess('independent native /model', () => native.handleModelCommand(modelRef(plan)), plan);
  assert.equal(subject.settings.getDefaultModel(), nativeDefault, '/model does not save defaults');
  await nativeSuccess('independent native cycle key', () => native.editor.handleInput('\u0010'), work);
  await nativeSuccess('independent native selector saves default', () => {
    native.showModelSelector(plan.id);
    selector.handleInput('\u0013');
  }, plan);
  assert.equal(subject.settings.getDefaultModel(), plan.id);
  subject.policy.linked = true;
  subject.session.setThinkingLevel('high');
  const reasoningModel = subject.session.model;
  notice = deferred();
  native.editor.handleInput('\u001b[Z');
  assert.equal((await deadline(notice.promise, 'native reasoning cycle while Linked')).kind, 'status');
  assert.notEqual(subject.session.thinkingLevel, 'high', 'reasoning remains directly cyclable while Linked without the footer');
  assert.equal(subject.manager.getEntries().some(entry => entry.type === 'custom' && entry.customType === 'settings:cycle'), false,
    'a guard-only runtime leaves stock native reasoning immediate and creates no cycling journal');
  assert.equal(subject.session.model, reasoningModel);
  assert.equal(subject.policy.linked, true, 'reasoning does not unlink the flow');
  subject.session.setThinkingLevel('high');
  console.log('PASS native handlers: /model, actual editor cycle/select keys and selector Enter/Ctrl+S deny while Linked and work in Independent');

  const apply = (model, run, revision = subject.policy.revision) => subject.record.lease.apply(target(model), revision, run);
  const beforeDefaults = structuredClone(subject.settings.getGlobalSettings());
  assert.equal(await apply(plan, () => subject.record.pi.setModel(plan)), true, 'private exact-target application reaches the real adapter');
  assert.equal(subject.session.model, plan);
  assert.deepEqual(subject.settings.getGlobalSettings(), beforeDefaults, 'private nonpersisting application leaves defaults alone');
  for (const model of [work, otherProvider]) {
    await denied(subject, `permit cannot select ${modelRef(model)}`, () => apply(plan, () => subject.session.setModel(model)));
  }
  // Same id on a different provider is still a different target.
  await denied(subject, 'permit is provider-specific', () => apply(work, () => subject.session.setModel(otherProvider)));
  await denied(subject, 'stale revision', () => apply(plan, () => subject.session.setModel(plan), subject.policy.revision - 1));
  const previousRevision = subject.policy.revision;
  await apply(work, async () => {
    subject.policy.revision++;
    await denied(subject, 'revision rechecked at setter entry', () => subject.session.setModel(work));
  });
  subject.policy.revision = previousRevision;
  await apply(work, async () => {
    await denied(subject, 'cycle never borrows private permit', () => subject.session.cycleModel());
    await denied(subject, 'failed entry consumes permit', () => subject.session.setModel(work));
  });
  await apply(plan, async () => {
    await denied(subject, 'mismatched setter consumes permit', () => subject.session.setModel(work));
    await denied(subject, 'cannot retry correct target after mismatch', () => subject.session.setModel(plan));
  });
  await apply(work, async () => {
    await subject.session.setModel(work);
    await denied(subject, 'permit is single-use even for same model', () => subject.session.setModel(work));
  });
  const late = deferred();
  let lateSetter;
  assert.equal(await apply(plan, async () => {
    lateSetter = late.promise.then(() => subject.session.setModel(plan));
    return 'callback value';
  }), 'callback value', 'apply preserves callback result');
  await denied(subject, 'async descendant after callback completion', () => { late.resolve(); return lateSetter; });
  const failedCallback = deferred();
  let failedCallbackSetter;
  await assert.rejects(apply(plan, async () => {
    failedCallbackSetter = failedCallback.promise.then(() => subject.session.setModel(plan));
    throw new Error('Local callback failure');
  }), { message: 'Local callback failure' });
  await denied(subject, 'async descendant after callback rejection', () => {
    failedCallback.resolve();
    return failedCallbackSetter;
  });

  // Pause the *real* original in its asynchronous auth check. A sibling call
  // inside apply and an unrelated caller outside it cannot borrow authorization.
  const enteredAuth = deferred();
  const releaseAuth = deferred();
  authHook = async () => { enteredAuth.resolve(); await releaseAuth.promise; };
  const beforeConcurrentAuth = authCalls;
  const concurrent = apply(plan, () => Promise.allSettled([subject.session.setModel(plan), subject.session.setModel(plan)]));
  try {
    await deadline(enteredAuth.promise, 'authorized original enters auth');
    await denied(subject, 'unrelated concurrent setter', () => subject.record.pi.setModel(plan));
  } finally { releaseAuth.resolve(); authHook = undefined; }
  const outcomes = await deadline(concurrent, 'concurrent permit');
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(outcomes[1].reason.message, deniedMessage);
  assert.equal(authCalls - beforeConcurrentAuth, 1, 'only the authorized call reached SDK auth');
  assert.equal(subject.session.model, plan);

  let nestedAuth = 0;
  authHook = async () => {
    nestedAuth++;
    await denied(subject, 'nested auth callback cannot reuse permit', () => subject.session.setModel(work));
  };
  try { await apply(work, () => subject.session.setModel(work)); }
  finally { authHook = undefined; }
  assert.equal(nestedAuth, 1);
  let nestedEvent = 0;
  bridge.onModelSelect = async record => {
    if (record.manager !== subject.manager) return;
    nestedEvent++;
    await denied(subject, 'nested actual model_select callback', () => record.pi.setModel(worker));
  };
  try { await apply(plan, () => subject.session.setModel(plan)); }
  finally { bridge.onModelSelect = undefined; }
  assert.equal(nestedEvent, 1, 'nested assertion ran through the real extension event');
  console.log('PASS private apply: exact provider/id/revision, return values, consumption, expired async descendants, concurrent and nested denial');

  control.policy.linked = true;
  const controlOwner = acquire(control);
  await denied(control, 'permit is manager-specific', () => apply(worker, () => control.session.setModel(worker)));
  const extraOwner = acquire(subject);
  assert.equal(proto.setModel, wrappers.setModel, 'multiple owners share one wrapper');
  assert.equal(proto.cycleModel, wrappers.cycleModel);
  const stale = subject.record;
  const beforeReload = snapshot(subject);
  await subject.session.reload(); // Actual shutdown -> real loader -> fresh fixture/session_start.
  subject.record = bridge.records.at(-1);
  leases.add(subject.record.lease);
  assert.notEqual(subject.record, stale);
  assert.equal(stale.shutdowns, 1, 'reload called the old runtime shutdown hook');
  assert.equal(stale.lease.available, false);
  assertIdentity(subject.session, subject.record);
  assert.equal(proto.setModel, wrappers.setModel, 'surviving owner preserves shared wrapper across module reload');
  assert.deepEqual({ ...snapshot(subject), events: beforeReload.events }, beforeReload, 'reload leaves model/state/defaults/scope unchanged');
  stale.lease.dispose();
  extraOwner.dispose();
  assert.equal(subject.record.lease.available, true, 'stale cleanup does not dispose the replacement owner');
  await denied(subject, 'new runtime remains guarded after stale cleanup', () => subject.session.setModel(work));
  await denied(subject, 'old lease cannot authorize new runtime', () => stale.lease.apply(target(work), subject.policy.revision, () => subject.session.setModel(work)));
  await apply(work, () => subject.record.pi.setModel(work));
  await denied(control, 'other manager remains guarded', () => control.session.setModel(work));

  // SDK dispose() invalidates contexts; the host emits shutdown first. Exercise
  // that actual dispatcher rather than assuming dispose() emits an event itself.
  await emitSessionShutdownEvent(subject.session.extensionRunner, { type: 'session_shutdown', reason: 'exit' });
  assert.equal(subject.record.shutdowns, 1);
  assert.equal(subject.record.lease.available, false);
  assert.equal(proto.setModel, wrappers.setModel, 'another manager still owns the patch');
  control.session.setThinkingLevel('high');
  await denied(control, 'last other manager remains guarded', () => control.session.setModel(work));
  controlOwner.dispose();
  await emitSessionShutdownEvent(control.session.extensionRunner, { type: 'session_shutdown', reason: 'exit' });
  assert.equal(proto.setModel, originals.setModel, 'last owner restores original setter');
  assert.equal(proto.cycleModel, originals.cycleModel, 'last owner restores original cycle');
  assert.equal(Object.hasOwn(proto, patchSymbol), false);
  await wrappers.setModel.call(subject.session, plan, { persist: false });
  assert.equal(subject.session.model, plan, 'retained old setter wrapper becomes inert');
  assert(await wrappers.cycleModel.call(subject.session, 'forward'), 'retained old cycle wrapper becomes inert');

  // A third-party wrapper retaining our delegate must survive owner cleanup.
  const thirdPartyOwner = acquire(subject);
  const retained = proto.setModel;
  const thirdParty = async function (...args) { return retained.apply(this, args); };
  proto.setModel = thirdParty;
  try {
    thirdPartyOwner.dispose();
    assert.equal(proto.setModel, thirdParty, 'guard cleanup must not remove a later third-party wrapper');
    await subject.session.setModel(worker);
    assert.equal(subject.session.model, worker, 'third-party retained delegate is inert');
    const replacementOwner = acquire(subject);
    stale.lease.dispose();
    thirdPartyOwner.dispose();
    await denied(subject, 'stale owners cannot remove a newly installed guard', () => subject.session.setModel(plan));
    replacementOwner.dispose();
    assert.equal(proto.setModel, thirdParty);
  } finally { proto.setModel = originals.setModel; }
  console.log('PASS owners: independent managers, real reload/shutdown, stale leases, last-owner restoration and retained third-party wrappers');

  for (const test of [subject, control]) assert.deepEqual(test.errors, [], 'no swallowed extension lifecycle/event errors');
  assert.equal(localResponses, 2, 'guard scenarios made no model requests after local fixture setup');
  assert.deepEqual(networkAttempts, [], 'no attempted network access, even if an SDK path caught the error');
  assert.deepEqual(inferenceAttempts, [], 'no attempted inference');
  assert.equal(proto.setModel, originals.setModel);
  assert.equal(proto.cycleModel, originals.cycleModel);
  console.log(`PASS linked model guard integration on SDK ${sdkManifest.version}; no network/inference`);

  // Full integration below loads the production extensions, not factories that impersonate
  // role discovery or lifecycle ownership. The observer only captures the real host identity.
  const flowChannel = 'pi-plugins.workflow-flow.v1';
  const flowRecords = [];
  let reviewCalls;
  replace(ModelRuntime.prototype, 'streamSimple', (model, context) => {
    assert(reviewCalls, 'only the scripted completion reviewer may use a nested transport');
    assert.equal(modelRef(model), modelRef(plan), 'completion reviewer stays with the planning model');
    reviewCalls.push({ model: modelRef(model), messages: structuredClone(context.messages) });
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ outcome: 'accepted',
      summary: 'Local approved plan satisfied.', evidence: ['Local verification passed.'], limitations: [], findings: [] }) }],
      api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); });
    return stream;
  });
  bridge.flowRecords = flowRecords;
  const observerPath = resolve(temp, 'flow-observer.ts');
  writeFileSync(observerPath, `
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { createCustomSelectorHarness } from ${JSON.stringify(resolve(root, 'packages/pi-plan-mode/test/support.ts'))};
export default function (pi) {
  const records = globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(bridgeSymbol))})].flowRecords;
  // Earlier startup handlers can select the restored model before this observer starts.
  // Capture those events too, rather than throwing or silently dropping them.
  const record = { pi, ctx: undefined, AgentSession, createAssistantMessageEventStream, createCustomSelectorHarness,
    starts: [], models: [], roleQueries: [], workflows: [], activity: [], shutdowns: 0 };
  for (const type of ['input', 'tool_result', 'turn_end']) pi.on(type, event => {
    record.activity.push({ type, ...(type === 'tool_result' ? { isError: event.isError, toolName: event.toolName } : {}) });
  });
  pi.on('session_start', (_event, ctx) => {
    record.ctx = ctx;
    records.push(record);
  });
  pi.events.on('subagents:role-model', request => record?.roleQueries.push(structuredClone(request)));
  pi.events.on('workflow-mode:changed', event => record?.workflows.push(structuredClone(event)));
  pi.on('before_agent_start', async (event, ctx) => {
    record.starts.push({ prompt: event.prompt,
      model: ctx.model?.id, exec: ctx.sessionManager.getBranch().filter(e => e.customType === 'plan-mode:exec').at(-1)?.data,
      tools: pi.getActiveTools() });
    await record.beforeStart?.(event, ctx);
  });
  pi.on('model_select', event => record.models.push(event.model.id));
  pi.on('session_shutdown', () => { if (record) record.shutdowns++; });
}
`);
  const failures = [];
  const orderings = [
    ['tool-gate', 'subagents', 'plan-mode'], ['tool-gate', 'plan-mode', 'subagents'],
    ['subagents', 'tool-gate', 'plan-mode'], ['subagents', 'plan-mode', 'tool-gate'],
    ['plan-mode', 'tool-gate', 'subagents'], ['plan-mode', 'subagents', 'tool-gate'],
  ];
  const branchData = (current, type) => current.sessionManager.getBranch()
    .filter(entry => entry.type === 'custom' && entry.customType === type).at(-1)?.data;
  const customRecords = current => current.sessionManager.getEntries().filter(entry => entry.type === 'custom'
    && ['tool-gate:flow', 'tool-gate:workflow', 'plan-mode:inline'].includes(entry.customType));
  const visibleTransitions = current => current.sessionManager.getEntries().filter(entry => entry.type === 'custom_message'
    && entry.customType === 'workflow:transition');
  function query(record) {
    const request = { kind: 'query' };
    record.pi.events.emit(flowChannel, request);
    assert(request.snapshot, 'production gate answers synchronous flow query');
    return request.snapshot;
  }
  async function request(record, data) {
    record.pi.events.emit(flowChannel, data);
    assert(data.result instanceof Promise, `${data.kind}: result promise is attached synchronously`);
    return deadline(data.result, `flow ${data.kind}`);
  }
  async function close(current) {
    await emitSessionShutdownEvent(current.extensionRunner, { type: 'session_shutdown', reason: 'exit' });
    current.dispose();
    const index = sessions.indexOf(current);
    if (index >= 0) sessions.splice(index, 1);
  }
  function roles(dir, same, general = 'work', pins = true) {
    const agents = resolve(dir, '.pi/agents');
    mkdirSync(agents, { recursive: true });
    for (const [role, id, effort] of [['general', general, 'low'], ['planner', 'plan', 'high'], ['worker', same ? 'plan' : 'worker', 'medium']]) {
      writeFileSync(resolve(agents, `${role}.md`), `---\nname: ${role}\ndescription: Local ${role}\nmodels:\n  ${provider}: ${provider}/${id}${pins ? `:${effort}` : ''}\n  linked-other: linked-other/work${pins ? `:${effort}` : ''}\n---\nLocal role fixture.\n`);
    }
  }
  async function flowFixture(label, names, { same = false, general = 'work', pins = true, seed, tui = false, nativeTui = false, compaction, newSession, review = false, planShortcut } = {}) {
    const dir = resolve(temp, label);
    mkdirSync(dir, { recursive: true });
    process.chdir(dir);
    roles(dir, same, general, pins);
    writeFileSync(resolve(temp, 'tool-gate.json'), JSON.stringify({ defaultApproval: 'auto' }));
    writeFileSync(resolve(temp, 'subagents.json'), JSON.stringify({ jev: { enabled: false }, widget: 'off', fleetView: false }));
    writeFileSync(resolve(temp, 'pi-plan-mode.json'), JSON.stringify({
      thinkingLevel: 'inherit', plansDirectory: resolve(dir, 'plans'), completionReview: review,
      renderedPlans: false, jevToolSelection: false, ...(planShortcut ? { toggleShortcut: planShortcut } : {}),
    }));
    const test = { dir, names, same, notes: [], errors: [], dialogs: [], choices: [], requests: [], script: [], statuses: new Map(), generations: [] };
    const create = async ({ sessionManager, sessionStartEvent }) => {
      const settings = SettingsManager.inMemory({ defaultProvider: provider, defaultModel: work.id, defaultThinkingLevel: 'off',
        cacheWarming: 'off', compaction: compaction ?? { enabled: false }, retry: { enabled: false } });
      const services = await createAgentSessionServices({ cwd: dir, agentDir: temp, modelRuntime: models, settingsManager: settings,
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: [...names.map(name => resolve(root, `packages/pi-${name}/src/index.ts`)), observerPath] } });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, [], label);
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: work, thinkingLevel: 'off' });
      const current = result.session;
      sessions.push(current);
      test.generations.push(current);
      test.nativeStream = current.agent.streamFunction;
      current.agent.streamFunction = (model, context) => {
        assert(localModels.some(local => modelRef(local) === modelRef(model)), 'real agent uses only local physical models');
        const call = { model: model.id, provider: model.provider, messages: structuredClone(context.messages), current };
        test.requests.push(call);
        const stream = createAssistantMessageEventStream();
        const next = test.script.shift();
        const value = typeof next === 'function' ? next(call) : next;
        const content = value?.name ? [{ type: 'toolCall', id: value.id, name: value.name, arguments: value.args ?? {} }]
          : [{ type: 'text', text: value?.text ?? `Local response ${label}.` }];
        const reason = value?.name ? 'toolUse' : 'stop';
        const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          stopReason: reason, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        const send = () => { stream.push({ type: 'done', reason, message }); stream.end(message); };
        if (value?.wait) value.wait.then(send); else queueMicrotask(send);
        return stream;
      };
      test.settings = settings;
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const manager = SessionManager.inMemory(dir);
    seed?.(manager, dir);
    test.runtime = await createAgentSessionRuntime(create, { cwd: dir, agentDir: temp, sessionManager: manager });
    const ui = new Proxy({
      // The SDK copies known UI properties; Proxy fallback methods are not enumerable.
      setWidget() {},
      onTerminalInput() { return () => {}; },
      setStatus(key, value) { if (value === undefined) test.statuses.delete(key); else test.statuses.set(key, value); },
      notify(message) { test.notes.push(message); },
      async select(title, options) {
        test.dialogs.push({ title, options: [...options] });
        const choice = test.choices.shift();
        if (typeof choice === 'function') return choice(title, options);
        assert(choice === undefined || options.includes(choice), `Missing choice ${choice}: ${options}`);
        return choice;
      },
      custom(factory) {
        test.harness = test.record.createCustomSelectorHarness(factory, 140, undefined, 40);
        return test.harness.resultPromise;
      },
    }, { get: (object, key) => key in object ? object[key] : () => {} });
    const bind = async current => {
      if (nativeTui) {
        // Actual native binding and abort/queue/editor methods; only terminal
        // presentation is substituted. In particular no mock ctx.abort handler.
        const mode = Object.create(InteractiveMode.prototype);
        mode.runtimeHost = test.runtime;
        mode.ui = { requestRender() {} };
        mode.keybindings = keybindings;
        mode.defaultEditor = new CustomEditor(mode.ui, getEditorTheme(), keybindings);
        mode.editor = mode.defaultEditor;
        mode.editor.setText('Keep this unsent native draft.');
        mode.compactionQueuedMessages = [];
        mode.pendingMessagesContainer = { clear() {}, addChild() {} };
        mode.createExtensionUIContext = () => ui;
        for (const name of ['setupAutocompleteProvider', 'showLoadedResources', 'showStartupNoticesIfNeeded']) mode[name] = () => {};
        mode.showExtensionError = (path, error) => test.errors.push({ path, error });
        await mode.bindCurrentSessionExtensions();
        test.nativeMode = mode;
      } else await current.bindExtensions({ mode: tui ? 'tui' : 'rpc', uiContext: ui, onError: error => test.errors.push(error),
        commandContextActions: {
          waitForIdle: () => current.waitForIdle(),
          newSession: async options => {
            test.parentEntries = structuredClone(current.sessionManager.getEntries());
            const result = await test.runtime.newSession(options);
            newSession?.(result);
            return result;
          },
        } });
      test.record = flowRecords.at(-1);
      assert.equal(test.record.AgentSession, AgentSession, 'production loader shares the selected SDK class');
      assert.equal(test.record.createAssistantMessageEventStream, createAssistantMessageEventStream, 'production loader shares selected pi-ai');
      assert.equal(test.record.ctx.sessionManager, current.sessionManager);
      assert.equal(Object.getPrototypeOf(current), proto);
    };
    test.runtime.setRebindSession(bind);
    await bind(test.runtime.session);
    test.current = () => test.runtime.session;
    test.flow = () => query(test.record);
    test.exec = () => branchData(test.current(), 'plan-mode:exec');
    test.command = command => deadline(test.current().prompt(command), `${label} ${command}`);
    test.turn = text => deadline(test.current().prompt(text), `${label} ${text}`);
    test.call = async (name, args = {}) => {
      const id = `${label}-${test.requests.length}-${name}`;
      test.script.push({ id, name, args });
      await test.turn(`Local integration: ${name}`);
      const result = test.current().sessionManager.getEntries().filter(entry => entry.type === 'message')
        .map(entry => entry.message).find(message => message.role === 'toolResult' && message.toolCallId === id);
      assert(result, `${name} executes through actual AgentSession`);
      return result;
    };
    test.reload = async () => {
      const records = structuredClone(customRecords(test.current()));
      const transitions = structuredClone(visibleTransitions(test.current()));
      const old = test.record;
      await test.current().reload();
      test.record = flowRecords.at(-1);
      assert.notEqual(test.record, old, 'reload replaces the actual extension runtime');
      assert.equal(old.shutdowns, 1);
      assert.deepEqual(customRecords(test.current()), records, 'reload does not persist flow/workflow/inline restoration');
      assert.deepEqual(visibleTransitions(test.current()), transitions, 'reload adds no live workflow markers');
    };
    test.go = async id => {
      const records = structuredClone(customRecords(test.current()));
      const transitions = structuredClone(visibleTransitions(test.current()));
      assert.equal((await test.current().navigateTree(id, { summarize: false })).cancelled, false);
      assert.deepEqual(customRecords(test.current()), records, 'tree reconstruction appends no workflow/flow/inline records');
      assert.deepEqual(visibleTransitions(test.current()), transitions, 'tree reconstruction is not a live transition');
    };
    test.dispose = async () => { for (const current of test.generations) if (sessions.includes(current)) await close(current); };
    return test;
  }
  async function scenario(label, run) {
    try { await run(); console.log(`PASS actual Pi linked flow: ${label}`); }
    catch (error) { failures.push(error); console.error(`FAIL actual Pi linked flow: ${label}: ${error.stack}`); }
    finally { authHook = undefined; effortTransport = undefined; }
  }

  // Real input/agent/tool/turn events must not become task-admission boundaries.
  // Run both extension orders and both distinct and same physical phase models.
  for (const names of [orderings[0], orderings.at(-1)]) for (const general of ['work', 'plan']) {
    const label = `boundary-effort-${names.join('+')}-${general}`;
    await scenario(label, async () => {
      const test = await flowFixture(label, names, { general, pins: false });
      const current = test.current();
      const writes = [];
      const nativeThinking = current.setThinkingLevel;
      current.setThinkingLevel = function (level, ...args) {
        writes.push(level);
        return nativeThinking.call(this, level, ...args);
      };
      const entries = () => current.sessionManager.getBranch().filter(entry => entry.customType === 'tool-gate:phase-effort');
      const state = () => ({ calls: effortCalls.length, quotaChecks: quotaChecks.length,
        writes: [...writes], entries: structuredClone(entries()), thinking: current.thinkingLevel });
      const unchangedEffort = async (label, run) => {
        const before = state();
        await run();
        assert.deepEqual(state(), before, `${label}: no effort classifier, quota demand, setter or boundary entry`);
      };
      try {
        await unchangedEffort('ordinary Independent input', () => test.turn('Investigate the parser and design a focused fix.'));
        effortTransport = ({ model }) => effortAnswer(model);
        const beforeSelection = effortCalls.length;
        const quotaBeforeSelection = quotaChecks.length;
        await test.command('/flow linked');
        assert.equal(test.flow().operatingMode, 'linked');
        assert.equal(current.model.id, general, 'assigned General model is preserved');
        assert.equal(effortCalls.length, beforeSelection + 1, 'explicit selection judges General once');
        assert.equal(quotaChecks.length, quotaBeforeSelection + 1, 'selection demand-reads target pressure once');
        assert.equal(current.thinkingLevel, 'medium', 'cumulative theta=0.5 wins, not argmax high');
        assert.equal(entries().at(-1).data.phase, 'general');
        assert.equal(entries().at(-1).data.source, 'system1');
        assert.equal(entries().at(-1).data.requested, 'medium');
        assert.equal(entries().at(-1).data.effective, 'medium');
        assert.equal(entries().at(-1).data.pressure.state, 'not-applicable', 'private route is not healthy/unlimited quota');
        assert.equal(entries().at(-1).data.classifier.provider, 'typesafe');
        assert.equal(entries().at(-1).data.classifier.model, 'jev-latest');
        current.setThinkingLevel('high'); // Real unowned SDK event, seen by both extensions.
        await test.command('/approvals yolo');
        await unchangedEffort('General messages and same-model reconciliation', async () => {
          for (const mode of ['chat', 'work', 'work']) await test.command(`/mode ${mode}`);
          await test.turn('Now solve a genuinely hard problem, not an acknowledgement.');
          const failed = await test.call('read', { path: resolve(test.dir, 'missing-effort-regression.txt') });
          assert.equal(failed.isError, true, 'a real failed tool result crosses the lifecycle');
          await test.turn('Retry the investigation after that tool error.');
          // Exercise the actual before-agent-start handler independently as well.
          await current.extensionRunner.emit({ type: 'before_agent_start', prompt: 'Probe reconciliation', systemPrompt: '' });
        });
        assert(test.record.activity.some(event => event.type === 'input'));
        assert(test.record.starts.length >= 3, 'real prompts dispatched before_agent_start');
        assert(test.record.activity.some(event => event.type === 'tool_result' && event.isError));
        assert(test.record.activity.some(event => event.type === 'turn_end'));
        const beforePlan = effortCalls.length;
        await test.command('/plan');
        assert.equal(test.flow().workflow, 'plan');
        assert.equal(current.model.id, 'plan', 'Plan keeps its durable model even when General shares it');
        assert.equal(effortCalls.length, beforePlan + 1, 'genuine General → Plan calibrates once, even on the same model');
        assert.equal(current.thinkingLevel, 'medium', 'later phase may replace a manual General choice');
        assert.equal(entries().at(-1).data.phase, 'plan');
        current.setThinkingLevel('high');
        const planLeaf = current.sessionManager.appendCustomEntry('test:effort-plan', {});
        await unchangedEffort('Plan routine input and restore', async () => {
          await test.turn('Continue investigating without crossing a phase boundary.');
          await test.reload();
          await test.turn('Resume the existing Plan after reload.');
        });
        const beforeTree = { calls: effortCalls.length, quota: quotaChecks.length };
        await test.go(planLeaf);
        assert.deepEqual({ calls: effortCalls.length, quota: quotaChecks.length }, beforeTree,
          'tree restore never reclassifies or reads pressure');
        assert.equal(current.thinkingLevel, 'high', 'native saved effort is restoration authority');
        const planFile = branchData(current, 'plan-mode:inline').planFile;
        writeFileSync(planFile, '# Effort integration plan\n\nImplement the focused parser fix.\n');
        const beforeApproval = effortCalls.length;
        test.choices.push('Approve and implement', 'low');
        await test.call('exit_plan_mode');
        assert.equal(test.flow().workflow, 'exec');
        assert.equal(current.model.id, 'worker');
        assert.equal(effortCalls.length, beforeApproval + 1, 'approval judges once; coordinator does not reclassify Exec');
        assert.equal(current.thinkingLevel, 'low', 'manual approval overrides the automatic default');
        assert.equal(entries().at(-1).data.phase, 'exec');
        assert.equal(entries().at(-1).data.source, 'manual');
        assert.equal(entries().at(-1).data.requested, 'low');
        await unchangedEffort('approved Exec continuation and reload', async () => {
          await test.turn('Continue the approved implementation.');
          await test.reload();
          await test.turn('Resume the same execution.');
        });
        const beforeReplan = effortCalls.length;
        await test.command('/plan');
        assert.equal(effortCalls.length, beforeReplan + 1, 'explicit replan is another Plan boundary');
        assert.equal(current.thinkingLevel, 'medium');
        const draft = test.exec().replanning.draftFile;
        writeFileSync(draft, '# Revised effort plan\n\nImplement the revised fix.\n');
        const beforeResume = effortCalls.length;
        test.choices.push('Approve and implement', 'high');
        await test.call('exit_plan_mode');
        assert.equal(effortCalls.length, beforeResume + 1, 'reapproval judges the revised plan once, not again at resume');
        assert.equal(current.thinkingLevel, 'high');
        assert.equal(entries().at(-1).data.source, 'manual');
        assert.deepEqual(test.errors, []);
      } finally { current.setThinkingLevel = nativeThinking; await test.dispose(); }
    });
  }

  await scenario('manual native effort cancels a pending cross-extension phase judgment', async () => {
    const test = await flowFixture('manual-phase-effort-race', orderings[3], { pins: false });
    const entered = deferred();
    const release = deferred();
    let selecting;
    try {
      await test.turn('Investigate a parser bug and design its fix.');
      effortTransport = ({ model }) => effortAnswer(model);
      await test.command('/flow linked');
      const current = test.current();
      const entries = structuredClone(customRecords(current));
      const before = effortCalls.length;
      effortTransport = async ({ model }) => { entered.resolve(); await release.promise; return effortAnswer(model); };
      selecting = test.command('/plan');
      await deadline(entered.promise, 'pending Plan effort transport');
      const call = effortCalls.at(-1);
      current.setThinkingLevel('high');
      await deadline(selecting, 'manual choice cancels Plan without waiting for classifier');
      assert.equal(call.options.signal.aborted, true, 'unowned SDK effort event aborts pending inference');
      release.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(effortCalls.length, before + 1);
      assert.equal(test.flow().workflow, 'work', 'cancelled preparation commits no phase');
      assert.equal(current.model.id, 'work');
      assert.equal(current.thinkingLevel, 'high', 'late answer cannot overwrite manual effort');
      assert.deepEqual(customRecords(current), entries);
      effortTransport = ({ model }) => effortAnswer(model);
      await test.command('/plan');
      assert.equal(test.flow().workflow, 'plan', 'a later explicit boundary is not permanently pinned');
      assert.equal(current.thinkingLevel, 'medium');
      assert.deepEqual(test.errors, []);
    } finally { release.resolve(); await selecting; await test.dispose(); }
  });

  await scenario('TUI cycles share settlement; explicit commands and Linked role commits stay authoritative', async () => {
    const test = await flowFixture('settings-cycle-settlement', orderings[3], { tui: true, planShortcut: 'alt+o' });
    try {
      await test.command(`/flow linked ${provider}`);
      const current = test.current();
      const entries = () => current.sessionManager.getBranch();
      const anchors = () => entries().filter(entry => entry.type === 'custom' && entry.customType === 'settings:cycle');
      const cycle = channel => {
        const request = { userInitiated: true };
        test.record.pi.events.emit(channel, request);
        assert.ok(request.result instanceof Promise, 'cycle result is attached synchronously, not merely scheduled');
        return request.result;
      };
      const effective = structuredClone(test.flow());
      const records = structuredClone(customRecords(current));
      const modelsBefore = test.record.models.length;
      const workflowsBefore = test.record.workflows.length;
      const transitionsBefore = visibleTransitions(current).length;
      const first = cycle('workflow-mode:cycle');
      const second = cycle('workflow-mode:cycle');
      const approvals = cycle('permission-mode:cycle');
      assert.deepEqual(test.flow(), effective, 'flow queries continue reporting committed Work, not pending Plan');
      assert.equal(current.model.id, 'work', 'preview does not activate a Linked planner');
      assert.deepEqual(customRecords(current), records, 'preview does not persist ordinary workflow/inline/flow state');
      assert.equal(test.record.models.length, modelsBefore);
      assert.equal(test.record.workflows.length, workflowsBefore);
      assert.equal(anchors().length, 1, 'mixed owner previews share one UI-only anchor');
      assert.match(test.statuses.get('permission-mode'), /auto/u, 'pending relaxed approvals are not already protection');
      assert.deepEqual(await deadline(Promise.all([first, second, approvals]), 'shared cycle settlement'), [true, true, true]);
      assert.equal(test.flow().workflow, 'plan');
      assert.equal(current.model.id, 'plan');
      assert.equal(test.record.models.length, modelsBefore + 1, 'one final Linked role activation');
      assert.equal(test.record.workflows.length, workflowsBefore + 1, 'one final workflow publication');
      assert.equal(visibleTransitions(current).length, transitionsBefore, 'journal replaces legacy cycle transition markers');
      assert.match(test.statuses.get('permission-mode'), /yolo/u);
      const originalAnchor = structuredClone(anchors()[0]);
      const firstRow = originalAnchor.data.id;
      // Five completed workflow batches, including pauses beyond the fallback,
      // must edit one journal-backed line while each batch really activates its role.
      for (const target of ['work', 'plan', 'work', 'plan']) {
        await new Promise(resolve => setTimeout(resolve, 1050));
        const before = { models: test.record.models.length, workflows: test.record.workflows.length,
          records: structuredClone(entries()) };
        const batch = [cycle('workflow-mode:cycle')];
        if (target === 'plan') batch.push(cycle('workflow-mode:cycle'));
        assert.equal(current.model.id, target === 'plan' ? 'work' : 'plan', 'the previous role stays effective throughout preview');
        assert.deepEqual(await deadline(Promise.all(batch), `completed ${target} batch`), batch.map(() => true));
        assert.equal(test.flow().workflow, target);
        assert.equal(current.model.id, target, 'each completed batch activates only its final role model');
        assert.equal(test.record.models.length, before.models + 1, 'no intermediate Linked role activation');
        assert.equal(test.record.workflows.length, before.workflows + 1);
        assert.equal(anchors().length, 1, 'consecutive completed batches retain one visible journal anchor');
        assert.deepEqual(anchors()[0], originalAnchor, 'the original native anchor record is append-only and immutable');
        assert.deepEqual(entries().slice(0, before.records.length), before.records, 'later batches never rewrite earlier records');
        const latest = entries().filter(entry => entry.customType === 'settings:cycle-state').at(-1).data;
        assert.equal(latest.id, firstRow);
        assert.equal(latest.phase, 'applied');
        assert.equal(latest.settings.find(item => item.key === 'workflow').target, target, 'history shows this batch, not a cumulative baseline');
      }
      assert.doesNotMatch(JSON.stringify(current.sessionManager.buildSessionContext().messages), /settings:cycle|Settings pending/u,
        'neither the reused visible anchor nor hidden snapshots enter model context');

      await test.command('/mode work');
      assert.equal(test.flow().workflow, 'work', 'explicit /mode remains immediate');
      await test.command('/approvals auto');
      assert.match(test.statuses.get('permission-mode'), /auto/u, 'explicit approvals remain immediate');
      const shortcuts = current.extensionRunner.getShortcuts(keybindings.getResolvedBindings());
      assert.ok(shortcuts.has('alt+o'), 'configured Plan key is registered');
      const anchorsBeforeForward = anchors().length;
      const forwarded = shortcuts.get('alt+o').handler(current.extensionRunner.createContext());
      assert.equal(test.flow().workflow, 'work', 'forwarded Plan shortcut only previews');
      await deadline(forwarded, 'forwarded Plan settlement');
      assert.equal(test.flow().workflow, 'chat', 'forwarded Plan callback awaits the real final settlement');
      assert.equal(anchors().length, anchorsBeforeForward + 1, 'forwarded Plan key adds no separate timer or anchor');
      await test.command('/mode work');
      const noOp = structuredClone({ records: customRecords(current), flow: test.flow(),
        models: test.record.models, workflows: test.record.workflows });
      const roundTrip = [cycle('workflow-mode:cycle'), cycle('workflow-mode:cycle'), cycle('workflow-mode:cycle')];
      assert.deepEqual(await deadline(Promise.all(roundTrip), 'round-trip cycle'), [true, true, true]);
      assert.deepEqual({ records: customRecords(current), flow: test.flow(), models: test.record.models,
        workflows: test.record.workflows }, noOp, 'round trip invokes no model setter, workflow event or ordinary persistence');
      assert.equal(entries().filter(entry => entry.customType === 'settings:cycle-state').at(-1).data.phase, 'unchanged');
      const unchangedRow = anchors().at(-1).data.id;
      const beforeUnchanged = anchors().length;
      const unchangedAgain = [cycle('workflow-mode:cycle'), cycle('workflow-mode:cycle'), cycle('workflow-mode:cycle')];
      assert.deepEqual(await deadline(Promise.all(unchangedAgain), 'second unchanged batch'), [true, true, true]);
      assert.equal(anchors().length, beforeUnchanged, 'completed no-op batches reuse the row without allocating a visible anchor');
      assert.equal(entries().filter(entry => entry.customType === 'settings:cycle-state').at(-1).data.id, unchangedRow);
      assert.deepEqual({ records: customRecords(current), flow: test.flow(), models: test.record.models,
        workflows: test.record.workflows }, noOp, 'repeated no-op allocates no role/model/workflow state');

      // An entered failing Linked role setter must not allow a later permission relaxation.
      authHook = async () => { throw new Error('Local final role activation refused'); };
      const failed = [cycle('workflow-mode:cycle'), cycle('workflow-mode:cycle'), cycle('permission-mode:cycle')];
      assert.deepEqual(await deadline(Promise.all(failed), 'failed role cycle'), [false, false, false]);
      assert.match(test.statuses.get('permission-mode'), /auto/u, 'failed role activation never relaxes approvals');
      assert.deepEqual(test.errors, []);
    } finally { authHook = undefined; await test.dispose(); }
  });

  for (const names of orderings) for (const same of [false, true]) {
    const label = `${names.join('+')}-${same ? 'same-model' : 'distinct-worker'}`;
    await scenario(label, async () => {
      const test = await flowFixture(label, names, { same, planShortcut: 'alt+o' });
      try {
        const current = test.current();
        const manager = current.sessionManager;
        const check = (mode, id, operatingMode = 'linked') => {
          const flow = test.flow();
          assert.equal(flow.operatingMode, operatingMode);
          assert.equal(flow.workflow, mode);
          assert.equal(flow.blocked, undefined);
          assert.equal(flow.transitioning, false);
          assert.equal(current.model.id, id);
          assert.equal(current.model.provider, provider);
          assert.deepEqual(test.errors, []);
        };
        check('work', 'work', 'independent');
        assert.equal(branchData(current, 'tool-gate:flow'), undefined, 'old/empty histories default to Independent without writing');
        await test.command('/mode plan');
        check('plan', 'work', 'independent');
        const pinnedCalls = { calls: effortCalls.length, quota: quotaChecks.length };
        await test.command('/flow linked');
        check('plan', 'plan');
        assert.equal(current.thinkingLevel, 'high', 'initial activation applies destination role suggestion');
        const initial = structuredClone(test.flow().selectedFlow);
        assert(Object.values(initial.roles).every(role => role.thinkingPinned === true), 'authored role effort provenance survives discovery');
        assert.deepEqual(initial.roles.work, initial.roles.chat);
        assert.deepEqual(Object.fromEntries(Object.entries(initial.roles).map(([phase, role]) => [phase, role.modelId])),
          { work: 'work', chat: 'work', plan: 'plan', exec: same ? 'plan' : 'worker' });
        const preserved = { model: current.model, thinking: current.thinkingLevel, workflow: test.flow().workflow,
          approvals: test.statuses.get('permission-mode') };
        await test.command('/flow independent');
        assert.deepEqual({ model: current.model, thinking: current.thinkingLevel, workflow: test.flow().workflow,
          approvals: test.statuses.get('permission-mode') }, preserved, 'unlink changes no other axis');
        await test.command('/flow linked');
        current.setThinkingLevel('medium');
        // SDK setters dispatch effort events asynchronously. Let this completed
        // manual choice settle before requesting a later (non-racing) boundary.
        await new Promise(resolve => setImmediate(resolve));
        for (const mode of ['chat', 'plan', 'work']) {
          const result = await request(test.record, { kind: 'workflow', workflow: mode });
          assert.equal(result.ok, true, result.error);
          check(mode, initial.roles[mode].modelId);
          assert.equal(current.thinkingLevel, initial.roles[mode].suggestedThinking,
            'a genuine phase boundary applies authored effort pins rather than carrying current effort');
        }
        assert.deepEqual({ calls: effortCalls.length, quota: quotaChecks.length }, pinnedCalls,
          'authored pins skip effort classification and quota demand at selection and phase boundaries');
        await test.command('/flow');
        assert.deepEqual(test.dialogs.at(-1), { title: 'Operating mode', options: ['Independent', 'Linked · linked-local', 'Linked · linked-other'] });
        await test.command('/mode');
        assert(test.dialogs.at(-1).options.includes('Change provider...'));
        assert(test.dialogs.at(-1).options.includes('Use Independent mode'));
        assert(!test.dialogs.at(-1).options.some(option => /exec/iu.test(option)), 'base picker never launches Exec');
        await test.command('/approvals yolo');
        const approvals = test.statuses.get('permission-mode');
        await test.command('/flow linked linked-other');
        assert.equal(test.flow().workflow, 'work');
        assert.equal(current.model.provider, 'linked-other');
        await test.command('/flow linked linked-local');
        assert.equal(test.statuses.get('permission-mode'), approvals);
        check('work', 'work');
        const workLeaf = manager.appendCustomEntry('test:linked-work', {});

        // These are production guard leases, not the artificial policy used in the baseline.
        const stable = () => structuredClone({ flow: test.flow(), model: current.model, thinking: current.thinkingLevel,
          entries: manager.getEntries(), defaults: test.settings.getGlobalSettings(), scope: current.scopedModels });
        const beforeDenied = stable();
        for (const run of [() => current.setModel(plan, { persist: true }), () => current.setModel(current.model),
          () => test.record.pi.setModel(worker), () => current.cycleModel('forward', { persist: true })]) {
          await assert.rejects(run(), { message: deniedMessage });
          assert.deepEqual(stable(), beforeDenied, 'unprivileged paths cannot mutate the linked tuple');
        }
        const busyStarted = deferred();
        const releaseTurn = deferred();
        test.script.push(() => { busyStarted.resolve(); return { wait: releaseTurn.promise }; });
        const busy = test.turn('Hold the local transport open.');
        await deadline(Promise.race([busyStarted.promise, busy.then(() => {
          throw new Error(`Busy fixture settled before transport: ${JSON.stringify(current.messages.slice(-2))}; ${test.notes.join('; ')}`);
        })]), 'busy turn');
        try {
          await test.command('/flow linked linked-other');
          await test.command('/flow independent');
          await test.command('/mode plan');
          check('work', 'work');
          assert(test.notes.some(note => note.includes('Wait for the current turn before changing the linked flow.')));
        } finally { releaseTurn.resolve(); await busy; }

        // A model-owned enter_plan_mode crosses the awaited mid-turn boundary. Pause the
        // real SDK auth await to prove branch navigation is canceled before it can write.
        const entered = deferred();
        const release = deferred();
        authHook = async () => { entered.resolve(); await release.promise; };
        const beforeEntry = test.requests.length;
        const entering = test.call('enter_plan_mode');
        await deadline(entered.promise, 'tool-owned plan model activation');
        try {
          assert.equal(test.flow().workflow, 'work', 'workflow is not committed before model activation');
          await assert.rejects(current.navigateTree(workLeaf, { summarize: false }), /current response/u,
            'native tree rejects a running turn before extension hooks');
          const treeResult = await current.extensionRunner.emit({ type: 'session_before_tree', targetId: workLeaf });
          assert.equal(treeResult?.cancel, true, 'gate also fences the tree lifecycle while activation awaits auth');
          const switchResult = await current.extensionRunner.emit({ type: 'session_before_switch', reason: 'new' });
          assert.equal(switchResult?.cancel, true, 'session replacement is canceled during model activation');
        } finally { release.resolve(); authHook = undefined; }
        const enteredResult = await entering;
        assert.match(JSON.stringify(enteredResult.content), /Entered plan mode/u);
        check('plan', 'plan');
        assert.deepEqual(test.requests.slice(beforeEntry).map(call => call.model), ['work', 'plan'], 'first continuation waits for Plan');
        const planFile = branchData(current, 'plan-mode:inline').planFile;
        const planText = `# Linked approved plan\n\nImplement ${label} locally.\n`;
        writeFileSync(planFile, planText);
        const planLeaf = manager.appendCustomEntry('test:linked-plan', {});
        const revision = test.flow().revision;
        let committed = false;
        const stale = await request(test.record, { kind: 'execution', phase: 'begin', expectedRevision: revision - 1,
          planFile, commit() { committed = true; } });
        assert.equal(stale.ok, false);
        assert.equal(committed, false, 'stale approvals cannot commit execution');

        const beforeHandoff = test.requests.length;
        const modelEvents = test.record.models.length;
        const transitions = visibleTransitions(current).length;
        test.choices.push((title, options) => {
          assert.match(title, /Linked worker:/u);
          assert(title.includes(`${provider}/${same ? 'plan' : 'worker'}`));
          assert.deepEqual(options, ['Approve and implement', 'Context: Keep history', 'Edit the plan', 'Save for later', 'No, keep planning']);
          assert.match(title, /Context: Keep history\. Effort:/u, 'worker, context and effort belong in the question');
          assert(options.some(option => /save/iu.test(option)) && options.some(option => /edit/iu.test(option)));
          assert(!options.some(option => /implement here|hand off to/iu.test(option)), 'no free-model implementation choices');
          return 'Approve and implement';
        }, 'medium');
        const approved = await test.call('exit_plan_mode');
        assert.equal(approved.details?.outcome, 'handoff', JSON.stringify(approved));
        check('exec', same ? 'plan' : 'worker');
        assert.equal(test.exec().active, true, 'same physical model is still explicit approved Exec');
        assert.equal(test.exec().planFile, approved.details.planFile);
        assert.equal(readFileSync(test.exec().planFile, 'utf8'), planText);
        assert.deepEqual(test.exec().linkedFlow.selectedFlow, test.flow().selectedFlow);
        assert(current.getActiveToolNames().includes('finish_plan'));
        assert.deepEqual(test.requests.slice(beforeHandoff).map(call => call.model), ['plan', same ? 'plan' : 'worker']);
        assert.deepEqual(test.record.models.slice(modelEvents), same ? [] : ['worker'], 'Plan → Exec never visits Work');
        assert.deepEqual(visibleTransitions(current).slice(transitions).map(entry => entry.details),
          [{ version: 1, previous: 'plan', mode: 'exec' }]);
        assert(test.requests.at(-1).messages.some(message => message.role === 'toolResult' && message.toolCallId === approved.toolCallId));
        assert.equal(manager.getEntries().some(entry => entry.type === 'compaction'), false, 'keep does not compact');
        const execLeaf = manager.appendCustomEntry('test:linked-exec', {});
        const beforeExecControls = stable();
        await test.command('/flow linked linked-other');
        await test.command('/mode work');
        assert.deepEqual(stable(), beforeExecControls, 'provider/work commands cannot leave active Exec');
        await test.command('/mode');
        assert.deepEqual(test.dialogs.at(-1).options, ['Revisit plan', 'Execution status', 'Use Independent mode']);
        // Every public re-entry path reaches the registered planner owner. Reapproval
        // resumes the same durable task, even when planner and worker are identical.
        const workingFile = resolve(test.dir, 'unfinished.txt');
        writeFileSync(workingFile, 'Preserve unfinished implementation.\n');
        const originalExecution = structuredClone(test.exec());
        const implementationStarted = deferred();
        const releaseImplementation = deferred();
        test.script.push(() => { implementationStarted.resolve(); return { wait: releaseImplementation.promise }; });
        const implementing = test.turn('Hold implementation while a user requests Plan.');
        await deadline(implementationStarted.promise, 'busy implementation');
        try {
          const beforeBusyReplan = structuredClone(test.exec());
          for (const command of ['/plan', '/mode plan']) await test.command(command);
          check('exec', same ? 'plan' : 'worker');
          assert.deepEqual(test.exec(), beforeBusyReplan, 'busy replan cannot stage or suspend a task');
          assert(test.notes.some(note => note.includes('Implementation is running. Interrupt it, then revisit the plan.')));
        } finally { releaseImplementation.resolve(); await implementing; }
        check('exec', same ? 'plan' : 'worker');
        for (const [index, control] of ['/plan', '/mode plan', 'shortcut', 'menu'].entries()) {
          const approvedFile = test.exec().planFile;
          const approvedText = readFileSync(approvedFile, 'utf8');
          const beforeReplan = test.requests.length;
          const transitionsBeforeReplan = visibleTransitions(current).length;
          if (control === 'shortcut') {
            const shortcuts = current.extensionRunner.getShortcuts(keybindings.getResolvedBindings());
            assert.ok(shortcuts.has('alt+o'), 'configured Plan shortcut is actually registered');
            await deadline(shortcuts.get('alt+o').handler(current.extensionRunner.createContext()), 'revisit shortcut');
          } else if (control === 'menu') {
            test.choices.push('Revisit plan');
            await test.command('/mode');
          } else await test.command(control);
          check('plan', 'plan');
          assert.equal(test.requests.length, beforeReplan, `${control}: command-only replan makes no model request`);
          assert.equal(test.flow().replanning, true);
          assert.equal(test.exec().active, true, 'effective Plan still owns an unfinished execution');
          const draft = test.exec().replanning.draftFile;
          assert.notEqual(draft, approvedFile);
          assert.equal(branchData(current, 'plan-mode:inline').planFile, draft);
          assert.equal(readFileSync(approvedFile, 'utf8'), approvedText, 'replan cannot overwrite the old approval');
          assert.equal(test.exec().negotiation.id, originalExecution.negotiation.id);
          assert.equal(test.exec().negotiation.planRevision ?? 1, index + 1);
          if (index === 0) {
            const suspendedTuple = structuredClone({ flow: test.flow(), exec: test.exec(), models: test.record.models });
            for (const execution of [
              { phase: 'begin', planFile: draft },
              { phase: 'resume', planFile: draft, expectedExecutionId: 'stale-task', expectedPlanRevision: 1 },
              { phase: 'resume', planFile: draft, expectedExecutionId: test.exec().negotiation.id, expectedPlanRevision: 0 },
            ]) {
              let committed = false;
              const refused = await request(test.record, { kind: 'execution', expectedRevision: test.flow().revision,
                ...execution, commit() { committed = true; } });
              assert.equal(refused.ok, false, 'begin cannot replace resume, and resume requires the exact task/revision');
              assert.equal(committed, false);
              assert.deepEqual({ flow: test.flow(), exec: test.exec(), models: test.record.models }, suspendedTuple);
            }
          }
          for (const field of ['attempts', 'revisionsUsed', 'maxRevisions', 'reviewCostUsd', 'history']) {
            assert.deepEqual(test.exec().negotiation[field], originalExecution.negotiation[field], `replan preserves ${field}`);
          }
          await test.command('/mode work');
          assert.deepEqual(test.dialogs.at(-1).options, ['Keep planning', 'Execution status', 'Stop implementation', 'Use Independent mode']);
          await test.command('/mode chat');
          check('plan', 'plan');
          const beforePlanners = test.requests.length;
          await test.command('/planners');
          assert.equal(test.requests.length, beforePlanners, '/planners cannot replace this unfinished task');
          await test.command('/flow linked linked-other');
          check('plan', 'plan');
          await test.turn(`Inspect revised draft ${index} without implementing.`);
          assert.equal(test.requests.at(-1).model, 'plan', 'the actual next provider request uses the planner');
          const revisedText = `# Revised linked plan ${index}\n\nKeep the unfinished changes.\n`;
          writeFileSync(draft, revisedText);
          // Enter Context and return to main. Choosing keep/compact alone cannot
          // activate a worker or approve the draft, even in RPC's select loop.
          const compact = index % 2 === 1;
          test.choices.push('Context: Keep history', (title, options) => {
            assert.deepEqual(options, ['Keep history', 'Compact to approved plan']);
            assert.equal(test.exec().replanning.draftFile, draft);
            assert.equal(current.model.id, 'plan');
            return compact ? 'Compact to approved plan' : 'Keep history';
          }, (title, options) => {
            assert.equal(test.exec().active, true);
            assert.equal(test.exec().replanning.draftFile, draft, 'context-only selection never approves');
            assert.equal(current.model.id, 'plan');
            assert.equal(options[0], 'Approve and implement');
            assert.match(title, new RegExp(`Context: ${compact ? 'Compact to approved plan' : 'Keep history'}`, 'u'));
            return 'Approve and implement';
          }, 'medium');
          const beforeResume = test.requests.length;
          const resumed = await test.call('exit_plan_mode');
          assert.equal(resumed.details?.outcome, 'handoff', JSON.stringify(resumed));
          check('exec', same ? 'plan' : 'worker');
          assert.equal(test.flow().replanning, undefined, 'false replanning is omitted from the contract');
          assert.equal(test.exec().replanning, undefined);
          assert.equal(test.exec().planFile, draft);
          assert.equal(readFileSync(draft, 'utf8'), revisedText);
          assert.equal(test.exec().negotiation.id, originalExecution.negotiation.id, 'resume is not begin');
          assert.equal(test.exec().negotiation.planRevision, index + 2);
          for (const field of ['attempts', 'revisionsUsed', 'maxRevisions', 'reviewCostUsd', 'history']) {
            assert.deepEqual(test.exec().negotiation[field], originalExecution.negotiation[field], `resume preserves ${field}`);
          }
          assert.deepEqual(test.requests.slice(beforeResume).map(call => call.model), ['plan', same ? 'plan' : 'worker']);
          const workerContext = JSON.stringify(test.requests.at(-1).messages);
          assert.equal(workerContext.includes(`Inspect revised draft ${index} without implementing.`), !compact,
            'explicit compaction alone removes the old conversation from the actual worker context');
          assert.equal(manager.getEntries().filter(entry => entry.type === 'compaction').length, Math.floor((index + 1) / 2),
            'only explicit compact approvals create compaction records');
          assert.equal(readFileSync(workingFile, 'utf8'), 'Preserve unfinished implementation.\n');
          assert.deepEqual(visibleTransitions(current).slice(transitionsBeforeReplan).map(entry => entry.details), [
            { version: 1, previous: 'exec', mode: 'plan' }, { version: 1, previous: 'plan', mode: 'exec' },
          ], 'neither direction visits Work');
        }
        await test.reload();
        const resumedAt = test.requests.length;
        await test.turn('Resume the approved implementation.');
        assert.deepEqual(test.requests.slice(resumedAt).map(call => call.model), [same ? 'plan' : 'worker'],
          'first input reconciles optional-provider startup order before any model request');
        check('exec', same ? 'plan' : 'worker');
        await test.command('/plan-exec stop');
        check('work', 'work');
        assert.equal(test.exec().active, false);
        assert.equal(test.exec().completion.completion, 'stopped');
        await test.go(execLeaf);
        check('exec', same ? 'plan' : 'worker');
        await test.go(planLeaf);
        check('plan', 'plan');
        await test.go(workLeaf);
        check('work', 'work');
        await test.go(execLeaf);
        check('exec', same ? 'plan' : 'worker');
        const report = `completed-${label}`;
        await test.call('finish_plan', { report, verification: 'Local checks passed.', concerns: 'None.' });
        check('work', 'work');
        assert.equal(test.exec().active, false);
        assert.equal(test.exec().completion.completion, 'no_review');
        assert(JSON.stringify(manager.getBranch()).includes(report), 'completion retains implementation evidence');
        assert.equal(test.statuses.get('permission-mode'), approvals, 'all lifecycle transitions preserve approvals');
        await test.go(execLeaf);
        const execution = structuredClone(test.exec());
        await test.command('/flow independent');
        check('exec', same ? 'plan' : 'worker', 'independent');
        assert.deepEqual(test.exec(), execution, 'unlink preserves active Exec');
        await current.setModel(work);
        check('exec', 'work', 'independent');
        await test.command('/flow linked');
        check('exec', 'work', 'independent');
        await test.command('/plan-exec stop');
        check('work', 'work', 'independent');
      } finally { await test.dispose(); }
    });
  }

  for (const names of [orderings[0], orderings.at(-1)]) for (const stop of [false, true]) {
    const label = `${stop ? 'stop' : 'completion'}-retry-${names.join('+')}`;
    await scenario(label, async () => {
      const test = await flowFixture(label, names, { review: !stop });
      reviewCalls = [];
      try {
        await test.command('/flow linked');
        await test.command('/plan');
        writeFileSync(branchData(test.current(), 'plan-mode:inline').planFile, '# Retry completion\n\nImplement locally.\n');
        test.choices.push('Approve and implement', 'medium');
        await test.call('exit_plan_mode');
        const completion = { report: `saved-${label}`, verification: 'Passed.', concerns: 'None.' };
        authHook = () => { throw new Error('Local Work activation failed'); };
        const failedCompletion = stop ? await test.command('/plan-exec stop') : await test.call('finish_plan', completion);
        assert.equal(test.exec().active, true);
        assert.equal(test.flow().workflow, 'exec');
        assert.equal(test.current().model.id, 'worker');
        assert.equal(test.exec().negotiation.phase, 'paused');
        const pending = structuredClone(test.exec().pendingCompletion);
        if (!stop) assert.equal(pending.report, completion.report);
        assert.equal(pending.completion, stop ? 'stopped' : 'accepted');
        assert.equal(reviewCalls.length, stop ? 0 : 1, 'completion alone makes one real reviewer session/local transport request');
        assert(JSON.stringify(stop ? test.notes : failedCompletion.content)
          .includes('Work model unavailable. Retry completion or use /flow independent.'));
        authHook = undefined;
        await test.reload();
        await test.turn('Report the paused completion status without implementing.');
        assert.equal(test.exec().pendingCompletion.report, pending.report, 'pending intent survives actual reload');
        const before = test.requests.length;
        await test.command('/plan-exec retry');
        assert.equal(test.requests.length, before, 'retry does not request implementation or repeat review');
        assert.equal(test.exec().active, false);
        assert.equal(test.exec().completion.report, pending.report);
        assert.equal(test.exec().completion.completion, pending.completion);
        assert.equal(reviewCalls.length, stop ? 0 : 1, 'saved completion retries never rerun review');
        assert.equal(test.flow().workflow, 'work');
        assert.equal(test.current().model.id, 'work');
        assert.deepEqual(test.errors, []);
      } finally { reviewCalls = undefined; await test.dispose(); }
    });
  }

  await scenario('initial activation refuses actual concurrent workflow and Independent commands', async () => {
    const test = await flowFixture('initial-selection-controls', orderings[2]);
    const entered = deferred();
    const release = deferred();
    let selecting;
    try {
      const current = test.current();
      await current.setModel(worker); // General must enter the real asynchronous SDK setter.
      const records = structuredClone(customRecords(current));
      authHook = async () => { entered.resolve(); await release.promise; };
      selecting = test.command('/flow linked');
      await deadline(entered.promise, 'initial selection auth');
      assert.equal(test.flow().operatingMode, 'independent', 'Linked is not committed early');
      assert.equal(test.flow().transitioning, true);
      const notes = test.notes.length;
      await test.command('/mode plan');
      await test.command('/flow independent');
      assert.equal(test.flow().workflow, 'work');
      assert.deepEqual(customRecords(current), records, 'neither control uses an Independent fast path during selection');
      assert.equal(test.notes.slice(notes).filter(note => /transition is in progress/u.test(note)).length, 2,
        'both actual commands explicitly refuse, rather than falsely reporting a successful no-op');
      release.resolve();
      authHook = undefined;
      await selecting;
      assert.equal(test.flow().operatingMode, 'linked');
      assert.equal(test.flow().workflow, 'work');
      assert.equal(test.flow().blocked, undefined);
      assert.equal(current.model.id, 'work', 'General cannot be committed as a healthy Plan');
      await test.command('/flow independent');
      await test.command('/mode plan');
      assert.equal(test.flow().operatingMode, 'independent');
      assert.equal(test.flow().workflow, 'plan', 'ordinary Independent controls remain usable');
      assert.equal(current.model.id, 'work');
      assert.deepEqual(test.errors, []);
    } finally { release.resolve(); authHook = undefined; await selecting; await test.dispose(); }
  });

  for (const reason of ['reload', 'exit']) await scenario(`${reason} drains actual entered SDK setter before lifecycle replacement`, async () => {
    const test = await flowFixture(`drain-${reason}`, orderings[2]);
    const entered = deferred();
    const release = deferred();
    let selecting;
    let shutdown;
    try {
      await test.command('/flow linked');
      const current = test.current();
      const manager = current.sessionManager;
      const oldRunner = current.extensionRunner;
      const records = structuredClone(customRecords(current));
      const entries = manager.getEntries().length;
      const defaults = structuredClone(test.settings.getGlobalSettings());
      authHook = async () => { entered.resolve(); await release.promise; };
      selecting = test.command('/mode plan');
      await deadline(entered.promise, 'pre-shutdown SDK auth');
      let finished = false;
      let replacementStarted = false;
      shutdown = (reason === 'reload'
        ? current.reload({ beforeSessionStart() { replacementStarted = true; } })
        : emitSessionShutdownEvent(oldRunner, { type: 'session_shutdown', reason }))
        .then(() => { finished = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(finished, false, 'awaited shutdown cannot finish while an authorized native setter is pending');
      assert.equal(replacementStarted, false, 'new runtime must not reconcile ahead of an old SDK write');
      assert.equal(current.extensionRunner, oldRunner);
      assert.deepEqual(customRecords(current), records);
      release.resolve();
      authHook = undefined;
      await deadline(Promise.all([selecting, shutdown]), `${reason} drains without waiting on agent idle`);
      assert.equal(current.sessionManager, manager, 'reload keeps the very same manager');
      assert.deepEqual(customRecords(current), records, 'cancelled old transition never writes flow/workflow/inline metadata');
      assert.deepEqual(test.settings.getGlobalSettings(), defaults, 'stale transition never persists global defaults');
      const writes = manager.getEntries().slice(entries).filter(entry => entry.type === 'model_change').map(entry => entry.modelId);
      assert.deepEqual(writes, reason === 'reload' ? ['plan', 'work'] : ['plan'],
        'native model writes actually occur; shutdown drains them, it does not stub or suppress the setter');
      if (reason === 'reload') {
        test.record = flowRecords.at(-1);
        assert.equal(replacementStarted, true);
        assert.equal(test.flow().workflow, 'work');
        assert.equal(test.flow().blocked, undefined);
        assert.equal(current.model.id, 'work', 'new reconciliation is the last writer');
        assert.equal(test.flow().transitioning, false);
        await assert.rejects(current.setModel(plan), { message: deniedMessage });
      }
      assert.deepEqual(test.errors, [], 'no swallowed stale-context errors during shutdown');
    } finally { release.resolve(); authHook = undefined; await selecting; await shutdown; await test.dispose(); }
  });

  await scenario('idle model activation fences actual tree and session replacement', async () => {
    const test = await flowFixture('idle-navigation-fence', orderings[2]);
    const entered = deferred();
    const release = deferred();
    let selecting;
    try {
      await test.command('/flow linked');
      const current = test.current();
      const leaf = current.sessionManager.appendCustomEntry('test:before-activation', {});
      current.sessionManager.appendCustomEntry('test:activation-origin', {});
      const entries = structuredClone(current.sessionManager.getEntries());
      authHook = async () => { entered.resolve(); await release.promise; };
      selecting = test.command('/mode plan');
      await deadline(entered.promise, 'idle authorized setter auth');
      assert.equal(current.isStreaming, false, 'command does not run an agent turn');
      assert.equal((await current.navigateTree(leaf, { summarize: false })).cancelled, true,
        'actual native navigation observes the gate cancellation hook');
      assert.equal((await test.runtime.newSession()).cancelled, true,
        'actual runtime replacement observes the gate cancellation hook');
      assert.equal(test.current(), current);
      assert.deepEqual(current.sessionManager.getEntries(), entries, 'no branch/model/workflow writes before auth returns');
      release.resolve();
      await selecting;
      assert.equal(test.flow().workflow, 'plan');
      assert.equal(current.model.id, 'plan');
      assert.deepEqual(test.errors, []);
    } finally {
      release.resolve();
      authHook = undefined;
      await selecting;
      await test.dispose();
    }
  });

  // The planner app is driven through its actual component. A fresh implementation
  // replaces services/AgentSession; no synthetic session_start is emitted on the parent.
  for (const names of orderings) {
    const label = `fresh-${names.join('+')}`;
    await scenario(label, async () => {
      const switched = deferred();
      const test = await flowFixture(label, names, { same: true, tui: true, newSession: switched.resolve,
        seed(manager) {
          manager.appendCustomEntry('plan-run', { id: label, createdAt: 1, task: 'approved local task', state: 'active',
            planners: [{ id: 'A', spec: `${provider}/plan`, name: 'Local planner', plan: '# Linked fresh plan\n\nImplement locally.', revision: 1 }],
            merged: { plan: '# Linked fresh plan\n\nImplement locally.', revision: 1, name: 'Local planner', spec: `${provider}/plan` } });
        } });
      try {
        const parent = test.current();
        await test.command('/flow linked');
        await test.command('/approvals yolo');
        const savedFlow = structuredClone(test.flow().selectedFlow);
        await test.turn(`parent-history-${label}`);
        const opened = test.command('/planners');
        const until = async (check, why) => {
          const end = Date.now() + 10000;
          while (!check()) {
            if (Date.now() >= end) throw new Error(`Timed out: ${why}`);
            await new Promise(resolve => setImmediate(resolve));
          }
        };
        await until(() => test.harness, 'planner app');
        const screen = () => test.harness.render().join('\n');
        for (let i = 0; i < 5 && !/⏎ do it/u.test(screen()); i++) test.harness.handleInput('\t');
        test.harness.handleInput('\r');
        assert.match(screen(), /● Implement/u);
        assert.match(screen(), /Execute with linked worker/u);
        assert(!/Mode\s+‹/u.test(screen()), 'Linked app cannot select ordinary same-model execution');
        const focus = label => {
          for (let i = 0; i < 10; i++) {
            if (new RegExp(`${label}\\s+‹`, 'u').test(screen())) return;
            test.harness.handleInput('\u001b[B');
          }
          assert.fail(`Missing app row ${label}: ${screen()}`);
        };
        focus('Model');
        const beforeModelCycle = screen();
        test.harness.handleInput('\u001b[C');
        assert.equal(screen(), beforeModelCycle, 'linked app worker is not a free-model picker');
        focus('Context');
        assert.match(screen(), /this conversation, plus the plan/u);
        test.harness.handleInput('\u001b[C');
        assert.match(screen(), /compact to plan/u);
        test.harness.handleInput('\u001b[C');
        assert.match(screen(), /fresh session with only the plan/u);
        await until(() => !screen().includes('choosing...'), 'implementation effort default');
        const before = test.requests.length;
        test.harness.handleInput('\r');
        await opened;
        await deadline(switched.promise, 'fresh linked runtime replacement');
        const fresh = test.current();
        assert.notEqual(fresh, parent);
        assert.equal(test.generations.length, 2);
        assert.deepEqual(parent.sessionManager.getEntries(), test.parentEntries, 'old callbacks never mutate the parent');
        assert.equal(test.flow().operatingMode, 'linked');
        assert.equal(test.flow().workflow, 'exec', 'child reconciles bootstrap as Exec, never Work');
        assert.deepEqual(test.flow().selectedFlow, savedFlow);
        assert.equal(fresh.model.id, 'plan', `same-model planner/worker enters explicit Exec in child: ${test.notes.join('; ')}`);
        assert.equal(fresh.thinkingLevel, 'medium', `fresh child uses the worker suggestion: ${test.notes.join('; ')}`);
        assert.equal(test.exec().active, true);
        assert.equal(test.exec().implementerModel, `${provider}/plan`);
        assert.deepEqual(test.exec().linkedFlow.selectedFlow, savedFlow);
        assert.equal(readFileSync(test.exec().planFile, 'utf8'), '# Linked fresh plan\n\nImplement locally.\n');
        assert.match(test.statuses.get('permission-mode'), /auto/u, 'child keeps configured approval default, not parent Yolo');
        const calls = test.requests.slice(before);
        assert.equal(calls.length, 1, 'one implementation brief only');
        assert.equal(calls[0].current, fresh);
        assert.equal(calls[0].model, 'plan');
        assert(!JSON.stringify(calls[0].messages).includes(`parent-history-${label}`), 'fresh omits parent conversation');
        assert(JSON.stringify(calls[0].messages).includes('# Linked fresh plan'));
        assert.equal(test.record.starts.length, 1);
        assert.equal(test.record.starts[0].exec?.active, true, 'Exec is committed before the first child prompt');
        assert(test.record.starts[0].tools.includes('finish_plan'));
        const consumed = () => fresh.sessionManager.getBranch().filter(entry => entry.customType === 'plan-implementation-runtime-consumed');
        assert.equal(consumed().length, 1);
        const requests = test.requests.length;
        await test.reload();
        assert.equal(consumed().length, 1);
        assert.equal(test.requests.length, requests, 'reload does not resend the child brief');
        await test.turn('Report child execution status.');
        assert.equal(test.requests.at(-1).model, 'plan');
        await test.call('finish_plan', { report: `fresh-completed-${label}`, verification: 'Passed.', concerns: 'None.' });
        assert.equal(test.current(), fresh, 'completion stays in child');
        assert.equal(fresh.model.id, 'work');
        assert.equal(test.flow().workflow, 'work');
        assert.equal(test.exec().active, false);
        assert.deepEqual(parent.sessionManager.getEntries(), test.parentEntries);
        assert.equal(fresh.sessionManager.getEntries().some(entry => entry.type === 'compaction'), false);
        assert.deepEqual(test.errors, []);
      } finally { await test.dispose(); }
    });
  }

  await scenario('immutable snapshot, explicit refresh and blocked branch recovery', async () => {
    const test = await flowFixture('snapshot-and-blocked', orderings[2]);
    const current = test.current();
    try {
      const independentLeaf = current.sessionManager.appendCustomEntry('test:independent', {});
      await test.command('/flow linked');
      const snapshot = structuredClone(test.flow().selectedFlow);
      const linkedLeaf = current.sessionManager.appendCustomEntry('test:linked', {});
      roles(test.dir, false, 'worker');
      const queries = test.record.roleQueries.length;
      for (let i = 0; i < 3; i++) assert.deepEqual(test.flow().selectedFlow, snapshot);
      assert.equal(test.record.roleQueries.length, queries, 'plain snapshots do not rediscover role defaults');
      await test.command('/mode plan');
      await test.command('/mode work');
      assert.equal(current.model.id, 'work', 'phase transitions use activated snapshot despite edited roles');
      await test.reload();
      await test.turn('Reconcile the existing selected flow.');
      assert.deepEqual(test.flow().selectedFlow, snapshot, 'reload reuses assignments, not current role files');
      await test.command('/flow linked');
      assert.equal(current.model.id, 'worker', 'explicitly reselecting the provider refreshes assignments');
      assert.equal(test.flow().selectedFlow.roles.work.modelId, 'worker');
      await test.go(independentLeaf);
      assert.equal(test.flow().operatingMode, 'independent');
      await test.go(linkedLeaf);
      assert.equal(test.flow().operatingMode, 'linked');
      assert.deepEqual(test.flow().selectedFlow, snapshot);
      assert.equal(current.model.id, 'work');

      // Authenticated availability, not getAll(), is authoritative even on resume.
      const availableSnapshot = models.getAvailableSnapshot;
      models.getAvailableSnapshot = () => availableSnapshot().filter(model => modelRef(model) !== modelRef(work));
      try {
        await test.reload();
        assert.equal(test.flow().operatingMode, 'linked');
        assert.match(test.flow().blocked, /not an available authenticated physical chat model/u);
        const before = test.requests.length;
        for (const source of ['interactive', 'rpc', 'extension']) await current.prompt(`Blocked ${source} input`, { source });
        assert.equal(test.requests.length, before, 'blocked flow rejects every input source before transport');
        const deniedTool = await current.extensionRunner.emitToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'blocked-read', input: { path: 'x' } });
        assert.equal(deniedTool?.block, true, 'blocked flow also refuses tool calls');
        await assert.rejects(current.setModel(plan), { message: deniedMessage });
        await test.command('/flow status');
        assert(test.notes.some(note => /Blocked:.*not an available/u.test(note)));
        await test.command('/flow independent');
        assert.equal(test.flow().operatingMode, 'independent', 'recovery command runs before blocked input hook');
        assert.equal(test.flow().blocked, undefined);
        await current.setModel(plan);
      } finally { models.getAvailableSnapshot = availableSnapshot; }
      assert.deepEqual(test.errors, []);
    } finally { await test.dispose(); }
  });

  for (const lateBlock of [false, true]) for (const recovery of ['independent', `linked ${provider}`]) await scenario(`native TUI ${lateBlock ? 'context' : 'restored'}-blocked custom queues survive and recover via ${recovery}`, async () => {
    const test = await flowFixture(`blocked-custom-${lateBlock}-${recovery.split(' ')[0]}`, ['tool-gate', 'subagents'], {
      nativeTui: true,
      compaction: lateBlock ? undefined : { enabled: true, keepRecentTokens: 1 },
      seed: lateBlock ? undefined : manager => {
        manager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Earlier conversation. '.repeat(300) }], timestamp: Date.now() - 2000 });
        manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Prior response above the context limit.' }],
          api: work.api, provider, model: work.id, stopReason: 'stop', timestamp: Date.now() - 1000,
          usage: { input: 40000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 40010,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        manager.appendCustomEntry('tool-gate:flow', { version: 1, operatingMode: 'linked', revision: 4 });
      },
    });
    const current = test.current();
    const release = deferred();
    let starting;
    const compactions = [];
    const stopWatching = current.subscribe(event => { if (event.type === 'compaction_start' || event.type === 'compaction_end') compactions.push(event); });
    const fakeStream = current.agent.streamFunction;
    const priorRuntimeStream = models.streamSimple;
    const { provider: transport } = await models.prepareRequest(work);
    const priorTransport = transport.streamSimple;
    try {
      // Keep the SDK's complete request path, including signal-aware credential
      // resolution, intact. Only the final provider transport is local/scripted.
      current.agent.streamFunction = test.nativeStream;
      models.streamSimple = productionStreamSimple.bind(models);
      transport.streamSimple = fakeStream;
      current.setSteeringMode('one-at-a-time');
      current.setFollowUpMode('one-at-a-time');
      const draft = test.nativeMode.editor.getText();
      if (lateBlock) await test.command(`/flow linked ${provider}`);
      else await test.reload(); // Capture is required on real reload as well as construction.
      assert.equal(!!test.flow().blocked, !lateBlock);
      const entered = deferred();
      test.record.beforeStart = async () => { entered.resolve(); await release.promise; };
      const custom = id => ({ customType: 'accepted-result', content: id, display: true, details: { id } });
      starting = current.sendCustomMessage(custom('trigger'), { triggerTurn: true });
      await deadline(entered.promise, 'blocked custom before_agent_start');
      for (const id of ['steer-1', 'steer-2', 'steer-3']) test.record.pi.sendMessage(custom(id), { triggerTurn: true, deliverAs: 'steer' });
      for (const id of ['follow-1', 'follow-2', 'follow-3']) test.record.pi.sendMessage(custom(id), { triggerTurn: true, deliverAs: 'followUp' });
      test.record.pi.sendMessage(custom('next'), { deliverAs: 'nextTurn' });
      test.record.pi.sendMessage(custom('passive'), { triggerTurn: false });
      assert.equal(current.agent.steeringQueue.messages.length, 3, 'all custom steering messages accepted');
      assert.equal(current.agent.followUpQueue.messages.length, 3, 'all custom follow-ups accepted');
      // In the late-block case input accepted a user follow-up while healthy.
      // A later extension makes the role provider unavailable before context.
      // The native TUI abort path would merge this into the editor and silently
      // discard customs. The ordinary input gate can only block NEW user text.
      if (lateBlock) {
        assert.equal(await current.followUp('Accepted queued user text.'), 'queued');
        test.record.pi.events.emit('subagents:role-model-ready', { ready: false });
        await current.sendUserMessage('This new input is blocked by missing role defaults.');
        assert(test.flow().blocked);
      }
      const queuedUser = [...current.getFollowUpMessages()];
      assert.equal(queuedUser.length, lateBlock ? 1 : 0);
      const persisted = () => current.sessionManager.getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === 'accepted-result')
        .map(entry => entry.details.id);
      const retained = () => [...persisted(), ...current.agent.steeringQueue.messages, ...current.agent.followUpQueue.messages]
        .map(value => typeof value === 'string' ? value : value.details?.id).filter(Boolean).sort();
      const accepted = ['trigger', 'steer-1', 'steer-2', 'steer-3', 'follow-1', 'follow-2', 'follow-3', 'next', 'passive'].sort();
      release.resolve();
      await deadline(starting, 'blocked custom settles without waiting on its own abort');
      assert.equal(current.isIdle, true);
      assert.equal(test.requests.length, 0, 'no provider transport request while blocked');
      if (!lateBlock) {
        assert(compactions.some(event => event.type === 'compaction_start'), 'native pre-run compaction actually attempted');
        assert(compactions.some(event => event.type === 'compaction_end' && event.aborted), 'blocked pre-run compaction cancelled before summarization');
        assert.equal(current.sessionManager.getBranch().some(entry => entry.type === 'compaction'), false);
      }
      assert.deepEqual(networkAttempts, []);
      assert.deepEqual(inferenceAttempts, []);
      assert.deepEqual(retained(), accepted, 'every accepted result is durable or still queued, exactly once');
      assert.deepEqual(current.getFollowUpMessages(), queuedUser, 'native abort never clears accepted user queue');
      assert.equal(test.nativeMode.editor.getText(), draft, 'native draft unchanged');
      assert.equal(test.flow().operatingMode, 'linked', 'never silently unlink');
      assert(test.flow().blocked);
      // A second custom-triggered run still cannot infer or drain the remaining
      // queue by making automatic progress behind the blocked state.
      test.record.beforeStart = undefined;
      await deadline(current.sendCustomMessage(custom('retry'), { triggerTurn: true }), 'second blocked custom');
      accepted.push('retry'); accepted.sort();
      assert.equal(test.requests.length, 0);
      assert.deepEqual(retained(), accepted);
      assert.equal(test.nativeMode.editor.getText(), draft);
      current.setAutoCompactionEnabled(false);
      if (lateBlock) test.record.pi.events.emit('subagents:role-model-ready', { ready: true });
      await test.command(`/flow ${recovery}`);
      assert.equal(test.flow().blocked, undefined);
      assert.deepEqual(retained(), accepted, 'recovery command itself does not consume accepted results');
      assert.equal(test.requests.length, 0, 'recovery is not an inference request');
      await test.turn('Explicitly resume after recovery.');
      assert(test.requests.length > 0, 'recovered run resumes through the local provider');
      assert.deepEqual(persisted().sort(), accepted, 'all custom results reach durable history exactly once');
      assert.equal(current.agent.hasQueuedMessages(), false);
      for (const id of accepted) assert(test.requests.some(call => call.messages.some(message =>
        JSON.stringify(message.content).includes(id))), `${id} reaches resumed provider context`);
      assert.equal(test.nativeMode.editor.getText(), draft);
      assert.deepEqual(test.errors, []);
    } finally {
      release.resolve();
      await starting;
      models.streamSimple = priorRuntimeStream;
      transport.streamSimple = priorTransport;
      stopWatching();
      await test.dispose();
    }
  });

  for (const same of [false, true]) await scenario(`tool-origin replan settles onto planner (${same ? 'same' : 'distinct'} model)`, async () => {
    const test = await flowFixture(`tool-replan-${same}`, orderings[1], { same });
    try {
      await test.command('/flow linked');
      await test.command('/plan');
      writeFileSync(branchData(test.current(), 'plan-mode:inline').planFile, '# Tool-origin revision\n\nImplement locally.\n');
      test.choices.push('Approve and implement', 'medium');
      await test.call('exit_plan_mode');
      const before = structuredClone(test.exec());
      const requests = test.requests.length;
      await test.call('enter_plan_mode');
      assert.equal(test.flow().workflow, 'plan');
      assert.equal(test.flow().replanning, true);
      assert.equal(test.exec().active, true);
      assert.equal(test.exec().negotiation.id, before.negotiation.id);
      assert.equal(test.exec().planFile, before.planFile, 'the tool request creates a draft, not a replacement approval');
      assert.notEqual(test.exec().replanning.draftFile, before.planFile);
      assert.deepEqual(test.requests.slice(requests).map(call => call.model), [same ? 'plan' : 'worker', 'plan'],
        'settlement stops the implementer before one planner continuation');
      await test.command('/plan-exec stop');
      assert.equal(test.flow().workflow, 'work');
      assert.equal(test.current().model.id, 'work');
      assert.deepEqual(test.errors, []);
    } finally { await test.dispose(); }
  });

  for (const unlink of [false, true]) await scenario(`stop suspended task${unlink ? ' after explicit unlink' : ''}`, async () => {
    const test = await flowFixture(`stop-replanning-${unlink}`, orderings[2]);
    try {
      await test.command('/flow linked');
      await test.command('/plan');
      writeFileSync(branchData(test.current(), 'plan-mode:inline').planFile, '# Suspend and stop\n\nKeep local work.\n');
      test.choices.push('Approve and implement', 'medium');
      await test.call('exit_plan_mode');
      const id = test.exec().negotiation.id;
      await test.command('/plan');
      const suspended = structuredClone(test.exec());
      assert.equal(test.flow().workflow, 'plan');
      await test.reload();
      await test.turn('Continue revising, without resuming implementation.');
      assert.equal(test.requests.at(-1).model, 'plan', 'restored suspension sends the next turn to the planner');
      assert.equal(test.exec().negotiation.id, id);
      assert.deepEqual(test.exec().replanning, suspended.replanning);
      if (unlink) {
        await test.command('/flow independent');
        assert.equal(test.flow().operatingMode, 'independent');
        assert.deepEqual(test.exec(), suspended, 'explicit recovery preserves the suspended task');
        const refused = await test.call('exit_plan_mode');
        assert.match(JSON.stringify(refused), /This suspended Linked task is now Independent/u);
        assert.equal(test.exec().negotiation.id, id);
        assert.equal(test.flow().workflow, 'plan');
      }
      await test.command('/plan-exec stop');
      assert.equal(test.exec().active, false);
      assert.equal(test.exec().replanning, undefined);
      assert.equal(test.exec().completion.completion, 'stopped');
      assert.equal(test.flow().workflow, 'work');
      assert.equal(test.current().model.id, unlink ? 'plan' : 'work', 'Independent stop never secretly switches the model');
      await test.turn('Report stopped task status.');
      assert.equal(test.requests.at(-1).model, unlink ? 'plan' : 'work');
      assert.deepEqual(test.errors, []);
    } finally { await test.dispose(); }
  });

  await scenario('missing planner owner refuses replan without changing the real worker', async () => {
    const test = await flowFixture('missing-replan-owner', ['tool-gate', 'subagents'], {
      seed(manager, dir) {
        const selectedFlow = { provider, anchorModel: work.id, roles: Object.fromEntries(
          [['work', work], ['chat', work], ['plan', plan], ['exec', worker]].map(([role, model]) =>
            [role, { provider: model.provider, modelId: model.id, suggestedThinking: 'high' }])) };
        const planFile = resolve(dir, 'approved.md');
        writeFileSync(planFile, '# Approved task\n');
        manager.appendCustomEntry('tool-gate:flow', { version: 1, operatingMode: 'linked', revision: 1, selectedFlow });
        manager.appendCustomEntry('plan-mode:exec', { active: true, planFile,
          negotiation: { id: 'owner-missing', planRevision: 1 }, linkedFlow: { selectedFlow } });
      },
    });
    try {
      await test.turn('Inspect task with planner owner absent.');
      assert.equal(test.requests.at(-1).model, 'worker');
      const before = structuredClone({ flow: test.flow(), exec: test.exec(), entries: customRecords(test.current()) });
      await test.command('/mode plan');
      test.choices.push('Revisit plan');
      await test.command('/mode');
      assert.deepEqual({ flow: test.flow(), exec: test.exec(), entries: customRecords(test.current()) }, before);
      assert(test.notes.some(note => note.includes('Revisiting this plan is unavailable; no workflow changed.')));
      await test.turn('Still implementing on the existing worker.');
      assert.equal(test.requests.at(-1).model, 'worker');
      assert.deepEqual(test.errors, []);
    } finally { await test.dispose(); }
  });

  await scenario('missing optional role service preserves Independent', async () => {
    const test = await flowFixture('missing-role-service', ['tool-gate', 'plan-mode']);
    try {
      const before = structuredClone(test.current().sessionManager.getEntries());
      await test.command('/flow linked');
      assert.equal(test.flow().operatingMode, 'independent');
      assert.deepEqual(test.current().sessionManager.getEntries(), before);
      assert(test.notes.some(note => /role defaults unavailable/iu.test(note)));
      await test.current().setModel(plan);
      await test.command('/plan');
      assert.equal(test.flow().workflow, 'plan');
      assert.deepEqual(test.errors, []);
    } finally { await test.dispose(); }
  });
  assert.deepEqual(networkAttempts, [], 'no network attempted by any guard/flow/lifecycle path');
  assert.deepEqual(inferenceAttempts, [], 'no paid inference attempted');
  assert.equal(localResponses, 2, 'production lifecycle never uses an unscripted nested transport');
  assert.equal(proto.setModel, originals.setModel, 'all production flow owners cleaned up');
  assert.equal(proto.cycleModel, originals.cycleModel);
  assert.equal(proto._bindExtensionCore, originals._bindExtensionCore, 'session capture is restored with the last owner');
  if (failures.length) throw new AggregateError(failures, `${failures.length} linked-flow scenarios failed`);
  console.log(`PASS full linked-flow integration on SDK ${sdkManifest.version}; no network/inference`);
} finally {
  for (const selector of selectors) selector.dispose();
  for (const session of sessions) {
    try { await emitSessionShutdownEvent?.(session.extensionRunner, { type: 'session_shutdown', reason: 'exit' }); }
    finally { session.dispose(); }
  }
  // Include a lease whose identity assertion failed before it entered leases.
  for (const record of bridge.records) record.lease.dispose();
  for (const lease of leases) lease.dispose();
  if (proto && originals) {
    proto.setModel = originals.setModel;
    proto.cycleModel = originals.cycleModel;
    proto._bindExtensionCore = originals._bindExtensionCore;
  }
  delete globalThis[bridgeSymbol];
  for (const restore of restores.reverse()) restore();
  syncBuiltinESMExports();
  process.chdir(originalCwd);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
}
