// Real Pi 1.4 loader, provider serializer, codemode worker and Unix socket; no network/paid calls.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createJiti } from 'jiti';

const sdkPath = resolve('packages/pi-sidebar/node_modules/pi-coding-agent-1-4/dist/index.js');
const sdk = await import(sdkPath);
const { ModelRuntime, SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices, createCodemodeExtension, getAgentDir } = sdk;
const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': sdkPath } });
const { SidebarHost } = await jiti.import('../packages/pi-sidebar/src/family/host.ts');
const { MainState } = await jiti.import('../packages/pi-sidebar/src/main-state.ts');
const { SidebarAgent } = await jiti.import('../packages/pi-sidebar/src/child.ts');
const { FamilyClient } = await jiti.import('../packages/pi-sidebar/src/family/transport.ts');
const { readFamilyTranscript, FamilyRetrievalBudget } = await jiti.import('../packages/pi-sidebar/src/family/tools.ts');
const { forgetFamily } = await jiti.import('../packages/pi-sidebar/src/family/handoff.ts');
const { FAMILY_CHANNEL, FAMILY_ENTRY } = await jiti.import('../packages/pi-sidebar/src/family-contract.ts');
const dir = mkdtempSync(resolve(tmpdir(), 'pi-family-sidebar-'));
const env = Object.fromEntries(['HOME', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME'].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const sessions = [];
const hosts = [];
const kernels = new Set();
const errors = [];
const requests = [];
let pendingCode;
let beforeReply;
let toolId = 0;
let client;

// Feed Anthropic's actual provider adapter an in-memory SSE response. Any unexpected URL fails
// closed: this exercises real request hooks/serialization, not a handcrafted cached payload.
function sse(content) {
  const id = `local-${++toolId}`;
  const events = [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'family-local', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: content.type === 'tool_use' ? { ...content, input: {} } : { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: content.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } : { type: 'text_delta', text: content.text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: content.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const waitFor = async (label, check) => {
  const until = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

try {
  process.env.HOME = dir;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.XDG_CONFIG_HOME = resolve(dir, 'xdg');
  assert.equal(getAgentDir(), dir, 'all family state uses the temporary agent directory');
  globalThis.fetch = async (url, init) => {
    try {
      const address = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      assert.match(address, /^https:\/\/family-local\.invalid\/v1\/messages(?:\?|$)/u, `unexpected network request: ${address}`);
      const payload = JSON.parse(init?.body ?? await url.clone().text());
      requests.push(payload);
      const isSidebar = JSON.stringify(payload).includes('<sidebar>');
      if (isSidebar && beforeReply) { const hook = beforeReply; beforeReply = undefined; await hook(); }
      const code = isSidebar ? pendingCode : undefined;
      if (code) pendingCode = undefined;
      return sse(code ? { type: 'tool_use', id: `code-${toolId}`, name: 'codemode', input: { code } } : { type: 'text', text: isSidebar ? 'Sidebar local answer.' : 'Main local answer.' });
    } catch (error) { errors.push(String(error)); throw error; }
  };

  // A minimal runtime-owned adapter loads the production Host/MainState/SidebarAgent through
  // Pi's real extension runtime. No TUI mocks, and never register family tools on main.
  function familyExtension(pi) {
    const main = new MainState(pi);
    const host = new SidebarHost(pi, main, async () => { throw new Error('No TUI in this integration'); });
    const sidebar = new SidebarAgent(pi, main);
    const runtime = { pi, main, host, sidebar, stale: false };
    hosts.push(runtime);
    sidebar.family = host.binding;
    pi.on('session_start', async (_event, ctx) => {
      await host.start(ctx);
      kernels.add(host.kernel);
      await sidebar.setThread(host.kernel.messages);
    });
    pi.on('session_shutdown', async event => {
      await sidebar.dispose();
      await host.dispose(event.reason);
      main.dispose();
      runtime.stale = true;
    });
    sidebar.onEvent(event => { if (event.type === 'sidebar_error') errors.push(event.message); });
  }
  const models = await ModelRuntime.create({ agentDir: dir });
  const provider = {
    baseUrl: 'https://family-local.invalid', apiKey: 'local-not-a-credential', api: 'anthropic-messages',
    models: [{ id: 'family-local', name: 'Local family fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 }],
  };
  models.registerProvider('family-local', provider);
  const create = async (manager = SessionManager.inMemory(dir), codemode = true) => {
    const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime: models,
      settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', defaultTools: codemode ? ['codemode'] : [], retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: codemode ? ['builtin:codemode'] : [], extensionFactories: [...(codemode ? [{ name: 'codemode', builtin: true, factory: createCodemodeExtension() }] : []), familyExtension] } });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: models.getModel('family-local', 'family-local'), thinkingLevel: 'off', tools: codemode ? ['codemode'] : [] });
    sessions.push(session);
    await session.bindExtensions({ onError: error => errors.push(error) });
    return session;
  };
  const session = await create();
  let runtime = hosts.at(-1);
  const kernel = runtime.host.kernel;
  const familyId = kernel.familyId;
  assert.equal(kernel.store.directory, resolve(dir, 'pi-sidebar', 'families', familyId));
  const mainTools = JSON.stringify(runtime.pi.getAllTools());
  assert(!runtime.pi.getAllTools().some(t => t.name.startsWith('sidebar_')));
  await session.prompt('Main request to preserve exactly.');
  const cached = structuredClone(runtime.main.request.payload);
  const cachedBytes = JSON.stringify(cached);
  assert(cached.tools?.some(t => t.name === 'codemode'), 'main cached declarations contain real codemode');
  assert.equal(session.messages.at(-1).stopReason, 'stop', 'main completed through the fake stream');
  assert(!JSON.stringify(cached).includes('sidebar_agents'));
  assert(!JSON.stringify(cached).includes('sidebar_transcript'));
  const child = await runtime.host.service.prepare({ kind: 'subagent', label: 'Explicit child' });
  const credentials = JSON.parse(Object.values(child.env)[0]);
  let observation = { sessionId: 'socket-child', leafId: null, revision: 1, messages: [], projected: { text: 'Socket child evidence.', coverage: 'complete' }, live: { state: 'working' } };
  client = new FamilyClient(credentials, () => observation);
  client.start();
  await waitFor('socket child observation', () => kernel.snapshot().agents.find(a => a.agentId === child.agentId)?.coverage === 'complete');
  const grandchild = await client.request('prepare', { kind: 'scout', label: 'Explicit grandchild' });
  assert.equal(kernel.snapshot().agents.find(a => a.agentId === grandchild.agentId)?.parentId, child.agentId);
  runtime.host.service.focus(child.agentId);
  pendingCode = `const roster = await tools.sidebar_agents({}); const transcript = await tools.sidebar_transcript({agentId:${JSON.stringify(child.agentId)}}); text({roster, transcript});`;
  await runtime.sidebar.ask('Read the child through codemode.');
  const result = runtime.sidebar.messages.find(m => m.role === 'toolResult' && m.toolName === 'codemode');
  assert(result && !result.isError, JSON.stringify({ result, messages: runtime.sidebar.messages.filter(m => m.role === 'assistant').map(m => ({ stopReason: m.stopReason, errorMessage: m.errorMessage })), errors, requestCount: requests.length }));
  const resultText = JSON.stringify(result.content);
  assert.match(resultText, /Socket child evidence/u);
  assert.match(resultText, /Explicit grandchild/u);
  assert.match(resultText, /Quoted transcript evidence/u);
  const firstSide = requests.filter(p => JSON.stringify(p).includes('<sidebar>'));
  assert(firstSide.length >= 2, 'real codemode execution has an automatic follow-up model request');
  function assertPrefix(payload) {
    assert.equal(JSON.stringify({ ...cached, messages: payload.messages.slice(0, cached.messages.length) }), cachedBytes, 'main cached request remains byte-identical');
    for (const [key, value] of Object.entries(cached)) if (!['messages', 'max_tokens'].includes(key)) assert.deepEqual(payload[key], value, `cached ${key} unchanged`);
    assert.equal(JSON.stringify(payload.tools), JSON.stringify(cached.tools), 'deferred tools never change cached declarations');
    const blocks = payload.messages.flatMap(m => m.content ?? []).filter(b => b.type === 'text' && b.text.startsWith('<sidebar-status'));
    assert(blocks.length > 0);
    assert(blocks.every(b => !b.cache_control), 'volatile family status is outside the cached breakpoint');
  }
  firstSide.forEach(assertPrefix);
  assert.equal(JSON.stringify(runtime.main.request.payload), cachedBytes);
  assert.equal(JSON.stringify(runtime.pi.getAllTools()), mainTools, 'main tool registry was never mutated');
  assert(!JSON.stringify(session.messages).includes('Socket child evidence'), 'no family context/tool output reaches main');
  console.log('PASS real Pi 1.4 deferred family tools execute through cached codemode declarations; main prefix/tools/context unchanged');

  // Change focus after submission but before the fake transport returns: follow-up requests
  // in this answer must keep the captured subject, even as live family state changes.
  const at = requests.length;
  beforeReply = async () => {
    runtime.host.service.focus(kernel.rootId);
    observation = { ...observation, revision: 2, live: { state: 'idle' } };
    client.send('update', observation);
  };
  pendingCode = 'text(await tools.sidebar_agents({limit:1}));';
  await runtime.sidebar.ask('Keep the submitted subject while navigation changes.');
  requests.slice(at).forEach(assertPrefix);
  const statusTexts = requests.slice(at).flatMap(p => p.messages.flatMap(m => m.content ?? [])).filter(b => b.type === 'text' && b.text.startsWith('<sidebar-status')).map(b => b.text);
  assert(statusTexts.every(text => text.includes(`captured subject=${JSON.stringify(child.agentId)}`)), 'in-flight subject remains captured');
  assert.equal(kernel.focusId, kernel.rootId);
  const changedAt = requests.length;
  await runtime.sidebar.ask('Now answer about main instead.');
  requests.slice(changedAt).forEach(assertPrefix);
  const latestStatus = requests.at(-1).messages.flatMap(m => m.content ?? []).findLast(b => b.type === 'text' && b.text.startsWith('<sidebar-status'));
  assert(latestStatus.text.includes(`captured subject=${JSON.stringify(kernel.rootId)}`), 'next question captures the new focus');
  assert.equal(JSON.stringify(runtime.main.request.payload), cachedBytes);
  assert.equal(JSON.stringify(runtime.pi.getAllTools()), mainTools);
  await kernel.store.flush();
  await waitFor('family exchange persistence', () => kernel.messages.length === runtime.sidebar.messages.length);
  const thread = structuredClone(kernel.messages);
  runtime.host.preferences({ model: 'family-local/family-local', draft: 'Unsent family draft' });
  const treeTarget = session.sessionManager.getEntries().find(e => e.type === 'message' && e.message.role === 'assistant').id;
  await session.navigateTree(treeTarget, { summarize: false });
  assert.deepEqual(kernel.messages, thread, '/tree does not branch family history');
  assert.equal(kernel.familyId, familyId);
  const oldRuntime = runtime;
  await session.reload();
  runtime = hosts.at(-1);
  assert.notEqual(runtime, oldRuntime);
  assert.equal(oldRuntime.stale, true);
  assert.equal(runtime.host.kernel, kernel, 'reload adopts the same family kernel');
  assert.deepEqual(runtime.sidebar.messages, thread, 'reload restores one family thread');
  assert.equal(kernel.draft, 'Unsent family draft');
  assert.equal(kernel.model, 'family-local/family-local');
  assert.throws(() => oldRuntime.host.service.focus(child.agentId), /not available/u, 'old service closure rejects after reload');
  assert.equal(oldRuntime.main.ctx, undefined, 'old observation context was released');
  await runtime.host.append([{ role: 'user', content: 'Fresh runtime exchange', timestamp: Date.now() }]);
  assert.equal(kernel.messages.at(-1).content, 'Fresh runtime exchange');
  console.log('PASS captured question subject, /tree family history, reload reuse and stale service rejection');

  const unrelated = await create();
  const other = hosts.at(-1);
  assert.notEqual(other.host.kernel.familyId, familyId, 'same cwd is not family membership');
  const forkManager = SessionManager.inMemory(dir);
  forkManager.appendCustomEntry(FAMILY_ENTRY, runtime.host.membership);
  await create(forkManager);
  assert.notEqual(hosts.at(-1).host.kernel.familyId, familyId, 'copied membership cannot enroll a different session ID');
  assert(!other.host.snapshot().agents.some(a => a.agentId === child.agentId));
  assert.equal((await other.host.transcript({ agentId: child.agentId })).coverage, 'unavailable');
  assert.notEqual(unrelated.sessionManager.getSessionId(), session.sessionManager.getSessionId());

  const cancelled = await runtime.host.service.prepareHandoff();
  cancelled.cancel();
  assert(!kernel.snapshot().agents.some(a => a.agentId === cancelled.agentId), 'a cancelled handoff reservation is discarded');
  assert.equal(kernel.anchorId, kernel.rootId);
  const handed = await runtime.host.service.prepareHandoff();
  const implementer = SessionManager.inMemory(dir);
  implementer.appendCustomEntry(FAMILY_ENTRY, { ...handed, sessionId: implementer.getSessionId() });
  await create(implementer);
  const adopted = hosts.at(-1);
  assert.equal(adopted.host.kernel, kernel);
  assert.equal(kernel.anchorId, handed.agentId);
  assert.equal(kernel.draft, 'Unsent family draft');
  assert.equal(kernel.model, 'family-local/family-local');
  assert.deepEqual(adopted.sidebar.messages, kernel.messages);
  assert.equal(kernel.messages.filter(m => m.content === 'Fresh runtime exchange').length, 1);
  // Exercise the same read/attachment path as /context, with no codemode declaration at all.
  const noCode = await create(SessionManager.inMemory(dir), false);
  const fallback = hosts.at(-1);
  await noCode.prompt('Main without codemode.');
  const fallbackCached = structuredClone(fallback.main.request.payload);
  assert(!fallbackCached.tools?.some(t => t.name === 'codemode'));
  const attachment = await readFamilyTranscript(fallback.host, { agentId: fallback.host.kernel.rootId }, new FamilyRetrievalBudget());
  assert.equal(attachment.unavailable, undefined);
  assert.match(attachment.text, /Quoted transcript evidence/u);
  fallback.sidebar.nextContext = attachment.text;
  const fallbackStart = requests.length;
  await fallback.sidebar.ask('Use my explicit transcript attachment.');
  assert.equal(fallback.sidebar.nextContext, undefined, 'attachment is consumed once');
  assert(requests.slice(fallbackStart).some(p => JSON.stringify(p).includes('Quoted transcript evidence')));
  assert(!JSON.stringify(noCode.messages).includes('Quoted transcript evidence'), 'fallback context is never sent to main');
  assert.deepEqual(fallback.main.request.payload, fallbackCached);
  assert.deepEqual(errors, []);
  console.log('PASS no-codemode quoted transcript attachment remains Sidebar-only');
  console.log('PASS real socket descendant reservation, same-cwd/fork isolation, cancelled/successful handoff preserves thread/model/draft');
} finally {
  client?.dispose();
  for (const session of sessions.reverse()) await session.dispose();
  // SDK dispose need not emit extension shutdown; explicitly release these test-owned hosts.
  for (const { host, main, sidebar } of hosts) { await sidebar.dispose(); await host.dispose('quit'); main.dispose(); }
  for (const kernel of kernels) { await kernel.dispose(); forgetFamily(kernel.familyId); }
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(dir, { recursive: true, force: true });
}
