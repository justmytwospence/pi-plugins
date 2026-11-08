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
  const { createAssistantMessageEventStream } = await import(aiUrl.href);
  const { Text } = await import(tuiUrl.href);
  const { AgentSession, ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices,
    createAgentSessionFromServices, createAgentSessionRuntime, initTheme } = sdk;
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
  const failures = [];
  for (const { names, inlineActive } of cases) {
    const label = names.join('+') + (inlineActive ? '-inline-active' : '');
    try {
      const dir = resolve(temp, label);
      mkdirSync(dir, { recursive: true });
      process.chdir(dir); // Gate also resolves its registration-time keys from process.cwd().
      writeFileSync(resolve(temp, 'pi-plan-mode.json'), JSON.stringify({
        thinkingLevel: 'inherit', plansDirectory: resolve(dir, 'plans'), completionReview: false,
        implementationModelMap: { [`anthropic/${planningId}`]: [{ provider: 'anthropic', modelId: implementationId, thinkingLevel: 'off' }] },
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
        const stream = createAssistantMessageEventStream();
        requestedModels.push(model.id);
        const next = script.shift();
        const content = next?.text ? [{ type: 'text', text: next.text }]
          : next ? [{ type: 'toolCall', id: next.id, name: next.name, arguments: next.args }] : [{ type: 'text', text: 'Local response.' }];
        const reason = next && !next.text ? 'toolUse' : 'stop';
        const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() };
        queueMicrotask(() => { stream.push({ type: 'done', reason, message }); stream.end(message); });
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
          const selected = options.find(option => approvalChoice === 'handoff' ? option.startsWith('Yes, hand off to ')
            : option === (approvalChoice === 'compact-here' ? 'Yes, compact plan and implement here' : 'Yes, implement here'));
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
      const hasGate = names.includes('tool-gate');
      const hasPlan = names.includes('plan-mode');
      const branchData = type => manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === type).at(-1)?.data;
      const workflow = () => /workflow: (\w+)/.exec(statuses.get('workflow-mode') ?? '')?.[1];
      const transitions = () => manager.getEntries().filter(entry => entry.type === 'custom_message'
        && entry.customType === 'workflow:transition');
      let checkedMode;
      let checkedTransitions = 0;
      let restoring = false;
      const reload = async () => {
        const before = structuredClone(transitions());
        const calls = effortCalls.length;
        const thinking = session.thinkingLevel;
        await session.reload();
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
          if (['plan-mode-notice', 'tool-gate:chat-notice'].includes(message.customType)) {
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
        await session.prompt(`Local integration: ${name}`);
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
        const visibleBefore = structuredClone(transitions());
        const before = restoreRecords();
        const calls = effortCalls.length;
        assert.equal((await session.navigateTree(target.id, { summarize: false })).cancelled, false);
        assert.equal(effortCalls.length, calls, `${label}: branch restoration never reclassifies effort`);
        assert.deepEqual(restoreRecords(), before, `${label}: restoration must not append workflow or inline records`);
        assert.deepEqual(transitions(), visibleBefore, `${label}: tree navigation must not append visible transitions`);
        restoring = true;
        const branch = manager.getBranch();
        assert.deepEqual(branch.slice(0, target.entryIds.length).map(entry => entry.id), target.entryIds,
          `${label}: restoration preserves the destination entry IDs and count`);
        // Exec may snapshot its restored negotiation state; workflow/inline restoration may not.
        assert(branch.slice(target.entryIds.length).every(entry => entry.type === 'custom'
          && entry.customType === 'plan-mode:exec'), `${label}: only exec snapshots may follow the stable destination`);
      };
      if (inlineActive) {
        check('plan');
        assert.equal(branchData('plan-mode:inline')?.active, true, 'startup preserves an existing standalone plan');
        await reload();
        check('plan');
        await emitWorkflow(api, 'workflow-mode:set', { mode: 'work' });
        api.events.emit('permission-mode:set', { mode: 'auto' });
      }
      check('work', 'auto');
      await unchangedEffort('ordinary prompts, tool errors and turn ends', async () => {
        await session.prompt('Investigate a difficult parser bug and design a fix.');
        const result = await call('read', { path: resolve(dir, 'missing-effort-regression.txt') });
        assert.equal(result.isError, true, 'exercise a real failed tool result');
        await session.prompt('Retry the investigation after the failed read.');
      });
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
        await reload();
        check('chat');
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
        await reload();
        check('plan');
        if (hasGate) {
          assert.deepEqual(workflowEvents.at(-1)?.cycle, ['work', 'chat', 'plan']);
          const before = manager.getBranch().length;
          await emitWorkflow(api, 'permission-mode:cycle', {});
          check('plan', 'auto');
          await emitWorkflow(api, 'permission-mode:cycle', {});
          check('plan');
          assert.equal(manager.getBranch().slice(before).some(entry => entry.customType === 'plan-mode:inline'), false, 'approval changes do not exit or reenter plan');
        }
        selectedEffort = 'high'; // Effort-only approval must remain ordinary work, not exec.
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
        assert(!session.getActiveToolNames().includes('finish_plan'), 'ordinary approval is not exec');
        assert.equal(branchData('plan-mode:exec')?.active, undefined);
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
        assert(!session.getActiveToolNames().includes('finish_plan'), 'compact-here is ordinary work');
        assert.equal(branchData('plan-mode:exec')?.active, undefined);
        await session.prompt('/plan');
        check('plan');
        const handoffFile = branchData('plan-mode:inline')?.planFile;
        writeFileSync(handoffFile, '# Handoff plan\n\nImplement a local test.\n');
        const planningMarker = `planning-history-${label}`;
        await session.prompt(planningMarker);
        const beforeHandoff = requests.length;
        const compactions = () => manager.getEntries().filter(entry => entry.type === 'compaction');
        const beforeCompactions = structuredClone(compactions());
        approvalChoice = 'handoff';
        selectedEffort = 'off';
        result = await call('exit_plan_mode');
        assert.equal(result.details?.outcome, 'handoff', JSON.stringify(result));
        assert.equal(result.details.planFile, approvedFile, 'handoff reuses the previously approved path');
        assert.equal(branchData('plan-mode:exec')?.planFile, approvedFile);
        if (!inlineActive) assert.equal(readFileSync(planFile, 'utf8'), reviewedPlan, 'later revisions do not mutate the original draft');
        assert.equal(session.model.id, implementationId);
        assert.equal(requestedModels.at(-1), implementationId, 'handoff continues using the distinct model');
        assert.deepEqual(requests.slice(beforeHandoff).map(request => request.model), [planningId, implementationId],
          'approval hands off directly without an extra planner turn');
        const firstExecutor = requests[beforeHandoff + 1];
        assert(JSON.stringify(firstExecutor.messages).includes(planningMarker), 'first executor sees planning history');
        assert(firstExecutor.messages.some(message => message.role === 'toolResult'
          && message.toolCallId === result.toolCallId && JSON.stringify(message.content) === JSON.stringify(result.content)),
        'first executor sees the approval tool result');
        assert.deepEqual(compactions(), beforeCompactions, 'handoff must not compact');
        assert.equal(branchData('plan-mode:exec')?.active, true);
        assert(session.getActiveToolNames().includes('finish_plan'));
        check('exec', 'bypassPermissions', ['work']); // Approval exits plan before beginning implementation.
        const execLeaf = destination(manager.appendCustomEntry('test:exec-marker', {}));
        assert(execLeaf.entryIds.includes(planLeaf.id), 'plan target is an ancestor of exec');
        assert(execLeaf.entryIds.includes(workLeaf.id), 'work target is an ancestor of exec');
        if (hasGate) {
          await emitWorkflow(api, 'workflow-mode:cycle', {});
          await emitWorkflow(api, 'workflow-mode:set', { mode: 'work' });
          check('exec');
          assert(notifications.some(message => message.includes('/plan-exec stop')));
          await emitWorkflow(api, 'permission-mode:cycle', {});
          check('exec', 'auto');
          await emitWorkflow(api, 'permission-mode:cycle', {});
        }
        await session.prompt('/plan');
        check('exec');
        await reload();
        check('exec');
        assert.equal(branchData('plan-mode:exec')?.active, true, 'reload does not durably complete exec');
        await unchangedEffort('existing approved execution continuation', () => session.prompt('Resume the selected implementation tuple.'));
        assert(session.getActiveToolNames().includes('finish_plan'));
        await session.prompt('/plan-exec stop');
        check('work');
        assert.equal(branchData('plan-mode:exec')?.active, false);
        await go(execLeaf);
        check('exec');
        // Restore directly from exec into an active inline plan on another branch. An early
        // exec:false publication must not append a workflow=work or inline-exit record.
        await go(planLeaf);
        check('plan');
        assert.equal(branchData('plan-mode:inline')?.active, true, 'exec→plan retains the target branch plan');
        if (chatLeaf) {
          await go(execLeaf);
          check('exec');
          await go(chatLeaf);
          check('chat');
        }
        for (const { kind, planFile, target } of planRestores) {
          await go(execLeaf);
          check('exec');
          await go(target);
          check('plan');
          assert.equal(branchData('plan-mode:inline')?.active, true, `exec→${kind} plan stays active`);
          assert.equal(branchData('plan-mode:inline')?.planFile, planFile, `${kind} plan path is preserved`);
          await reload();
          check('plan');
          assert.deepEqual(manager.getBranch().map(entry => entry.id), target.entryIds,
            `${label}: ${kind} plan reload must not append records`);
          if (kind === 'missing') assert.equal(existsSync(planFile), false, 'restoration does not create the missing plan');
          else assert.equal(readFileSync(planFile, 'utf8'), '', 'restoration does not fill the empty plan');
        }
        // These are true ancestors of exec, not sibling leaves. Cached branch-anchor
        // membership cannot distinguish them from the branch we are leaving.
        await go(execLeaf);
        check('exec');
        await go(planLeaf);
        check('plan');
        await go(execLeaf);
        check('exec');
        await go(workLeaf);
        check('work');
        assert.equal(approvalCount, 3, 'one approval dialog per submission');
        await go(execLeaf);
        check('exec');
        const implementationMarker = `implementation-history-${label}`;
        script.push({ text: implementationMarker });
        await session.prompt('Carry out the approved implementation.');
        const completionReport = `completed-implementation-${label}`;
        result = await call('finish_plan', { report: completionReport, verification: 'Local checks passed.', concerns: 'None.' });
        check('work');
        assert.equal(branchData('plan-mode:exec')?.active, false);
        assert.equal(session.model.id, planningId, 'completion restores the planning model');
        assert(!session.getActiveToolNames().includes('finish_plan'));
        const activeHistory = JSON.stringify(manager.getBranch());
        for (const marker of [planningMarker, implementationMarker, completionReport]) {
          assert(activeHistory.includes(marker), `${label}: completion retains ${marker} on active branch`);
        }
        assert(manager.getBranch().some(entry => entry.type === 'message'
          && entry.message.role === 'toolResult' && entry.message.toolCallId === result.toolCallId),
        'completion result remains on the active branch');
        const beforeFollowup = requests.length;
        await session.prompt('What did we plan and implement?');
        assert.equal(requests.length, beforeFollowup + 1);
        assert.equal(requests.at(-1).model, planningId);
        for (const marker of [planningMarker, implementationMarker, completionReport]) {
          assert(JSON.stringify(requests.at(-1).messages).includes(marker), `restored model sees ${marker}`);
        }
        assert.deepEqual(compactions(), beforeCompactions, 'completion and follow-up must not compact');
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
  // Conversation recovery runs through real AgentSessions, including the reviewer. Only the
  // provider transport and native selections are scripted; no exec handler is called directly.
  const { registerExec } = await jiti.import('../packages/pi-plan-mode/src/exec.ts');
  for (const scenario of ['human-answer', 'failed-review']) {
    const label = `conversation-${scenario}`;
    const reviewers = [];
    try {
      const dir = resolve(temp, label);
      mkdirSync(dir, { recursive: true });
      process.chdir(dir);
      const planFile = resolve(dir, 'plan.md');
      writeFileSync(planFile, '# Local conversation plan\n\nVerify the human-only check.\n');
      const manager = SessionManager.inMemory(dir);
      const errors = [];
      const requests = [];
      const reviewRequests = [];
      const inputs = [];
      const delivered = [];
      const dialogs = [];
      const choices = [];
      const script = [];
      const reviews = [];
      let controller;
      let execContext;
      let unexpectedRequests = 0;
      let toolId = 0;
      const text = value => [{ type: 'text', text: value }];
      const tool = (name, args) => [{ type: 'toolCall', id: `${label}-${++toolId}`, name, arguments: args }];
      const transport = (queue, calls) => (model, context) => {
        calls.push({ model: model.id, messages: structuredClone(context.messages) });
        const stream = createAssistantMessageEventStream();
        const next = queue.shift();
        if (!next) unexpectedRequests++;
        let content;
        let failure;
        try {
          assert(next, `${label}: unexpected provider request`);
          content = typeof next === 'function' ? next(context) : next.content;
          failure = next.error;
        } catch (error) {
          errors.push(error);
          failure = error.message;
        }
        const reason = failure ? 'error' : content?.some(part => part.type === 'toolCall') ? 'toolUse' : 'stop';
        const message = { role: 'assistant', content: content ?? [], api: model.api, provider: model.provider,
          model: model.id, stopReason: reason, ...(failure ? { errorMessage: failure } : {}), timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { stream.push({ type: failure ? 'error' : 'done', reason,
          ...(failure ? { error: message } : { message }) }); stream.end(message); });
        return stream;
      };
      const sessionServices = factories => createAgentSessionServices({ cwd: dir, agentDir: temp, modelRuntime: models,
        settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
          noContextFiles: true, extensionFactories: factories } });
      const services = await sessionServices([pi => {
        controller = registerExec(pi, {
          completionReview: () => true, completionMaxRevisions: () => 2,
          restoreModel: async () => {},
          consultantAccess: () => ({ tools: [], extensions: [], skills: [], policy: {}, systemPrompt: [] }),
          createSession: async () => {
            const services = await sessionServices([]);
            const { session: reviewer } = await createAgentSessionFromServices({ services,
              sessionManager: SessionManager.inMemory(dir), model: models.getModel('anthropic', planningId), thinkingLevel: 'off' });
            reviewers.push(reviewer);
            reviewer.agent.streamFunction = transport(reviews, reviewRequests);
            await reviewer.bindExtensions({ mode: 'print' });
            return { session: reviewer, file: resolve(dir, 'reviewer.jsonl'),
              subscribe: listener => reviewer.subscribe(listener), dispose: () => reviewer.dispose() };
          },
        });
        pi.on('session_start', (_event, ctx) => { execContext = ctx; });
        pi.on('input', event => { inputs.push({ source: event.source, text: event.text }); });
        pi.on('message_end', event => { if (event.message.role === 'user') delivered.push(event.message); });
      }]);
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager,
        model: models.getModel('anthropic', implementationId), thinkingLevel: 'off' }));
      session.agent.streamFunction = transport(script, requests);
      const ui = new Proxy({
        async select(title, options) {
          dialogs.push({ title, options: [...options] });
          assert(choices.length, `${label}: unexpected selection`);
          const choice = choices.shift();
          assert(choice === undefined || options.includes(choice), `${label}: missing choice ${choice}`);
          return choice;
        },
      }, { get: (target, key) => key in target ? target[key] : () => {} });
      await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: error => errors.push(error) });
      controller.begin(execContext, { active: true, planFile, implementer: 'Local implementer',
        implementerModel: `anthropic/${implementationId}`, asks: 0, costUsd: 0,
        planner: { spec: `anthropic/${planningId}`, name: 'Local reviewer', sessionFile: resolve(dir, 'seed.jsonl') } }, { record: true });
      assert(session.getActiveToolNames().includes('continue_plan'));
      const state = () => manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'plan-mode:exec').at(-1).data;
      const completion = { report: 'Implemented local plan.', verification: 'Automated checks passed.', concerns: 'Human-only check pending.' };
      const accepted = { outcome: 'accepted', summary: 'Plan satisfied.', evidence: ['Human answer recorded.'], limitations: [], findings: [] };
      const guidance = context => context.messages.flatMap(message => typeof message.content === 'string'
        ? [message.content] : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text))
        .filter(value => value.includes('An approved plan is being implemented.')).at(-1);
      const turn = async (prompt, steps, source = 'rpc') => {
        const before = requests.length;
        script.push(...steps);
        await session.prompt(prompt, { source });
        assert.equal(requests.length - before, steps.length, `${label}: exact provider calls for ${prompt}`);
        assert.equal(script.length, 0, `${label}: all scripted steps consumed`);
        assert.deepEqual(errors, [], label);
      };
      if (scenario === 'human-answer') {
        const question = 'Did the physical indicator turn green?';
        reviews.push({ content: text(JSON.stringify({ outcome: 'user_needed', summary: 'Human check required.',
          evidence: ['Automated checks passed.'], limitations: ['Cannot observe physical indicator.'], findings: [],
          question, recommendation: 'Check the indicator and reply here.' })) });
        choices.push('Use recommendation');
        await turn('Submit the implementation for review.', [() => tool('finish_plan', completion), () => text('Waiting.')]);
        assert.equal(state().negotiation.pause, undefined);
        // The pause opens one dialog during finish_plan; Use recommendation answers the reviewer.
        assert.equal(dialogs.length, 1, 'a user-needed pause opens its dialog once');
        assert.equal(dialogs[0].title, question);
        assert.deepEqual(dialogs[0].options, ['Use recommendation', 'Finish unreviewed', 'Stop implementation', 'Type something.']);
        assert.equal(state().negotiation.phase, 'revising');
        assert.deepEqual(state().negotiation.userAnswers, ['Use your recommendation: Check the indicator and reply here.']);
        reviews.push({ content: text(JSON.stringify(accepted)) });
        await turn('Continue.', [() => tool('finish_plan', { ...completion, concerns: 'None.' })]);
        assert(JSON.stringify(reviewRequests[1].messages).includes('Use your recommendation'), 'review receives the human evidence');
        assert.equal(delivered.length, 2, 'each input was actually delivered through the real session');
        assert.deepEqual(inputs.map(event => event.source), ['rpc', 'rpc']);
      } else {
        // A failed review is retried once automatically; the second failure pauses and asks.
        reviews.push({ error: 'Local reviewer transport failed.' }, { error: 'Local reviewer transport failed.' });
        choices.push(undefined);
        await turn('Submit the implementation for review.', [() => tool('finish_plan', completion)]);
        const paused = structuredClone(state().negotiation);
        assert.equal(paused.pause.reason, 'failure');
        assert.equal(dialogs.length, 1, 'new failure offers recovery once');
        assert.match(dialogs[0].title, /Review did not finish/u);
        assert.deepEqual(dialogs[0].options, ['Retry review', 'Finish unreviewed', 'Stop implementation', 'Type something.']);
        choices.push(undefined);
        await turn('What happened to the review?', [context => {
          assert.match(guidance(context), /Do not implement while paused/u);
          return text('The local reviewer transport failed.');
        }]);
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.deepEqual(state().negotiation, paused);
        assert.equal(dialogs.length, 2, 'the turn ending reopens the pause dialog; cancelling it changes nothing');
        assert.equal(reviewRequests.length, 2, 'discussion must not retry the reviewer');
        choices.push('Retry review');
        reviews.push({ content: text(JSON.stringify(accepted)) });
        await turn('Please retry the review.', [() => tool('continue_plan', { action: 'retry' }), () => {
          assert.equal(dialogs.length, 3, 'retry requires a fresh dialog choice');
          assert.equal(state().negotiation.phase, 'implementing');
          return tool('finish_plan', { report: 'Replacement must not be used.', verification: 'Replacement.', concerns: 'Replacement.' });
        }]);
        assert.deepEqual(state().negotiation.history[1].report, completion, 'confirmed retry preserves saved report');
        assert.equal(state().negotiation.revisionsUsed, 0, 'retry does not consume a revision');
      }
      assert.equal(state().active, false);
      assert.equal(state().completion.completion, 'accepted');
      assert.equal(reviewRequests.length, scenario === 'human-answer' ? 2 : 3, 'exactly the scripted reviewer calls');
      assert(reviewRequests.every(call => call.model === planningId));
      assert(requests.every(call => call.model === implementationId));
      assert.equal(reviews.length, 0);
      assert.equal(choices.length, 0);
      assert.equal(unexpectedRequests, 0);
      assert(inputs.every(event => !event.text.startsWith('/')), 'conversation needs no slash commands');
      assert(!session.getActiveToolNames().includes('continue_plan'));
      assert.deepEqual(errors, [], label);
      console.log(`PASS actual Pi execution conversation: ${label}, source-aware delivery and bounded review`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL actual Pi execution conversation: ${label}: ${error.stack}`);
    } finally {
      await session?.dispose();
      session = undefined;
      for (const reviewer of reviewers) await reviewer.dispose();
    }
  }
  // Drive the actual approval app while its one task judgment is still pending.
  // Target changes cancel target waits, not the shared judgment; manual choices
  // remain per-target and win even when the late automatic result arrives.
  const { createCustomSelectorHarness } = await jiti.import('../packages/pi-plan-mode/test/support.ts');
  const alternateId = 'claude-haiku-4-5';
  assert(models.getModel('anthropic', alternateId), 'second local implementation target exists');
  for (const names of [['tool-gate', 'plan-mode'], ['plan-mode', 'tool-gate']]) {
    const label = `pending-effort-${names.join('+')}`;
    let opened;
    let release;
    try {
      const dir = resolve(temp, label);
      mkdirSync(dir, { recursive: true });
      process.chdir(dir);
      writeFileSync(resolve(temp, 'tool-gate.json'), JSON.stringify({ defaultApproval: 'yolo' }));
      writeFileSync(resolve(temp, 'pi-plan-mode.json'), JSON.stringify({
        thinkingLevel: 'inherit', plansDirectory: resolve(dir, 'plans'), completionReview: false,
        renderedPlans: false, jevToolSelection: false,
        implementationModelMap: { [`anthropic/${planningId}`]: [implementationId, alternateId]
          .map(modelId => ({ provider: 'anthropic', modelId })) },
      }));
      const errors = [];
      const requests = [];
      const before = effortCalls.length;
      const pendingAnswer = new Promise(resolve => { release = resolve; });
      effortTransport = async ({ model }) => { await pendingAnswer; return effortAnswer(model); };
      const manager = SessionManager.inMemory(dir);
      manager.appendCustomEntry('plan-run', { id: label, createdAt: 1, task: 'Implement the parser fix', state: 'active',
        planners: [{ id: 'A', spec: `anthropic/${planningId}`, name: 'Local planner',
          plan: '# Pending effort plan\n\nImplement the focused parser fix.', revision: 1 }],
        merged: { plan: '# Pending effort plan\n\nImplement the focused parser fix.', revision: 1,
          name: 'Local planner', spec: `anthropic/${planningId}` } });
      const services = await createAgentSessionServices({ cwd: dir, agentDir: temp, modelRuntime: models,
        settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          additionalExtensionPaths: names.map(name => resolve(root, `packages/pi-${name}/src/index.ts`)) } });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, [], label);
      ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager,
        model: models.getModel('anthropic', planningId), thinkingLevel: 'off' }));
      session.agent.streamFunction = (model, context) => {
        requests.push({ model: model.id, messages: structuredClone(context.messages) });
        const stream = createAssistantMessageEventStream();
        const message = { role: 'assistant', content: [{ type: 'text', text: 'Local implementation.' }],
          api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); });
        return stream;
      };
      let harness;
      const ui = new Proxy({
        // SDK prompt wrapping copies enumerable properties, not Proxy fallbacks.
        setStatus() {},
        notify() {},
        custom(factory) { harness = createCustomSelectorHarness(factory, 140, undefined, 40); return harness.resultPromise; },
      }, { get: (target, key) => key in target ? target[key] : () => {} });
      await session.bindExtensions({ mode: 'tui', uiContext: ui, onError: error => errors.push(error),
        commandContextActions: { waitForIdle: () => session.waitForIdle() } });
      assert.deepEqual(errors, [], `${label}: startup`);
      opened = session.prompt('/planners');
      await boundedUntil(() => harness, `${label}: planner app`);
      const screen = () => harness.render().join('\n');
      for (let i = 0; i < 5 && !/⏎ do it/u.test(screen()); i++) harness.handleInput('\t');
      harness.handleInput('\r');
      assert.match(screen(), /● Implement/u);
      await boundedUntil(() => effortCalls.length > before, `${label}: shared judgment started`);
      const call = effortCalls.at(-1);
      assert.match(screen(), /choosing\.\.\./u);
      const focus = label => {
        for (let i = 0; i < 10; i++) {
          if (new RegExp(`${label}\\s+‹`, 'u').test(screen())) return;
          harness.handleInput('\u001b[B');
        }
        assert.fail(`Missing ${label}: ${screen()}`);
      };
      focus('Mode');
      harness.handleInput('\u001b[C'); // Here → first configured target.
      focus('Model');
      harness.handleInput('\u001b[C'); // First → second target, still pending.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(effortCalls.length, before + 1, 'model cycling reuses the in-flight task judgment');
      assert.equal(call.options.signal.aborted, false, 'target cancellation does not abort the shared judgment');
      const choose = level => {
        focus('Effort');
        for (let i = 0; i < 10 && !new RegExp(`Effort\\s+‹ ${level}\\b`, 'u').test(screen()); i++) harness.handleInput('\u001b[C');
        assert.match(screen(), new RegExp(`Effort\\s+‹ ${level}\\b`, 'u'));
      };
      choose('high');
      focus('Model');
      harness.handleInput('\u001b[D');
      choose('low');
      focus('Model');
      harness.handleInput('\u001b[C');
      focus('Effort');
      assert.match(screen(), /Effort\s+‹ high\b/u, 'manual effort is remembered for the second target');
      release();
      await boundedUntil(() => !screen().includes('choosing...'), `${label}: judgment settles`);
      await new Promise(resolve => setImmediate(resolve));
      assert.match(screen(), /Effort\s+‹ high\b/u, 'late automatic medium cannot overwrite manual high');
      assert.equal(effortCalls.length, before + 1);
      harness.handleInput('\r');
      await withDeadline(opened, `${label}: approve`);
      await boundedUntil(() => requests.length > 0, `${label}: executor starts`);
      await session.waitForIdle();
      assert.equal(session.model.id, alternateId);
      assert.equal(session.thinkingLevel, 'high');
      assert.equal(effortCalls.length, before + 1, 'commit does not rejudge an already approved tuple');
      const approvedCalls = effortCalls.length;
      await session.reload();
      await session.prompt('Continue this selected implementation.');
      assert.equal(effortCalls.length, approvedCalls, 'reload and continuation retain approval effort');
      assert.equal(session.thinkingLevel, 'high');
      assert.deepEqual(errors, [], label);
      console.log(`PASS actual Pi pending approval effort: ${label}, one judgment and per-target manual choices`);
    } catch (error) {
      failures.push(error);
      console.error(`FAIL actual Pi pending approval effort: ${label}: ${error.stack}`);
    } finally {
      release?.();
      effortTransport = undefined;
      await session?.dispose();
      session = undefined;
    }
  }
  // /planners' fresh path really replaces the SDK runtime: do not simulate session_start
  // on the old extension objects (that would hide stale-context and load-order bugs).
  for (const names of [['tool-gate', 'plan-mode'], ['plan-mode', 'tool-gate']]) {
    for (const activation of ['success', 'false', 'invalid', 'throw', 'keep-A', 'keep-M']) {
      const keep = activation.startsWith('keep-');
      const label = `${names.join('+')}-${keep ? activation : `fresh-${activation}`}`;
      let runtime;
      try {
        const dir = resolve(temp, label);
        mkdirSync(dir, { recursive: true });
        process.chdir(dir);
        // Fresh sessions use the user's configured default, independently of workflow.
        writeFileSync(resolve(temp, 'tool-gate.json'), JSON.stringify({ defaultApproval: 'yolo' }));
        writeFileSync(resolve(temp, 'pi-plan-mode.json'), JSON.stringify({
          thinkingLevel: 'inherit', plansDirectory: resolve(dir, 'plans'), completionReview: false,
          renderedPlans: false, jevToolSelection: false,
          implementationModelMap: { [`anthropic/${planningId}`]: [{ provider: 'anthropic', modelId: implementationId, thinkingLevel: 'off' }] },
        }));
        const statuses = new Map();
        const errors = [];
        const notes = [];
        const events = [];
        const starts = [];
        const requests = [];
        const script = [];
        let generation = 0;
        let api;
        let harness;
        let finishSwitch;
        let oldEntries;
        const switched = new Promise((resolve, reject) => { finishSwitch = { resolve, reject }; });
        const createRuntime = async ({ sessionManager, sessionStartEvent }) => {
          const owner = ++generation;
          const services = await createAgentSessionServices({ cwd: dir, agentDir: temp, modelRuntime: models,
            settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false } }),
            resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
              additionalExtensionPaths: names.map(name => resolve(root, `packages/pi-${name}/src/index.ts`)),
              extensionFactories: [pi => {
                api = pi;
                pi.events.on('workflow-mode:exec', event => events.push({ owner, ...event }));
                pi.on('before_agent_start', (event, ctx) => {
                  starts.push({ owner, prompt: event.prompt, model: ctx.model?.id,
                    exec: ctx.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === 'plan-mode:exec').at(-1)?.data,
                    tools: pi.getActiveTools() });
                });
              }] } });
          assert.deepEqual(services.resourceLoader.getExtensions().errors, [], label);
          const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
            model: models.getModel('anthropic', planningId), thinkingLevel: 'off' });
          result.session.agent.streamFunction = (model, context) => {
            requests.push({ owner, model: model.id, messages: structuredClone(context.messages) });
            const stream = createAssistantMessageEventStream();
            const next = script.shift();
            const content = next ? [{ type: 'toolCall', id: `${label}-finish`, name: 'finish_plan', arguments: next }]
              : [{ type: 'text', text: model.id === implementationId ? `implementation-marker-${label}` : `planning-response-${label}` }];
            const reason = next ? 'toolUse' : 'stop';
            const message = { role: 'assistant', content,
              api: model.api, provider: model.provider, model: model.id, stopReason: reason, timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
            queueMicrotask(() => { stream.push({ type: 'done', reason, message }); stream.end(message); });
            return stream;
          };
          if (owner === 2 && activation === 'throw') result.session.setModel = async () => { throw new Error('Local activation failure'); };
          return { ...result, services, diagnostics: services.diagnostics };
        };
        const manager = SessionManager.inMemory(dir);
        manager.appendCustomEntry('tool-gate:approvals', { version: 1, mode: 'bypassPermissions' });
        manager.appendCustomEntry('plan-run', { id: label, createdAt: 1, task: 'approved local task', state: 'active',
          planners: [{ id: 'A', spec: `anthropic/${planningId}`, name: 'Local planner',
            plan: '# Planner A SDK plan\n\nImplement planner A locally.', revision: 1 }],
          merged: { plan: '# Fresh SDK plan\n\nImplement locally.', revision: 1,
            name: 'Local planner', spec: `anthropic/${planningId}` } });
        runtime = await createAgentSessionRuntime(createRuntime, { cwd: dir, agentDir: temp, sessionManager: manager });
        const ui = new Proxy({
          setStatus(key, value) { if (value === undefined) statuses.delete(key); else statuses.set(key, value); },
          notify(message) { notes.push({ owner: generation, message }); },
          custom(factory) { harness = createCustomSelectorHarness(factory, 140, undefined, 40); return harness.resultPromise; },
        }, { get(target, key) { return key in target ? target[key] : () => {}; } });
        const bind = async current => {
          const configuredAuth = models.hasConfiguredAuth;
          if (generation === 2 && activation === 'false') models.hasConfiguredAuth = () => false;
          try {
            await current.bindExtensions({ mode: 'tui', uiContext: ui, onError: error => errors.push(error),
              commandContextActions: {
                waitForIdle: () => current.waitForIdle(),
                newSession: async options => {
                  try {
                    oldEntries = structuredClone(current.sessionManager.getEntries());
                    const result = await runtime.newSession({ ...options, setup: async freshManager => {
                      await options.setup(freshManager);
                      if (activation === 'invalid') {
                        const bootstrap = freshManager.getBranch().find(e => e.customType === 'plan-implementation-runtime');
                        freshManager.appendCustomEntry('plan-implementation-runtime', { ...bootstrap.data, model: 'invalid-model-spec' });
                      }
                    } });
                    finishSwitch.resolve(result);
                    return result;
                  } catch (error) { finishSwitch.reject(error); throw error; }
                },
              } });
          } finally { models.hasConfiguredAuth = configuredAuth; }
        };
        runtime.setRebindSession(bind);
        await bind(runtime.session);
        const original = runtime.session;
        const planningMarker = `planner-history-${label}`;
        if (keep) await original.prompt(planningMarker);
        const beforeHandoff = requests.length;
        const parentLeaf = manager.getLeafId();
        const opened = original.prompt('/planners');
        // Wait for the real command's asynchronous settings load to open its actual app.
        await boundedUntil(() => harness, `${label}: planner screen`);
        for (let i = 0; i < 5 && !/⏎ do it/u.test(harness.render().join('\n')); i++) harness.handleInput('\t');
        harness.handleInput('\r');
        assert.match(harness.render().join('\n'), /● Implement/u);
        const focus = label => {
          for (let i = 0; i < 10; i++) {
            if (new RegExp(`${label}\\s+‹`, 'u').test(harness.render().join('\n'))) return;
            harness.handleInput('\u001b[B');
          }
          assert.fail(`Missing ${label}: ${harness.render().join('\n')}`);
        };
        if (keep) {
          focus('Plan');
          const author = activation.slice(5);
          if (!new RegExp(`Plan\\s+‹ ${author}\\b`, 'u').test(harness.render().join('\n'))) harness.handleInput('\u001b[C');
          assert.match(harness.render().join('\n'), new RegExp(`Plan\\s+‹ ${author}\\b`, 'u'));
        }
        focus('Mode');
        harness.handleInput('\u001b[C');
        focus('Context');
        if (!keep) harness.handleInput('\u001b[C');
        assert.match(harness.render().join('\n'), keep ? /this conversation, plus the plan/u : /fresh session with only the plan/u);
        await boundedUntil(() => !harness.render().join('\n').includes('choosing...'), `${label}: settled effort`);
        const approvedEffortCalls = effortCalls.length;
        harness.handleInput('\r');
        await opened;
        assert.equal(effortCalls.length, approvedEffortCalls, 'implementation consumes the selected effort without another judgment');
        if (keep) {
          await boundedUntil(() => requests.length > beforeHandoff, `${label}: implementation request`);
          await original.waitForIdle();
          assert.equal(runtime.session, original, 'keep must retain the original runtime');
          assert.equal(generation, 1);
          assert.deepEqual(requests.slice(beforeHandoff).map(request => request.model), [implementationId],
            'keep hands off directly without another planner turn');
          assert(JSON.stringify(requests.at(-1).messages).includes(planningMarker));
          const exec = () => manager.getBranch().filter(e => e.customType === 'plan-mode:exec').at(-1)?.data;
          assert.equal(exec()?.active, true);
          const approvedPlan = activation === 'keep-A'
            ? '# Planner A SDK plan\n\nImplement planner A locally.' : '# Fresh SDK plan\n\nImplement locally.';
          assert.equal(basename(exec().planFile), activation === 'keep-A' ? 'planner-a-sdk-plan.md' : 'fresh-sdk-plan.md');
          assert.equal(readFileSync(exec().planFile, 'utf8').trim(), approvedPlan);
          assert(JSON.stringify(requests.at(-1).messages).includes(approvedPlan.split('\n')[0]),
            "executor receives the selected author's plan");
          const completionReport = `completion-marker-${label}`;
          script.push({ report: completionReport, verification: 'Local checks passed.', concerns: 'None.' });
          await original.prompt('Finish the implementation.');
          assert.equal(exec()?.active, false);
          assert.equal(original.model.id, planningId);
          assert(manager.getBranch().some(entry => entry.id === parentLeaf), 'keep retains its ancestor');
          for (const marker of [planningMarker, `implementation-marker-${label}`, completionReport]) {
            assert(JSON.stringify(manager.getBranch()).includes(marker), 'keep completion retains both histories');
          }
          await original.prompt('Recall our plan and implementation.');
          assert.equal(requests.at(-1).model, planningId);
          for (const marker of [planningMarker, `implementation-marker-${label}`, completionReport]) {
            assert(JSON.stringify(requests.at(-1).messages).includes(marker), 'restored model sees both histories');
          }
          assert.equal(manager.getEntries().some(entry => entry.type === 'compaction'), false);
          assert.deepEqual(errors, [], label);
          console.log(`PASS actual Pi /planners keep handoff: ${label}, completion and history continuity`);
          continue;
        }
        await withDeadline(switched, `${label}: runtime replacement`);
        assert.notEqual(runtime.session, original, 'handoff must replace, not reuse, the original runtime');
        assert.equal(generation, 2);
        assert.deepEqual(original.sessionManager.getEntries(), oldEntries, 'replacement callbacks cannot write through the stale runtime');
        const fresh = runtime.session;
        const branch = type => fresh.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === type);
        const workflow = () => /workflow: (\w+)/u.exec(statuses.get('workflow-mode') ?? '')?.[1];
        const consumed = () => branch('plan-implementation-runtime-consumed');
        const savedPlanFile = branch('plan-implementation-runtime').at(-1)?.data.exec?.planFile;
        assert.equal(savedPlanFile, resolve(dir, 'plans/fresh-sdk-plan.md'));
        assert.equal(readFileSync(savedPlanFile, 'utf8'), '# Fresh SDK plan\n\nImplement locally.\n');
        const planNotices = () => fresh.sessionManager.getEntries().filter(entry => entry.type === 'message'
          && entry.message.customType === 'plan-mode-notice');
        const checkRecovery = () => {
          const state = branch('plan-mode:inline').at(-1)?.data;
          assert.equal(state?.active, true, 'replacement owns durable active plan recovery');
          assert.equal(state.planFile, savedPlanFile, 'recovery reuses the bootstrap saved plan path');
          assert.equal(readFileSync(state.planFile, 'utf8'), '# Fresh SDK plan\n\nImplement locally.\n',
            'recovery preserves the complete saved plan content');
          assert.deepEqual(starts, [], 'failed activation sends no implementation brief, including after reload');
          assert.deepEqual(requests, [], 'failed activation never requests implementation');
          const notices = planNotices();
          assert(notices.filter(entry => entry.message.details?.active === true).length <= 1,
            'recovery must not duplicate plan entry notices');
          assert.equal(notices.filter(entry => entry.message.details?.active === false).length, 0,
            'failed activation must not send a plan exit notice');
        };
        const checkApprovals = () => assert.match(statuses.get('permission-mode') ?? '', /yolo/u);
        checkApprovals();
        assert.equal(consumed().length, 1, 'replacement consumes the bootstrap once');
        const transition = events.filter(e => e.active && e.source === 'transition');
        let negotiation;
        if (activation === 'success') {
          assert.equal(workflow(), 'exec');
          assert.equal(fresh.model.id, implementationId);
          assert(fresh.getActiveToolNames().includes('finish_plan'));
          assert.deepEqual(transition, [{ owner: 2, active: true, source: 'transition' }]);
          const state = branch('plan-mode:exec').at(-1)?.data;
          assert.equal(state?.active, true);
          assert.equal(state.planFile, savedPlanFile, 'fresh execution reuses the saved descriptive plan path');
          assert.equal(state.implementerModel, `anthropic/${implementationId}`);
          negotiation = structuredClone(state.negotiation);
          assert(negotiation?.executionId, 'fresh begin initializes negotiation identity');
          assert.equal(starts.length, 1, 'implementation is sent once');
          assert.equal(starts[0].owner, 2, 'only the replacement runtime starts implementation');
          assert.equal(starts[0].model, implementationId);
          assert.equal(starts[0].exec?.active, true, 'matching exec must already exist before the brief');
          assert.equal(starts[0].exec?.planFile, state.planFile);
          assert.equal(starts[0].exec?.implementerModel, state.implementerModel);
          assert(starts[0].tools.includes('finish_plan'));
          assert.match(starts[0].prompt, /# Fresh SDK plan/u);
          assert.match(starts[0].prompt, /finish_plan/u);
          assert.deepEqual(requests.map(({ owner, model }) => ({ owner, model })), [{ owner: 2, model: implementationId }]);
        } else {
          assert.equal(workflow(), 'plan');
          assert.equal(fresh.model.id, planningId);
          assert.equal(branch('plan-mode:exec').length, 0, 'failed bootstrap must not durably enter exec');
          assert.deepEqual(transition, []);
          assert(!fresh.getActiveToolNames().includes('finish_plan'));
          assert.equal(typeof savedPlanFile, 'string', 'bootstrap retains the saved plan path');
          checkRecovery();
          assert(notes.some(note => note.owner === 2 && /approve.*again|reapproval/iu.test(note.message)), 'fresh UI explains reapproval');
          assert.deepEqual(starts, [], 'failed activation sends no implementation brief');
          assert.deepEqual(requests, []);
        }
        const visibleTransitions = () => fresh.sessionManager.getEntries().filter(entry => entry.type === 'custom_message'
          && entry.customType === 'workflow:transition');
        const initialTransitions = structuredClone(visibleTransitions());
        assert.equal(initialTransitions.length, 1,
          'fresh bootstrap emits one live transition into exec or recovery plan, not a startup marker');
        assert.equal(initialTransitions[0].display, true);
        assert.deepEqual(initialTransitions[0].details,
          { version: 1, previous: 'work', mode: activation === 'success' ? 'exec' : 'plan' });
        for (const entry of planNotices()) assert.equal(entry.message.display, false, 'fresh plan reminders stay hidden');
        const recovery = structuredClone(branch('plan-mode:inline'));
        const recoveryNotices = structuredClone(planNotices());
        const recoveryNotes = structuredClone(notes);
        for (let i = 0; i < 2; i++) {
          await fresh.reload();
          assert.equal(effortCalls.length, approvedEffortCalls, 'fresh bootstrap/reload never rejudges the approved tuple');
          assert.deepEqual(visibleTransitions(), initialTransitions, 'fresh reload must not append visible transitions');
          assert.equal(consumed().length, 1, 'reload must not consume or rerun bootstrap again');
          assert.equal(workflow(), activation === 'success' ? 'exec' : 'plan');
          checkApprovals();
          assert.equal(events.filter(e => e.active && e.source === 'transition').length, activation === 'success' ? 1 : 0);
          if (negotiation) {
            assert.deepEqual(branch('plan-mode:exec').at(-1)?.data.negotiation, negotiation, 'restore preserves initialized negotiation');
            assert(fresh.getActiveToolNames().includes('finish_plan'));
          } else {
            assert.equal(branch('plan-mode:exec').length, 0);
            assert.deepEqual(branch('plan-mode:inline'), recovery, 'reload does not duplicate recovery or use stale inline state');
            checkRecovery();
            assert.deepEqual(planNotices(), recoveryNotices, 'reload does not append plan entry or exit notices');
            assert.deepEqual(notes, recoveryNotes, 'reload does not repeat recovery UI notifications');
            assert(!fresh.getActiveToolNames().includes('finish_plan'));
          }
        }
        assert.deepEqual(original.sessionManager.getEntries(), oldEntries, 'old runtime must never persist recovery after replacement');
        assert.equal(starts.length, activation === 'success' ? 1 : 0, 'reload never resends implementation');
        if (activation === 'success') {
          const childManager = fresh.sessionManager;
          const childLeaf = childManager.getLeafId();
          script.push({ report: `fresh-completion-${label}`, verification: 'Local checks passed.', concerns: 'None.' });
          await fresh.prompt('Finish this child implementation.');
          assert.equal(runtime.session, fresh, 'completion stays in the child runtime');
          assert.equal(runtime.session.sessionManager, childManager, 'completion never returns to the parent manager');
          assert.notEqual(childManager, manager);
          assert(childManager.getBranch().some(entry => entry.id === childLeaf), 'completion retains the child branch');
          assert.equal(branch('plan-mode:exec').at(-1)?.data.active, false);
          assert(JSON.stringify(childManager.getBranch()).includes(`fresh-completion-${label}`));
          assert.deepEqual(manager.getEntries(), oldEntries, 'child completion leaves parent unchanged');
        }
        assert.deepEqual(errors, [], label);
        console.log(`PASS actual Pi /planners fresh handoff: ${label}, once-only bootstrap and reload`);
      } catch (error) {
        failures.push(error);
        console.error(`FAIL actual Pi /planners fresh handoff: ${label}: ${error.stack}`);
      } finally {
        await runtime?.dispose();
      }
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
