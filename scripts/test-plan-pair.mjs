// A plan model pair (anthropic/opusplan) routes one agent loop: plan on Opus, build on Sonnet,
// consult Opus in the same transcript, then build again. Real Pi loader and AgentSession; every
// model transport is local.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = realpathSync(process.env.PI_TEST_SDK_ROOT
  ? resolve(process.env.PI_TEST_SDK_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..'));
const sdkUrl = pathToFileURL(resolve(sdkRoot, 'dist/index.js'));
const aiManifest = findPackageJSON('@earendil-works/pi-ai', sdkUrl);
const aiPackage = JSON.parse(readFileSync(aiManifest, 'utf8'));
const aiUrl = pathToFileURL(resolve(dirname(aiManifest), aiPackage.exports?.['.']?.import ?? aiPackage.main));
const temp = mkdtempSync(resolve(tmpdir(), 'pi-suite-plan-pair-'));
const cwd = process.cwd();
const saved = Object.fromEntries(['HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'PI_OFFLINE', 'PI_SUBAGENT'].map(key => [key, process.env[key]]));
const opus = 'claude-opus-5-5';
const sonnet = 'claude-sonnet-5-5';
try {
  process.env.HOME = temp;
  process.env.PI_CODING_AGENT_DIR = temp;
  process.env.XDG_CONFIG_HOME = resolve(temp, 'xdg');
  process.env.PI_OFFLINE = '1';
  delete process.env.PI_SUBAGENT;
  const sdk = await import(sdkUrl.href);
  const { createAssistantMessageEventStream } = await import(aiUrl.href);
  const { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices, initTheme } = sdk;
  initTheme('dark', false);
  const models = await ModelRuntime.create({ agentDir: temp, allowModelNetwork: false });
  await models.setRuntimeApiKey('anthropic', 'test-placeholder');
  models.classify = async () => ({ answers: {}, stopReason: 'error', errorMessage: 'Local integration classifier' });
  const dir = resolve(temp, 'work');
  mkdirSync(dir, { recursive: true });
  process.chdir(dir);
  writeFileSync(resolve(temp, 'pi-plan-mode.json'), JSON.stringify({ thinkingLevel: 'inherit', plansDirectory: resolve(dir, 'plans') }));
  const services = await createAgentSessionServices({ cwd: dir, agentDir: temp, modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve(root, 'packages/pi-plan-mode/src/index.ts')] } });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
  const pair = models.getModel('anthropic', 'opusplan');
  assert(pair, 'the extension registered anthropic/opusplan');
  assert.equal(pair.api, 'pi-virtual');
  const manager = SessionManager.inMemory(dir);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: pair, thinkingLevel: 'off' });
  const requested = [];
  const script = [];
  let calls = 0;
  session.agent.streamFunction = (model) => {
    requested.push(model.id);
    const stream = createAssistantMessageEventStream();
    const next = script.shift();
    const content = next ? [{ type: 'toolCall', id: `local-${++calls}`, name: next.name, arguments: next.args }] : [{ type: 'text', text: 'Local response.' }];
    const reason = next ? 'toolUse' : 'stop';
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: reason, timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'done', reason, message }); stream.end(message); });
    return stream;
  };
  const errors = [];
  const ui = new Proxy({
    setStatus() {},
    notify() {},
    async select(title, options) {
      if (title === 'Implementation effort') return options[0];
      assert.equal(title.startsWith('Implement this plan?'), true, title);
      assert.match(title, /implements; .* answers its questions/u, 'the approval names who implements and who answers');
      return options.find(option => option === 'Yes, implement here');
    },
  }, { get(target, key) { return key in target ? target[key] : () => {}; } });
  await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: error => errors.push(error) });
  const active = () => session.getActiveToolNames();
  assert(active().includes('ask_planner') && active().includes('planner_answer'), 'a pair selection activates the consultation tools');

  await session.prompt('/plan');
  const inline = manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'plan-mode:inline').at(-1)?.data;
  assert.equal(inline?.active, true, 'plan mode is on');
  writeFileSync(inline.planFile, '# Pair plan\n\n- `src/a.ts`: change it.\n');
  script.push({ name: 'exit_plan_mode', args: {} }, { name: 'ask_planner', args: { question: 'Is src/b.ts also needed?' } },
    { name: 'planner_answer', args: { answer: 'No, only src/a.ts.' } });
  requested.length = 0;
  await session.prompt('Plan and then implement it.');
  assert.deepEqual(errors, []);
  assert.deepEqual(requested, [opus, sonnet, opus, sonnet], `routing: ${requested}`);
  assert.equal(requested[0], opus, 'planning runs on the planner');
  assert.equal(requested[1], sonnet, 'the request after approval, in the same loop, runs on the worker');
  assert.equal(requested[2], opus, 'a consultation runs on the planner');
  assert.equal(requested[3], sonnet, 'after planner_answer the worker continues');
  assert.equal(session.model.id, 'opusplan', 'the selection never changes');
  assert.equal(manager.getBranch().some(entry => entry.type === 'model_change' && entry.modelId !== 'opusplan'), false, 'no setModel happened');
  const results = manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'toolResult').map(entry => entry.message);
  const byTool = name => results.find(message => message.toolName === name);
  assert.match(byTool('exit_plan_mode').content[0].text, /call ask_planner/u);
  assert.equal(byTool('exit_plan_mode').details.outcome, 'approved');
  assert.match(byTool('ask_planner').content[0].text, /^The implementer asks the planner \(.*\):\n\nIs src\/b\.ts also needed\?/u);
  assert.match(byTool('planner_answer').content[0].text, /^Planner's answer:\n\nNo, only src\/a\.ts\./u);
  console.log('PASS plan model pair routes plan, build, consult and build in one agent loop');
} finally {
  process.chdir(cwd);
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(temp, { recursive: true, force: true });
}
