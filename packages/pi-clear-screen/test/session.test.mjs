import assert from 'node:assert/strict';
import { test } from 'node:test';
import clearScreen from '../src/index.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices,
  createAgentSessionFromServices, createAgentSessionRuntime } from '@earendil-works/pi-coding-agent';

function instance(model, thinkingLevel = 'high', manager = { entries: [], getBranch() { return this.entries; }, appendCustomEntry(customType, data) { this.entries.push({ type: 'custom', customType, data }); } }) {
  let active = true;
  const handlers = new Map();
  const commands = new Map();
  const calls = [];
  const ctx = { mode: 'print', sessionManager: manager, model, thinkingLevel,
    modelRegistry: { find: (provider, id) => ({ provider, id }) },
  };
  clearScreen({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerShortcut() {},
    setModel: async model => { assert.ok(active, 'never use stale pi'); calls.push(['model', model]); return true; },
    setThinkingLevel: level => { assert.ok(active, 'never use stale pi'); calls.push(['thinking', level]); },
  });
  handlers.get('session_start')({}, ctx);
  return { ctx, calls, commands, handlers, stop() { handlers.get('session_shutdown')({}, ctx); active = false; } };
}

test('/clear restores model and thinking through the fresh extension instance', async () => {
  const old = instance({ provider: 'openai-codex', id: 'selected' }, 'xhigh');
  const fresh = instance({ provider: 'anthropic', id: 'startup' });
  let stale = false;
  const original = old.ctx;
  const ctx = new Proxy(original, { get(target, key) { assert.ok(!stale, 'never use stale ctx'); return target[key]; } });
  original.newSession = async options => {
    old.stop(); stale = true;
    await options.setup(fresh.ctx.sessionManager);
    await fresh.handlers.get('session_start')({ reason: 'new' }, fresh.ctx);
    return { cancelled: false };
  };
  await old.commands.get('clear').handler('', ctx);
  assert.deepEqual(old.calls, []);
  assert.deepEqual(fresh.calls, [['model', { provider: 'openai-codex', id: 'selected' }], ['thinking', 'xhigh']]);
  fresh.stop();
});

test('cancelled /clear leaves the current selection alone', async () => {
  const old = instance({ provider: 'test', id: 'selected' });
  old.ctx.newSession = async () => ({ cancelled: true });
  await old.commands.get('clear').handler('', old.ctx);
  assert.deepEqual(old.calls, []);
  old.stop();
});

test('/clear without a selected model still creates a session', async () => {
  const old = instance(undefined);
  let created = false;
  old.ctx.newSession = async options => { created = true; old.stop(); await options.setup({ appendCustomEntry() { assert.fail('no selection to restore'); } }); return { cancelled: false }; };
  await old.commands.get('clear').handler('', old.ctx);
  assert.ok(created);
});

test('real Pi runtime clears context and preserves a non-startup selection across repeated replacements', async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'pi-clear-model-'));
  let runtime;
  try {
    const models = await ModelRuntime.create({ agentDir: dir });
    await models.setRuntimeApiKey('anthropic', 'test-placeholder');
    await models.setRuntimeApiKey('openai', 'test-placeholder');
    const startup = models.getModel('anthropic', 'claude-opus-4-5');
    const selected = models.getModel('openai', 'gpt-5');
    assert.ok(startup); assert.ok(selected);
    const factory = async ({ cwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({ cwd, agentDir: dir, modelRuntime: models,
        settingsManager: SettingsManager.inMemory({ cacheWarming: 'off' }),
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true,
          noThemes: true, noContextFiles: true, extensionFactories: [clearScreen] },
      });
      const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent,
        model: startup, thinkingLevel: 'low', tools: [] });
      return { ...result, services, diagnostics: services.diagnostics };
    };
    runtime = await createAgentSessionRuntime(factory, { cwd: dir, agentDir: dir, sessionManager: SessionManager.inMemory(dir) });
    const bind = async session => session.bindExtensions({ commandContextActions: {
      newSession: options => runtime.newSession(options),
    } });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    await runtime.session.setModel(selected);
    runtime.session.setThinkingLevel('high');
    for (let i = 0; i < 2; i++) {
      const old = runtime.session;
      old.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'discard this context' }], timestamp: Date.now() });
      old.refreshContext();
      await old.prompt('/clear');
      assert.notEqual(runtime.session, old);
      assert.equal(runtime.session.model.provider, selected.provider);
      assert.equal(runtime.session.model.id, selected.id);
      assert.equal(runtime.session.thinkingLevel, 'high');
      assert.equal(runtime.session.messages.length, 0);
    }
  } finally {
    await runtime?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('/exit requests shutdown', async () => {
  const old = instance(undefined);
  let shutdown = false;
  old.ctx.shutdown = () => { shutdown = true; };
  await old.commands.get('exit').handler('', old.ctx);
  assert.ok(shutdown);
  old.stop();
});
