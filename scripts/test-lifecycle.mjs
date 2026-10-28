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
const originalEnv = Object.fromEntries(['HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME'].map(key => [key, process.env[key]]));
let session;
try {
  process.env.HOME = dir;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.XDG_CONFIG_HOME = resolve(dir, 'xdg');
  const models = await ModelRuntime.create({ agentDir: dir });
  await models.setRuntimeApiKey('anthropic', 'test-placeholder');
  models.classify = async () => ({ answers: {}, stopReason: 'error', errorMessage: 'Classification disabled in lifecycle test' });
  const factories = [];
  for (const name of ['auto-effort', 'subagents', 'herdr', 'next-prompt']) factories.push((await jiti.import(`../packages/pi-${name}/src/index.ts`)).default);
  factories.push((await jiti.import('../packages/pi-todo/index.ts')).default);
  let pi;
  factories.push(api => { pi = api; api.on('before_agent_start', (event, ctx) => { starts.push({ type: event.messageType, busy: !ctx.isIdle(), prompt: event.prompt }); }); });
  const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off' }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: factories } });
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), model: models.getModel('anthropic', 'claude-opus-4-5'), thinkingLevel: 'off', tools: ['todo', 'subagent'] }));
  let createdTodo = false;
  session.agent.streamFunction = model => {
    const stream = createAssistantMessageEventStream();
    const content = createdTodo
      ? [{ type: 'text', text: 'Local test response.' }]
      : [{ type: 'toolCall', id: 'local-todo', name: 'todo', arguments: { action: 'create', subject: 'Check suite-owned todos' } }];
    const reason = createdTodo ? 'stop' : 'toolUse';
    createdTodo = true;
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'done', reason, message }); stream.end(message); });
    return stream;
  };
  await session.bindExtensions({ onError: error => errors.push(error) });
  session.setActiveToolsByName(['todo']);
  await session.prompt('Check the local lifecycle');
  const settled = new Promise(resolve => { const off = session.subscribe(event => { if (event.type === 'agent_settled') { off(); resolve(); } }); });
  pi.sendMessage({ customType: 'test:background', content: 'Background task completed.', display: false }, { triggerTurn: true });
  await Promise.race([settled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Custom run did not settle')), 5000); timer.unref(); })]);
  assert.deepEqual(errors, []);
  const todoResult = session.state.messages.find(message => message.role === 'toolResult' && message.toolName === 'todo');
  assert(todoResult, 'the native session executed the suite-owned todo tool');
  assert.equal(todoResult.isError, false, JSON.stringify(todoResult.content));
  const { getTodos } = await jiti.import('../packages/pi-todo/state/store.ts');
  assert.equal(getTodos(session.sessionManager.getSessionId())[0]?.subject, 'Check suite-owned todos');
  assert.deepEqual(starts.map(s => s.type), ['user', 'custom']);
  assert.ok(starts.every(s => s.busy));
  assert.equal(starts[1].prompt, undefined);
  console.log('PASS real Pi user/custom starts, todo execution/persistence, startup busy state, prompt guards, and strict theme loading');

  // /reload keeps a running async subagent: the reloaded runtime adopts it (pi-subagents' handoff),
  // can steer it, and delivers its result exactly once. The child is a local fake Pi.
  const { setPiInvocation } = await jiti.import('../packages/pi-subagents/src/child.ts');
  setPiInvocation({ command: process.execPath, args: [resolve('packages/pi-subagents/test/fixtures/fake-pi-loop.mjs')] });
  const script = [];
  session.agent.streamFunction = model => {
    const stream = createAssistantMessageEventStream();
    const { content, reason } = script.shift() ?? { content: [{ type: 'text', text: 'Noted.' }], reason: 'stop' };
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'done', reason, message }); stream.end(message); });
    return stream;
  };
  const call = (id, args) => ({ content: [{ type: 'toolCall', id, name: 'subagent', arguments: args }], reason: 'toolUse' });
  const waitFor = async (what, check, ms = 10000) => {
    for (const until = Date.now() + ms; !check(); await new Promise(r => setTimeout(r, 20))) if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
  };
  const toolText = () => session.state.messages.filter(m => m.role === 'toolResult' && m.toolName === 'subagent').at(-1)?.content.map(c => c.text).join('') ?? '';
  const results = () => session.state.messages.filter(m => m.customType === 'subagent-result');
  session.setActiveToolsByName(['todo', 'subagent']);
  script.push(call('local-subagent', { task: 'Loop until steered', agent: 'general', model: 'anthropic/claude-opus-4-5', thinking: 'off', async: true }));
  await session.prompt('Delegate in the background');
  const id = /background: (\w+) \(/u.exec(toolText())?.[1];
  assert(id, `the async subagent started: ${toolText()}`);
  await session.reload();
  script.push(call('local-steer', { action: 'steer', id, message: 'Finish now.' }));
  await session.prompt('Tell it to finish');
  assert.equal(toolText(), `Steered ${id}.`, 'the reloaded runtime adopted the running child');
  await waitFor('the adopted subagent result', () => results().length > 0);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(results().length, 1, 'the result is delivered exactly once');
  assert.match(results()[0].content, /finished after[\s\S]*final after \d+ turns/u);
  assert.deepEqual(errors, []);
  setPiInvocation(undefined);
  console.log('PASS /reload hands a running subagent to the reloaded runtime, which steers it and delivers its result once');
} finally {
  await session?.dispose();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
}
