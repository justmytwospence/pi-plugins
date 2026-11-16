// Prompt-cache prefix check for the whole suite: every extension in the root manifest is loaded into
// one real Pi AgentSession, and the provider payload each request would send (after every
// `before_provider_request` handler) is captured, never sent. A provider caches each request's prefix,
// so request N+1 must extend request N: same system prompt, tools and model, and the same content
// blocks in the same order, with new ones only at the end. A hook that rewrites, moves or re-stamps
// earlier content re-bills the whole conversation on every call (it did, twice); this fails it.
// Select another host with PI_TEST_SDK_ROOT=/absolute/path/to/pi-coding-agent.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { findPackageJSON, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// Extensions that cannot run headless in this one session, each with the reason. An extension that
// shapes provider requests may never be listed here (checked below). Start empty; add only what the
// session cannot bind, with a one-line reason.
const SKIP = new Map([
  // ['./packages/pi-example/src/index.ts', 'needs a real terminal'],
]);
// The hooks that can rewrite what a provider receives. pi-sidebar's child.ts only shapes Sidebar's own
// side session, which is not the conversation under test.
const REQUEST_HOOKS = /\bon\(\s*["'](context|context_with_system|before_provider_request)["']/;
const SIDE_SESSION_ONLY = new Set(['packages/pi-sidebar/src/child.ts']);

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const entries = manifest.pi.extensions;
for (const entry of SKIP.keys()) assert(entries.includes(entry), `SKIP names ${entry}, which is not in the manifest`);
const sourceFiles = dir => readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory()
  ? (item.name === 'node_modules' ? [] : sourceFiles(join(dir, item.name)))
  : /\.(ts|mjs|js)$/.test(item.name) ? [join(dir, item.name)] : []);
for (const entry of SKIP.keys()) {
  const packageDir = resolve(root, entry.split('/').slice(0, 3).join('/'));
  for (const file of sourceFiles(join(packageDir, 'src'))) {
    const path = relative(root, file);
    assert(SIDE_SESSION_ONLY.has(path) || !REQUEST_HOOKS.test(readFileSync(file, 'utf8')),
      `${entry} shapes provider requests (${path}) and must stay in the cache-prefix test`);
  }
}
const loaded = entries.filter(entry => !SKIP.has(entry));

const temp = mkdtempSync(resolve(tmpdir(), 'pi-suite-cache-prefix-'));
const cwd = process.cwd();
const envKeys = ['HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'PI_OFFLINE', 'PI_SUBAGENT', 'PI_TOOL_GATE_APPROVAL', 'PI_TOOL_GATE_WORKFLOW'];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const networkAttempts = [];
const restoreNetwork = [];
let session;
// AgentSession.dispose() does not emit session_shutdown (the runtime that owns it does), and some
// extensions watch files until they are told to stop: shut down first, as the runtime does.
const closeSession = async () => {
  const closing = session;
  session = undefined;
  if (!closing) return;
  try { await closing.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); } catch { /* Already failed. */ }
  await closing.dispose();
};
const withDeadline = async (promise, label, ms = 20000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
};

// What the provider would be sent, normalized so only content and order matter. Cache breakpoints
// move on every request by design, and Anthropic merges consecutive user messages, so compare the
// flattened content blocks without `cache_control` rather than whole messages.
const strip = value => Array.isArray(value) ? value.map(strip)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'cache_control').map(([key, item]) => [key, strip(item)]))
    : value;
const blocks = payload => payload.messages.flatMap(message =>
  (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content)
    .map(block => JSON.stringify({ role: message.role, ...strip(block) })));
const head = payload => JSON.stringify(strip({ model: payload.model, system: payload.system, tools: payload.tools, thinking: payload.thinking }));

try {
  process.env.HOME = temp;
  process.env.PI_CODING_AGENT_DIR = temp;
  process.env.XDG_CONFIG_HOME = resolve(temp, 'xdg');
  process.env.PI_OFFLINE = '1';
  for (const key of ['PI_SUBAGENT', 'PI_TOOL_GATE_APPROVAL', 'PI_TOOL_GATE_WORKFLOW']) delete process.env[key];
  // No credential or Herdr state from the machine running this reaches an extension.
  for (const key of Object.keys(process.env)) {
    if (/^HERDR_/.test(key) || /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i.test(key)) delete process.env[key];
  }
  // Fail even swallowed network attempts, and install the tripwires before loading the SDK.
  for (const [object, key] of [[globalThis, 'fetch'], [http, 'request'], [http, 'get'],
    [https, 'request'], [https, 'get'], [net.Socket.prototype, 'connect'], [tls, 'connect']]) {
    const original = object[key];
    object[key] = (...args) => {
      // Process-local Unix sockets (Sidebar's) are part of a normal session; anything else is a leak.
      if (key === 'connect' && object === net.Socket.prototype && typeof args[0] === 'string') return original.apply(this, args);
      networkAttempts.push(key);
      throw new Error(`Cache-prefix integration forbids network ${key}`);
    };
    restoreNetwork.push(() => { object[key] = original; });
  }
  syncBuiltinESMExports();
  const sdk = await import(sdkUrl.href);
  const { createAssistantMessageEventStream } = await import(aiUrl.href);
  const { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices, initTheme } = sdk;
  initTheme('dark', false);
  const models = await ModelRuntime.create({ agentDir: temp, allowModelNetwork: false });
  await models.setRuntimeApiKey('anthropic', 'test-placeholder');
  // System 1 resolution stays real, but no classifier request may leave the process.
  writeFileSync(resolve(temp, 'system1.json'), JSON.stringify({ waterfall: ['jev'] }));
  models.classify = async () => ({ answers: {}, stopReason: 'error', errorMessage: 'Local integration classifier' });

  const dir = resolve(temp, 'project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'a.txt'), 'file contents\n');
  let api;
  const services = await createAgentSessionServices({ cwd: dir, agentDir: temp, modelRuntime: models,
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: loaded.map(entry => resolve(root, entry)),
      extensionFactories: [pi => { api = pi; }] } });
  assert.deepEqual(services.resourceLoader.getExtensions().errors, [], 'every manifest extension loads');
  const manager = SessionManager.inMemory(dir);
  ({ session } = await createAgentSessionFromServices({ services, sessionManager: manager,
    model: models.getModel('anthropic', 'claude-opus-4-5'), thinkingLevel: 'off' }));

  // The real stream function builds the real provider payload and runs every before_provider_request
  // handler; the capture throws before anything is sent, and the scripted stream answers instead.
  const real = session.agent.streamFunction;
  const payloads = [];
  const script = [];
  class Captured extends Error {}
  const scriptedStream = (model, next) => {
    const stream = createAssistantMessageEventStream();
    const content = next?.text ? [{ type: 'text', text: next.text }]
      : next ? [{ type: 'toolCall', id: next.id, name: next.name, arguments: next.args }]
        : [{ type: 'text', text: 'Local response.' }];
    const reason = next && !next.text ? 'toolUse' : 'stop';
    const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: reason, timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: 'done', reason, message }); stream.end(message); });
    return stream;
  };
  session.agent.streamFunction = async (model, context, options) => {
    let payload;
    const probe = await real(model, context, { ...options, onPayload: async (built, builtFor) => {
      const replaced = await options?.onPayload?.(built, builtFor);
      payload = JSON.parse(JSON.stringify(replaced ?? built));
      throw new Captured('payload captured');
    } });
    for await (const _ of probe) { /* drain to the end */ }
    if (!payload) {
      const result = await probe.result?.();
      assert.fail(`the real stream never built a provider payload: ${result?.errorMessage ?? 'no error reported'}`);
    }
    payloads.push(payload);
    return scriptedStream(model, script.shift());
  };

  const errors = [];
  // The runner copies this object, so every method must be an own property (a Proxy would lose them).
  const { theme } = await import(new URL('./modes/interactive/theme/theme.js', sdkUrl).href);
  const noop = () => {};
  const ui = {
    select: async () => undefined, confirm: async () => false, input: async () => undefined, editor: async () => undefined,
    custom: async () => undefined, notify: noop, onTerminalInput: () => noop, setStatus: noop, setWorkingMessage: noop,
    setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop, setWidget: noop, setFooter: noop,
    setHeader: noop, setTitle: noop, pasteToEditor: noop, setEditorText: noop, getEditorText: () => '',
    addAutocompleteProvider: noop, setEditorComponent: noop, getEditorComponent: () => undefined, theme,
    getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: false, error: 'UI not available' }),
    getToolsExpanded: () => false, setToolsExpanded: noop,
  };
  await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: error => errors.push(error) });
  assert(api, 'the capture factory ran');

  const assertExtends = (prev, next, why) => {
    assert.equal(head(next), head(prev), `${why}: system prompt, tools and model stay identical`);
    const a = blocks(prev);
    const b = blocks(next);
    const at = a.findIndex((block, index) => block !== b[index]);
    assert(at === -1, `${why}: request ${payloads.indexOf(next)} rewrote history at block ${at}: was ${a[at]?.slice(0, 300)} now ${b[at]?.slice(0, 300)}`);
    assert(b.length >= a.length, `${why}: the request lost content`);
  };
  const ask = async (text, requests) => {
    const before = payloads.length;
    await withDeadline(session.prompt(text), text);
    assert.equal(payloads.length - before, requests, `${text}: ${requests} provider request(s)`);
    return payloads.slice(before);
  };
  const guidance = payload => blocks(payload).filter(block => block.includes('Current tool-gate settings:'));

  // The agent reads a file before the gate would ask about it.
  api.events.emit('permission-mode:set', { mode: 'bypassPermissions' });
  const [first] = await ask('First question.', 1);
  script.push({ id: 'cache-read-1', name: 'read', args: { path: resolve(dir, 'a.txt') } });
  const [call, continuation] = await ask('Read the file.', 2);
  const [third] = await ask('Third question.', 1);
  assertExtends(first, call, 'a second prompt');
  assertExtends(call, continuation, 'a tool continuation');
  assertExtends(continuation, third, 'a prompt after a tool call');

  // A settings change appends its snapshot; it must not move what was sent.
  api.events.emit('permission-mode:set', { mode: 'auto' });
  const [changed] = await ask('After a mode change.', 1);
  assertExtends(third, changed, 'a mode change');
  assert(guidance(changed).at(-1)?.includes('approvals **auto**'), 'the newest guidance snapshot states the live approval mode');

  // Saved anchors keep a reload from moving the snapshot.
  await withDeadline(session.reload(), 'reload');
  const [reloaded] = await ask('After reload.', 1);
  assertExtends(changed, reloaded, 'a reload');
  assert(guidance(reloaded).at(-1)?.includes('approvals **auto**'), 'the snapshot survives a reload');

  assert.deepEqual(errors, [], 'no extension reported an error');
  assert.deepEqual(networkAttempts, [], 'all model transports remain local');
  await closeSession();
  console.log(`PASS actual Pi cache prefix: ${loaded.length} extensions, ${payloads.length} requests stay append-only`);
} catch (error) {
  console.error(`FAIL actual Pi cache prefix: ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  try { await closeSession(); } catch { /* Already failed. */ }
  process.chdir(cwd);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
  for (const restore of restoreNetwork.reverse()) restore();
  syncBuiltinESMExports();
}
// Sidebar's family server stays listening on purpose (the family outlives a reload and the host
// process ends it), so a session that was shut down still keeps this process alive: end it here.
process.stdout.write('', () => process.exit(process.exitCode ?? 0));
