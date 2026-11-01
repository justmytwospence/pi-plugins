// Offline cross-component coverage: every existing classifier path follows one agent-dir setting.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createJiti } from 'jiti';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jiti = createJiti(import.meta.url, { interopDefault: true });
const dir = mkdtempSync(join(tmpdir(), 'pi-system1-integration-'));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const select = backend => writeFileSync(join(dir, 'system1.json'), JSON.stringify({ backend }));
const config = { enabled: true, provider: 'typesafe', model: 'jev-latest', timeoutMs: 1000 };
const question = { type: 'bool', instructions: 'Is this true?', criteria: { true: 'True', false: 'False' } };
const questions = { q: question };
const usage = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } };
const answered = (model, context) => ({
  model: model.id, stopReason: 'stop', usage,
  answers: Object.fromEntries(Object.entries(context.questions).map(([id, q]) => [id,
    q.type === 'bool' ? { type: 'bool', probability: 0.9 } : q.type === 'score'
      ? { type: 'score', score: 0.5, confidence: 0.9 }
      : { type: 'choice', choice: Object.keys(q.criteria)[0], confidence: 1,
        probabilities: Object.fromEntries(Object.keys(q.criteria).map((key, i) => [key, i ? 0 : 1])) },
  ])),
});
function registry({ native = true, pending = false } = {}) {
  const lookups = [], calls = [], available = [];
  let settle;
  return {
    lookups, calls, available,
    findOfType(type, provider, id) {
      assert.equal(type, 'classifier'); lookups.push({ provider, id });
      if (provider === 'system1-openai' && !native) return undefined;
      return { type: 'classifier', provider, id, api: provider === 'system1-openai' ? 'openai-decisions' : 'typesafe-system-one', baseUrl: 'https://api.openai.com/v1' };
    },
    async getAvailableOfType(type, provider) {
      assert.equal(type, 'classifier'); available.push(provider);
      return provider === 'system1-openai'
        ? native ? [{ provider, id: 'gpt-6-luna' }] : []
        : provider === 'typesafe' ? [{ provider, id: 'jev-latest' }] : [];
    },
    async classify(model, context, options) {
      calls.push({ model, context, options });
      assert.equal(options.retries, 0, 'host retry multiplication is disabled');
      if (pending) return await new Promise(resolve => { settle = () => resolve(answered(model, context)); });
      return answered(model, context);
    },
    settle() { assert.ok(settle, 'a fake request must be pending'); settle(); },
  };
}

try {
  // The real extension loader aliases Pi AI package roots to its compatibility module.
  // A plain jiti/unit import is not equivalent: unsupported subpaths can silently fail.
  const sdkEntry = process.env.PI_TEST_SDK || import.meta.resolve('@earendil-works/pi-coding-agent');
  const sdkUrl = sdkEntry.startsWith('file:') ? sdkEntry : pathToFileURL(sdkEntry).href;
  const { loadExtensions, createExtensionRuntime } = await import(new URL('./core/extensions/loader.js', sdkUrl));
  const extensionRuntime = createExtensionRuntime();
  const loaded = await loadExtensions([resolve(root, 'packages/pi-system1/src/index.ts')], dir, undefined, extensionRuntime);
  assert.deepEqual(loaded.errors, [], 'the actual SDK loader accepts the extension');
  const provider = extensionRuntime.pendingNativeProviderRegistrations.find(entry => entry.provider.id === 'system1-openai')?.provider;
  assert.ok(provider, 'the actual SDK loader must register the Decisions login provider, not only the tool');
  assert.equal(typeof provider.auth.apiKey?.login, 'function');
  assert.equal(provider.auth.oauth, undefined);
  const { InteractiveMode } = await import(new URL('./modes/interactive/interactive-mode.js', sdkUrl));
  const interactive = Object.create(InteractiveMode.prototype);
  Object.defineProperty(interactive, 'session', { value: { modelRuntime: {
    getProviders: () => [provider], getProviderAuthStatus: () => ({ configured: false }), isUsingOAuth: () => false,
  } } });
  const loginPrompts = [];
  interactive.showApiKeyLoginDialog = async (id, name) => { loginPrompts.push({ id, name }); };
  interactive.showLoginDialog = () => assert.fail('Decisions must not start an OAuth login');
  interactive.showLoginProviderSelector = () => assert.fail('the exact provider ID must not fall through to provider search');
  await interactive.handleLoginCommand('system1-openai');
  assert.deepEqual(loginPrompts, [{ id: 'system1-openai', name: 'OpenAI Decisions (API credits)' }]);
  console.log('PASS actual SDK loader and /login system1-openai API-key prompt routing (no credentials or network)');

  const adapters = [];
  for (const name of ['auto-effort', 'copy', 'next-prompt', 'subagents', 'tool-gate']) {
    const { askJev } = await jiti.import(`../packages/pi-${name}/src/jev.ts`);
    adapters.push({ name, call: reg => askJev(reg, config, { evidence: 'local fixture' }, questions), off: reg => askJev(reg, { ...config, enabled: false }, {}, questions) });
  }
  const sidebar = await jiti.import('../packages/pi-sidebar/src/jev.ts');
  adapters.push({ name: 'sidebar', call: reg => sidebar.askJevBool(reg, { evidence: 'local fixture' }, question) });
  const cache = await jiti.import('../packages/pi-cache-guard/src/jev.ts');
  adapters.push({ name: 'cache-guard', call: reg => cache.askJev(reg, config, 1000, { evidence: 'local fixture' }, questions), off: reg => cache.resolveJev(reg, { ...config, enabled: false }) });
  const plan = await jiti.import('../packages/pi-plan-mode/src/jev-tool-picker.ts');
  const pickerInput = { task: 'Research this task', conversation: '', cwd: dir, capabilities: [{ id: 'docs', label: 'Docs', description: 'Look up relevant API docs', fallbackSelected: false }] };
  adapters.push({ name: 'plan-mode', call: reg => plan.pickToolsWithJev({ ...pickerInput, registry: reg }), off: reg => plan.pickToolsWithJev({ ...pickerInput, capabilities: [], registry: reg }) });

  for (const backend of ['jev', 'openai-decisions']) {
    select(backend);
    const expected = backend === 'jev' ? 'typesafe' : 'system1-openai';
    for (const adapter of adapters) {
      const reg = registry();
      const result = await adapter.call(reg);
      assert.ok(result.ok === true || result.kind === 'jev', `${adapter.name}: ${JSON.stringify(result)}`);
      assert.equal(reg.calls.length, 1, adapter.name);
      assert.equal(reg.calls[0].model.provider, expected, adapter.name);
      if (backend === 'openai-decisions') assert.ok(reg.lookups.every(x => x.provider === expected), 'no Jev lookup');
      if (adapter.off) {
        const disabled = registry(); await adapter.off(disabled);
        assert.equal(disabled.calls.length, 0, `${adapter.name} remains disabled`);
      }
    }
    const available = registry();
    const resolved = await cache.resolveJev(available, config);
    assert.equal(resolved.kind, 'ready'); assert.equal(resolved.target.provider, expected);
    if (backend === 'openai-decisions') assert.deepEqual(available.available, ['system1-openai'], 'no Jev discovery under Decisions');
  }

  select('openai-decisions');
  for (const adapter of adapters) {
    const missing = registry({ native: false });
    const result = await adapter.call(missing);
    assert.ok(result.ok === false || result.kind === 'fallback', `${adapter.name} must fail without the isolated provider`);
    assert.equal(missing.calls.length, 0);
    assert.ok(missing.lookups.every(x => x.provider === 'system1-openai'), 'missing provider never falls back to Jev');
  }
  for (const adapter of adapters) {
    select('openai-decisions');
    const reg = registry({ pending: true });
    const pending = adapter.call(reg);
    for (let i = 0; !reg.calls.length && i < 10; i++) await Promise.resolve();
    assert.equal(reg.calls.length, 1, adapter.name);
    select('jev'); reg.settle();
    const result = await pending;
    assert.ok(result.ok === false || result.kind === 'fallback', `${adapter.name} must discard a stale backend result`);
  }

  // SDK children already copy native registrations. Test that path without constructing a real runtime.
  const childProvider = { id: 'system1-openai' };
  const host = { modelRegistry: { getRegisteredProviderIds: () => ['system1-openai'], getRegisteredNativeProvider: () => childProvider } };
  const child = await jiti.import('../packages/pi-sidebar/src/child.ts');
  const planner = await jiti.import('../packages/pi-plan-mode/src/planner/session.ts');
  for (const inherit of [child.inheritProviders, planner.inheritProviders]) {
    const received = [];
    inherit(host, { registerNativeProvider: provider => received.push(provider) });
    assert.deepEqual(received, [childProvider]);
  }
  const { childEnv } = await jiti.import('../packages/pi-subagents/src/child.ts');
  assert.equal(childEnv('inherit', process.env).PI_CODING_AGENT_DIR, dir);
  select('openai-decisions');
  const helper = resolve(root, 'packages/pi-system1/src/system1.ts');
  const subprocess = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import {createJiti} from 'jiti';
    const jiti = createJiti(import.meta.url);
    const {resolveSystem1Target} = await jiti.import(${JSON.stringify(helper)});
    console.log(JSON.stringify(resolveSystem1Target({provider:'typesafe',model:'jev-latest'})));
  `], { cwd: root, encoding: 'utf8', env: childEnv('inherit', process.env) });
  assert.equal(subprocess.status, 0, subprocess.stderr);
  assert.equal(JSON.parse(subprocess.stdout).provider, 'system1-openai');
  console.log('PASS all eight classifier consumers, off states, missing-provider/no-fallback, stale results and child selection inheritance (offline)');
} finally {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
}
