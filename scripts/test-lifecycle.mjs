// Real AgentSession lifecycle; model transport is entirely local and makes no paid calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createJiti } from 'jiti';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } from '@earendil-works/pi-coding-agent';
const jiti = createJiti(import.meta.url);
const sdk = import.meta.resolve('@earendil-works/pi-coding-agent');
const { loadThemeFromPath } = await import(new URL('./modes/interactive/theme/theme.js', sdk));
for (const name of ['dark', 'light']) assert.ok(loadThemeFromPath(resolve(`packages/pi-cc-render/themes/cc-${name}.json`)));
const dir = mkdtempSync(resolve(tmpdir(), 'pi-suite-lifecycle-'));
const errors = [];
const starts = [];
let session;
try {
  const models = await ModelRuntime.create({ agentDir: dir });
  await models.setRuntimeApiKey('anthropic', 'test-placeholder');
  models.classify = async () => ({ answers: {}, stopReason: 'error', errorMessage: 'Classification disabled in lifecycle test' });
  const factories = [];
  for (const name of ['auto-effort', 'subagents', 'herdr', 'next-prompt']) factories.push((await jiti.import(`../packages/pi-${name}/src/index.ts`)).default);
  let pi;
  factories.push(api => { pi = api; api.on('before_agent_start', (event, ctx) => { starts.push({ type: event.messageType, busy: !ctx.isIdle(), prompt: event.prompt }); }); });
  const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off' }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories } });
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), model: models.getModel('anthropic', 'claude-opus-4-5'), thinkingLevel: 'off', tools: [] }));
  session.agent.streamFunction = model => {
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Local test response.' }], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); });
    return stream;
  };
  await session.bindExtensions({ onError: error => errors.push(error) });
  await session.prompt('Check the local lifecycle');
  const settled = new Promise(resolve => { const off = session.subscribe(event => { if (event.type === 'agent_settled') { off(); resolve(); } }); });
  pi.sendMessage({ customType: 'test:background', content: 'Background task completed.', display: false }, { triggerTurn: true });
  await Promise.race([settled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Custom run did not settle')), 5000); timer.unref(); })]);
  assert.deepEqual(errors, []);
  assert.deepEqual(starts.map(s => s.type), ['user', 'custom']);
  assert.ok(starts.every(s => s.busy));
  assert.equal(starts[1].prompt, undefined);
  console.log('PASS real Pi user/custom starts, startup busy state, prompt guards, and strict theme loading');
} finally {
  await session?.dispose();
  rmSync(dir, { recursive: true, force: true });
}
