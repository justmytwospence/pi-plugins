// Capture the real gate commands before handing their native selects to both phone readers.
// The catalog/role provider is local fixture data: no inference, model transport or saved settings.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
import path from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';

// Use the same SDK identity as the directly imported gate, including its local install.
// A non-writable adapter method exercises the real unavailable-guard path, then is restored.
const gateJiti = createJiti(new URL('../../packages/pi-tool-gate/src/index.ts', import.meta.url).href);
const { AgentSession } = await gateJiti.import('@earendil-works/pi-coding-agent');
const model = (provider, id) => ({ provider, id, name: id, api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-responses', type: 'chat', reasoning: true });
const models = [model('anthropic', 'claude-opus-5-5'), model('openai', 'gpt-6.1')];
const linkedLabels = ['Work', 'Chat', 'Plan'].map(label => `${label} · claude-opus-5-5`);
const flowLabels = ['Independent', 'Linked · anthropic', 'Linked · openai'];
const execLabels = ['Revisit plan', 'Execution status', 'Use Independent mode'];
const replanLabels = ['Keep planning', 'Execution status', 'Stop implementation', 'Use Independent mode'];
const specs = [
  { name: '/mode picker', command: 'mode', question: 'Workflow', labels: ['Work', 'Chat', 'Plan', 'Operating mode...'] },
  { name: '/approvals picker', command: 'approvals', question: 'Approvals', labels: ['Auto', 'Yolo'] },
  { name: '/flow picker', command: 'flow', question: 'Operating mode', labels: flowLabels },
  { name: 'linked /flow picker', command: 'flow', linked: true, question: 'Operating mode', labels: flowLabels },
  { name: 'linked /mode picker', command: 'mode', linked: true, question: 'Workflow · Linked anthropic', labels: [...linkedLabels, 'Change provider...', 'Use Independent mode'] },
  { name: 'linked Exec /mode picker', command: 'mode', linked: true, exec: true, question: 'Workflow · Exec active', labels: execLabels },
  { name: 'linked Exec /flow picker', command: 'flow', linked: true, exec: true, question: 'Operating mode · Exec active', labels: execLabels },
  ...['mode', 'flow'].map(command => ({ name: `linked replanning /${command} picker`, command, linked: true, exec: true, replanning: true,
    question: `${command === 'mode' ? 'Workflow' : 'Operating mode'} · Revisiting plan`, labels: replanLabels })),
  ...['roles', 'guard'].flatMap(unavailable => [
    { name: `/flow picker (unavailable ${unavailable})`, command: 'flow', unavailable, question: 'Operating mode', labels: unavailable === 'roles' ? ['Independent', 'Flow status'] : flowLabels },
    { name: `/mode picker (unavailable ${unavailable})`, command: 'mode', unavailable, question: 'Workflow', labels: ['Work', 'Chat', 'Plan', 'Operating mode...'] },
  ]),
  ...['roles', 'guard', 'assignment'].flatMap(unavailable => [
    { name: `blocked Linked /flow picker (${unavailable})`, command: 'flow', unavailable, linked: true, blockedQuestion: true, labels: unavailable === 'roles' ? ['Independent', 'Flow status'] : flowLabels },
    { name: `blocked Linked /mode picker (${unavailable})`, command: 'mode', unavailable, linked: true, blockedQuestion: true,
      labels: [...(unavailable === 'assignment' ? ['Work', 'Chat', 'Plan'].map(label => `${label} · unavailable-model`) : linkedLabels), 'Change provider...', 'Use Independent mode'] },
  ]),
];

export async function gatePickerDialogs({ toolGate, ExtensionSelectorComponent }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-client-workflows-'));
  const environment = { PI_CODING_AGENT_DIR: path.join(dir, 'agent'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  const saved = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try {
    const dialogs = [];
    for (const spec of specs) {
      const handlers = new Map(), commands = new Map(), bus = new EventEmitter();
      const events = {
        emit: (name, data) => bus.emit(name, data),
        on: (name, handler) => { bus.on(name, handler); return () => bus.off(name, handler); },
      };
      const assignedId = spec.unavailable === 'assignment' ? 'unavailable-model' : models[0].id;
      const entries = [
        { type: 'custom', id: 'workflow', customType: 'tool-gate:workflow', data: { version: 1, mode: 'work' } },
        { type: 'custom', id: 'approvals', customType: 'tool-gate:approvals', data: { version: 1, mode: 'auto' } },
        ...(spec.linked ? [{ type: 'custom', id: 'flow', customType: 'tool-gate:flow', data: {
          version: 1, operatingMode: 'linked', revision: 1,
          selectedFlow: { provider: models[0].provider, anchorModel: models[0].id,
            roles: Object.fromEntries(['work', 'chat', 'plan', 'exec'].map(phase => [phase, {
              provider: models[0].provider, modelId: assignedId, suggestedThinking: 'high',
            }])),
          },
        } }] : []),
        ...(spec.exec ? [{ type: 'custom', id: 'exec', customType: 'plan-mode:exec', data: { active: true, planFile: '/tmp/client-plan.md', ...(spec.replanning ? { replanning: { version: 1, draftFile: '/tmp/client-revision.md' } } : {}) } }] : []),
      ];
      let blocked = false, thinking = 'high', captured;
      const notifications = [];
      events.on('herdr:blocked', ({ active }) => { blocked = active; });
      if (spec.unavailable !== 'roles') events.on('subagents:role-model', request => {
        assert.ok(['general', 'planner', 'worker'].includes(request.role), 'flows use only their declared role provider');
        assert.ok(request.availableModels.some(candidate => `${candidate.provider}/${candidate.id}` === request.parent));
        request.reply = { model: request.parent, thinking: 'high' };
      });
      const ctx = {
        hasUI: true, mode: 'tui', cwd: dir, isIdle: () => true, model: models[0],
        modelRegistry: { getAvailable: () => models, getAll: () => models, find: (provider, id) => models.find(model => model.provider === provider && model.id === id) },
        sessionManager: { getBranch: () => entries, getSessionId: () => 'remote-picker', getLeafId: () => entries.at(-1).id },
        ui: {
          setStatus() {}, notify: message => notifications.push(message),
          select: async (title, options) => {
            assert.ok(blocked, `${spec.name} holds herdr:blocked while its native select waits`);
            assert.equal(captured, undefined, 'one command opens one picker');
            if (spec.blockedQuestion) {
              assert.match(title, /blocked/iu, 'blocked Linked mode must not present a healthy workflow picker');
              assert.match(title, /\/flow independent/u, 'blocked picker question includes the recovery command');
            } else assert.equal(title, spec.question);
            assert.deepEqual(options, spec.labels);
            assert.ok(options.every(label => visibleWidth(label) <= 42), 'native options fit the phone without unguttered wrapping');
            captured = { title, options: [...options] };
            return undefined;
          },
        },
      };
      const cycleDescriptor = Object.getOwnPropertyDescriptor(AgentSession.prototype, 'cycleModel');
      if (spec.unavailable === 'guard') {
        assert.ok(cycleDescriptor?.writable && cycleDescriptor.configurable, 'guard fixture requires the real writable SDK adapter');
        Object.defineProperty(AgentSession.prototype, 'cycleModel', { ...cycleDescriptor, writable: false });
      }
      toolGate({
        on: (name, handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
        registerShortcut() {}, registerMessageRenderer() {}, getAllTools: () => [],
        registerCommand: (name, spec) => commands.set(name, spec), events,
        appendEntry: (customType, data) => entries.push({ type: 'custom', id: `entry-${entries.length}`, customType, data }),
        getThinkingLevel: () => thinking, setThinkingLevel: level => { thinking = level; },
        setModel: async () => assert.fail('read-only picker fixtures must not change the physical model'),
        exec: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', killed: false }),
      });
      // Model capture normally runs between extension factories and session_start.
      // Exercise the real SDK binding method while keeping these read-only picker
      // fixtures independent of transports and terminal runtime construction.
      const capturedSession = Object.create(AgentSession.prototype);
      Object.defineProperty(capturedSession, 'sessionManager', { value: ctx.sessionManager });
      capturedSession._bindExtensionCore({ bindCore() {} });
      const emit = async name => { for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx); };
      const snapshot = () => { const request = { kind: 'query' }; events.emit('pi-plugins.workflow-flow.v1', request); return structuredClone(request.snapshot); };
      try {
        events.emit('workflow-mode:plan-provider', { planFile: '/tmp/client-plan.md' });
        events.emit('subagents:role-model-ready', { ready: spec.unavailable !== 'roles' });
        await emit('session_start');
        const before = snapshot();
        assert.ok(before?.ready, 'gate fixture must run the real startup lifecycle');
        assert.equal(before.operatingMode, spec.linked ? 'linked' : 'independent');
        assert.equal(before.replanning, spec.replanning ? true : undefined);
        assert.equal(before.workflow, spec.replanning ? 'plan' : spec.exec ? 'exec' : 'work');
        assert.equal(before.guardAvailable, spec.unavailable !== 'guard', 'fixture exercises the actual guard adapter availability');
        if (spec.linked && spec.unavailable) {
          assert.match(before.blocked, spec.unavailable === 'guard' ? /model guard/iu : spec.unavailable === 'roles' ? /Role defaults unavailable/u : /unavailable-model/u);
          assert.match(before.blocked, /\/flow independent/u, 'blocked restoration keeps explicit recovery');
        } else assert.equal(before.blocked, undefined, 'healthy picker must not secretly be a blocked-flow fixture');
        if (spec.unavailable) {
          await commands.get('flow').handler('status', ctx);
          assert.equal(notifications.length, 1, 'flow status reports exactly once');
          const status = notifications.pop();
          assert.match(status, new RegExp(`Model guard: ${spec.unavailable === 'guard' ? 'unavailable' : 'available'}`));
          if (spec.unavailable === 'roles') assert.match(status, /Role defaults unavailable/u);
          if (spec.linked) assert.match(status, /Blocked:.*\/flow independent/u);
          assert.match(status, /Usage: \/flow \[status\|independent\|linked \[provider\]\]/u);
        }
        const branch = structuredClone(entries);
        assert.ok(commands.has(spec.command), `/${spec.command} is registered`);
        await commands.get(spec.command).handler('', ctx);
        assert.ok(captured, `${spec.name} opens a native select`);
        assert.equal(blocked, false, `${spec.name} releases its hold on cancellation`);
        assert.deepEqual(snapshot(), before, 'cancelling leaves operating mode, provider, workflow and revision unchanged');
        assert.deepEqual(entries, branch, 'cancelling persists no model/default/workflow changes');
        assert.equal(thinking, 'high', 'cancelling preserves reasoning');
        assert.deepEqual(notifications, [], 'picker capture must not silently hide a lifecycle error');
        dialogs.push({
          name: spec.name, question: captured.title.replace(/\s+/gu, ' ').trim(),
          lines: width => new ExtensionSelectorComponent(captured.title, captured.options, () => {}, () => {}).render(width),
          herdr: { options: captured.options.length, multi: false, labels: captured.options },
          collie: { kind: 'prompt-select', options: captured.options.length + 1, labels: captured.options, wraps: captured.options },
        });
      } finally {
        try { await emit('session_shutdown'); }
        finally {
          if (spec.unavailable === 'guard') Object.defineProperty(AgentSession.prototype, 'cycleModel', cycleDescriptor);
        }
      }
    }
    return dialogs;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
