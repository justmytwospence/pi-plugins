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

test('/clear starts a plain new session and carries nothing over', async () => {
  const old = instance({ provider: 'openai-codex', id: 'selected' }, 'xhigh');
  const args = [];
  old.ctx.newSession = async (...a) => { args.push(...a); old.stop(); return { cancelled: false }; };
  await old.commands.get('clear').handler('', old.ctx);
  assert.deepEqual(args, []);
  assert.deepEqual(old.calls, []);
});

test('real Pi runtime clears context and returns to the startup selection across repeated replacements', async () => {
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
    for (let i = 0; i < 2; i++) {
      const old = runtime.session;
      await old.setModel(selected);
      old.setThinkingLevel('high');
      assert.equal(old.thinkingLevel, 'high');
      old.sessionManager.appendMessage({ role: 'user', content: [{ type: 'text', text: 'discard this context' }], timestamp: Date.now() });
      old.refreshContext();
      await old.prompt('/clear');
      assert.notEqual(runtime.session, old);
      assert.equal(runtime.session.model.provider, startup.provider);
      assert.equal(runtime.session.model.id, startup.id);
      assert.equal(runtime.session.thinkingLevel, 'low');
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
