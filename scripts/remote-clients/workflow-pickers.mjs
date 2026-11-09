// Capture the real gate commands before handing their native selects to both phone readers.
// The catalog is local fixture data: no inference, model transport or saved settings.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';

const model = (provider, id) => ({ provider, id, name: id, api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-responses', type: 'chat', reasoning: true });
const models = [model('anthropic', 'claude-opus-5-5'), model('openai', 'gpt-6.1')];
const specs = [
  { name: '/mode picker', command: 'mode', question: 'Workflow', labels: ['Work', 'Chat', 'Plan'] },
  ...['on', 'off'].map(prompting => ({ name: `/approvals picker (prompts ${prompting})`, command: 'approvals', prompting, labels: ['Auto', 'Yolo', `Turn permission prompts ${prompting === 'on' ? 'off' : 'on'}`] })),
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
      const entries = [
        { type: 'custom', id: 'workflow', customType: 'tool-gate:workflow', data: { version: 1, mode: 'work' } },
        { type: 'custom', id: 'approvals', customType: 'tool-gate:approvals', data: { version: 1, mode: 'auto' } },
        ...(spec.prompting ? [{ type: 'custom', id: 'prompting', customType: 'tool-gate:prompting', data: { version: 1, denyInsteadOfPrompting: spec.prompting === 'off' } }] : []),
      ];
      let blocked = false, thinking = 'high', captured;
      const notifications = [];
      events.on('herdr:blocked', ({ active }) => { blocked = active; });
      const ctx = {
        hasUI: true, mode: 'tui', cwd: dir, isIdle: () => true, model: models[0],
        modelRegistry: { getAvailable: () => models, getAll: () => models, find: (provider, id) => models.find(model => model.provider === provider && model.id === id) },
        sessionManager: { getBranch: () => entries, getSessionId: () => 'remote-picker', getLeafId: () => entries.at(-1).id },
        ui: {
          setStatus() {}, notify: message => notifications.push(message),
          select: async (title, options) => {
            assert.ok(blocked, `${spec.name} holds herdr:blocked while its native select waits`);
            assert.equal(captured, undefined, 'one command opens one picker');
            if (spec.prompting) {
              assert.equal(title, `Approvals · Permission prompts: ${spec.prompting}\n/gate prompts default restores inherited/config policy.`);
            } else assert.equal(title, spec.question);
            assert.deepEqual(options, spec.labels);
            assert.ok(options.every(label => visibleWidth(label) <= 42), 'native options fit the phone without unguttered wrapping');
            captured = { title, options: [...options] };
            return undefined;
          },
        },
      };
      toolGate({
        on: (name, handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); return () => {}; },
        registerShortcut() {}, registerMessageRenderer() {}, getAllTools: () => [],
        registerCommand: (name, spec) => commands.set(name, spec), events,
        appendEntry: (customType, data) => entries.push({ type: 'custom', id: `entry-${entries.length}`, customType, data }),
        getThinkingLevel: () => thinking, setThinkingLevel: level => { thinking = level; },
        setModel: async () => assert.fail('read-only picker fixtures must not change the physical model'),
        exec: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', killed: false }),
      });
      const emit = async name => { for (const handler of handlers.get(name) ?? []) await handler({ type: name }, ctx); };
      try {
        events.emit('workflow-mode:plan-provider', { planFile: '/tmp/client-plan.md' });
        await emit('session_start');
        const branch = structuredClone(entries);
        assert.ok(commands.has(spec.command), `/${spec.command} is registered`);
        await commands.get(spec.command).handler('', ctx);
        assert.ok(captured, `${spec.name} opens a native select`);
        assert.equal(blocked, false, `${spec.name} releases its hold on cancellation`);
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
        await emit('session_shutdown');
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
