// Real Pi loader, AgentSession, branch navigation and reload. All model transports are local.
// Select another host with PI_TEST_SDK_ROOT=/absolute/path/to/pi-coding-agent.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { findPackageJSON, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = realpathSync(process.env.PI_TEST_SDK_ROOT
  ? resolve(process.env.PI_TEST_SDK_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..'));
const sdkManifest = JSON.parse(readFileSync(resolve(sdkRoot, 'package.json'), 'utf8'));
assert.equal(sdkManifest.name, '@earendil-works/pi-coding-agent', 'PI_TEST_SDK_ROOT must be the SDK package root');
const sdkUrl = pathToFileURL(resolve(sdkRoot, 'dist/index.js'));
function hostDependency(name) {
  // pi-ai has import-only exports; resolve its package from the chosen host, not a component.
  const manifestPath = findPackageJSON(name, sdkUrl);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.name, name);
  return pathToFileURL(resolve(dirname(manifestPath), manifest.exports?.['.']?.import ?? manifest.main));
}
const aiUrl = hostDependency('@earendil-works/pi-ai');
const tuiUrl = hostDependency('@earendil-works/pi-tui');
const agentCoreUrl = hostDependency('@earendil-works/pi-agent-core');
// Match the SDK loader's compatibility entrypoint and subpath aliases in direct TS imports too.
const aliases = Object.fromEntries(['@earendil-works', '@mariozechner'].flatMap(scope => [
  [`${scope}/pi-coding-agent`, fileURLToPath(sdkUrl)],
  [`${scope}/pi-agent-core`, fileURLToPath(agentCoreUrl)],
  [`${scope}/pi-tui`, fileURLToPath(tuiUrl)],
  [`${scope}/pi-ai/providers/all`, fileURLToPath(new URL('./providers/all.js', aiUrl))],
  [`${scope}/pi-ai/compat`, fileURLToPath(new URL('./compat.js', aiUrl))],
  [`${scope}/pi-ai/oauth`, fileURLToPath(new URL('./oauth.js', aiUrl))],
  [`${scope}/pi-ai`, fileURLToPath(new URL('./compat.js', aiUrl))],
]));
const jiti = createJiti(import.meta.url, { alias: aliases });
const temp = mkdtempSync(resolve(tmpdir(), 'pi-suite-mode-flow-'));
const cwd = process.cwd();
const originalEnv = Object.fromEntries(['HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'PI_OFFLINE',
  'PI_SUBAGENT', 'PI_TOOL_GATE_APPROVAL', 'PI_TOOL_GATE_WORKFLOW'].map(key => [key, process.env[key]]));
const networkAttempts = [];
const restoreNetwork = [];
// emit() is synchronous; the provider attaches the actual completion promise to the request.
const emitWorkflow = async (api, channel, request = {}) => {
  api.events.emit(channel, request);
  if (request.result) await request.result;
};
const planningId = 'claude-opus-4-5';
const implementationId = 'claude-sonnet-4-5';
let session;
const withDeadline = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
};
const boundedUntil = async (check, label) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setImmediate(resolve));
  }
};
try {
  process.env.HOME = temp;
  process.env.PI_CODING_AGENT_DIR = temp;
  process.env.XDG_CONFIG_HOME = resolve(temp, 'xdg');
  process.env.PI_OFFLINE = '1';
  // These fixtures create top-level sessions, even when this script is run by a worker.
  for (const key of ['PI_SUBAGENT', 'PI_TOOL_GATE_APPROVAL', 'PI_TOOL_GATE_WORKFLOW']) delete process.env[key];
  // Fail even swallowed network attempts, and install the tripwires before loading the SDK.
  for (const [object, key] of [[globalThis, 'fetch'], [http, 'request'], [http, 'get'],
    [https, 'request'], [https, 'get'], [net.Socket.prototype, 'connect'], [tls, 'connect']]) {
    const original = object[key];
    object[key] = () => {
      networkAttempts.push(key);
      throw new Error(`Mode-flow integration forbids network ${key}`);
    };
    restoreNetwork.push(() => { object[key] = original; });
  }
  syncBuiltinESMExports();
  const sdk = await import(sdkUrl.href);
  const { createAssistantMessageEventStream, getCurrentSystemMessage, getSystemMessageText, toToolDeclaration } = await import(aiUrl.href);
  const { Text } = await import(tuiUrl.href);
  const { AgentSession, ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices,
    createAgentSessionFromServices, createAgentSessionRuntime, createCodingTools, initTheme } = sdk;
  // Exercise bare imports through the actual selected SDK loader, not just our path resolver.
  const identityFixture = resolve(temp, 'host-identity.ts');
  writeFileSync(identityFixture, `
import { AgentSession, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { Text } from '@earendil-works/pi-tui';
export { AgentSession, ModelRuntime, createAssistantMessageEventStream, Text };
export default function (pi) {
  pi.events.on('test:host-identity', request => {
    Object.assign(request, { AgentSession, ModelRuntime, createAssistantMessageEventStream, Text });
  });
}
`);
  const identityBus = sdk.createEventBus();
  const loaded = await sdk.discoverAndLoadExtensions([identityFixture], temp, temp, identityBus);
  assert.deepEqual(loaded.errors, [], 'host identity fixture loads through the selected SDK');
  assert.equal(loaded.extensions.length, 1);
  const loaderIdentity = {};
  identityBus.emit('test:host-identity', loaderIdentity);
  const expectedIdentity = { AgentSession, ModelRuntime, createAssistantMessageEventStream, Text };
  const jitiIdentity = await jiti.import(identityFixture);
  for (const [name, value] of Object.entries(expectedIdentity)) {
    assert.equal(loaderIdentity[name], value, `SDK loader uses the selected host's ${name}`);
    assert.equal(jitiIdentity[name], value, `direct TS imports use the selected host's ${name}`);
  }
  console.log(`PASS actual Pi host identity: SDK ${sdkManifest.version} at ${sdkRoot}, SDK/pi-ai/tui and direct TS imports`);
  initTheme('dark', false);
  const models = await ModelRuntime.create({ agentDir: temp, allowModelNetwork: false });
  await models.setRuntimeApiKey('anthropic', 'test-placeholder');
  // Classifier transport is local, but System 1 resolution/provenance stays real.
  // Permission/tool-selection calls are not evidence of effort reclassification.
  writeFileSync(resolve(temp, 'system1.json'), JSON.stringify({ waterfall: ['jev'] }));
  const effortCalls = [];
  const otherClassifierCalls = [];
  let effortTransport;
  const effortAnswer = model => ({ model: model.id, stopReason: 'stop', answers: {
    effort: { type: 'choice', choice: 'high', confidence: 0.4,
      probabilities: { low: 0.3, medium: 0.25, high: 0.4, xhigh: 0.05 } },
  } });
  models.classify = async (model, context, options) => {
    if (Object.keys(context.questions).length === 1 && context.questions.effort?.type === 'choice') {
      assert(['general', 'plan', 'exec'].includes(context.state.phase));
      const call = { model, context: structuredClone(context), options };
      effortCalls.push(call);
      return effortTransport ? effortTransport(call) : effortAnswer(model);
    }
    otherClassifierCalls.push({ model, context: structuredClone(context) });
    return { answers: {}, stopReason: 'error', errorMessage: 'Local integration classifier' };
  };
  models.streamSimple = () => { throw new Error('Unexpected nested model request'); };
  const cases = [
    { names: ['tool-gate'] }, { names: ['plan-mode'] },
    { names: ['tool-gate', 'plan-mode'] }, { names: ['plan-mode', 'tool-gate'] },
    { names: ['tool-gate', 'plan-mode'], inlineActive: true },
    { names: ['plan-mode', 'tool-gate'], inlineActive: true },
    ...[['tool-gate'], ['plan-mode'], ['tool-gate', 'plan-mode'], ['plan-mode', 'tool-gate']]
      .flatMap(providers => Array.from({ length: providers.length + 1 }, (_, at) => ({
        names: [...providers.slice(0, at), 'status-footer', ...providers.slice(at)],
      }))).flatMap(testCase => testCase.names.includes('plan-mode') && testCase.names.includes('tool-gate')
        ? [testCase, { ...testCase, inlineActive: true }] : [testCase]),
  ];
  // The fast tier runs four representative combinations; PI_TEST_FULL=1 runs all of them.
  const FULL = process.env.PI_TEST_FULL === '1';
  const labelOf = ({ names, inlineActive }) => names.join('+') + (inlineActive ? '-inline-active' : '');
  const FAST = new Set(['tool-gate+plan-mode', 'plan-mode+tool-gate-inline-active',
    'tool-gate+plan-mode+status-footer', 'status-footer+plan-mode+tool-gate-inline-active']);
  for (const fast of FAST) if (!cases.some(testCase => labelOf(testCase) === fast)) throw new Error(`unknown fast mode-flow case: ${fast}`);
  const failures = [];
  for (const { names, inlineActive } of FULL ? cases : cases.filter(testCase => FAST.has(labelOf(testCase)))) {
    const label = labelOf({ names, inlineActive });
    try {
      const dir = resolve(temp, label);
      mkdirSync(dir, { recursive: true });
      process.chdir(dir); // Gate also resolves its registration-time keys from process.cwd().
      writeFileSync(resolve(temp, 'pi-plan-mode.json'), JSON.stringify({
        thinkingLevel: 'inherit', plansDirectory: resolve(dir, 'plans'),
      }));
      const statuses = new Map();
      const errors = [];
      const notifications = [];
      const workflowEvents = [];
      const approvalEvents = [];
      const activity = [];
      const thinkingWrites = [];
      let api;
      let approvalChoice = 'here';
      let approvalCount = 0;
      let callCount = 0;
      let selectedEffort;
      const requestedModels = [];
      const requests = [];
      const hasGate = names.includes('tool-gate');
      const hasPlan = names.includes('plan-mode');
      const guidanceType = 'tool-gate:mode-guidance';
      const settingsNoticeType = 'tool-gate:mode-settings-notice';
      const settingsNoticeText = 'Tool-gate settings changed. Apply the current workflow and approval guidance on your next response.';
      const messageText = message => typeof message.content === 'string' ? message.content
        : (message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
      let expectedPrompts = 'on';
      let expectedSystems;
      const services = await createAgentSessionServices({ cwd: dir, agentDir: temp, modelRuntime: models,
        settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false } }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: names.map(name => resolve(root, `packages/pi-${name}/src/index.ts`)),
          extensionFactories: [pi => {
            api = pi;
            pi.events.on('workflow-mode:changed', event => workflowEvents.push(event));
            pi.events.on('permission-mode:changed', event => approvalEvents.push(event));
            for (const type of ['input', 'before_agent_start', 'tool_result', 'turn_end']) pi.on(type, event => {
              activity.push({ type, ...(type === 'tool_result' ? { isError: event.isError } : {}) });
            });
          }] } });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, [], label);
      const manager = SessionManager.inMemory(dir);
      if (inlineActive) {
        // A resumed conversation already has a saved system baseline. Without one,
        // the pre-prompt plan→work transition becomes the transcript's first message,
        // an invalid synthetic history once the SDK refreshes context from the manager.
        manager.appendMessage({ role: 'system', content: 'Local integration restored-plan session.',
          toolsAdded: createCodingTools(dir).map(toToolDeclaration), timestamp: Date.now() });
        const planFile = resolve(dir, 'standalone-plan.md');
        writeFileSync(planFile, '# Existing standalone plan\n\nContinue the plan.\n');
        manager.appendCustomEntry('tool-gate:approvals', { version: 1, mode: 'bypassPermissions' });
        manager.appendCustomEntry('plan-mode:inline', { active: true, told: false, planFile });
      }
      ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager,
        model: models.getModel('anthropic', planningId), thinkingLevel: 'off' }));
      const script = [];
      session.agent.streamFunction = (model, context) => {
        requests.push({ model: model.id, messages: structuredClone(context.messages) });
        const systems = context.messages.filter(message => message.role === 'system');
        assert.equal(context.messages[0]?.role, 'system', `${label}: preserve the leading system prompt (request ${requests.length}; persisted roles: ${manager.buildSessionContext().messages.map(message => message.role).join(',')})`);
        const currentSystem = getCurrentSystemMessage(context.messages);
        assert(getSystemMessageText(currentSystem).trim(), `${label}: current system instructions reach the transport`);
        assert(currentSystem.toolsAdded?.some(tool => tool.name === 'read'), `${label}: current read declaration reaches the transport`);
        assert(session.agent.state.tools.some(tool => tool.name === 'read' && typeof tool.execute === 'function'),
          `${label}: the declared read tool remains executable`);
        if (expectedSystems) assert.deepEqual(systems, expectedSystems, `${label}: preserve every system message and patch in order`);
        if (hasGate) {
          const guidance = context.messages.filter(message => messageText(message).includes('Current tool-gate settings:'));
          // Earlier snapshots stay where they first appeared (an append-only prefix keeps the provider
          // cache hitting); the newest one states the live settings.
          assert(guidance.length >= 1, `${label}: at least one request-local settings block`);
          const newest = guidance.at(-1);
          assert.equal(newest.role, 'user', 'the hidden custom snapshot is provider user content, not a system override');
          const mode = /workflow: (\w+)/.exec(statuses.get('workflow-mode') ?? '')?.[1];
          const approval = approvalEvents.at(-1)?.mode === 'bypassPermissions' ? 'yolo' : 'auto';
          assert(messageText(newest).includes(`Current tool-gate settings: workflow **${mode}**; approvals **${approval}**; permission prompts **${expectedPrompts}**`),
            `${label}: request uses live workflow, approval and prompting state`);
          assert(!context.messages.some(message => messageText(message).includes(settingsNoticeText)),
            `${label}: stale busy notice is replaced, not delivered alongside the snapshot`);
          assert.equal(manager.getEntries().some(entry => (entry.type === 'message' ? entry.message : entry).customType === guidanceType), false,
            `${label}: request snapshots never become session entries`);
        }
        const stream = createAssistantMessageEventStream();
        requestedModels.push(model.id);
        const next = script.shift();
        const content = next?.text ? [{ type: 'text', text: next.text }]
          : next ? [{ type: 'toolCall', id: next.id, name: next.name, arguments: next.args }] : [{ type: 'text', text: 'Local response.' }];
        const reason = next && !next.text ? 'toolUse' : 'stop';
        const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() };
        const finish = () => { stream.push({ type: 'done', reason, message }); stream.end(message); };
        queueMicrotask(() => {
          if (next?.hold) {
            const partial = { ...message, content: [{ type: 'text', text: '' }] };
            stream.push({ type: 'start', partial });
            stream.push({ type: 'text_start', contentIndex: 0, partial });
            partial.content[0].text = next.text;
            stream.push({ type: 'text_delta', contentIndex: 0, delta: next.text, partial });
            next.release = () => {
              stream.push({ type: 'text_end', contentIndex: 0, content: next.text, partial: message });
              finish();
            };
          } else finish();
        });
        return stream;
      };
      // RPC approval still runs the real ApprovalPicker choice/effort logic, without a terminal.
      const ui = new Proxy({
        setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
        notify(message) { notifications.push(message); },
        async select(title, options) {
          if (title === 'Implementation effort') {
            assert(!selectedEffort || options.includes(selectedEffort), `missing effort ${selectedEffort}`);
            return selectedEffort ?? options[0];
          }
          assert.equal(title, 'Implement this plan?');
          approvalCount++;
          const selected = options.find(option => option === (approvalChoice === 'compact-here'
            ? 'Yes, compact plan and implement here' : 'Yes, implement here'));
          assert(selected, `${label}: missing ${approvalChoice} choice in ${options}`);
          return selected;
        },
      }, { get(target, key) { return key in target ? target[key] : () => {}; } });
      await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: error => errors.push(error) });
      const nativeThinking = session.setThinkingLevel;
      session.setThinkingLevel = function (level, ...args) {
        thinkingWrites.push(level);
        return nativeThinking.call(this, level, ...args);
      };
      const effortState = () => ({ calls: effortCalls.length, writes: [...thinkingWrites], thinking: session.thinkingLevel });
      const unchangedEffort = async (why, run) => {
        const before = effortState();
        await run();
        assert.deepEqual(effortState(), before, `${label}: ${why} does not classify or write effort`);
      };
      const branchData = type => manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === type).at(-1)?.data;
      const workflow = () => /workflow: (\w+)/.exec(statuses.get('workflow-mode') ?? '')?.[1];
      const transitions = () => manager.getEntries().filter(entry => entry.type === 'custom_message'
        && entry.customType === 'workflow:transition');
      let checkedMode;
      let checkedTransitions = 0;
      let restoring = false;
      const reload = async () => {
        const requestCount = requests.length;
        const before = structuredClone(transitions());
        const calls = effortCalls.length;
        const thinking = session.thinkingLevel;
        await session.reload();
        assert.equal(requests.length, requestCount, `${label}: restoration does not launch a model request`);
        assert.equal(effortCalls.length, calls, `${label}: reload never judges effort`);
        assert.equal(session.thinkingLevel, thinking, `${label}: reload retains native saved effort`);
        assert.deepEqual(transitions(), before, `${label}: reload must not append visible transitions`);
        restoring = true;
      };
      const check = (mode, approval = 'bypassPermissions', intermediate = []) => {
        assert.equal(workflow(), mode, `${label}: workflow status`);
        const visible = transitions();
        const changed = checkedMode !== undefined && checkedMode !== mode && !restoring;
        // RPC cycles remain immediate and retain their normal transition feedback;
        // the coalesced TUI journal is covered by test-footer-controls instead.
        const path = changed ? [checkedMode, ...intermediate, mode] : [];
        assert.equal(visible.length, checkedTransitions + Math.max(0, path.length - 1),
          `${label}: one marker per live RPC transition, none for startup, no-op, approvals or restore`);
        for (let i = 1; i < path.length; i++) {
          const marker = visible[checkedTransitions + i - 1];
          assert.equal(marker.display, true, 'workflow transitions are visible independently of agent reminders');
          assert.deepEqual(marker.details, { version: 1, previous: path[i - 1], mode: path[i] });
        }
        for (const entry of manager.getEntries()) {
          const message = entry.type === 'message' ? entry.message : entry;
          if (entry.type !== 'custom' && ['plan-mode-notice', 'tool-gate:chat-notice'].includes(message.customType)) {
            assert.equal(message.display, false, 'agent workflow reminders stay hidden independently of visible transitions');
          }
        }
        checkedMode = mode;
        checkedTransitions = visible.length;
        restoring = false;
        if (hasGate) {
          assert.equal(approvalEvents.at(-1)?.mode, approval, `${label}: approvals`);
          assert.deepEqual(approvalEvents.at(-1)?.cycle, ['auto', 'bypassPermissions']);
        } else assert.equal(statuses.has('permission-mode'), false, 'standalone plan must not invent approvals');
        assert.deepEqual(errors, [], label);
      };
      const call = async (name, args = {}) => {
        const id = `local-${++callCount}`;
        script.push({ id, name, args });
        const before = requests.length;
        await session.prompt(`Local integration: ${name}`);
        if (name === 'read') {
          // Plan approval may intentionally compact away its own call/result pair.
          assert.equal(requests.length, before + 2, `${label}: tool call has a fresh continuation request: ${session.state.messages.at(-1)?.errorMessage ?? ''}`);
          const continuation = requests.at(-1).messages;
          assert(continuation.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall' && block.id === id)),
            `${label}: preserve the assistant tool call in continuation context`);
          assert(continuation.some(message => message.role === 'toolResult' && message.toolCallId === id),
            `${label}: preserve the paired tool result in continuation context`);
        }
        // Locate the actual tool result persisted by AgentSession.
        const result = manager.getEntries().filter(entry => entry.type === 'message').map(entry => entry.message)
          .filter(message => message.role === 'toolResult' && message.toolCallId === id).at(-1);
        assert(result, `${label}: ${name} executed through AgentSession: ${JSON.stringify(session.state.messages.slice(-2))}`);
        return result;
      };
      const destination = id => ({ id, entryIds: manager.getBranch(id).map(entry => entry.id) });
      const restoreRecords = () => manager.getEntries().filter(entry => entry.type === 'custom'
        && ['tool-gate:workflow', 'plan-mode:inline'].includes(entry.customType)).map(entry => entry.id);
      const go = async target => {
        const requestCount = requests.length;
        const visibleBefore = structuredClone(transitions());
        const before = restoreRecords();
        const calls = effortCalls.length;
        assert.equal((await session.navigateTree(target.id, { summarize: false })).cancelled, false);
        assert.equal(requests.length, requestCount, `${label}: branch restoration does not launch a model request`);
        assert.equal(effortCalls.length, calls, `${label}: branch restoration never reclassifies effort`);
        assert.deepEqual(restoreRecords(), before, `${label}: restoration must not append workflow or inline records`);
        assert.deepEqual(transitions(), visibleBefore, `${label}: tree navigation must not append visible transitions`);
        restoring = true;
        const branch = manager.getBranch();
        assert.deepEqual(branch.slice(0, target.entryIds.length).map(entry => entry.id), target.entryIds,
          `${label}: restoration preserves the destination entry IDs and count`);
        assert.equal(branch.length, target.entryIds.length, `${label}: nothing may follow the stable destination`);
      };
      if (inlineActive) {
        check('plan');
        assert.equal(branchData('plan-mode:inline')?.active, true, 'startup preserves an existing standalone plan');
        await reload();
        check('plan');
        await emitWorkflow(api, 'workflow-mode:set', { mode: 'work' });
        api.events.emit('permission-mode:set', { mode: 'auto' });
      }
      const settingsNotices = () => manager.getEntries().map(entry => entry.type === 'message' ? entry.message : entry)
        .filter(message => message.customType === settingsNoticeType);
      const requestSnapshot = async why => {
        const before = requests.length;
        await session.prompt(`Local integration snapshot: ${why}.`);
        assert.equal(requests.length, before + 1, `${label}: ${why} makes exactly one local request`);
      };
      check('work', 'auto');
      await unchangedEffort('ordinary prompts, tool errors and turn ends', async () => {
        await requestSnapshot('initial prompt');
        // Seed a real transcript patch, not a request-hook fixture. A context handler that
        // folds Pi's system history into one new head must fail this ordered comparison.
        const patch = { role: 'system', content: 'Local integration: preserve this mid-conversation system patch.', timestamp: Date.now() };
        manager.appendMessage(patch);
        session.agent.state.messages = [...session.agent.state.messages, patch];
        expectedSystems = structuredClone(session.state.messages.filter(message => message.role === 'system'));
        assert(expectedSystems.length >= 2, 'fixture contains a leading prompt and a mid-conversation system patch');
        const result = await call('read', { path: resolve(dir, 'missing-effort-regression.txt') });
        assert.equal(result.isError, true, 'exercise a real failed tool result');
        await requestSnapshot('repeated prompt after the failed read');
        expectedSystems = undefined;
      });
      if (hasGate) {
        const noticesBefore = settingsNotices().length;
        api.events.emit('permission-mode:set', { mode: 'bypassPermissions' });
        await requestSnapshot('idle approval change to yolo');
        api.events.emit('permission-mode:set', { mode: 'auto' });
        await session.prompt('/gate prompts off');
        expectedPrompts = 'off';
        await requestSnapshot('idle prompting policy change');
        await session.prompt('/gate prompts on');
        expectedPrompts = 'on';
        await requestSnapshot('idle approval and prompting reset');
        assert.equal(settingsNotices().length, noticesBefore, 'idle settings changes do not queue busy notices');
        const busyChange = async modes => {
          const held = { text: 'Local tool-free streaming response.', hold: true };
          const before = requests.length;
          const noticeCount = settingsNotices().length;
          script.push(held);
          const running = session.prompt('Local integration: change approvals while this response streams.');
          try {
            await boundedUntil(() => held.release, `${label}: controlled local stream starts`);
            assert.equal(session.isStreaming, true, 'change committed settings during an actual SDK stream');
            for (const mode of modes) api.events.emit('permission-mode:set', { mode });
            assert.equal(requests.length, before + 1, 'settings do not interrupt the current streaming request');
          } finally {
            held.release?.();
            await withDeadline(running, `${label}: tool-free busy settings continuation`);
          }
          assert.equal(requests.length, before + 2, 'a busy settings steer causes exactly one tool-free continuation');
          assert.equal(requests.at(-1).messages.some(message => message.role === 'toolResult'
            && !requests[before].messages.some(previous => previous.role === 'toolResult' && previous.toolCallId === message.toolCallId)), false,
          'the continuation is driven by the settings steer, not a newly executed tool');
          const notices = settingsNotices();
          assert.equal(notices.length, noticeCount + 1, 'rapid committed approval changes coalesce to one persisted busy notice');
          assert.equal(notices.at(-1).display, false, 'busy settings notices remain hidden');
          assert.equal(messageText(notices.at(-1)), settingsNoticeText);
        };
        await unchangedEffort('busy approval changes and tool-free continuation', async () => {
          await busyChange(['bypassPermissions', 'auto', 'bypassPermissions', 'bypassPermissions']);
          // The first continuation must clear the coalescing flag for the next batch.
          await busyChange(['auto']);
        });
        check('work', 'auto');
      }
      for (const type of ['input', 'before_agent_start', 'turn_end']) assert(activity.some(event => event.type === type));
      assert(activity.some(event => event.type === 'tool_result' && event.isError));
      await emitWorkflow(api, 'workflow-mode:set', { mode: 'work' });
      api.events.emit('permission-mode:set', { mode: 'auto' });
      check('work', 'auto'); // No-op setters must not create transcript markers.
      if (hasGate) {
        await emitWorkflow(api, 'permission-mode:cycle', {});
        check('work');
        await emitWorkflow(api, 'workflow-mode:cycle', {});
        check('chat');
        await emitWorkflow(api, 'workflow-mode:cycle', {});
        check(hasPlan ? 'plan' : 'work');
        await emitWorkflow(api, 'workflow-mode:set', { mode: 'work' });
        check('work');
      }
      // A custom marker gives real /tree a stable leaf even before any model turn.
      const workLeaf = destination(manager.appendCustomEntry('test:work-marker', {}));
      if (!hasPlan) {
        await emitWorkflow(api, 'workflow-mode:set', { mode: 'plan' });
        check('work');
        await emitWorkflow(api, 'workflow-mode:set', { mode: 'chat' });
        check('chat');
        const chatLeaf = destination(manager.appendCustomEntry('test:chat-marker', {}));
        await go(workLeaf);
        check('work');
        await go(chatLeaf);
        check('chat');
        await requestSnapshot('restored chat branch');
        await reload();
        check('chat');
        await requestSnapshot('reloaded chat branch with existing told marker');
        assert.deepEqual(workflowEvents.at(-1)?.cycle, ['work', 'chat']);
      } else {
        // Inline-only histories also arise when plan-mode previously ran without the gate.
        // Neither an empty file nor a missing file may cause allocation/persistence on restore.
        const planRestores = [];
        for (const kind of ['empty', 'missing']) {
          const planFile = resolve(dir, `${kind}-restore-plan.md`);
          if (kind === 'empty') writeFileSync(planFile, '');
          manager.appendCustomEntry('plan-mode:inline', { active: true, told: false, planFile });
          planRestores.push({ kind, planFile,
            target: destination(manager.appendCustomEntry(`test:${kind}-plan-marker`, {})) });
          await go(workLeaf);
          check('work');
        }
        let chatLeaf;
        if (hasGate) {
          await emitWorkflow(api, 'workflow-mode:set', { mode: 'chat' });
          check('chat');
          chatLeaf = destination(manager.appendCustomEntry('test:chat-marker', {}));
          await go(workLeaf);
          check('work');
        }
        await session.prompt('/plan');
        check('plan');
        const planFile = branchData('plan-mode:inline')?.planFile;
        assert(planFile, `${label}: plan path persisted`);
        if (!inlineActive) assert.match(basename(planFile), /^draft-\d+-[a-f0-9-]+\.md$/u);
        const reviewedPlan = '# Local plan\n\nImplement a local test.\n';
        writeFileSync(planFile, reviewedPlan);
        const planLeaf = destination(manager.appendCustomEntry('test:plan-marker', {}));
        await go(workLeaf);
        check('work');
        await go(planLeaf);
        check('plan');
        await requestSnapshot('restored plan branch');
        await reload();
        check('plan');
        await requestSnapshot('reloaded plan branch');
        if (hasGate) {
          assert.deepEqual(workflowEvents.at(-1)?.cycle, ['work', 'chat', 'plan']);
          const before = manager.getBranch().length;
          await emitWorkflow(api, 'permission-mode:cycle', {});
          check('plan', 'auto');
          await emitWorkflow(api, 'permission-mode:cycle', {});
          check('plan');
          assert.equal(manager.getBranch().slice(before).some(entry => entry.customType === 'plan-mode:inline'), false, 'approval changes do not exit or reenter plan');
        }
        selectedEffort = 'high'; // Effort-only approval stays ordinary work.
        const beforeApproval = effortCalls.length;
        let result = await call('exit_plan_mode');
        assert.equal(effortCalls.length, beforeApproval + 1, 'one Exec judgment at approval, none at commit or continuation');
        assert.equal(effortCalls.at(-1).context.state.phase, 'exec');
        assert.equal(result.details?.outcome, 'approved', JSON.stringify(result));
        const approvedFile = result.details.planFile;
        assert.equal(approvedFile, inlineActive ? planFile : resolve(dir, 'plans/local-plan.md'));
        assert.equal(branchData('plan-mode:inline')?.planFile, approvedFile, 'persist the approved provider path');
        assert.equal(readFileSync(approvedFile, 'utf8'), reviewedPlan);
        assert.equal(readFileSync(planFile, 'utf8'), reviewedPlan, 'approval leaves the original draft intact');
        if (!inlineActive) assert.notEqual(approvedFile, planFile);
        assert(JSON.stringify(requests.at(-1).messages).includes(approvedFile), 'normal continuation receives the approved path');
        check('work');
        assert(manager.getEntries().some(entry => (entry.type === 'message' ? entry.message : entry).customType === 'plan-mode-notice'),
          'real model turns exercise hidden reminders as well as visible transitions');
        assert.equal(session.model.id, planningId);
        assert.equal(session.thinkingLevel, 'high', 'manual approval overrides cumulative medium recommendation');
        await unchangedEffort('manual approved effort across routine continuation', () => session.prompt('Continue the approved work without changing phases.'));
        assert.equal(branchData('plan-mode:exec'), undefined, 'approval never enters the removed exec workflow');
        await reload();
        check('work');
        await session.prompt('/plan');
        check('plan');
        writeFileSync(branchData('plan-mode:inline')?.planFile, '# Compact plan\n\nImplement locally.\n');
        approvalChoice = 'compact-here';
        result = await call('exit_plan_mode');
        assert.equal(result.details?.outcome, 'approved', JSON.stringify(result));
        assert.equal(result.details.planFile, approvedFile, 'compacting an already promoted plan retains its path');
        assert.equal(readFileSync(approvedFile, 'utf8'), '# Compact plan\n\nImplement locally.\n');
        check('work');
        assert.equal(session.model.id, planningId);
        assert.equal(branchData('plan-mode:exec'), undefined);
        // Tree restoration across the work and plan leaves, including inline-only histories.
        await go(planLeaf);
        check('plan');
        assert.equal(branchData('plan-mode:inline')?.active, true, 'work→plan retains the target branch plan');
        if (chatLeaf) {
          await go(workLeaf);
          check('work');
          await go(chatLeaf);
          check('chat');
        }
        for (const { kind, planFile, target } of planRestores) {
          await go(workLeaf);
          check('work');
          await go(target);
          check('plan');
          assert.equal(branchData('plan-mode:inline')?.active, true, `work→${kind} plan stays active`);
          assert.equal(branchData('plan-mode:inline')?.planFile, planFile, `${kind} plan path is preserved`);
          await reload();
          check('plan');
          assert.deepEqual(manager.getBranch().map(entry => entry.id), target.entryIds,
            `${label}: ${kind} plan reload must not append records`);
          if (kind === 'missing') assert.equal(existsSync(planFile), false, 'restoration does not create the missing plan');
          else assert.equal(readFileSync(planFile, 'utf8'), '', 'restoration does not fill the empty plan');
        }
        await go(planLeaf);
        check('plan');
        await go(workLeaf);
        check('work');
        await requestSnapshot('restored work branch after plan approval');
        assert.equal(approvalCount, 2, 'one approval dialog per submission');
      }
      if (hasGate) {
        for (const entry of manager.getEntries()) {
          const message = entry.type === 'message' ? entry.message : entry;
          assert.notEqual(message.customType, guidanceType, `${label}: snapshots never persist under their custom type`);
          assert(!messageText(message).includes('Current tool-gate settings:'),
            `${label}: snapshot text never persists as an ordinary message either`);
        }
        assert(!session.state.messages.some(message => messageText(message).includes('Current tool-gate settings:')),
          `${label}: snapshots never become sticky agent context`);
      }
      assert.deepEqual(errors, [], label);
      await session.dispose();
      session = undefined;
      console.log(`PASS actual Pi mode flow: ${label}, branch restore and reload`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL actual Pi mode flow: ${label}: ${error.message}`);
    } finally {
      await session?.dispose();
      session = undefined;
    }
  }
  assert.deepEqual(networkAttempts, [], 'all model transports remain local');
  if (failures.length) throw new AggregateError(failures, `${failures.length} mode-flow scenarios failed`);
} finally {
  await session?.dispose();
  process.chdir(cwd);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
  for (const restore of restoreNetwork.reverse()) restore();
  syncBuiltinESMExports();
}
