// Remote clients read a waiting Pi dialog off the screen and turn it into a phone card. This renders
// the suite's dialogs through Pi's real theme and components, as they sit over the one-row footer
// pi-status-footer draws while `herdr:blocked` is held, and runs every screen through each installed
// client's own reader:
//   - herdr-web-ui: `parseInteractivePrompt` from its installed bundle (docs/clients.md, "herdr-web-ui
//     compatibility");
//   - Collie: the pi adapter of a Collie checkout, given this machine's `frames.toml`.
// A client that is not installed is skipped, so this is not part of `npm test`: run it with
// `npm run check:clients` after changing a dialog, the footer or a below-editor widget.
// With Sidebar (pi-sidebar) open, every dialog is drawn again in Sidebar's real split, collapsed as
// the controller collapses it while a dialog waits, and main's idle editor must read as it does
// without Sidebar.
// Overrides: HERDR_WEB_UI_DIR, COLLIE_DIR (a checkout with frames.toml support), COLLIE_FRAMES.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripVTControlCharacters } from 'node:util';
import { setKeybindings } from '@earendil-works/pi-tui';
const { TuiBase } = await import(new URL('./tui.js', import.meta.resolve('@earendil-works/pi-tui')));

const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
const { ExtensionSelectorComponent } = await import(new URL('./modes/interactive/components/extension-selector.js', sdkUrl));
const themeModule = await import(new URL('./modes/interactive/theme/theme.js', sdkUrl));
const jiti = createJiti(import.meta.url);
const { QuestionDialog } = await jiti.import('../packages/pi-ask-user-question/src/dialog.ts');
const { askApproval } = await jiti.import('../packages/pi-tool-gate/src/prompt.ts');
const { default: toolGate, ALLOW_ONCE, BLOCK, choiceLabels } = await jiti.import('../packages/pi-tool-gate/src/index.ts');
const { CustomEditor } = await import(new URL('./modes/interactive/components/custom-editor.js', sdkUrl));
const { sidebarScreen } = await import('./remote-clients/sidebar.mjs');
const { TerminalPanel } = await jiti.import('../packages/pi-interactive-shell/src/panel.ts');
const { HistoryPicker } = await jiti.import('../packages/pi-history-search/src/picker.ts');
const { default: historySearch } = await jiti.import('../packages/pi-history-search/src/index.ts');
const { pickApproval, createApprovalState, handoffLabel, HERE: IMPLEMENT_HERE, COMPACT_HERE, EDIT, KEEP } = await jiti.import('../packages/pi-plan-mode/src/approval-picker.ts');
const { registerExec, FINISH_MESSAGE_TYPE } = await jiti.import('../packages/pi-plan-mode/src/exec.ts');
const { createNegotiation } = await jiti.import('../packages/pi-plan-mode/src/negotiation.ts');
const { renderFooter, absorbStatuses } = await jiti.import('../packages/pi-status-footer/src/index.ts');
const { WORKFLOW_EXPLANATIONS } = await jiti.import('../packages/pi-status-footer/src/workflow-ui.ts');
const { choiceMenu, coldTitle } = await jiti.import('../packages/pi-cache-guard/src/index.ts');
const { registerTreeFork, FORK_TITLE, FORK_DESTINATIONS } = await jiti.import('../packages/pi-herdr/src/tree-fork.ts');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const herdrDir = process.env.HERDR_WEB_UI_DIR ?? latest(path.join(homedir(), '.local/share/herdr-web-ui'), /^remote-v\d+$/);
const collieDir = process.env.COLLIE_DIR ?? path.join(homedir(), 'Projects/collie');
const framesFile = process.env.COLLIE_FRAMES ?? path.join(homedir(), '.config/collie/frames.toml');

function latest(dir, pattern) {
  if (!existsSync(dir)) return undefined;
  const found = readdirSync(dir).filter((name) => pattern.test(name)).sort((a, b) => Number(a.match(/\d+/)) - Number(b.match(/\d+/)));
  return found.length ? path.join(dir, found.at(-1)) : undefined;
}

initTheme('dark', false);
const theme = themeModule.theme;
const kb = new KeybindingsManager({});
setKeybindings(kb);
// The component's local install has its own pi-tui singleton; native filter keys must
// use the same application bindings as the root-rendered dialogs.
const herdrTui = await jiti.import('../packages/pi-herdr/node_modules/@earendil-works/pi-tui/dist/index.js');
herdrTui.setKeybindings(kb);
const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} };

// What stands under a dialog while it waits: pi-status-footer's one row, alone or under pi-bg's pill.
const NOW = Date.now();
const modeStatuses = (workflow, approval, phase) => new Map([
  ...(workflow ? [['workflow-mode', `workflow: ${workflow}${workflow === 'exec' ? '' : ' (shift+tab to cycle)'}`]] : []),
  ...(approval ? [['permission-mode', `⏵⏵ ${approval} mode on (alt+a to cycle)`]] : []),
  ...(phase ? [['plan-exec', `exec mode on · ${phase} · 2 consultations · $0.02 consult · $0.01 review`]] : []),
]);
function statusFooter(width, statuses, { compact = false, phase = 'idle' } = {}) {
  const absorbed = absorbStatuses(statuses, { claudeRow: false });
  const lines = renderFooter({
    cwd: '/tmp/pi-plugins', model: 'claude-opus-5-5', provider: 'anthropic', thinking: 'high', oauth: true,
    context: { tokens: 24000, contextWindow: 200000, percent: 12 },
    git: { project: 'pi-plugins', branch: 'main' },
    totals: { input: 23000, output: 1500, cacheRead: 90000, cacheWrite: 400, cost: 1.24, compactions: 1, started: NOW - 60000 },
    quotas: [], now: NOW, queued: false, borderGauge: true, phase,
    ...absorbed, statuses: absorbed.rest, compact,
  }, width, theme);
  const plain = lines.map(stripVTControlCharacters);
  const kind = absorbed.exec !== undefined ? 'exec' : absorbed.workflow?.kind;
  const badge = kind?.toUpperCase();
  assert.doesNotMatch(plain.join('\n'), /workflow: (work|chat|plan|exec)/iu, 'raw provider status must not leak into the footer');
  if (compact) {
    assert.equal(lines.length, 1, 'blocked footer must stay one row');
    if (badge) assert.ok(plain[0].includes(badge), 'blocked footer keeps the uppercase workflow badge');
    assert.ok(!plain[0].includes('Approvals'), 'blocked footer must not merge approvals into the workflow badge');
  } else {
    const workflow = plain.filter(line => /\b(WORK|CHAT|PLAN|EXEC)\b/u.test(line));
    const approvals = plain.filter(line => line.includes('Approvals'));
    assert.equal(workflow.length, kind ? 1 : 0, 'workflow badge keeps its own row, including exec fallback');
    if (badge) {
      assert.ok(workflow[0].includes(badge), 'workflow row uses the uppercase mode badge');
      assert.ok(!workflow[0].includes('Approvals'), 'approvals stay separate from workflow');
      // Sidebar also probes smaller widths while measuring its layout; explanations may drop there.
      if (!absorbed.exec && width >= 46) assert.ok(workflow[0].includes(WORKFLOW_EXPLANATIONS[kind]), `workflow row explains ${kind} at width ${width} when no exec detail replaces it: ${workflow[0]}`);
    }
    assert.equal(approvals.length, absorbed.mode ? 1 : 0, 'Approvals keeps its own row');
    for (const [rows, icon] of [[workflow, '\uf0e8'], [approvals, '\uf510']]) {
      for (const line of rows) {
        assert.ok(line.startsWith(`${width >= 60 ? ' ' : ''}${icon}  `), `mode row keeps its indentation and distinct icon: ${JSON.stringify(line)}`);
        assert.equal(line.includes(icon === '\uf0e8' ? '\uf510' : '\uf0e8'), false, 'mode icons must not be shared');
      }
    }
  }
  return lines;
}
const footer = (width) => statusFooter(width, modeStatuses('plan', 'yolo'), { compact: true, phase: 'waiting' });
const UNDERS = {
  footer: (width) => footer(width),
  'pill+footer': (width) => [theme.fg('muted', ' 1 task '), '', ...footer(width)],
  ...Object.fromEntries(['work', 'chat', 'plan', 'exec'].flatMap(workflow => {
    return ['idle', 'waiting'].flatMap(phase => {
      const rows = width => statusFooter(width, modeStatuses(workflow, 'auto'), { compact: true, phase });
      return [
        [`${workflow} badge ${phase} footer`, rows],
        [`${workflow} badge ${phase} pill+footer`, width => [theme.fg('muted', ' 1 task '), '', ...rows(width)]],
      ];
    });
  })),
  'paused phase footer': (width) => phaseFooter(width),
};

const question = (multiSelect, options = 3) => ({
  question: 'Which approach should the remote-client check take?',
  header: 'Approach',
  multiSelect,
  options: [
    { label: 'Render', description: 'Draw it through the real components' },
    { label: 'Capture', description: 'Read a live pane' },
    { label: 'Both', description: 'Render here, capture to confirm' },
  ].slice(0, options),
});

function questionLines(questions, width) {
  const dialog = new QuestionDialog(tui, theme, kb, questions, () => {}, undefined, undefined);
  return dialog.render(width);
}

// tool-gate's approval dialog as index.ts builds it: a fixed hold offers once or block; a held call
// that rules can name also offers the rule for the session, the project and everywhere, with the rule
// in the question (never in the rows) and the edit row; a folder hold offers the folder.
function approvalOptions(kind, plural) {
  if (!kind) return [ALLOW_ONCE, BLOCK];
  const l = choiceLabels(kind, plural);
  return [ALLOW_ONCE, l.session, l.project, ...(l.everywhere ? [l.everywhere] : []), ...(l.edit ? [l.edit] : []), BLOCK];
}

const RULE = { kind: 'rules', grant: ['Rule: Bash(git push:*)'], command: 'git push origin feature', held: 'it changes something other people see' };
const RULES = {
  kind: 'rules', plural: true,
  grant: ['Rule: Bash(git push:*)', 'Rule: Bash(curl -s -X POST https://api.example.com/v1/deployments/1234567890/restart?force=true&notify=all)'],
  command: 'cd ~/Projects/app && git push origin feature && curl -s -X POST https://api.example.com/v1/deployments/1234567890/restart',
  held: 'it changes something other people see',
};
const FOLDER = { kind: 'dirs', grant: ['Folder: reads in ~/Projects/other'], tool: 'read', command: '', held: "reads ~/Projects/other/a.ts, outside this project's directories" };

async function approvalLines(width, spec = {}) {
  let lines;
  const ctx = {
    mode: 'tui',
    ui: {
      custom: (factory) => new Promise(() => { lines = factory(tui, theme, kb, () => {}).render(width); }),
      select: async () => undefined,
    },
  };
  const options = approvalOptions(spec.kind, spec.plural);
  void askApproval(ctx, {
    view: { tool: spec.tool ?? 'bash', subject: spec.tool === 'read' ? '~/Projects/other/a.ts' : '', body: { kind: 'code', lang: 'bash', text: spec.command ?? 'git push --force origin main' } },
    held: spec.held ?? 'force-pushes main/master',
    agentCase: 'The rebase rewrote the branch.',
    options,
    ...(spec.grant ? { grant: spec.grant } : {}),
    ...(spec.kind === 'rules' ? { editRow: choiceLabels('rules', spec.plural).edit, editText: spec.grant.map((g) => g.replace(/^Rule: /u, '')).join('\n') } : {}),
  }, 'Allow?');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return lines;
}

// Render the actual approval component, including the live effort key path.
const PLAN_TARGETS = [
  { target: { provider: 'anthropic', modelId: 'claude-opus-5-5', thinkingLevel: 'high' }, targetName: 'Claude Opus 5.5' },
  { target: { provider: 'anthropic', modelId: 'claude-sonnet-5-5', thinkingLevel: 'high' }, targetName: 'Claude Sonnet 5.5' },
];
function planLabels(count) {
  return [IMPLEMENT_HERE, COMPACT_HERE, ...PLAN_TARGETS.slice(0, count).map(t => handoffLabel(t.targetName, t.target.thinkingLevel)), EDIT, KEEP];
}
async function selectorLines(width, count, changed) {
  let lines;
  const models = [{ provider: 'anthropic', id: 'claude-fable-5-5', reasoning: true }, ...PLAN_TARGETS.map(t => ({ provider: t.target.provider, id: t.target.modelId, reasoning: true }))];
  const ctx = {
    hasUI: true, mode: 'tui',
    modelRegistry: { getAvailable: () => models, find: (p, id) => models.find(m => m.provider === p && m.id === id) },
    getScopedModels: () => [],
    ui: { custom: factory => new Promise(() => {
      const component = factory(tui, theme, kb, () => {});
      if (changed) component.handleInput('\x1b[C');
      lines = component.render(width);
    }) },
  };
  void pickApproval(ctx, { planning: { provider: 'anthropic', modelId: 'claude-fable-5-5', thinkingLevel: 'high' }, targets: PLAN_TARGETS.slice(0, count) }, createApprovalState());
  await new Promise(resolve => setTimeout(resolve, 0));
  return lines;
}

// pi-cache-guard's cold-cache question as its input handler builds it, with model offers from a
// listener (pi-auto-effort): Jev's pick first, the current model named, a plain offer after the mute line.
const coldView = { last: { provider: 'anthropic', model: 'claude-opus-5-5', at: 0, realAt: 0, tokens: 601_000 }, cold: { kind: 'expired', idleMs: 600_000 } };
const coldOffers = [
  { model: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', recommended: true, note: 'routine change' },
  { model: 'anthropic/claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];
const coldMenu = choiceMenu(coldView, { ready: true, filtered: true }, { current: 'Claude Opus 5.5', offers: coldOffers }).map((item) => item.label);
const plainMenu = choiceMenu(coldView, { ready: true, filtered: true }).map((item) => item.label);
function coldCacheLines(width, menu = coldMenu) {
  const title = coldTitle(coldView, { ready: true, filtered: true }, menu === coldMenu ? coldOffers[0] : undefined);
  const selector = new ExtensionSelectorComponent(title, menu, () => {}, () => {});
  return selector.render(width);
}

// Exercise the actual command's ctx.ui.select call, not a copy of its question/options.
let overrideStatus;
async function overrideLines(width) {
  const commands = new Map();
  const handlers = new Map();
  let lines, selected = false;
  const pi = {
    on: (name, handler) => handlers.set(name, handler), registerTool() {}, registerMessageRenderer() {},
    registerCommand: (name, spec) => commands.set(name, spec),
    getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
    events: { emit() {} },
  };
  const ctx = {
    hasUI: true, mode: 'tui', isIdle: () => true,
    ui: {
      setStatus: (key, value) => { if (key === 'plan-exec') overrideStatus = value; },
      notify: (message) => { throw new Error(message); },
      select: async (title, options) => {
        selected = true;
        lines = new ExtensionSelectorComponent(title, options, () => {}, () => {}).render(width);
        return 'Keep paused';
      },
    },
  };
  const exec = registerExec(pi, { completionReview: () => true, completionMaxRevisions: () => 2 });
  const negotiation = createNegotiation('remote-client-fixture', 2);
  negotiation.phase = 'paused';
  negotiation.pause = { reason: 'user_needed', action: 'Provide human verification.', question: 'Did the browser readiness check pass?' };
  ctx.sessionManager = { getBranch: () => [{ type: 'custom', customType: 'plan-mode:exec', data: { active: true, planFile: '/tmp/client-plan.md', implementer: 'Terra', implementerModel: 'openai-codex/gpt-6.1-terra', asks: 0, costUsd: 0, negotiation } }] };
  await handlers.get('session_start')({}, ctx);
  await commands.get('plan-exec').handler('accept', ctx);
  assert.ok(selected, 'actual /plan-exec accept must open a confirmation');
  assert.ok(exec.active, 'declining the fixture confirmation must leave execution paused');
  assert.match(overrideStatus, /^exec mode on · paused · user needed/u);
  return lines;
}

function phaseFooter(width) {
  assert.ok(overrideStatus, 'render the actual override command before its phase footer');
  const statuses = modeStatuses('exec', 'auto');
  statuses.set('plan-exec', overrideStatus);
  return statusFooter(width, statuses, { compact: true, phase: 'paused · user needed' });
}

// Capture Pi's native select while the real gate command holds its blocked signal. Cancel only
// after rendering so these fixtures also verify that the queued picker releases the hold.
async function gatePickerLines(width, command) {
  const commands = new Map();
  const events = new EventEmitter();
  let blocked = false, lines;
  events.on('herdr:blocked', ({ active }) => { blocked = active; });
  toolGate({
    on() {}, registerShortcut() {}, registerMessageRenderer() {},
    registerCommand: (name, spec) => commands.set(name, spec), events,
  });
  events.emit('workflow-mode:plan-provider', { planFile: '/tmp/client-plan.md' });
  await commands.get(command).handler('', {
    hasUI: true, mode: 'tui', cwd: '/tmp/pi-plugins', isIdle: () => true,
    ui: {
      select: async (title, options) => {
        assert.ok(blocked, `/${command} must hold herdr:blocked while selecting`);
        assert.deepEqual(options, command === 'mode' ? ['Work', 'Chat', 'Plan'] : ['Auto', 'Yolo']);
        lines = new ExtensionSelectorComponent(title, options, () => {}, () => {}).render(width);
        return undefined;
      },
      notify: (message) => { throw new Error(message); },
    },
  });
  assert.ok(lines, `actual /${command} must open a picker`);
  assert.equal(blocked, false, `/${command} must release herdr:blocked`);
  return lines;
}

// Render through the actual fork commands, cancelling before any file or pane creation.
// /tree-fork starts with Pi's native tree; /fork-here with an explicit name goes straight
// to the same destination dialog, without constructing a tree or naming loader.
async function treeForkLines(width, step, filter = 'default', command = 'tree-fork') {
  const direct = command === 'fork-here';
  const commands = new Map();
  const notifications = [];
  const events = new EventEmitter();
  let blocked = false, lines;
  events.on('herdr:blocked', ({ active }) => { blocked = active; });
  registerTreeFork({
    registerCommand: (name, spec) => commands.set(name, spec), events,
    getThinkingLevel: () => 'high',
  }, {
    selfPane: 'source', runtimeCurrent: () => () => true,
    call: async () => { throw new Error('cancelled fixture must not call Herdr'); },
    uniqueName: async () => { throw new Error('cancelled fixture must not create a fork'); },
  });
  const user = { type: 'message', id: 'user', parentId: null, timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Review the API design', timestamp: 0 } };
  const assistantMessage = (id, parentId, content, stopReason) => ({
    type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01Z',
    message: {
      role: 'assistant', content, stopReason, timestamp: 1,
      api: 'openai-responses', provider: 'openai', model: 'fixture',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  });
  const tool = assistantMessage('tool', 'user', [
    { type: 'text', text: 'INTERNAL_TOOL_REQUEST' },
    { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'INTERNAL_COMMAND' } },
  ], 'toolUse');
  const result = { type: 'message', id: 'result', parentId: 'tool', timestamp: '2026-01-01T00:00:02Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', content: [{ type: 'text', text: 'INTERNAL_TOOL_RESULT' }], isError: false, timestamp: 2 } };
  const commentary = assistantMessage('commentary', 'result', [{ type: 'text', text: 'INTERNAL_COMMENTARY', textSignature: JSON.stringify({ v: 1, phase: 'commentary' }) }], 'stop');
  const assistant = assistantMessage('reply', 'commentary', [{ type: 'text', text: 'The API review is complete.', textSignature: JSON.stringify({ v: 1, phase: 'final_answer' }) }], 'stop');
  const metadata = { type: 'custom', id: 'metadata', parentId: 'reply', timestamp: '2026-01-01T00:00:03Z', customType: 'INTERNAL_METADATA', data: { text: 'INTERNAL_TAIL' } };
  const entries = [user, tool, result, commentary, assistant, metadata];
  const tree = entries.reduceRight((children, entry) => [{ entry, children }], []);
  const before = structuredClone(tree);
  let customCalls = 0, selectCalls = 0;
  assert.ok(commands.has(command), `/${command} must be registered`);
  await commands.get(command).handler(direct ? 'API design review' : '', {
    hasUI: true, mode: 'tui', cwd: '/tmp/pi-plugins', isIdle: () => true,
    sessionManager: {
      getSessionFile: () => new URL(import.meta.url).pathname,
      getTree: () => {
        assert.equal(direct, false, '/fork-here must not build a projected tree');
        return tree;
      },
      getBranch: id => {
        const index = entries.findIndex(entry => entry.id === id);
        assert.notEqual(index, -1, 'naming context must use an original entry');
        return entries.slice(0, index + 1);
      },
      getLabel: () => undefined, getSessionName: () => 'API design review',
      getSessionId: () => 'fixture', getLeafId: () => 'metadata', getSessionDir: () => '/tmp',
    },
    ui: {
      custom: async factory => {
        assert.equal(direct, false, '/fork-here must show no tree picker or naming loader');
        assert.equal(++customCalls, 1, 'cancel before opening the naming loader');
        assert.ok(blocked, '/tree-fork tree must hold herdr:blocked');
        const picker = factory(tui, theme, kb, () => {});
        const list = picker.getTreeList();
        assert.equal(list.onLabelEdit, undefined, 'tree selection must disable label editing');
        assert.equal(list.getSelectedNode()?.entry.id, 'reply', 'trailing metadata maps to the completed answer');
        assert.equal(list.getSelectedNode()?.entry.parentId, 'user', 'display skips hidden ancestry');
        const assertProjection = () => {
          const rendered = picker.render(width);
          const text = rendered.map(stripVTControlCharacters).join('\n');
          assert.ok(text.includes('Review the API design'), 'projected tree shows the user prompt');
          assert.ok(text.includes('The API review is complete.'), 'projected tree shows the final answer');
          assert.doesNotMatch(text, /INTERNAL_/, 'native filters cannot restore internal records');
          return rendered;
        };
        assertProjection();
        if (filter === 'all') {
          picker.handleInput('\x01'); // Pi's native All filter, over the projected tree.
          assert.match(picker.render(width).map(stripVTControlCharacters).join('\n'), /\[all\]/i);
        }
        const rendered = assertProjection();
        if (step === 'tree') lines = rendered;
        return step === 'tree' ? undefined : 'reply';
      },
      select: async (title, options) => {
        assert.equal(++selectCalls, 1, `/${command} must show exactly one destination dialog`);
        assert.ok(blocked, `/${command} destination must hold herdr:blocked`);
        assert.equal(title, 'Open fork in Herdr?');
        assert.equal(title, FORK_TITLE);
        assert.deepEqual(options, ['New tab', 'Split beside this pane', 'New space']);
        assert.deepEqual(options, FORK_DESTINATIONS);
        lines = new ExtensionSelectorComponent(title, options, () => {}, () => {}).render(width);
        return undefined;
      },
      notify: message => notifications.push(message),
    },
  });
  assert.deepEqual(tree, before, 'projecting and browsing must not change source entries or parent links');
  assert.equal(assistant.parentId, 'commentary', 'source keeps its original internal ancestry');
  assert.equal(customCalls, direct ? 0 : 1, 'direct fork skips the tree; cancellation never enters naming');
  assert.equal(selectCalls, step === 'destination' ? 1 : 0, `/${command} must render only the requested step`);
  assert.deepEqual(notifications, [], `cancelled /${command} must not report an error`);
  assert.ok(lines, `/${command} must render ${step}`);
  assert.equal(blocked, false, `/${command} cancellation must release herdr:blocked`);
  return lines;
}

// Real prompt-history components: filter input stays terminal-owned, never a remote composer.
function historyPrompts(variant) {
  return variant === 'long/Unicode'
    ? ['調査する 👩🏽‍💻 café — ' + 'A long prompt with multiple lines\n'.repeat(12), '\x1b[31mUnsafe styling\x1b[0m\nsecond line', 'Fix Unicode rendering 界界界']
    : ['Review the API design\nKeep the existing public interface.', 'Fix the history picker', 'Run the unit tests'];
}
function historyLines(width, variant) {
  const picker = new HistoryPicker(historyPrompts(variant), '', theme, kb, () => {}, () => {});
  picker.focused = true;
  if (variant === 'filtered') picker.handleInput('history');
  if (variant === 'no-match') picker.handleInput('zzzz-no-match');
  const lines = picker.render(width);
  const plain = lines.map(stripVTControlCharacters).join('\n');
  assert.match(plain, /Prompt history/);
  if (variant === 'filtered') {
    assert.match(plain, /Fix the history picker/);
    assert.doesNotMatch(plain, /Review the API design/);
  }
  if (variant === 'no-match') assert.match(plain, /No matches/);
  return lines;
}

// Each dialog, and what each client must make of it.
const DIALOGS = [
  { name: 'plan exec override confirmation', lines: overrideLines, question: 'Finish without planner acceptance?', herdr: { options: 2, multi: false, labels: ['Finish without review', 'Keep paused'] }, collie: { kind: 'prompt-select', options: 3, labels: ['Finish without review', 'Keep paused'], wraps: ['Finish without review', 'Keep paused'] } },
  ...[['mode', 'Workflow', ['Work', 'Chat', 'Plan']], ['approvals', 'Approvals', ['Auto', 'Yolo']]].map(([command, question, labels]) => ({
    name: `/${command} picker`, lines: (w) => gatePickerLines(w, command), question,
    herdr: { options: labels.length, multi: false, labels },
    collie: { kind: 'prompt-select', options: labels.length + 1, labels, wraps: labels },
  })),
  ...['tree-fork', 'fork-here'].map(command => ({
    name: `/${command} destination`, lines: w => treeForkLines(w, 'destination', 'default', command), question: FORK_TITLE,
    herdr: { options: FORK_DESTINATIONS.length, multi: false, labels: FORK_DESTINATIONS },
    collie: { kind: 'prompt-select', options: FORK_DESTINATIONS.length + 1, labels: FORK_DESTINATIONS, wraps: FORK_DESTINATIONS },
  })),
  ...['default', 'all'].map(filter => ({
    name: `/tree-fork native tree (${filter})`, lines: w => treeForkLines(w, 'tree', filter), terminalPicker: true,
  })),
  ...['initial', 'filtered', 'no-match', 'long/Unicode'].map(variant => ({
    name: `prompt history (${variant})`, lines: w => historyLines(w, variant), terminalPicker: true,
  })),
  { name: 'ask single', lines: (w) => questionLines([question(false)], w), herdr: { options: 4, multi: false }, collie: { kind: 'prompt-select', options: 4 }, },
  { name: 'ask multi', lines: (w) => questionLines([question(true)], w), herdr: { multi: true }, collie: { kind: 'multi-select' }, },
  { name: 'tool-gate approval', lines: approvalLines, herdr: { options: 3, multi: false }, collie: { kind: 'prompt-select' }, },
  ...[
    ['tool-gate approval (rule)', RULE],
    ['tool-gate approval (two rules)', RULES],
    ['tool-gate approval (folder)', FOLDER],
  ].map(([name, spec]) => {
    const rows = [...approvalOptions(spec.kind, spec.plural), 'Block with a message'];
    return { name, lines: (w) => approvalLines(w, spec), herdr: { options: rows.length, multi: false, labels: rows }, collie: { kind: 'prompt-select', wraps: rows } };
  }),
  ...[0, 1, 2].flatMap(count => [false, true].map(changed => ({
    name: `plan approval (${count} targets${changed ? ', effort changed' : ''})`,
    lines: w => selectorLines(w, count, changed),
    question: `Implement this plan? ←/→ effort: ${changed ? 'off' : 'high'}`,
    herdr: { options: 4 + count, multi: false, labels: planLabels(count) },
    collie: { kind: 'prompt-select', options: 5 + count, labels: planLabels(count), wraps: planLabels(count) },
  }))),
  { name: 'cache-guard cold cache', lines: (w) => coldCacheLines(w, plainMenu), herdr: { options: plainMenu.length, multi: false, labels: plainMenu }, collie: { kind: 'prompt-select', options: plainMenu.length + 1, wraps: plainMenu } },
  { name: 'cache-guard cold cache (model offers)', lines: coldCacheLines, herdr: { options: coldMenu.length, multi: false, labels: coldMenu }, collie: { kind: 'prompt-select', options: coldMenu.length + 1, wraps: coldMenu } },
];
// Pi's own select (`ctx.ui.select`) wraps a long option onto the next row with no `│` gutter, and
// Collie reads no dialog with such a row. Every option of a Pi select must fit the narrowest width.
const wrapsRow = (labels, width) => labels.some((label) => label.length > width - 4);

const screens = [];
for (const width of [46, 120]) {
  tui.terminal.columns = width;
  for (const dialog of DIALOGS) {
    const lines = await dialog.lines(width);
    for (const [under, rows] of Object.entries(UNDERS)) {
      screens.push({ name: dialog.name, width, under, ansi: [...lines, ...rows(width)].join('\n') });
    }
  }
}

// Sidebar open: below main under 161 columns, beside it from there (its default share and minimum).
const HEIGHT = 40;
for (const width of [46, 120, 180]) {
  tui.terminal.columns = width;
  for (const dialog of DIALOGS) {
    const lines = await dialog.lines(width);
    for (const [under, rows] of Object.entries(UNDERS)) {
      const { lines: screen } = sidebarScreen({ width, height: HEIGHT, dock: () => lines, footer: rows, collapsed: true });
      screens.push({ name: dialog.name, width, under: `${under}, Sidebar open`, ansi: screen.join('\n') });
    }
  }
}

// Main's idle editor under pi-status-footer's indented footer, without Sidebar and with it (either
// half focused): each client must read the last two as it reads the first.
const editor = new CustomEditor({ ...tui, terminal: { rows: HEIGHT, columns: 180 } }, themeModule.getEditorTheme(), kb, { paddingX: 0 });
editor.setText('next step');
const FOOTERS = [
  ...['work', 'chat', 'plan', 'exec'].flatMap(workflow => ['auto', 'yolo'].map(approval => ({
    name: `${workflow}/${approval}`, statuses: modeStatuses(workflow, approval, workflow === 'exec' ? 'implementing' : undefined),
  }))),
  ...['consulting', 'review 2', 'revising · 3 findings', 'paused · user needed', 'paused · review unavailable'].flatMap(phase => ['auto', 'yolo'].map(approval => ({
    name: `exec/${approval} ${phase}`, statuses: modeStatuses('exec', approval, phase),
  }))),
  ...['work', 'chat', 'plan', 'exec'].map(workflow => ({ name: `standalone ${workflow}`, statuses: modeStatuses(workflow) })),
  { name: 'standalone exec', statuses: modeStatuses(undefined, undefined, 'review 2') },
  { name: 'approval provider only', statuses: modeStatuses(undefined, 'auto') },
  { name: 'no mode providers', statuses: new Map() },
  // Eight notebook status slots plus the five core rows reach the deployed 13-row allowance,
  // rather than merely comparing equally unreadable Sidebar baselines.
  { name: 'high status count', statuses: modeStatuses('plan', 'yolo'), highStatus: true },
];
function idleFooter(width, fixture) {
  if (!fixture.highStatus) return statusFooter(width, fixture.statuses);
  const statuses = new Map(fixture.statuses);
  for (let i = 1; i <= 8; i++) statuses.set(i === 1 ? 'marimo' : `marimo-${i}`, `marimo: analysis-${i}.py · disconnected`);
  const absorbed = absorbStatuses(statuses, { claudeRow: false });
  assert.equal(absorbed.marimo.length, 8);
  const lines = statusFooter(width, statuses);
  assert.equal(lines.length, 13, 'high-status idle fixture must exercise the full footer allowance');
  return lines;
}
const IDLE = [['without Sidebar', { open: false }], ['Sidebar open, main focused', { focused: false }], ['Sidebar open, Sidebar focused', { focused: true }]];
// Collie reads only main's side of Sidebar's split through frames.toml's panel_below and
// panel_beside declarations (Collie fork 1.24.0-frames.18b43859 and later).
for (const width of [46, 120, 180]) {
  for (const fixture of FOOTERS) {
    const baseline = screens.length;
    for (const [under, options] of IDLE) {
      const { lines: screen } = sidebarScreen({ width, height: HEIGHT, dock: (w) => editor.render(w), footer: (w) => idleFooter(w, fixture), ...options });
      screens.push({ name: `idle editor ${fixture.name}`, width, under, idle: baseline, ansi: screen.join('\n') });
    }
  }
}

// Capture the returned completion renderer from the real registerExec API, rather than drawing a
// lookalike card or calling renderFinish directly. Both expansion states live ahead of the idle
// composer, through the same layout and reader checks as the normal-footer fixtures above.
const messageRenderers = new Map();
registerExec({
  on() {}, registerTool() {}, registerCommand() {},
  registerMessageRenderer: (name, renderer) => messageRenderers.set(name, renderer),
  events: { emit() {} },
}, { completionReview: () => true, completionMaxRevisions: () => 2 });
const renderCompletion = messageRenderers.get(FINISH_MESSAGE_TYPE);
assert.equal(typeof renderCompletion, 'function', 'registerExec must register its returned completion renderer');
const completionDetails = {
  completion: 'accepted', planFile: '/tmp/client-plan.md', implementer: 'Terra',
  report: 'Updated the completion transcript fixture.\n\nThe registered message now appears above the idle editor, with both remote readers checking the composer. '.repeat(4),
  verification: 'Ran the remote-client compatibility checks at narrow and wide widths.\n\nChecked Sidebar with main and Sidebar focus. '.repeat(4),
  concerns: 'No outstanding implementation issues reported.',
  asks: 2, costUsd: 0.02,
  decision: {
    outcome: 'accepted', summary: 'The compatibility fixture is complete.',
    evidence: ['Expanded evidence marker: both remote readers checked.'],
    limitations: ['No live phone interaction was performed.'], findings: [],
  },
  changes: { edited: ['scripts/test-remote-clients.mjs'], outside: [] },
  negotiation: { attempts: 1, reviewCostUsd: 0.01, phase: 'accepted', history: [] },
};
for (const expanded of [false, true]) {
  for (const width of [46, 120, 180]) {
    const transcript = renderCompletion({
      customType: FINISH_MESSAGE_TYPE, content: 'Returned implementation completion',
      details: completionDetails, display: true,
    }, { expanded }, theme);
    const rendered = transcript.render(width).map(stripVTControlCharacters).join('\n');
    assert.match(rendered.replace(/\s+/gu, ' '), /Updated the completion transcript fixture/u, 'actual returned message renders the implementer report');
    assert.equal(rendered.includes('Expanded evidence marker'), expanded, 'only expanded completion shows detailed evidence');
    assert.equal(/ctrl\+o to expand/iu.test(rendered), !expanded, 'concise completion offers expansion');
    const baseline = screens.length;
    for (const [under, options] of IDLE) {
      const { lines: screen } = sidebarScreen({
        width, height: HEIGHT, transcript, dock: w => editor.render(w),
        footer: w => idleFooter(w, { statuses: modeStatuses('plan', 'auto') }), ...options,
      });
      const ansi = screen.join('\n');
      assert.match(stripVTControlCharacters(ansi).replace(/\s+/gu, ' '), /Updated the completion transcript fixture/u, 'completion must be visible ahead of the composer, including with Sidebar');
      screens.push({ name: `returned completion ${expanded ? 'expanded' : 'concise'}`, width, under, idle: baseline, ansi });
    }
  }
}

// A terminal is not a question or an editable Pi composer. Its frame deliberately
// differs from editor/dialog frames; keyboard interaction is terminal-only for now.
for (const width of [46, 120]) {
  tui.terminal.columns = width;
  const panel = new TerminalPanel(tui, theme, 'interactive-example', '/tmp', () => {});
  for (const confirm of [false, true]) {
    if (confirm) { panel.handleInput('\x1d'); panel.handleInput('q'); }
    const lines = panel.render(width - 2).map(line => ` ${line} `);
    screens.push({ name: 'interactive terminal', terminal: true, width, under: confirm ? 'stop confirmation' : 'active panel', ansi: [...lines, ...footer(width)].join('\n') });
  }
  await panel.shutdown();
}

// Exercise the real extension overlay, not just a picker replacing the editor dock.
// A short centered overlay can otherwise leave a live editor frame/composer exposed below it.
async function historyOverlayScreen(width, variant, base) {
  const overlayTui = new TuiBase({ rows: HEIGHT, columns: width, hideCursor() {} });
  overlayTui.requestRender = () => {};
  const main = new CustomEditor(overlayTui, themeModule.getEditorTheme(), kb);
  main.setText('Review');
  overlayTui.setFocus(main);
  const events = new Map(), commands = new Map();
  historySearch({
    on: (name, handler) => events.set(name, handler), registerShortcut() {},
    registerCommand: (name, spec) => commands.set(name, spec),
  });
  let close;
  const ctx = { mode: 'tui', sessionManager: {
    getBranch: () => historyPrompts(variant).map((text, index) => ({ type: 'message', id: String(index), message: { role: 'user', content: text } })),
    getSessionId: () => 'remote-client-fixture', getLeafId: () => 'leaf',
  }, ui: {
    getEditorText: () => main.getExpandedText(), setEditorText: () => assert.fail('cancel must not mutate the draft'),
    notify: message => assert.fail(message), onTerminalInput: () => () => {},
    setWidget: (_key, factory) => { factory?.(overlayTui); },
    custom: (factory, options) => new Promise(resolve => {
      close = value => { overlayTui.hideOverlay(); resolve(value); };
      const picker = factory(overlayTui, theme, kb, close);
      overlayTui.showOverlay(picker, options.overlayOptions);
      picker.handleInput('\x15'); // clear the real expanded draft seed via Input
      if (variant === 'filtered') picker.handleInput('history');
      if (variant === 'no-match') picker.handleInput('zzzz-no-match');
    }),
  } };
  await events.get('session_start')({}, ctx);
  const pending = commands.get('history-search').handler('', ctx);
  const screen = overlayTui.compositeOverlays(base, width, HEIGHT);
  assert.equal(screen.length, HEIGHT, 'real overlay occupies terminal height');
  close(undefined);
  await pending;
  await events.get('session_shutdown')({}, ctx);
  assert.equal(main.getText(), 'Review');
  return screen;
}
for (const width of [46, 120, 180]) {
  for (const variant of ['initial', 'filtered', 'no-match', 'long/Unicode']) {
    for (const [under, rows] of Object.entries(UNDERS)) {
      for (const sidebar of [false, true]) {
        const { lines: base } = sidebarScreen({ width, height: HEIGHT, dock: w => editor.render(w), footer: rows, open: sidebar, collapsed: true });
        const lines = await historyOverlayScreen(width, variant, base);
        screens.push({ name: `prompt history (${variant})`, width, under: `${under}, real overlay${sidebar ? ', Sidebar open' : ''}`, ansi: lines.join('\n') });
      }
    }
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'pi-remote-clients-'));
const screensFile = path.join(dir, 'screens.json');
writeFileSync(screensFile, JSON.stringify(screens.map((s) => ({ ...s, text: stripVTControlCharacters(s.ansi) }))));

function probe(label, script, cwd, extra = []) {
  const run = spawnSync('bun', [path.join(HERE, 'remote-clients', script), screensFile, ...extra], { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`${label} probe failed:\n${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout);
}

const results = {};
if (herdrDir && existsSync(path.join(herdrDir, 'server/prompt.ts'))) results.herdr = probe('herdr-web-ui', 'herdr.ts', herdrDir, [herdrDir]);
else console.log('SKIP herdr-web-ui: no installed bundle (HERDR_WEB_UI_DIR)');
if (existsSync(path.join(collieDir, 'web/src/lib/frame-declarations.ts'))) results.collie = probe('Collie', 'collie.ts', path.join(collieDir, 'web'), [collieDir, framesFile]);
else console.log('SKIP Collie: no checkout with frames.toml support (COLLIE_DIR)');

let failures = 0;
screens.forEach((screen, i) => {
  const label = `${screen.name} @${screen.width} over ${screen.under}`;
  const problems = [];
  if (screen.terminal) {
    const h = results.herdr?.[i], c = results.collie?.[i];
    if (h) problems.push(`herdr-web-ui: terminal misidentified as question: ${JSON.stringify(h)}`);
    if (c?.blocks.some(block => block.kind !== 'raw')) problems.push(`Collie: terminal misidentified as card: ${JSON.stringify(c.blocks)}`);
    if (c && ['empty', 'draft'].includes(c.composer)) problems.push(`Collie: terminal misidentified as Pi composer: ${c.composer}`);
    report(label, problems);
    return;
  }
  if (screen.idle !== undefined) {
    // An idle screen reads as the same screen without Sidebar does.
    const h = results.herdr, c = results.collie;
    if (h && JSON.stringify(h[i]) !== JSON.stringify(h[screen.idle])) problems.push(`herdr-web-ui: ${JSON.stringify(h[i])}, without Sidebar ${JSON.stringify(h[screen.idle])}`);
    const kinds = (r) => JSON.stringify({ blocks: r.blocks.filter((b) => b.kind !== 'raw'), composer: r.composer, draft: r.draft });
    if (h?.[i] !== null && h?.[i] !== undefined) problems.push(`herdr-web-ui: idle editor misidentified as question: ${JSON.stringify(h[i])}`);
    if (c) {
      if (c[i].composer !== 'draft' || c[i].draft?.trim() !== 'next step') problems.push(`Collie: wanted draft composer containing "next step", got ${JSON.stringify({ composer: c[i].composer, draft: c[i].draft })}`);
      if (c[i].blocks.some(b => b.kind !== 'raw')) problems.push(`Collie: idle editor misidentified as card: ${JSON.stringify(c[i].blocks)}`);
      if (kinds(c[i]) !== kinds(c[screen.idle])) problems.push(`Collie: ${kinds(c[i])}, without Sidebar ${kinds(c[screen.idle])}`);
    }
    report(label, problems);
    return;
  }
  const dialog = DIALOGS.find((d) => d.name === screen.name);
  const h = results.herdr?.[i];
  if (dialog.terminalPicker) {
    // Tree navigation and searchable prompt history stay terminal-only. Collie may mirror the whole pane with
    // its declared Escape control, but must not lift a selection card or partial dialog.
    const c = results.collie?.[i];
    if (h) problems.push(`herdr-web-ui: terminal picker misidentified as question: ${JSON.stringify(h)}`);
    if (c) {
      const mirrors = c.blocks.filter(b => b.kind === 'unread-dialog');
      if (mirrors.length > 1 || c.blocks.some(b => b.kind !== 'raw' && b.kind !== 'unread-dialog') || mirrors.some(b =>
        b.wholePane !== true || b.cancel?.key !== 'Escape' || b.cancel?.agent !== 'pi' ||
        typeof b.cancel?.signature !== 'string' || !b.cancel.signature.trim()
      )) problems.push(`Collie: terminal picker must be raw or one Escape-only whole-pane mirror: ${JSON.stringify(c.blocks)}`);
    }
    if (c && ['empty', 'draft'].includes(c.composer)) problems.push(`Collie: terminal picker misidentified as composer: ${c.composer}`);
    report(label, problems);
    return;
  }
  if (h !== undefined) {
    if (h === null) problems.push('herdr-web-ui: no card');
    else {
      if (dialog.question && h.question.replace(/\s+/g, ' ').trim() !== dialog.question) problems.push(`herdr-web-ui: question ${JSON.stringify(h.question)}`);
      if (dialog.herdr.multi !== undefined && h.multi !== dialog.herdr.multi) problems.push(`herdr-web-ui: multi_select ${h.multi}`);
      if (dialog.herdr.options !== undefined && h.options.length !== dialog.herdr.options) problems.push(`herdr-web-ui: options ${JSON.stringify(h.options)}`);
      else if (dialog.herdr.labels !== undefined && JSON.stringify(h.options) !== JSON.stringify(dialog.herdr.labels)) problems.push(`herdr-web-ui: labels ${JSON.stringify(h.options)}`);
    }
  }
  const c = results.collie?.[i];
  if (c !== undefined) {
    const card = c.blocks.find((b) => b.kind !== 'raw');
    const wanted = dialog.collie.kind;
    const read = [];
    if (c.blocks.some(b => b.kind === 'unread-dialog')) read.push('Collie: ordinary question rendered as unread-dialog');
    if (card?.kind !== wanted) read.push(`Collie: ${card?.kind ?? 'no card'}, wanted ${wanted}`);
    else if (wanted === dialog.collie.kind && dialog.collie.options !== undefined && card.options.length !== dialog.collie.options) read.push(`Collie: options ${JSON.stringify(card.options)}`);
    if (card?.kind === wanted && dialog.question && card.question.replace(/\s+/g, ' ').trim() !== dialog.question) read.push(`Collie: question ${JSON.stringify(card.question)}`);
    if (card?.kind === wanted && dialog.collie.labels && JSON.stringify(card.options.slice(0, dialog.collie.labels.length)) !== JSON.stringify(dialog.collie.labels)) read.push(`Collie: labels ${JSON.stringify(card.options)}`);
    if (dialog.collie.wraps && wrapsRow(dialog.collie.wraps, screen.width)) read.push(`an option is wider than ${screen.width - 4} columns, and Pi's own select wraps it with no gutter`);
    problems.push(...read);
  }
  report(label, problems);
});

function report(label, problems) {
  if (problems.length) {
    failures++;
    console.log(`FAIL ${label}\n  ${problems.join('\n  ')}`);
  } else console.log(`ok   ${label}`);
}
assert.equal(failures, 0, `${failures} screen(s) not read as their client should read them`);
console.log('PASS remote clients read every dialog');
