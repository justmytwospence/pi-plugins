// Network-free integration of real transcript components, CC render patches, Sidebar SplitRoot,
// sticky/clear extensions and copy/navigation consumers. Keyboard ownership is tested separately
// in pi-vim/test/sdk-integration.test.ts; this fixture asserts the resulting renderer geometry.
// PI_TEST_SDK_ROOT may select another installed SDK without mixing its TUI component identities.
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { findPackageJSON, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { createJiti } from 'jiti';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sdkRoot = realpathSync(process.env.PI_TEST_SDK_ROOT
  ? resolve(process.env.PI_TEST_SDK_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))), '..'));
assert.equal(JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')).name, '@earendil-works/pi-coding-agent');
const sdkUrl = pathToFileURL(join(sdkRoot, 'dist/index.js'));
const tuiManifest = findPackageJSON('@earendil-works/pi-tui', sdkUrl);
const tuiPackage = JSON.parse(readFileSync(tuiManifest, 'utf8'));
const tuiPath = resolve(dirname(tuiManifest), tuiPackage.exports?.['.']?.import ?? tuiPackage.main);

// Sandbox before importing extensions: no host credentials, subprocesses, or network transports.
const temp = mkdtempSync(join(tmpdir(), 'pi-transcript-navigation-'));
const env = { ...process.env };
for (const key of Object.keys(process.env)) {
  if (/(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH|ACCESS_KEY|PRIVATE_KEY)(?:_|$)/i.test(key)) delete process.env[key];
}
for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'XDG_CACHE_HOME', 'PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
  process.env[key] = join(temp, key);
  mkdirSync(process.env[key]);
}
process.env.PI_OFFLINE = '1';
const originals = { fetch: globalThis.fetch, connect: net.Socket.prototype.connect,
  httpRequest: http.request, httpGet: http.get, httpsRequest: https.request, httpsGet: https.get };
const childNames = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'];
const originalChild = Object.fromEntries(childNames.map(key => [key, childProcess[key]]));
let forbiddenIO = 0;
const forbidIO = () => { forbiddenIO++; throw new Error('transcript fixture forbids network and subprocess I/O'); };
globalThis.fetch = forbidIO;
net.Socket.prototype.connect = forbidIO;
http.request = http.get = https.request = https.get = forbidIO;
for (const key of childNames) childProcess[key] = forbidIO;
syncBuiltinESMExports();

const sdk = await import(sdkUrl.href);
const tui = await import(pathToFileURL(tuiPath).href);
const { createInteractiveTuiReference } = await import(new URL('./modes/interactive/tui-renderer.js', sdkUrl));
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
const themeModule = await import(new URL('./modes/interactive/theme/theme.js', sdkUrl));
const { Container, ScrollView, Text, TuiAltScreen, VStack, getKeybindings, setKeybindings } = tui;
const { UserMessageComponent, AssistantMessageComponent, ToolExecutionComponent, CustomMessageComponent } = sdk;
const previousKeys = getKeybindings();
setKeybindings(new KeybindingsManager({ 'app.model.select': 'alt+p' }));
themeModule.initTheme('dark', false);
// Prototype patches and instanceof checks must address exactly the SDK/TUI used by the renderer.
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': fileURLToPath(sdkUrl), '@earendil-works/pi-tui': tuiPath,
} });
const load = path => jiti.import(resolve(root, path));
const { transcriptCheckpoint, TRANSCRIPT_ROWS } = await load('packages/pi-vim/src/transcript-contract.ts');
const { captureTranscript, scrollToCheckpoint } = await load('packages/pi-vim/src/transcript-viewport.ts');
const { snapshotTranscript } = await load('packages/pi-copy/src/copy-mode/snapshot.ts');
const { default: sticky, PIN_CHANNEL } = await load('packages/pi-sticky-last-prompt/src/index.ts');
const { default: clearScreen } = await load('packages/pi-clear-screen/src/index.ts');
const { SplitRoot, dividerLines } = await load('packages/pi-sidebar/src/layout.ts');
const { DEFAULT_MIN_COLUMNS, DEFAULT_RATIO, orientationFor } = await load('packages/pi-sidebar/src/config.ts');
const { installToolGrouping, ToolGroupComponent } = await load('packages/pi-cc-render/src/renderer/tool/grouping.ts');
const { installDefaultMode, installToolExpandedBackground } = await load('packages/pi-cc-render/src/renderer/default-mode.ts');
const { installCompactMode } = await load('packages/pi-cc-render/src/renderer/compact-mode.ts');
const { WriteExecutionMetadataStore } = await load('packages/pi-cc-render/src/renderer/tool/diff/index.ts');
const { config } = await load('packages/pi-cc-render/src/config/config.ts');
const savedMode = config.mode;
const plain = value => stripVTControlCharacters(value).replace(/\x1b_pi:[^\x07]*\x07/gu, '').trimEnd();
const context = { userWords: new Map([['bash', [() => 'first human answer']], ['read', [() => 'latest human answer']]]) };

class MemoryTerminal {
  constructor(columns) { this.columns = columns; this.rows = 24; this.kittyProtocolActive = false; this.writes = []; }
  start(input) { this.input = input; }
  stop() { this.input = undefined; }
  async drainInput() {}
  write(data) { this.writes.push(data); }
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  moveBy() {}
  setTitle() {}
  setProgress() {}
  setProgramStatus() {}
}
const baseMessage = { role: 'assistant', timestamp: 1234, api: 'anthropic-messages', provider: 'test', model: 'test',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const assistantMessage = (text, stopReason = 'stop') => ({ ...baseMessage, stopReason, content: [{ type: 'text', text }] });
const paragraph = label => Array.from({ length: 18 }, (_, i) => `${label} ${i}: ${'wide wrapping geometry '.repeat(5)}`).join('\n');

function fixture(width, sidebar, style) {
  const terminal = new MemoryTerminal(width);
  let renderer = new TuiAltScreen(terminal);
  const renderers = [renderer];
  const reference = createInteractiveTuiReference(() => renderer);
  const handlers = new Map();
  const shortcuts = new Map();
  const listeners = new Map();
  const widgets = new Map();
  const notices = [];
  const events = {
    on(channel, fn) { const list = listeners.get(channel) ?? []; list.push(fn); listeners.set(channel, list); },
    emit(channel, value) { for (const fn of listeners.get(channel) ?? []) fn(value); },
  };
  events.on('pi-plugins.user-words.v1', request => {
    request.register('bash', () => 'first human answer');
    request.register('read', () => 'latest human answer');
  });
  const pi = { events,
    on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
    registerCommand() {}, registerShortcut(key, value) { shortcuts.set(key, value); },
  };
  const ctx = { mode: 'tui', hasUI: true, sessionManager: { getBranch: () => [] }, isIdle: () => true,
    ui: { theme: themeModule.theme, notify: text => notices.push(text),
      setWidget(key, factory) {
        widgets.get(key)?.dispose?.(); widgets.delete(key);
        if (factory) widgets.set(key, factory(reference, themeModule.theme));
      },
    },
  };
  const emit = async name => {
    for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason: name === 'session_start' ? 'startup' : 'quit' }, ctx);
  };
  config.mode = style;
  const metadata = new WriteExecutionMetadataStore();
  const defaultMode = installDefaultMode(metadata);
  const grouping = installToolGrouping(() => config.mode === 'on');
  grouping.setTheme(themeModule.theme);
  const compact = installCompactMode({ writeMetadata: metadata });
  const releaseBackground = installToolExpandedBackground();
  sticky(pi);
  clearScreen(pi);

  function mount(document = new Container()) {
    const chat = new Container();
    document.addChild(new Text('Fixture transcript header', 0, 0));
    document.addChild(chat);
    const scroll = new ScrollView(document, { primary: true, follow: 'end' });
    const main = new VStack([{ component: scroll, basis: 0, grow: 1 }]);
    const panel = new ScrollView(new Text('Sidebar fixture content\n'.repeat(30), 0, 0));
    const split = new SplitRoot(main, panel, { ratio: () => DEFAULT_RATIO, minColumns: DEFAULT_MIN_COLUMNS,
      collapsed: () => sidebar === 'closed', focused: () => false,
      divider: (orientation, _focused, columns, length) => dividerLines(orientation, columns, text => text, { sidebar: false, length, pointer: text => text }),
    }, () => renderer.requestRender());
    renderer.clear(); renderer.addChild(document); renderer.setLayoutRoot(split);
    return { document, chat, scroll, split };
  }
  const mounted = mount();
  renderer.start();
  const frame = () => { renderer.renderNow(); renderer.renderNow(); };
  function tool(name, id, marked) {
    const component = new ToolExecutionComponent(name, id, name === 'bash' ? { command: 'echo fixture' } : { path: '/fixture.txt' },
      {}, undefined, reference, temp);
    const result = { content: [{ type: 'text', text: `Rendered ${name} result\nsecond result line` }], details: {}, isError: false };
    component.updateResult(marked ? transcriptCheckpoint(result, { id, kind: 'report' }) : result, false);
    return component;
  }
  function populate(chat, suffix = '') {
    const prompt = new UserMessageComponent(`User request${suffix} with wrapping ${'intent '.repeat(24)}`);
    chat.addChild(prompt);
    chat.addChild(new Text(paragraph('ordinary status'), 0, 0));
    const call = { ...baseMessage, stopReason: 'toolUse', content: [
      { type: 'toolCall', id: `bash${suffix}`, name: 'bash', arguments: { command: 'echo fixture' } },
      { type: 'toolCall', id: `read${suffix}`, name: 'read', arguments: { path: '/fixture.txt' } },
    ] };
    const calling = new AssistantMessageComponent(call, true);
    chat.addChild(calling);
    const first = tool('bash', `bash${suffix}`, true);
    const second = tool('read', `read${suffix}`, true);
    chat.addChild(first); chat.addChild(second); calling.updateContent(call, true);
    chat.addChild(new Text(paragraph('unmarked progress'), 0, 0));
    const artifact = new CustomMessageComponent(transcriptCheckpoint({ role: 'custom', customType: 'unfamiliar-fixture',
      content: `Delivered plan${suffix}\n${'plan body '.repeat(18)}`, display: true, timestamp: 1234, details: {} },
    { id: `plan${suffix}`, kind: 'unfamiliar-kind' }));
    chat.addChild(artifact);
    chat.addChild(new Text(paragraph('unmarked log'), 0, 0));
    const finalMessage = assistantMessage(`Final response${suffix}\n${'response body '.repeat(20)}`);
    const response = new AssistantMessageComponent(finalMessage, false);
    chat.addChild(response); response.updateContent(finalMessage, false);
    chat.addChild(new Text(paragraph('unmarked tail'), 0, 0));
    return { prompt, first, second, artifact, response };
  }
  return { terminal, reference, emit, notices, frame, mount, populate, ...mounted,
    get renderer() { return renderer; },
    bar() {
      const bars = renderer.overlayStack.filter(entry => entry.component.constructor.name === 'PinBar');
      assert.equal(bars.length, 1, 'one live sticky overlay'); return bars[0];
    },
    clear() { shortcuts.get('ctrl+l').handler(ctx); frame(); },
    pinService() { const request = { version: 1 }; events.emit(PIN_CHANNEL, request); assert.ok(request.service); return request.service; },
    replaceRenderer() {
      renderer = new TuiAltScreen(terminal); renderers.push(renderer);
      const mounted = mount(); renderer.start(); return mounted;
    },
    async close() {
      try { await emit('session_shutdown'); }
      finally { releaseBackground(); compact.shutdown(); grouping.shutdown(); defaultMode.shutdown(); for (const r of renderers) r.stop({ preserveScreen: true }); }
    },
  };
}

// Compare against the SDK frame's actual scroll-content rows, not only another helper's output.
function capture(f) {
  const result = captureTranscript(f.reference, context);
  assert.ok(result, 'real fullscreen geometry must be measurable');
  const boxes = [];
  const visit = box => { if (box.component === result.view) boxes.push(box); for (const child of box.children ?? []) visit(child); };
  visit(f.renderer.currentLayout.root);
  assert.equal(boxes.length, 1);
  assert.equal(result.width, result.view.getContentWidth(boxes[0].rect.width));
  assert.deepEqual(result.lines, boxes[0].scrollContentLines, 'index must equal the actual SDK layout content');
  const copy = snapshotTranscript(f.reference, 9999, context);
  assert.ok(copy && !copy.fallback, 'copy must capture fullscreen rather than its text fallback');
  assert.deepEqual(copy.lines, result.lines);
  // Generated package-local index copies have independent WeakMap ID sequences for native
  // components. Compare native membership/kind and exact source identity, not coincidental counters;
  // explicit producer IDs (including grouped feedback) must still agree byte-for-byte.
  const comparable = block => {
    const { source, ...value } = block;
    if (block.checkpoint && (source instanceof UserMessageComponent || source instanceof AssistantMessageComponent)) {
      assert.ok(block.checkpoint.id);
      return { ...value, checkpoint: { ...block.checkpoint, id: '<native-component-id>' } };
    }
    return value;
  };
  assert.deepEqual(copy.blocks.map(comparable), result.blocks.map(comparable));
  copy.blocks.forEach((block, i) => assert.equal(block.source, result.blocks[i].source));
  assert.deepEqual(copy.plain, result.lines.map(line => stripVTControlCharacters(line).replace(/\s+$/u, '')));
  assert.equal(copy.viewportHeight, result.viewportHeight);
  return result;
}
function landingRows(index) {
  return [...new Set(index.blocks.filter(block => block.checkpoint).map(block =>
    Math.max(0, Math.min(block.start - 1, index.lines.length - index.viewportHeight))))].sort((a, b) => a - b);
}
function navigate(f) {
  let index = capture(f);
  const targets = landingRows(index);
  assert.ok(targets.length >= 3, 'fixture needs multiple independently reachable checkpoints');
  index.view.scrollToEnd(); f.frame();
  let expected = [...targets].filter(row => row < index.view.scrollTop).reverse();
  let suppressed = 0;
  for (const target of expected) {
    scrollToCheckpoint(f.reference, context, -1); f.frame();
    assert.equal(index.view.scrollTop, target, 'previous stop must use actual rendered rows and the one-row margin');
    assert.equal(index.view.isFollowingEnd, false);
    assert.deepEqual(f.bar().component.render(index.width), [], 'a checkpoint stop lands without the sticky bar');
    // Moving off the landing row and back brings the bar back where a prompt is scrolled off.
    index.view.scrollTo(target + 1, { disableFollow: true }); f.frame();
    index.view.scrollTo(target, { disableFollow: true }); f.frame();
    if (f.bar().component.render(index.width).length) suppressed++;
  }
  assert.ok(suppressed > 0, 'some checkpoint stop would otherwise show a pinned prompt');
  const first = index.view.scrollTop;
  scrollToCheckpoint(f.reference, context, -1); f.frame(); assert.equal(index.view.scrollTop, first, 'up never wraps');
  for (const target of targets.filter(row => row > first)) {
    scrollToCheckpoint(f.reference, context, 1); f.frame(); assert.equal(index.view.scrollTop, target, 'next stop');
  }
  assert.equal(index.view.isFollowingEnd, false, 'checkpoint stops never resume follow');
  const end = Math.max(0, index.lines.length - index.view.viewportHeight);
  scrollToCheckpoint(f.reference, context, 1); f.frame(); assert.equal(index.view.scrollTop, end, 'down past the last checkpoint goes to the end');
  assert.equal(index.view.isFollowingEnd, true, 'and resumes follow');
  scrollToCheckpoint(f.reference, context, 1); f.frame(); assert.equal(index.view.scrollTop, end, 'down never wraps');
  index = capture(f);
  const human = index.blocks.find(block => block.userText);
  assert.ok(human);
  index.view.scrollTo(human.end, { disableFollow: true }); f.frame();
  const entry = f.bar();
  const bar = entry.component.render(index.width).map(plain).join('\n');
  assert.ok(bar.includes('User request'), 'sticky draws the human prompt, not the delivered plan/report');
  assert.ok(f.renderer.getScreenLines().some(line => plain(line).includes('User request')), 'sticky heading is visible in the composited SDK screen');
  const anchor = f.pinService().anchor([f.document], index.width, human.end);
  assert.ok(anchor); assert.equal(anchor.start, human.start); assert.equal(anchor.end, human.end);
  assert.equal(anchor.text, human.userText.replace(/\s+/gu, ' ').trim());
  entry.component.handleMouse({ type: 'click', button: 'left', x: 2, y: 0, width: index.width, height: 1 });
  f.frame(); assert.equal(index.view.scrollTop, Math.max(0, human.start - 1), 'sticky click and navigator agree on the prompt row');
  assert.deepEqual(entry.component.render(index.width), [], 'a prompt on screen must blank its sticky heading');
}

for (const width of [46, 120, 180]) for (const sidebar of ['closed', 'open']) for (const style of ['on', 'compact']) {
  test(`real transcript ${width} Sidebar ${sidebar} CC ${style}`, async () => {
    const f = fixture(width, sidebar, style);
    try {
      await f.emit('session_start');
      const items = f.populate(f.chat); f.frame();
      let index = capture(f);
      assert.equal(index.view, f.scroll);
      assert.equal(f.split.orientation, orientationFor(width, DEFAULT_MIN_COLUMNS));
      if (sidebar === 'open' && f.split.orientation === 'right') assert.ok(index.width < width, 'open horizontal split must measure main, not terminal width');
      else assert.equal(index.width, width);
      if (sidebar === 'open' && f.split.orientation === 'down') assert.ok(index.viewportHeight < f.terminal.rows, 'narrow Sidebar allocates a vertical split');
      assert.equal(index.blocks.find(block => block.source === items.artifact)?.checkpoint?.kind, 'unfamiliar-kind');
      assert.equal(index.blocks.find(block => block.source === items.response)?.checkpoint?.kind, 'response');
      let row = f.document.children[0].render(index.width).length;
      for (const component of f.chat.children) {
        const lines = component.render(index.width);
        const block = index.blocks.find(block => block.source === component);
        if (block) {
          assert.equal(block.start, row, 'block starts at its actual concatenated document row');
          assert.equal(block.end, row + lines.length);
          assert.deepEqual(index.lines.slice(block.start, block.end), lines);
        }
        row += lines.length;
      }
      assert.equal(row, index.lines.length);
      if (style === 'on') {
        const group = f.chat.children.find(child => child instanceof ToolGroupComponent);
        assert.ok(group, 'actual CC Container patch must group the native tool components');
        assert.deepEqual(group.children, [items.first, items.second]);
        for (const expanded of [false, true]) {
          group.setExpanded(expanded); f.frame(); index = capture(f);
          const block = index.blocks.find(block => block.source === group);
          assert.ok(block?.checkpoint); assert.equal(block.userText, 'latest human answer');
          assert.equal(block.end - block.start, group.render(index.width).length, 'group is one atomic rendered range');
          assert.ok(!index.blocks.some(block => block.source === items.first || block.source === items.second), 'no invented child offsets');
          const pinned = f.pinService().anchor([f.document], index.width, block.end);
          assert.equal(pinned?.text, 'latest human answer'); assert.equal(pinned.start, block.start); assert.equal(pinned.end, block.end);
          navigate(f);
        }
      } else {
        assert.deepEqual(items.first.render(index.width), [], 'actual compact renderer hides annotated tool');
        assert.deepEqual(items.second.render(index.width), []);
        assert.ok(!index.blocks.some(block => block.source === items.first || block.source === items.second));
        assert.deepEqual(index.blocks.filter(block => block.checkpoint).map(block => block.source), [items.prompt, items.artifact, items.response], 'compact tails and tool-use summaries create no stops');
        navigate(f);
      }
      const before = capture(f);
      f.clear(); index = capture(f);
      assert.equal(typeof f.document[TRANSCRIPT_ROWS], 'function', 'real clear extension installs its row transform');
      assert.deepEqual(index.horizons, [before.lines.length], 'deleted sentinel has a zero-row clear horizon');
      assert.deepEqual(index.lines.slice(0, before.lines.length), before.lines, 'clear retains real rendered history');
      assert.equal(index.lines.length, before.lines.length + index.viewportHeight, 'clear pads by the allocated main viewport height');
      assert.ok(index.lines.every(line => !line.includes('\u0000pi-clear-screen\u0000')), 'sentinel never enters copy/index output');
      assert.equal(index.view.scrollTop, before.lines.length, 'clear places the zero-row horizon at the top');
      const clearedPin = f.bar().component.render(index.width).map(plain).join('\n');
      assert.ok(clearedPin.includes(style === 'on' ? 'latest human answer' : 'User request'), 'clear keeps the latest human intent pinned across the horizon');
      const answer = new UserMessageComponent('After clear human request'); f.chat.addChild(answer); f.frame();
      index = capture(f);
      assert.equal(index.blocks.find(block => block.source === answer)?.start, before.lines.length, 'post-clear prompt occupies removed marker row');
      navigate(f);
      f.clear(); index = capture(f);
      assert.equal(index.horizons.length, 1, 'repeated clear replaces, rather than accumulates, the marker');
      const frozen = snapshotTranscript(f.reference, width, context);
      assert.ok(frozen?.scrollTo);
      // Frozen copy scroll-back rejects even a same-height rendered edit.
      const frozenLength = frozen.lines.length;
      items.response.updateContent(assistantMessage('Other response\n' + 'response body '.repeat(20)), false); f.frame();
      assert.equal(capture(f).lines.length, frozenLength, 'edited transcript keeps the same row count');
      const unchanged = f.scroll.scrollTop;
      frozen.scrollTo(0); assert.equal(f.scroll.scrollTop, unchanged, 'copy cannot apply old geometry after content changes');
      assert.deepEqual(f.notices, [], 'fixture must not silently fall back after an extension diagnostic');
    } finally { await f.close(); }
  });
}

test('frozen copy geometry rejects resize, document/session and renderer replacement through the actual SDK Proxy', async () => {
  const f = fixture(120, 'open', 'on');
  try {
    await f.emit('session_start'); f.populate(f.chat); f.frame();
    let index = capture(f);
    const valid = snapshotTranscript(f.reference, 120, context);
    valid.scrollTo(0); f.frame(); assert.equal(f.scroll.scrollTop, 0, 'unchanged frozen copy can scroll');
    f.scroll.scrollToEnd(); f.frame();
    const resized = snapshotTranscript(f.reference, 120, context);
    f.terminal.columns = 180; f.frame();
    assert.notEqual(capture(f).width, index.width);
    const top = f.scroll.scrollTop;
    resized.scrollTo(0); assert.equal(f.scroll.scrollTop, top, 'resized copy is inert');
    navigate(f);
    f.clear();
    const oldDocument = f.document;
    assert.equal(typeof oldDocument[TRANSCRIPT_ROWS], 'function');
    const old = snapshotTranscript(f.reference, 180, context);
    const detachedTop = f.scroll.scrollTop;
    // Session lifecycle replaces the document/view while keeping the renderer and stable SDK Proxy.
    await f.emit('session_shutdown');
    const replacement = f.mount(); f.populate(replacement.chat, '-session'); await f.emit('session_start'); f.frame();
    const sessionTop = replacement.scroll.scrollTop;
    old.scrollTo(0); assert.equal(replacement.scroll.scrollTop, sessionTop);
    assert.equal(f.scroll.scrollTop, detachedTop, 'session replacement invalidates the detached view too');
    assert.equal(Object.hasOwn(oldDocument, TRANSCRIPT_ROWS), false);
    index = capture(f); assert.equal(index.document, replacement.document); assert.notEqual(index.view, f.scroll);
    const oldBar = f.bar().component;
    const oldRenderer = f.renderer;
    const retired = snapshotTranscript(f.reference, 180, context);
    const retiredTop = replacement.scroll.scrollTop;
    await f.emit('session_shutdown');
    assert.deepEqual(oldBar.render(180), [], 'sticky is inert between session owners');
    assert.ok(!oldRenderer.overlayStack.some(entry => entry.component === oldBar), 'shutdown removes the old renderer overlay');
    const fresh = f.replaceRenderer(); f.populate(fresh.chat, '-renderer'); await f.emit('session_start'); f.frame();
    assert.notEqual(f.renderer, oldRenderer);
    index = capture(f); assert.equal(index.document, fresh.document); assert.equal(index.view, fresh.scroll);
    const freshTop = fresh.scroll.scrollTop;
    retired.scrollTo(0);
    assert.equal(fresh.scroll.scrollTop, freshTop, 'retired capture cannot scroll replacement renderer');
    assert.equal(replacement.scroll.scrollTop, retiredTop, 'retired capture cannot scroll detached renderer either');
    scrollToCheckpoint(f.reference, context, -1); f.frame();
    assert.ok(fresh.scroll.scrollTop < freshTop, 'new navigation resolves the live renderer through the same Proxy');
  } finally { await f.close(); }
});

after(() => {
  try { assert.equal(forbiddenIO, 0, 'integration must make zero network/subprocess attempts'); }
  finally {
    config.mode = savedMode; setKeybindings(previousKeys);
    globalThis.fetch = originals.fetch; net.Socket.prototype.connect = originals.connect;
    http.request = originals.httpRequest; http.get = originals.httpGet;
    https.request = originals.httpsRequest; https.get = originals.httpsGet;
    Object.assign(childProcess, originalChild); syncBuiltinESMExports();
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env, env); rmSync(temp, { recursive: true, force: true });
  }
});
