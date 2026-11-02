// Remote clients read a waiting Pi dialog off the screen and turn it into a phone card. This renders
// the suite's dialogs through Pi's real theme and components, as they sit over the one-row footer
// pi-status-footer draws while `herdr:blocked` is held, and runs every screen through each installed
// client's own reader:
//   - Ovis (formerly herdr-web-ui): `parseInteractivePrompt` from a source checkout or installed bundle;
//   - Collie: the pi adapter of a Collie checkout, given this machine's `frames.toml`.
// A client that is not installed is skipped, so this is not part of `npm test`: run it with
// `npm run check:clients` after changing a dialog, the footer or a below-editor widget.
// With Sidebar (pi-sidebar) open, every dialog is drawn again in Sidebar's real split, collapsed as
// the controller collapses it while a dialog waits, and main's idle editor must read as it does
// without Sidebar.
// Overrides: OVIS_DIR, legacy HERDR_WEB_UI_DIR, COLLIE_DIR, COLLIE_FRAMES.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolveOvisDirectory, assertRemoteClientsPresent } from './lib/remote-client-paths.mjs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';
import { createEventBus, initTheme } from '@earendil-works/pi-coding-agent';
import { stripVTControlCharacters } from 'node:util';
import { Container, Spacer, setKeybindings, visibleWidth } from '@earendil-works/pi-tui';
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
const { createChatViewport } = await import(new URL('./modes/interactive/chat-viewport.js', sdkUrl));
const { renderLayoutFrame } = await import(new URL('./layout.js', import.meta.resolve('@earendil-works/pi-tui')));
const { SidebarPanel } = await jiti.import('../packages/pi-sidebar/src/panel.ts');
const { SplitRoot, dividerLines } = await jiti.import('../packages/pi-sidebar/src/layout.ts');
const { DEFAULT_MIN_COLUMNS, DEFAULT_RATIO } = await jiti.import('../packages/pi-sidebar/src/config.ts');
const { sidebarScreen, sidebarFamilyScreens } = await import('./remote-clients/sidebar.mjs');
const { startupSplashScreens } = await import('./remote-clients/startup-splash.mjs');
const { gatePickerDialogs } = await import('./remote-clients/workflow-pickers.mjs');
const { system1Dialogs } = await import('./remote-clients/system1.mjs');
const { subagentScreens } = await import('./remote-clients/subagents.mjs');
const { TerminalPanel } = await jiti.import('../packages/pi-interactive-shell/src/panel.ts');
const { HistoryPicker } = await jiti.import('../packages/pi-history-search/src/picker.ts');
const { default: historySearch } = await jiti.import('../packages/pi-history-search/src/index.ts');
const { ApprovalPicker, pickApproval, createApprovalState, handoffLabel, HERE: IMPLEMENT_HERE, COMPACT_HERE, LINKED_EXECUTE, LINKED_COMPACT, LINKED_FRESH, EDIT, SAVE, KEEP } = await jiti.import('../packages/pi-plan-mode/src/approval-picker.ts');
const { PlanNameInput } = await jiti.import('../packages/pi-plan-mode/src/plan-name-input.ts');
const { registerExec, FINISH_MESSAGE_TYPE } = await jiti.import('../packages/pi-plan-mode/src/exec.ts');
const { createNegotiation } = await jiti.import('../packages/pi-plan-mode/src/negotiation.ts');
const { renderFooter, layoutFooter, absorbStatuses } = await jiti.import('../packages/pi-status-footer/src/index.ts');
const { settingsCycles } = await jiti.import('../packages/pi-status-footer/src/settings-cycle.ts');
const { renderPill } = await jiti.import('../packages/pi-bg/src/pill.ts');
const { WORKFLOW_EXPLANATIONS } = await jiti.import('../packages/pi-status-footer/src/workflow-ui.ts');
const { choiceMenu, coldTitle } = await jiti.import('../packages/pi-cache-guard/src/index.ts');
const { registerTreeFork, FORK_TITLE, FORK_DESTINATIONS } = await jiti.import('../packages/pi-herdr/src/tree-fork.ts');
const { nextPromptScreens } = await import('./remote-clients/next-prompt.mjs');

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ovis = resolveOvisDirectory();
const collieDir = process.env.COLLIE_DIR ?? path.join(homedir(), 'Projects/collie');
const framesFile = process.env.COLLIE_FRAMES ?? path.join(homedir(), '.config/collie/frames.toml');


initTheme('dark', false);
const theme = themeModule.theme;
const kb = new KeybindingsManager({ 'app.model.select': ['alt+p', 'ctrl+l'] });
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
// Detached protocol snapshots, never a second renderer or a copy of role-default policy.
const flowSnapshot = (workflow, blocked, provider = 'anthropic', model = 'claude-opus-5-5') => ({
  version: 1, operatingMode: 'linked', revision: 1, workflow,
  ready: true, guardAvailable: true, transitioning: false,
  selectedFlow: {
    provider, anchorModel: model,
    roles: Object.fromEntries(['work', 'chat', 'plan', 'exec'].map(phase => [phase, {
      provider, modelId: model, suggestedThinking: 'high',
    }])),
  },
  ...(blocked ? { blocked } : {}),
});
const activity = width => [...renderPill({ label: '1 task' }, false, width, theme), ''];
function statusFooter(width, statuses, { compact = false, phase = 'idle', flow, autoEffort, providerUsage, providerUsageMore, system1, settingsCycle, readOnly = false, model = 'claude-opus-5-5', provider = 'anthropic' } = {}) {
  const absorbed = absorbStatuses(statuses, { claudeRow: false });
  const actions = {
    'model.open': {}, 'reasoning.cycle': {},
    ...(absorbed.workflow ? { 'workflow.cycle': {}, 'workflow.open': {}, 'flow.open': {} } : {}),
    ...(absorbed.exec !== undefined ? { 'execution.status': {} } : {}),
    ...(absorbed.mode ? { 'approvals.open': {} } : {}),
    ...(autoEffort === undefined ? {} : { 'effort.toggle': { active: autoEffort } }),
    ...(system1 ? { 'system1.open': {} } : {}),
  };
  const snapshot = {
    cwd: '/tmp/pi-plugins', model, provider, thinking: 'high', oauth: true,
    context: { tokens: 24000, contextWindow: 200000, percent: 12 },
    git: { project: 'pi-plugins', branch: 'main' },
    totals: { input: 23000, output: 1500, cacheRead: 90000, cacheWrite: 400, cost: 1.24, compactions: 1, started: NOW - 60000 },
    quotas: [], now: NOW, queued: false, borderGauge: true, phase,
    ...absorbed, statuses: absorbed.rest, compact, flow, actions, providerUsage, providerUsageMore, system1, settingsCycle, readOnly,
    primaryKeys: { model: kb.getKeys('app.model.select')[0], workflow: absorbed.workflow?.key, approvals: absorbed.mode?.key },
  };
  const layout = layoutFooter(snapshot, width, theme);
  const lines = renderFooter(snapshot, width, theme);
  assert.deepEqual(lines, layout.lines, 'client frames must use the actual footer layout');
  assert.ok(lines.every(line => visibleWidth(line) <= width), `footer rows fit ${width} columns`);
  if (readOnly) assert.deepEqual(layout.hits, [], 'other-session chrome must remain read-only despite a main preview');
  const plain = lines.map(stripVTControlCharacters);
  assert.doesNotMatch(plain.join('\n'), /\bpending\b|\bapplying\b/iu,
    'footer values do not duplicate the transcript phase indicator');
  const linked = !readOnly && flow?.operatingMode === 'linked';
  const effectiveKind = absorbed.exec !== undefined ? 'exec' : absorbed.workflow?.kind;
  const preview = !compact && !readOnly && ['pending', 'applying'].includes(settingsCycle?.phase) ? settingsCycle : undefined;
  const kind = effectiveKind && effectiveKind !== 'exec'
    ? preview?.settings.find(item => item.key === 'workflow')?.target ?? effectiveKind : effectiveKind;
  const badge = kind?.toUpperCase();
  assert.doesNotMatch(plain.join('\n'), /workflow: (work|chat|plan|exec)/iu, 'raw provider status must not leak into the footer');
  if (compact) {
    assert.equal(lines.length, 1, 'blocked footer must stay one row');
    assert.deepEqual(layout.hits, [], 'waiting dialogs must not leave live footer controls');
    if (badge) assert.ok(plain[0].includes(badge), 'blocked footer keeps the uppercase workflow badge');
    assert.ok(!plain[0].includes('Approvals'), 'blocked footer must not merge approvals into the workflow badge');
  } else {
    const workflow = plain.filter(line => /\b(WORK|CHAT|PLAN|EXEC)\b/u.test(line));
    const approvals = plain.filter(line => line.includes('Approvals'));
    assert.equal(workflow.length, kind ? 1 : 0, 'workflow badge keeps its own row, including exec fallback');
    if (badge) {
      assert.ok(workflow[0].includes(badge), 'workflow row uses the uppercase mode badge');
      assert.ok(!workflow[0].includes('Approvals'), 'approvals stay separate from workflow');
      // Hints yield before critical state at narrow widths; Sidebar also probes smaller widths.
      if (!preview && !linked && !absorbed.exec && width >= (kind === 'exec' ? 120 : 46)) assert.ok(workflow[0].includes(WORKFLOW_EXPLANATIONS[kind]), `workflow row explains ${kind} when space permits: ${workflow[0]}`);
      if (preview && width >= 46) assert.ok(workflow[0].includes(badge), 'draft workflow retains the target badge in its existing semantic row');
      if (!linked && kind === 'exec' && width >= 46) assert.match(workflow[0], /\/plan-exec\s*$/u, 'Independent Exec offers status, never a workflow cycle');
      if (linked && !absorbed.exec && !flow.blocked && width >= 120) assert.ok(workflow[0].includes(flow.selectedFlow.provider), 'Linked combines provider and workflow on one row');
    }
    assert.equal(approvals.length, absorbed.mode ? 1 : 0, 'Approvals keeps its own row');
    if (preview && width >= 46 && approvals.length) {
      const approval = preview.settings.find(item => item.key === 'approvals');
      if (approval) assert.ok(approvals[0].includes(approval.label), 'normal approval row retains the preview target without a phase suffix');
    }
    if (preview && width >= 120) {
      const reasoning = preview.settings.find(item => item.key === 'reasoning');
      if (reasoning) assert.ok(plain.some(line => line.includes('reasoning') && line.includes(reasoning.label)), 'normal model row retains the reasoning target');
      const effort = preview.settings.find(item => item.key === 'auto-effort');
      if (effort && autoEffort !== undefined) assert.ok(plain.some(line => line.includes('reasoning') && line.includes(effort.target ? 'auto' : 'auto off')), 'normal auto-effort segment retains the target');
    }
    if (linked) {
      assert.equal(lines.length, (absorbed.marimo?.length ?? 0) + 4 + (providerUsage?.length ?? 0), 'Linked removes only the duplicate model row');
      if (flow.blocked && width >= 46) assert.match(plain.join('\n'), /blocked/iu, 'an unavailable Linked flow must not look healthy');
    }
    // At full width each effective key follows its content directly, not a padded rail.
    if (width >= 120 && !readOnly) {
      const controls = [[linked ? workflow[0] : plain.find(line => line.includes('reasoning')), snapshot.primaryKeys.model]];
      if (!linked && workflow.length) controls.push([workflow[0], kind === 'exec' ? '/plan-exec' : snapshot.primaryKeys.workflow]);
      if (approvals.length) controls.push([approvals[0], snapshot.primaryKeys.approvals]);
      for (const [line, key] of controls) {
        if (!key || !line) continue;
        assert.ok(line.endsWith(` · ${key}`), `effective hint is an inline suffix: ${line}`);
        assert.ok(!line.endsWith(`  · ${key}`), `no alignment padding before hint: ${line}`);
      }
    }
    for (const [rows, icon] of [[workflow, '\uf0e8'], [approvals, '\uf510']]) {
      for (const line of rows) {
        assert.ok(line.startsWith(`${width >= 60 ? ' ' : ''}${icon}  `), `mode row keeps its indentation and distinct icon: ${JSON.stringify(line)}`);
        assert.equal(line.includes(icon === '\uf0e8' ? '\uf510' : '\uf0e8'), false, 'mode icons must not be shared');
      }
    }
  }
  return lines;
}
const codexReady = { provider: 'openai-codex', source: 'Codex account', state: 'ready', observedAt: NOW, windows: [{ label: '5h', used: 25, reset: NOW + 3_600_000 }] };
const codexUnavailable = { provider: 'openai-codex', source: 'Codex account', state: 'unavailable', windows: [], reason: 'Subscription limits are unavailable.' };
const codexStale = { ...codexReady, observedAt: NOW - 11 * 60_000 };
const codexResetDue = { ...codexReady, windows: [{ label: '5h', used: 25, reset: NOW - 1 }] };
const codexStates = { ready: codexReady, unavailable: codexUnavailable, stale: codexStale, 'reset due': codexResetDue };
const openaiModel = { provider: 'openai', model: 'gpt-5.2' };
const footer = (width) => statusFooter(width, modeStatuses('plan', 'yolo'), { compact: true, phase: 'waiting' });
const UNDERS = {
  footer: (width) => footer(width),
  'pill+footer': (width) => [...activity(width), ...footer(width)],
  ...Object.fromEntries(Object.entries(codexStates).flatMap(([state, usage]) => [false, true].flatMap(linked => {
    const rows = width => {
      const lines = statusFooter(width, modeStatuses('plan', 'auto'), {
        ...openaiModel, compact: true, phase: 'waiting', providerUsage: [usage],
        ...(linked ? { flow: flowSnapshot('plan', undefined, openaiModel.provider, openaiModel.model) } : {}),
      });
      assert.doesNotMatch(stripVTControlCharacters(lines[0]), /Codex/u);
      return lines;
    };
    const name = `OpenAI Codex ${state} ${linked ? 'Linked' : 'Independent'} blocked`;
    return [[name, rows], [`${name} pill`, width => [...activity(width), ...rows(width)]]];
  }))),
  ...Object.fromEntries(['work', 'chat', 'plan', 'exec'].flatMap(workflow => {
    return ['idle', 'waiting'].flatMap(phase => {
      const rows = width => statusFooter(width, modeStatuses(workflow, 'auto'), { compact: true, phase });
      return [
        [`${workflow} badge ${phase} footer`, rows],
        [`${workflow} badge ${phase} pill+footer`, width => [...activity(width), ...rows(width)]],
      ];
    });
  })),
  ...Object.fromEntries(['waiting for answer', 'review failed', 'approval needed', 'idle · not completed'].flatMap(phase => {
    const rows = width => statusFooter(width, modeStatuses('exec', 'auto', phase), { compact: true, phase });
    return [
      [`exec ${phase} footer`, rows],
      [`exec ${phase} pill+footer`, width => [...activity(width), ...rows(width)]],
    ];
  })),
  ...Object.fromEntries(['work', 'chat', 'plan', 'exec'].flatMap(workflow => {
    const rows = width => statusFooter(width, modeStatuses(workflow, 'auto', workflow === 'exec' ? 'implementing' : undefined), {
      compact: true, phase: 'waiting', flow: flowSnapshot(workflow),
    });
    return [
      [`Linked ${workflow} blocked footer`, rows],
      [`Linked ${workflow} blocked pill+footer`, width => [...activity(width), ...rows(width)]],
    ];
  })),
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
const GENERIC = { tool: 'deploy', action: 'deploy restart', target: 'production-api', command: 'preview only', held: 'restarts a service' };

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
    view: { tool: spec.tool ?? 'bash', subject: spec.tool === 'read' ? '~/Projects/other/a.ts' : '', ...(spec.action ? { action: spec.action, target: spec.target } : {}), body: { kind: 'code', lang: 'bash', text: spec.command ?? 'git push --force origin main' } },
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
  return [IMPLEMENT_HERE, COMPACT_HERE, ...PLAN_TARGETS.slice(0, count).map(t => handoffLabel(t.targetName, t.target.thinkingLevel)), EDIT, SAVE, KEEP];
}
async function selectorLines(width, count, changed, linked = false, fresh = false, recommendedThinkingLevel, effortDefaultKey) {
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
  void pickApproval(ctx, {
    planning: { provider: 'anthropic', modelId: linked ? PLAN_TARGETS[0].target.modelId : 'claude-fable-5-5', thinkingLevel: 'high' },
    targets: PLAN_TARGETS.slice(0, count),
    recommendedThinkingLevel, effortDefaultKey,
    ...(linked ? { intent: 'linked-execution', flow: flowSnapshot('plan'), ...(fresh ? { freshTarget: PLAN_TARGETS[0] } : {}) } : {}),
  }, createApprovalState());
  await new Promise(resolve => setTimeout(resolve, 0));
  return lines;
}

function planNameLines(width, edited = false) {
  const component = new PlanNameInput({ suggestion: 'client-plan', directory: '/tmp/plans' }, theme, kb, () => {}, () => {});
  try {
    if (edited) component.handleInput('-revised');
    const lines = component.render(width);
    assert.ok(lines.map(stripVTControlCharacters).join('\n').includes(edited ? 'client-plan-revised' : 'client-plan'), 'filename must be editable text');
    return lines;
  } finally {
    component.dispose();
  }
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

// Exercise real registerExec command/tool selects, not copies of their questions/options.
const EXEC_SELECTS = [
  { name: 'override confirmation', reason: 'user_needed', command: 'accept', question: 'Finish without planner acceptance?', labels: ['Finish without review', 'Keep paused'] },
  { name: 'failure recovery', reason: 'failure', command: '', question: 'Review did not finish\nThe review service was unavailable.\nAsk to retry the review, or discuss what happened. No retry has been authorized.', labels: ['Retry review', 'Discuss first', 'Finish without review', 'Stop implementation'] },
  { name: 'exhausted recovery', reason: 'exhausted', command: '', question: 'Another revision needs your approval\nRevisions used: 2. Outstanding findings: 0.\nAllow one more attempt, discuss the findings, or finish without review.', labels: ['Allow one more attempt', 'Discuss first', 'Finish without review', 'Stop implementation'] },
  { name: 'user-needed menu', reason: 'user_needed', command: '', question: 'Waiting for your answer\nDid the browser readiness check pass?\nProvide human verification.\nReply here. Ask for clarification if you need it; answering lets implementation continue.', labels: ['Answer in chat', 'Finish without review', 'Stop implementation'] },
  { name: 'stop confirmation', reason: 'user_needed', tool: 'stop', question: 'Stop implementation?', labels: ['Stop implementation', 'Keep working'] },
];
async function execSelectLines(width, spec) {
  const commands = new Map();
  const handlers = new Map();
  const tools = new Map();
  const events = new EventEmitter();
  let blocked = false, lines, selected = false, status;
  events.on('herdr:blocked', ({ active }) => { blocked = active; });
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    registerTool: spec => tools.set(spec.name, spec), registerMessageRenderer() {},
    registerCommand: (name, spec) => commands.set(name, spec),
    getActiveTools: () => [], setActiveTools() {}, appendEntry() {},
    events,
  };
  const ctx = {
    hasUI: true, mode: 'tui', isIdle: () => true,
    ui: {
      setStatus: (key, value) => { if (key === 'plan-exec') status = value; },
      notify: () => {}, // A canceled bare-command menu reports its paused status.
      select: async (title, options) => {
        assert.equal(selected, false, 'execution fixture must open exactly one select');
        selected = true;
        assert.ok(blocked, 'execution select must hold herdr:blocked');
        assert.deepEqual(options, spec.labels);
        assert.ok(!wrapsRow(options, 46), 'execution select labels must fit the phone width');
        assert.equal(title, spec.question, 'execution select must explain the current pause or confirmation');
        lines = new ExtensionSelectorComponent(title, options, () => {}, () => {}).render(width);
        return undefined;
      },
    },
  };
  const exec = registerExec(pi, { completionReview: () => true, completionMaxRevisions: () => 2 });
  const negotiation = createNegotiation('remote-client-fixture', 2);
  negotiation.phase = 'paused';
  negotiation.pause = { reason: spec.reason, action: spec.reason === 'failure' ? 'The review service was unavailable.' : 'Provide human verification.', ...(spec.reason === 'user_needed' ? { question: 'Did the browser readiness check pass?' } : {}) };
  if (spec.reason === 'exhausted') negotiation.revisionsUsed = 2;
  const before = structuredClone(negotiation);
  ctx.sessionManager = { getBranch: () => [{ type: 'custom', customType: 'plan-mode:exec', data: { active: true, planFile: '/tmp/client-plan.md', implementer: 'Terra', implementerModel: 'openai-codex/gpt-6.1-terra', asks: 0, costUsd: 0, negotiation } }] };
  await handlers.get('session_start')({}, ctx);
  if (spec.tool) await tools.get('continue_plan').execute('client-stop', { action: spec.tool }, undefined, undefined, ctx);
  else await commands.get('plan-exec').handler(spec.command, ctx);
  assert.ok(selected, 'actual execution action must open a select');
  assert.ok(exec.active, 'canceling the fixture select must leave execution paused');
  assert.deepEqual(negotiation, before, 'canceling must not authorize recovery or alter the pause');
  assert.equal(blocked, false, 'execution select must release herdr:blocked');
  const phase = spec.reason === 'user_needed' ? 'waiting for answer' : spec.reason === 'exhausted' ? 'approval needed' : 'review failed';
  assert.ok(status.startsWith(`exec mode on · ${phase} ·`), 'actual execution status must describe its pause');
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
  ...EXEC_SELECTS.map(spec => ({
    name: `plan exec ${spec.name}`, lines: width => execSelectLines(width, spec), question: spec.question.replace(/\s+/gu, ' ').trim(),
    herdr: { options: spec.labels.length, multi: false, labels: spec.labels },
    collie: { kind: 'prompt-select', options: spec.labels.length + 1, labels: spec.labels, wraps: spec.labels },
  })),
  ...await gatePickerDialogs({
    // Read-only picker capture does not display history, but its extension API
    // still supports registration of the shared public custom-entry renderer.
    toolGate: pi => toolGate({ ...pi, registerEntryRenderer() {} }), ExtensionSelectorComponent,
  }),
  ...await system1Dialogs({ ExtensionSelectorComponent }),
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
  { name: 'tool-gate approval (generic action and target)', lines: w => approvalLines(w, GENERIC), questionIncludes: ['Action: deploy restart', 'Target: production-api'], herdr: { options: 3, multi: false }, collie: { kind: 'prompt-select' } },
  ...[
    ['tool-gate approval (rule)', RULE],
    ['tool-gate approval (two rules)', RULES],
    ['tool-gate approval (folder)', FOLDER],
  ].map(([name, spec]) => {
    const rows = [...approvalOptions(spec.kind, spec.plural), 'Block with a message'];
    return {
      name, lines: (w) => approvalLines(w, spec),
      // Compare all target/rule characters below, ignoring whitespace inserted by screen wrapping.
      questionIncludes: [`Action: ${spec.tool ?? 'bash'}`, `Target: ${spec.tool === 'read' ? '~/Projects/other/a.ts' : spec.command}`, ...spec.grant],
      herdr: { options: rows.length, multi: false, labels: rows }, collie: { kind: 'prompt-select', wraps: rows },
    };
  }),
  ...[0, 1, 2].flatMap(count => [false, true].map(changed => ({
    name: `plan approval (${count} targets${changed ? ', effort changed' : ''})`,
    lines: w => selectorLines(w, count, changed),
    question: `Implement this plan? ←/→ effort: ${changed ? 'off' : 'high'}`,
    herdr: { options: 5 + count, multi: false, labels: planLabels(count) },
    collie: { kind: 'prompt-select', options: 6 + count, labels: planLabels(count), wraps: planLabels(count) },
  }))),
  ...[false, true].flatMap(fresh => [false, true].map(changed => {
    const labels = [LINKED_EXECUTE, LINKED_COMPACT, ...(fresh ? [LINKED_FRESH] : []), EDIT, SAVE, KEEP];
    return {
      name: `linked plan approval (same-model worker${fresh ? ', fresh available' : ''}${changed ? ', effort changed' : ''})`,
      lines: w => selectorLines(w, 1, changed, true, fresh),
      question: `Implement this plan? Linked worker: anthropic/claude-opus-5-5. ←/→ effort: ${changed ? 'off' : 'high'}`,
      herdr: { options: labels.length, multi: false, labels },
      collie: { kind: 'prompt-select', options: labels.length + 1, labels, wraps: labels },
    };
  })),
  ...[false, true].flatMap(linked => [false, true].map(changed => {
    const labels = linked ? [LINKED_EXECUTE, LINKED_COMPACT, EDIT, SAVE, KEEP] : planLabels(1);
    return {
      name: `${linked ? 'linked plan approval (same-model worker' : 'plan approval (1 target'}, recommended${changed ? ', effort changed' : ''})`,
      lines: w => selectorLines(w, 1, changed, linked, false, 'low', 'recommended-fixture'),
      question: `Implement this plan? ${linked ? 'Linked worker: anthropic/claude-opus-5-5. ' : ''}←/→ effort: ${changed ? 'medium' : 'low'}`,
      herdr: { options: labels.length, multi: false, labels },
      collie: { kind: 'prompt-select', options: labels.length + 1, labels, wraps: labels },
    };
  })),
  ...[false, true].map(edited => ({
    name: `plan save filename (${edited ? 'edited' : 'prefilled'})`, question: 'Save plan as',
    lines: width => planNameLines(width, edited),
    herdr: { options: 1, multi: false, labels: ['Type your answer'] },
    collie: { kind: 'unread-dialog' },
  })),
  { name: 'cache-guard cold cache', lines: (w) => coldCacheLines(w, plainMenu), herdr: { options: plainMenu.length, multi: false, labels: plainMenu }, collie: { kind: 'prompt-select', options: plainMenu.length + 1, wraps: plainMenu } },
  { name: 'cache-guard cold cache (model offers)', lines: coldCacheLines, herdr: { options: coldMenu.length, multi: false, labels: coldMenu }, collie: { kind: 'prompt-select', options: coldMenu.length + 1, wraps: coldMenu } },
];
// Pi's own select (`ctx.ui.select`) wraps a long option onto the next row with no `│` gutter, and
// Collie reads no dialog with such a row. Every option of a Pi select must fit the narrowest width.
const wrapsRow = (labels, width) => labels.some((label) => visibleWidth(label) > width - 4);

const screens = [];
for (const width of [46, 120, 180]) {
  tui.terminal.columns = width;
  for (const dialog of DIALOGS) {
    const lines = await dialog.lines(width);
    for (const [under, rows] of Object.entries(UNDERS)) {
      screens.push({ name: dialog.name, width, under, ansi: [...lines, ...rows(width)].join('\n'),
        ...(width === 46 && under === 'footer' && dialog.name === 'plan approval (0 targets)' ? { answer: { option_index: 3 } } : {}),
        ...(width === 46 && under === 'footer' && dialog.name === 'plan save filename (prefilled)' ? { answer: { custom_text: 'phone-renamed' } } : {}) });
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

// Composable family primaries have no main send target; native dialogs temporarily use main's
// real root and return to the exact same hosted primary without reconstructing it.
for (const width of [46, 120, 180]) {
  for (const label of ['running child', 'finished child', 'planner A', 'planner B', 'planner M', 'scout']) {
    const states = await sidebarFamilyScreens({ width, height: HEIGHT, label, dock: () => [], footer });
    for (const state of ['hosted', 'expanded', 'local', 'restored']) {
      screens.push({ name: `family ${label} ${state}`, width, under: 'hosted primary', terminal: true, ansi: states[state].join('\n') });
    }
  }
  for (const dialog of DIALOGS) {
    const lines = await dialog.lines(width);
    const states = await sidebarFamilyScreens({ width, height: HEIGHT, label: 'planner A', dock: () => lines, footer });
    screens.push({ name: dialog.name, width, under: 'family primary native', ansi: states.native.join('\n') });
  }
}

// Main's idle editor under pi-status-footer's indented footer, without Sidebar and with it (either
// half focused): each client must read the last two as it reads the first.
const editor = new CustomEditor({ ...tui, terminal: { rows: HEIGHT, columns: 180 } }, themeModule.getEditorTheme(), kb, { paddingX: 0 });
editor.setText('next step');
const usageReady = { provider: 'google', source: 'Google Antigravity subscription', state: 'ready', observedAt: NOW, windows: [{ label: '5h', used: 25, reset: NOW + 3_600_000 }] };
const usageFable = used => ({ provider: 'anthropic', source: 'Anthropic subscription', state: 'ready', observedAt: NOW, windows: [{ label: 'Fable', used, reset: NOW + 3 * 86400_000 }] });
const fable71 = usageFable(71);
const fable100 = usageFable(100);
const usageUnavailable = { provider: 'openai', source: 'OpenAI subscription', state: 'unavailable', windows: [], reason: 'Subscription limits are unavailable.' };
const usageLocal = { provider: 'ollama', source: 'Local inference', state: 'not-applicable', windows: [], reason: 'Local inference has no account quota.' };
// Account data must not expand the dialog's one-row, noninteractive footer.
for (const width of [46, 120, 180]) {
  const blocked = statusFooter(width, modeStatuses('plan', 'auto'), { compact: true, providerUsage: [usageReady, usageUnavailable], providerUsageMore: 3 });
  assert.equal(blocked.length, 1);
  assert.doesNotMatch(stripVTControlCharacters(blocked[0]), /Google|OpenAI|\+3 more/u);
  for (const usage of [fable71, fable100]) {
    const fableBlocked = statusFooter(width, modeStatuses('plan', 'auto'), { compact: true, providerUsage: [usage] });
    assert.equal(fableBlocked.length, 1, 'Fable usage must not add a blocked footer row');
  }
}
// Match the real helper's JSON-only snapshot contract. Rendering is delegated to its
// registered public entry renderer, not a lookalike Text or a second settings formatter.
const cycleSnapshot = phase => ({
  id: 'remote-client-settings-burst', phase,
  settings: [
    { key: 'workflow', baseline: 'work', target: 'plan', actual: 'work', label: 'plan' },
    { key: 'reasoning', baseline: 'high', target: 'medium', actual: 'high', label: 'medium' },
    { key: 'auto-effort', baseline: false, target: true, actual: false, label: 'on' },
    { key: 'approvals', baseline: 'auto', target: 'bypassPermissions', actual: 'auto', label: 'yolo' },
  ],
  ...(phase === 'cancelled' ? { reason: 'interrupted' } : phase === 'interrupted' ? { reason: 'check current settings' } : {}),
});
function cycleHistory(phase) {
  const renderers = new Map();
  settingsCycles({ events: createEventBus(), on() {},
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
  });
  assert.equal(renderers.has('settings:cycle-state'), false, 'state snapshots never render independent history rows');
  const renderer = renderers.get('settings:cycle');
  assert.ok(renderer, 'use the actual helper entry renderer');
  const component = renderer({ type: 'custom', customType: 'settings:cycle', data: { version: 1, ...cycleSnapshot(phase) } }, {}, theme);
  for (const width of [46, 120, 180]) {
    const history = component.render(width).map(stripVTControlCharacters).join('\n');
    assert.ok(history.includes(`Settings ${phase}`), 'the real history component, not the footer, labels phase');
    if (phase === 'pending' || phase === 'applying') assert.match(history, /Workflow plan/u, 'the real history component retains the latest target');
  }
  return component;
}
for (const width of [46, 120, 180]) for (const phase of ['pending', 'applying']) {
  for (const compact of [false, true]) {
    const guarded = statusFooter(width, modeStatuses('work', 'auto'), {
      ...(compact ? { compact: true, phase: 'waiting' } : { readOnly: true }),
      flow: flowSnapshot('work'), settingsCycle: cycleSnapshot(phase),
    });
    assert.doesNotMatch(guarded.map(stripVTControlCharacters).join('\n'), /pending|applying/u,
      'blocked and other-session chrome must not advertise main preview values');
  }
}
const system1Fixture = (status, lastBackend, nextRetryAt) => ({
  waterfall: ['jev', 'openai-decisions'], status,
  candidates: [
    { backend: 'jev', provider: 'typesafe', model: 'jev-latest', local: 'configured' },
    { backend: 'openai-decisions', provider: 'system1-openai', model: 'gpt-6-luna', local: 'configured' },
  ],
  ...(lastBackend ? { lastUsed: { backend: lastBackend, provider: lastBackend === 'jev' ? 'typesafe' : 'system1-openai',
    model: lastBackend === 'jev' ? 'jev-latest' : 'gpt-6-luna', at: NOW, fallback: true } } : {}),
  ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
});
const FOOTERS = [
  ...['ready', 'fallback', 'unknown', 'unavailable', 'cooldown expired'].flatMap(state => [false, true].map(linked => ({
    name: `System 1 ${state}${linked ? ' Linked' : ''}`, statuses: modeStatuses('plan', 'auto'),
    ...(linked ? { flow: flowSnapshot('plan') } : {}),
    system1: system1Fixture(state === 'cooldown expired' ? 'unavailable' : state, state === 'fallback' ? 'openai-decisions' : undefined,
      state === 'cooldown expired' ? NOW - 1 : state === 'unavailable' ? NOW + 300000 : undefined),
  }))),
  ...['work', 'chat', 'plan', 'exec'].flatMap(workflow => ['auto', 'yolo'].map(approval => ({
    name: `${workflow}/${approval}`, statuses: modeStatuses(workflow, approval, workflow === 'exec' ? 'implementing' : undefined),
  }))),
  ...['consulting', 'review 2', 'revising · 3 findings', 'waiting for answer', 'review failed', 'approval needed', 'idle · not completed'].flatMap(phase => ['auto', 'yolo'].map(approval => ({
    name: `exec/${approval} ${phase}`, statuses: modeStatuses('exec', approval, phase),
  }))),
  ...['work', 'chat', 'plan', 'exec'].map(workflow => ({ name: `standalone ${workflow}`, statuses: modeStatuses(workflow) })),
  { name: 'standalone exec', statuses: modeStatuses(undefined, undefined, 'review 2') },
  { name: 'approval provider only', statuses: modeStatuses(undefined, 'auto') },
  { name: 'no mode providers', statuses: new Map() },
  // Notebook status slots plus the five core rows reach the deployed 13-row allowance
  // (including any activity pill/separator), rather than comparing unreadable baselines.
  { name: 'high status count', statuses: modeStatuses('plan', 'yolo'), highStatus: true },
  { name: 'provider ready', statuses: modeStatuses('plan', 'auto'), providerUsage: [usageReady] },
  { name: 'Fable 71%', statuses: modeStatuses('plan', 'auto'), providerUsage: [fable71] },
  { name: 'Fable 100% high status', statuses: modeStatuses('plan', 'yolo'), providerUsage: [fable100], highStatus: true },
  { name: 'provider unavailable', statuses: modeStatuses('plan', 'auto'), providerUsage: [usageUnavailable] },
  { name: 'provider local', statuses: modeStatuses('plan', 'auto'), providerUsage: [usageLocal] },
  { name: 'status all providers', statuses: modeStatuses('plan', 'auto'), providerUsage: [usageReady, usageUnavailable], providerUsageMore: 3 },
  { name: 'status all high status count', statuses: modeStatuses('plan', 'yolo'), providerUsage: [usageReady, usageUnavailable], providerUsageMore: 3, highStatus: true },
  ...Object.entries(codexStates).flatMap(([state, usage]) => [false, true].flatMap(linked => [false, true].map(highStatus => ({
    name: `OpenAI Codex ${state} ${linked ? 'Linked' : 'Independent'}${highStatus ? ' high status' : ''}`,
    statuses: modeStatuses('plan', 'auto'), ...openaiModel, providerUsage: [usage], highStatus,
    ...(linked ? { flow: flowSnapshot('plan', undefined, openaiModel.provider, openaiModel.model) } : {}),
  })))),
  ...['work', 'chat', 'plan', 'exec'].map(workflow => ({
    name: `Linked ${workflow}`, statuses: modeStatuses(workflow, 'auto', workflow === 'exec' ? 'implementing' : undefined),
    flow: flowSnapshot(workflow), autoEffort: true,
  })),
  { name: 'Independent auto off', statuses: modeStatuses('work', 'auto'), autoEffort: false },
  { name: 'Linked auto off', statuses: modeStatuses('work', 'auto'), flow: flowSnapshot('work'), autoEffort: false },
  { name: 'Linked Exec paused', statuses: modeStatuses('exec', 'auto', 'waiting for answer'), flow: flowSnapshot('exec') },
  { name: 'Linked unavailable', statuses: modeStatuses('plan', 'auto'), flow: flowSnapshot('plan', 'Assigned model is unavailable. Use /flow independent.') },
  { name: 'Linked high status count', statuses: modeStatuses('plan', 'yolo'), flow: flowSnapshot('plan'), highStatus: true },
  ...['pending', 'applying', 'cancelled', 'interrupted'].flatMap(phase => [false, true].map(linked => ({
    name: `${linked ? 'Linked' : 'Independent'} settings ${phase}`,
    statuses: modeStatuses('work', 'auto'), ...(linked ? { flow: flowSnapshot('work') } : {}),
    autoEffort: false, settingsCycle: cycleSnapshot(phase), history: cycleHistory(phase), highStatus: true,
  }))),
];
function idleFooter(width, fixture, activityRows = 0) {
  if (!fixture.highStatus) return statusFooter(width, fixture.statuses, fixture);
  const statuses = new Map(fixture.statuses);
  // frames.toml's status_rows bounds the whole region below the editor, including
  // pi-bg's pill and separator, not just renderFooter's output. status_blank_rows
  // permits that separator within the region; it does not extend the row budget.
  const coreRows = statusFooter(width, fixture.statuses, fixture).length;
  assert.equal(coreRows, (fixture.flow?.operatingMode === 'linked' ? 4 : 5) + (fixture.providerUsage?.length ?? 0), 'provider rows count within the existing core row budget');
  const notebooks = 13 - coreRows - activityRows;
  for (let i = 1; i <= notebooks; i++) statuses.set(i === 1 ? 'marimo' : `marimo-${i}`, `marimo: analysis-${i}.py · disconnected`);
  const absorbed = absorbStatuses(statuses, { claudeRow: false });
  assert.equal(absorbed.marimo.length, notebooks);
  const lines = statusFooter(width, statuses, fixture);
  assert.equal(lines.length + activityRows, 13, 'high-status idle fixture must exercise the full combined status-row allowance');
  return lines;
}
const IDLE = [
  ['without Sidebar', { open: false }],
  ['Sidebar collapsed', { collapsed: true, focused: false }],
  ['Sidebar expanded, main focused', { focused: false }],
  ['Sidebar expanded, Sidebar focused', { focused: true }],
];
// Collie reads only main's side of Sidebar's split through frames.toml's panel_below and
// panel_beside declarations (Collie fork 1.24.0-frames.18b43859 and later).
for (const width of [46, 120, 180]) {
  for (const fixture of FOOTERS) {
    for (const withActivity of [false, true]) {
      const footerLines = idleFooter(width, fixture, withActivity ? 2 : 0);
      const rendered = footerLines.map(stripVTControlCharacters).join('\n');
      if (fixture.providerUsage?.includes(fable71) || fixture.providerUsage?.includes(fable100)) {
        const used = fixture.providerUsage[0].windows[0].used;
        assert.equal(footerLines.length + (withActivity ? 2 : 0), fixture.highStatus ? 13 : 6 + (withActivity ? 2 : 0), 'Fable keeps the existing row budget');
        assert.match(rendered, new RegExp(`Fable.*${used}%`, 'u'), 'Fable retains its percentage at every width');
        if (width >= 120) assert.match(rendered, /resets in 3d0h/u, 'wide Fable row retains its multi-day countdown');
      }
      if (fixture.providerUsage?.length) {
        assert.ok(fixture.providerUsage.length <= 2, 'at most two account rows');
        if (fixture.providerUsage.includes(usageReady)) assert.match(rendered, /Google.*5h.*25%/u, 'ready usage keeps its measured percentage');
        if (fixture.providerUsage.includes(usageUnavailable)) assert.match(rendered, /OpenAI.*limits unavailable/u, 'unavailable usage is explicit');
        if (fixture.providerUsage.includes(usageLocal)) assert.match(rendered, /Local.*no account quota/u, 'local usage is not presented as a subscription');
        if (fixture.provider === 'openai') {
          assert.equal(fixture.providerUsage.length, 1, 'OpenAI has exactly one Codex account row');
          assert.equal((rendered.match(/Codex/gu) ?? []).length, 1, 'the Codex account row is not duplicated');
          assert.doesNotMatch(rendered, /OpenAI.*limits unavailable/u, 'no separate unavailable OpenAI account row');
          if (fixture.providerUsage[0] === codexUnavailable) assert.match(rendered, /Codex.*limits unavailable/u);
          else assert.match(rendered, /Codex.*5h.*25%/u);
          if (fixture.providerUsage[0] === codexStale) assert.match(rendered, /stale/u);
          if (fixture.providerUsage[0] === codexResetDue) assert.match(rendered, /stale.*reset due/u);
        }
        if (fixture.providerUsageMore && width >= 120) assert.match(rendered, /OpenAI.*\+3 more/u, 'additional sources are counted on the second account row');
      }
      if (fixture.system1) {
        const expected = fixture.name.includes('cooldown expired') || fixture.system1.status === 'unknown' ? 'S1 Jev→OpenAI?'
          : fixture.system1.status === 'fallback' ? 'S1 OpenAI*'
          : fixture.system1.status === 'unavailable' ? 'S1 unavailable' : 'S1 Jev→OpenAI';
        assert.ok(rendered.includes(expected), `actual System 1 badge ${expected} fits ${width}`);
      }
      const baseline = screens.length;
      for (const [under, options] of IDLE) {
        const rows = w => withActivity ? [...activity(w), ...idleFooter(w, fixture, 2)] : idleFooter(w, fixture);
        const { lines: screen } = sidebarScreen({ width, height: HEIGHT,
          ...(fixture.history ? { transcript: fixture.history } : {}),
          dock: (w) => editor.render(w), footer: rows, ...options });
        if (fixture.history) {
          const history = fixture.history.render(width);
          assert.equal(history.length, 1, 'settings history stays a single content row');
          assert.ok(visibleWidth(history[0]) <= width, 'narrow settings history truncates without wrapping');
          const visible = screen.map(stripVTControlCharacters).filter(line => line.includes(`Settings ${fixture.settingsCycle.phase}`));
          assert.equal(visible.length, 1, 'real editor layout contains exactly one settings history anchor');
        }
        screens.push({ name: `idle editor ${fixture.name}${withActivity ? ' + activity' : ''}`, width, under, idle: baseline, ansi: screen.join('\n') });
      }
    }
  }
}

// The startup map/resources stay above the real editor and the native MCP manager dock.
// Both parsers must find only the actual editor when idle, never a map tile or manager control.
const splashStart = screens.length;
screens.push(...(await startupSplashScreens({
  theme, getEditorTheme: themeModule.getEditorTheme, kb, sidebarScreen,
  idleFooter: width => idleFooter(width, { statuses: modeStatuses('plan', 'auto') }), height: 64,
  footerVariants: [
    ...FOOTERS.filter(fixture => ['plan/auto', 'exec/auto', 'high status count', 'Linked work', 'Linked plan', 'Linked exec', 'Linked unavailable', 'Linked high status count'].includes(fixture.name)).flatMap(fixture => [
      { name: fixture.name, idleFooter: width => idleFooter(width, fixture) },
      { name: `${fixture.name} + activity`, idleFooter: width => [...activity(width), ...idleFooter(width, fixture, 2)] },
    ]),
    ...[false, true].flatMap(linked => [false, true].map(withActivity => ({
      name: `${linked ? 'Linked' : 'Independent'} blocked${withActivity ? ' + activity' : ''}`,
      herdrModelCard: true,
      idleFooter: width => [
        ...(withActivity ? activity(width) : []),
        ...statusFooter(width, modeStatuses('plan', 'auto'), { compact: true, phase: 'waiting', ...(linked ? { flow: flowSnapshot('plan') } : {}) }),
      ],
    }))),
  ],
})).map(screen => screen.idle === undefined ? screen : { ...screen, idle: screen.idle + splashStart }));

// Actual running/ended SessionViews, their native select, and the restored child/main composers.
// Keep these alongside the synthetic family-host matrix: both clients read the full native frame.
const subagentsStart = screens.length;
screens.push(...(await subagentScreens({
  height: HEIGHT, footer, idleFooter: width => idleFooter(width, { statuses: modeStatuses('plan', 'auto') }),
  sessionFooter: (session, width, childTheme) => renderFooter({
    ...session, quotas: [], now: NOW, statuses: [], oauth: false,
    git: { project: 'pi-plugins', branch: 'main' },
  }, width, childTheme),
})).map(screen => screen.idle === undefined ? screen : { ...screen, idle: screen.idle + subagentsStart }));

// Capture the returned completion renderer from the real registerExec API, rather than drawing a
// lookalike card or calling renderFinish directly. Both expansion states live ahead of the idle
// composer, through the same layout and reader checks as the normal-footer fixtures above.
const messageRenderers = new Map();
const completionTools = new Map();
registerExec({
  on() {}, registerTool: tool => completionTools.set(tool.name, tool), registerCommand() {},
  registerMessageRenderer: (name, renderer) => messageRenderers.set(name, renderer),
  events: new EventEmitter(),
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
    assert.equal(/ctrl\+o (?:to expand|for full report)/iu.test(rendered), !expanded, 'concise completion offers expansion');
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

// Compact transcript cards must not steal the actual waiting dialog's question or options.
// Reuse command selects and their existing parser contracts rather than lookalike dialogs.
const renderReview = completionTools.get('finish_plan')?.renderResult;
assert.equal(typeof renderReview, 'function', 'registerExec must register its review result renderer');
const pausedDetails = {
  planFile: completionDetails.planFile, implementer: 'Terra', round: 1,
  report: 'Implemented the readiness check.', verification: 'Automated checks passed.',
  concerns: 'Human verification is still needed.',
  decision: {
    outcome: 'user_needed', summary: 'Human verification is required.',
    question: 'Did the browser readiness check pass?', recommendation: 'Provide human verification.',
    evidence: ['Paused evidence marker: automated checks passed.'], limitations: [], findings: [],
  },
  negotiation: {
    attempts: 1, reviewCostUsd: 0.01, phase: 'paused', history: [],
    pause: { reason: 'user_needed', question: 'Did the browser readiness check pass?', action: 'Provide human verification.' },
  },
};
for (const width of [46, 120]) {
  tui.terminal.columns = width;
  for (const paused of [false, true]) {
    const dialog = DIALOGS.find(item => item.name === (paused ? 'plan exec user-needed menu' : '/mode picker'));
    const lines = await dialog.lines(width);
    const transcript = paused
      ? renderReview({ content: [], details: pausedDetails }, { expanded: false, isPartial: false }, theme)
      : renderCompletion({ customType: FINISH_MESSAGE_TYPE, content: 'Returned implementation completion', details: completionDetails, display: true }, { expanded: false }, theme);
    const rendered = transcript.render(width).map(stripVTControlCharacters).join('\n').replace(/\s+/gu, ' ');
    if (paused) {
      assert.ok(rendered.includes(pausedDetails.decision.question), 'collapsed review keeps the exact human question');
      assert.ok(rendered.includes(pausedDetails.decision.recommendation), 'collapsed review keeps the requested human action');
      assert.ok(!rendered.includes('Paused evidence marker'), 'collapsed review hides detailed evidence');
    } else {
      assert.match(rendered, /Updated the completion transcript fixture/u, 'compact accepted completion keeps its report preview');
      assert.ok(!rendered.includes('Expanded evidence marker'), 'compact accepted completion hides detailed evidence');
    }
    for (const open of [false, true]) {
      const { lines: screen } = sidebarScreen({
        width, height: Math.max(HEIGHT, transcript.render(width).length + lines.length + footer(width).length + 2),
        transcript, dock: () => lines, footer, open, collapsed: true,
      });
      const ansi = screen.join('\n');
      const plain = stripVTControlCharacters(ansi).replace(/\s+/gu, ' ');
      const marker = paused ? pausedDetails.decision.question : 'Updated the completion transcript fixture.';
      assert.ok(plain.includes(marker), 'compact transcript remains visible above the actual dialog');
      assert.ok(plain.indexOf(marker) < plain.lastIndexOf(dialog.question), 'transcript precedes the waiting dialog');
      screens.push({ name: dialog.name, width, under: `${paused ? 'paused user-needed review' : 'compact accepted completion'} transcript, ${open ? 'Sidebar open' : 'without Sidebar'}`, ansi });
    }
  }
}

// Retained next-prompt offers use the real editor and ghost/fallback widgets, never extra inputs.
const nextPromptStart = screens.length;
screens.push(...(await nextPromptScreens({
  theme, getEditorTheme: themeModule.getEditorTheme, kb, sidebarScreen,
  idleFooter: width => idleFooter(width, { statuses: modeStatuses('plan', 'auto') }), height: HEIGHT,
})).map(screen => screen.idle === undefined ? screen : { ...screen, idle: screen.idle + nextPromptStart }));

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

// Ordinary ctx.ui.custom replaces only editorContainer, as showExtensionCustom does.
// Transcript, footer/activity and Sidebar remain in the real layout outside that dock.
async function historyDockScreens(width, variant, rows, sidebar) {
  const dockTui = new TuiBase({ rows: HEIGHT, columns: width, hideCursor() {} });
  dockTui.requestRender = () => {};
  const main = new CustomEditor(dockTui, themeModule.getEditorTheme(), kb);
  main.setText('next step');
  const editorContainer = new Container();
  editorContainer.addChild(main);
  dockTui.setFocus(main);
  const events = new Map(), commands = new Map();
  historySearch({
    on: (name, handler) => events.set(name, handler), registerShortcut() {},
    registerCommand: (name, spec) => commands.set(name, spec),
  });
  // ExtensionRunner.withUIPrompt emits start/end around ordinary custom UI too.
  // Sidebar's controller collapses on start, then restores its prior split on end.
  let promptActive = false;
  let picker, mounted;
  const ready = new Promise(resolve => { mounted = resolve; });
  const ctx = { mode: 'tui', sessionManager: {
    getBranch: () => historyPrompts(variant).map((text, index) => ({ type: 'message', id: String(index), message: { role: 'user', content: text } })),
    getSessionId: () => 'remote-client-fixture', getLeafId: () => 'leaf',
  }, ui: {
    getEditorText: () => main.getExpandedText(), setEditorText: text => main.setText(text),
    notify: message => assert.fail(message), onTerminalInput: () => () => {},
    setWidget: (_key, factory) => { factory?.(dockTui); },
    custom: (factory, options) => new Promise((resolve, reject) => {
      assert.equal(options?.overlay ?? false, false, 'history must use ordinary custom UI, not an overlay');
      promptActive = true;
      const savedText = main.getText();
      let closed = false;
      const restore = () => {
        editorContainer.clear();
        editorContainer.addChild(main);
        main.setText(savedText);
        dockTui.setFocus(main);
        dockTui.requestRender();
      };
      const close = value => {
        if (closed) return;
        closed = true;
        restore();
        promptActive = false;
        resolve(value);
        picker?.dispose?.();
      };
      Promise.resolve(factory(dockTui, theme, kb, close)).then(component => {
        if (closed) return;
        picker = component;
        editorContainer.clear();
        editorContainer.addChild(picker);
        dockTui.setFocus(picker);
        dockTui.requestRender();
        picker.handleInput('\x15'); // clear the real expanded draft seed via Input
        if (variant === 'filtered') picker.handleInput('history');
        if (variant === 'no-match') picker.handleInput('zzzz-no-match');
        mounted();
      }).catch(error => { restore(); promptActive = false; reject(error); });
    }),
  } };
  const component = render => ({ render, invalidate() {} });
  const viewport = createChatViewport({
    document: component(() => [' Earlier transcript in main.']),
    pendingMessages: component(() => []), status: component(() => []),
    widgetsAbove: new Spacer(1), editor: editorContainer,
    widgetsBelow: component(() => []), footer: component(rows), scrollbar: 'never',
  });
  const panel = new SidebarPanel(dockTui, () => theme, {
    status: () => [{ text: 'main: working' }],
    submit() {}, confirm() {}, abort() {}, focusMain() {}, focusSidebar() {}, close() {},
    isBusy: () => false, matchesToggle: () => false, matchesFocusSwitch: () => false,
    toggleLabel: "ctrl+'", mainHidesThinking: () => false, cwd: '/tmp/pi-plugins',
  });
  panel.focused = sidebar.focused ?? true;
  const root = sidebar.open === false ? viewport.root : new SplitRoot(viewport.root, panel.root, {
    ratio: () => DEFAULT_RATIO, minColumns: DEFAULT_MIN_COLUMNS,
    collapsed: () => promptActive || (sidebar.collapsed ?? false),
    focused: () => panel.focused,
    divider: (orientation, focused, w, length) => dividerLines(orientation, w, text => theme.fg('borderAccent', text), {
      sidebar: focused, length, pointer: text => theme.bold(theme.fg('accent', text)),
    }),
  }, () => {});
  let frame;
  const render = () => {
    // SplitRoot applies orientation changes from the next frame, just as in Pi.
    renderLayoutFrame(root, width, HEIGHT, () => {});
    frame = renderLayoutFrame(root, width, HEIGHT, () => {});
    const lines = root instanceof SplitRoot ? root.dimUnfocused(frame.lines, frame) : frame.lines;
    return lines.map(line => line.replace(/\x1b_pi:[^\x07]*\x07/gu, ''));
  };
  await events.get('session_start')({}, ctx);
  const pending = commands.get('history-search').handler('', ctx);
  await ready;
  assert.equal(dockTui.getFocusedComponent(), picker, 'custom picker owns native focus');
  const lines = render();
  const plain = lines.map(stripVTControlCharacters).join('\n');
  const findBox = box => box.component === editorContainer ? box : box.children.map(findBox).find(Boolean);
  const editorBox = findBox(frame.root);
  assert.ok(editorBox, 'native viewport includes the replaced editor container');
  const dock = editorContainer.render(editorBox.rect.width).map(stripVTControlCharacters);
  assert.ok(dock.length <= editorBox.rect.height, 'picker must fit the actual allocated editor dock, without clipped results or hints');
  assert.ok(dock.length <= 13, 'history dock renders at most 13 rows, not viewport-sized padding');
  assert.ok(dock.every(line => line.trim().length > 0), 'history dock has no blank padding rows');
  assert.match(plain, /Earlier transcript in main\./u, 'conversation remains visible above the compact picker');
  assert.ok(plain.indexOf('Earlier transcript in main.') < plain.indexOf('Prompt history'), 'conversation stays above the dock');
  assert.match(plain, /Prompt history/u);
  assert.match(plain, /↑↓ move · Enter restore · Esc cancel/u);
  if (variant === 'filtered') {
    assert.match(plain, /Fix the history picker/u);
    assert.doesNotMatch(plain, /Review the API design/u);
  }
  if (variant === 'no-match') assert.match(plain, /No matches/u);
  const matches = variant === 'no-match' ? [] : variant === 'filtered' ? ['Fix the history picker'] : historyPrompts(variant).toReversed();
  for (let index = 0; index < matches.length; index++) {
    if (index) picker.handleInput('\x1b[B');
    const selectedScreen = render().map(stripVTControlCharacters).join('\n');
    assert.match(selectedScreen, new RegExp(`${index + 1}/${matches.length}`), 'navigation keeps the selected result count visible');
    const preview = stripVTControlCharacters(matches[index]).replace(/\s+/gu, ' ').replace(/[\x00-\x1f\x7f-\x9f]/gu, '');
    assert.ok(selectedScreen.includes(`› ${preview.slice(0, 20)}`), 'navigation keeps the actual selected result visible in the composed dock');
  }
  picker.handleInput('\x1b');
  await pending;
  assert.equal(main.getExpandedText(), 'next step', 'cancel preserves the complete draft');
  assert.equal(dockTui.getFocusedComponent(), main, 'closing restores native main-editor focus');
  assert.deepEqual(editorContainer.children, [main], 'closing restores the native editor-container child');
  const restored = render();
  await events.get('session_shutdown')({}, ctx);
  return { lines, restored };
}
const HISTORY_SIDEBARS = [
  ['without Sidebar', { open: false }],
  ['Sidebar collapsed', { collapsed: true, focused: false }],
  ['Sidebar expanded, main focused', { collapsed: false, focused: false }],
  ['Sidebar expanded, Sidebar focused', { collapsed: false, focused: true }],
];
const HISTORY_FOOTERS = [
  ...Object.entries(UNDERS),
  ...FOOTERS.flatMap(fixture => [
    [`normal ${fixture.name} footer`, w => idleFooter(w, fixture)],
    [`normal ${fixture.name} pill+footer`, w => [...activity(w), ...idleFooter(w, fixture, 2)]],
  ]),
];
for (const width of [46, 120, 180]) {
  for (const variant of ['initial', 'filtered', 'no-match', 'long/Unicode']) {
    for (const [under, rows] of HISTORY_FOOTERS) {
      let restoredBaseline;
      for (const [sidebarName, sidebar] of HISTORY_SIDEBARS) {
        const { lines, restored } = await historyDockScreens(width, variant, rows, sidebar);
        const context = `${under}, native dock, ${sidebarName}${sidebar.open === false ? '' : ' (collapsed during custom UI)'}`;
        screens.push({ name: `prompt history (${variant})`, width, under: context, ansi: lines.join('\n') });
        restoredBaseline ??= screens.length;
        screens.push({ name: `idle editor after prompt history (${variant})`, width, under: context, idle: restoredBaseline, ansi: restored.join('\n') });
      }
    }
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'pi-remote-clients-'));
const screensFile = path.join(dir, 'screens.json');
writeFileSync(screensFile, JSON.stringify(screens.map((s) => ({ ...s, text: stripVTControlCharacters(s.ansi) }))));

function probe(label, script, cwd, extra = [], runtime = 'bun') {
  // The history/footer/Sidebar matrix exceeds spawnSync's default 1 MiB JSON output limit.
  const run = spawnSync(runtime, [path.join(HERE, 'remote-clients', script), screensFile, ...extra], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new Error(`${label} probe failed:\n${run.error?.message ?? (run.stderr || run.stdout)}`);
  return JSON.parse(run.stdout);
}

const results = {};
const colliePresent = existsSync(path.join(collieDir, 'web/src/lib/frame-declarations.ts'));
assertRemoteClientsPresent({ ovis: Boolean(ovis), collie: colliePresent }, process.env.REQUIRE_REMOTE_CLIENTS === '1');
if (ovis) {
  console.log(`Ovis parser: ${ovis.kind} ${ovis.directory}${ovis.kind === 'source' ? ' (not installed validation)' : ''}`);
  const directory = path.resolve(ovis.directory);
  results.herdr = probe('Ovis', 'herdr.ts', directory, [directory], ovis.kind === 'bundle' ? path.resolve(ovis.bun) : ovis.bun);
} else console.log('SKIP Ovis: no installed bundle (OVIS_DIR or HERDR_WEB_UI_DIR)');
if (colliePresent) results.collie = probe('Collie', 'collie.ts', path.join(collieDir, 'web'), [collieDir, framesFile]);
else console.log('SKIP Collie: no checkout with frames.toml support (COLLIE_DIR)');

if (results.herdr) {
  for (const [index, screen] of screens.entries()) {
    if (!screen.answer) continue;
    const steps = results.herdr[index]?.answerSteps;
    assert.ok(Array.isArray(steps), 'Client navigation must come from the parsed card');
    const selected = [];
    const component = screen.answer.option_index !== undefined
      ? new ApprovalPicker({ targets: [] }, createApprovalState(), { efforts: () => [] }, theme, kb, () => {}, choice => selected.push(choice))
      : new PlanNameInput({ suggestion: 'client-plan', directory: '/tmp/plans' }, theme, kb, () => {}, value => selected.push(value));
    for (const step of steps) {
      if ('text' in step) {
        assert.equal(typeof step.text, 'string');
        component.handleInput(step.text);
        continue;
      }
      assert.ok(Array.isArray(step.keys) && Object.keys(step).length === 1, `Unsupported client navigation step: ${JSON.stringify(step)}`);
      for (const name of step.keys) {
        const key = { down: '\x1b[B', up: '\x1b[A', enter: '\r', 'ctrl+k': '\x0b', 'ctrl+u': '\x15' }[name];
        assert.ok(key, `Unsupported client navigation key: ${name}`);
        component.handleInput(key);
      }
    }
    assert.deepEqual(selected, [screen.answer.option_index !== undefined ? { choice: { kind: 'save' } } : 'phone-renamed'], 'client navigation must submit exactly the intended Save action or replacement name');
    component.dispose();
  }
}

let failures = 0;
screens.forEach((screen, i) => {
  const label = `${screen.name} @${screen.width} over ${screen.under}`;
  const problems = [];
  if (screen.terminal) {
    const h = results.herdr?.[i], c = results.collie?.[i];
    if (h) problems.push(`Ovis: terminal misidentified as question: ${JSON.stringify(h)}`);
    if (c?.blocks.some(block => block.kind !== 'raw')) problems.push(`Collie: terminal misidentified as card: ${JSON.stringify(c.blocks)}`);
    if (c && (['empty', 'draft'].includes(c.composer) || c.draft !== null)) problems.push(`Collie: terminal misidentified as Pi composer: ${JSON.stringify({ composer: c.composer, draft: c.draft })}`);
    report(label, problems);
    return;
  }
  if (screen.nativeControl || screen.splash === 'manager') {
    const h = results.herdr?.[i], c = results.collie?.[i];
    // herdr-web-ui deliberately lifts Pi's native model selector (pi-model) when
    // its hint is above a compact footer. That is the actual control, not a map
    // tile or a chat send target. Check its complete card, not a blanket allowance.
    if (results.herdr && JSON.stringify(h) !== JSON.stringify(screen.herdrNative ?? null)) {
      problems.push(`Ovis: native control wanted ${JSON.stringify(screen.herdrNative ?? null)}, got ${JSON.stringify(h)}`);
    }
    if (c) {
      const mirrors = c.blocks.filter(b => b.kind === 'unread-dialog');
      if (mirrors.length > 1 || c.blocks.some(b => b.kind !== 'raw' && b.kind !== 'unread-dialog') || mirrors.some(b =>
        (b.wholePane !== true && screen.under === 'without Sidebar') || b.cancel?.key !== 'Escape' || b.cancel?.agent !== 'pi' ||
        typeof b.cancel?.signature !== 'string' || !b.cancel.signature.trim()
      )) problems.push(`Collie: native control must be raw or an Escape-only mirror of main: ${JSON.stringify(c.blocks)}`);
      if (['empty', 'draft'].includes(c.composer) || c.draft !== null) problems.push(`Collie: native control/map misidentified as an editable send target: ${JSON.stringify({ composer: c.composer, draft: c.draft })}`);
    }
    report(label, problems);
    return;
  }
  if (screen.idle !== undefined) {
    // An idle screen reads as the same screen without Sidebar does.
    const expectedComposer = screen.expectedComposer ?? 'draft';
    const expectedDraft = Object.hasOwn(screen, 'expectedDraft') ? screen.expectedDraft : 'next step';
    const h = results.herdr, c = results.collie;
    if (h && JSON.stringify(h[i]) !== JSON.stringify(h[screen.idle])) problems.push(`Ovis: ${JSON.stringify(h[i])}, without Sidebar ${JSON.stringify(h[screen.idle])}`);
    const kinds = (r) => JSON.stringify({ blocks: r.blocks.filter((b) => b.kind !== 'raw'), composer: r.composer, draft: r.draft });
    if (h?.[i] !== null && h?.[i] !== undefined) problems.push(`Ovis: idle editor misidentified as question: ${JSON.stringify(h[i])}`);
    if (c) {
      if (c[i].composer !== expectedComposer || (c[i].draft?.trim() ?? null) !== expectedDraft) problems.push(`Collie: wanted ${expectedComposer} composer containing ${JSON.stringify(expectedDraft)}, got ${JSON.stringify({ composer: c[i].composer, draft: c[i].draft })}`);
      if (c[i].blocks.some(b => b.kind !== 'raw')) problems.push(`Collie: idle editor misidentified as card: ${JSON.stringify(c[i].blocks)}`);
      if (kinds(c[i]) !== kinds(c[screen.idle])) problems.push(`Collie: ${kinds(c[i])}, without Sidebar ${kinds(c[screen.idle])}`);
    }
    report(label, problems);
    return;
  }
  const dialog = screen.dialog ?? DIALOGS.find((d) => d.name === screen.name);
  assert.ok(dialog, `${label}: missing dialog expectation`);
  const h = results.herdr?.[i];
  if (dialog.terminalPicker) {
    // Tree navigation and searchable prompt history stay terminal-only. Collie may mirror the whole pane with
    // its declared Escape control, but must not lift a selection card or partial dialog.
    const c = results.collie?.[i];
    if (h) problems.push(`Ovis: terminal picker misidentified as question: ${JSON.stringify(h)}`);
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
    if (h === null) problems.push('Ovis: no card');
    else {
      if (dialog.question && h.question.replace(/\s+/g, ' ').trim() !== dialog.question) problems.push(`Ovis: question ${JSON.stringify(h.question)}`);
      for (const part of dialog.questionIncludes ?? []) if (!h.question.replace(/\s+/g, '').includes(part.replace(/\s+/g, ''))) problems.push(`Ovis: question missing ${JSON.stringify(part)}: ${JSON.stringify(h.question)}`);
      if (dialog.herdr.multi !== undefined && h.multi !== dialog.herdr.multi) problems.push(`Ovis: multi_select ${h.multi}`);
      if (dialog.herdr.options !== undefined && h.options.length !== dialog.herdr.options) problems.push(`Ovis: options ${JSON.stringify(h.options)}`);
      else if (dialog.herdr.labels !== undefined && JSON.stringify(h.options) !== JSON.stringify(dialog.herdr.labels)) problems.push(`Ovis: labels ${JSON.stringify(h.options)}`);
    }
  }
  const c = results.collie?.[i];
  if (c !== undefined) {
    if (['empty', 'draft'].includes(c.composer) || c.draft !== null) problems.push(`Collie: waiting dialog misidentified as an editable send target: ${JSON.stringify({ composer: c.composer, draft: c.draft })}`);
    const cards = c.blocks.filter((b) => b.kind !== 'raw');
    const card = cards[0];
    const wanted = dialog.collie.kind;
    const read = [];
    if (cards.length !== 1) read.push(`Collie: wanted exactly the waiting dialog, got ${cards.length} cards`);
    if (wanted === 'unread-dialog') {
      // Native ctx.ui.input is an Escape-only mirrored dialog, not a Pi chat composer.
      if (c.blocks.filter(b => b.kind !== 'raw').length !== 1 || card?.wholePane !== true ||
        card?.cancel?.key !== 'Escape' || card?.cancel?.agent !== 'pi' ||
        typeof card?.cancel?.signature !== 'string' || !card.cancel.signature.trim()) {
        read.push(`Collie: filename input must be one Escape-only whole-pane mirror: ${JSON.stringify(c.blocks)}`);
      }
      if (['empty', 'draft'].includes(c.composer)) read.push(`Collie: filename input misidentified as composer: ${c.composer}`);
    } else if (c.blocks.some(b => b.kind === 'unread-dialog')) read.push('Collie: ordinary question rendered as unread-dialog');
    if (card?.kind !== wanted) read.push(`Collie: ${card?.kind ?? 'no card'}, wanted ${wanted}`);
    else if (wanted === dialog.collie.kind && dialog.collie.options !== undefined && card.options.length !== dialog.collie.options) read.push(`Collie: options ${JSON.stringify(card.options)}`);
    if (card?.kind === wanted && wanted !== 'unread-dialog' && dialog.question && card.question.replace(/\s+/g, ' ').trim() !== dialog.question) read.push(`Collie: question ${JSON.stringify(card.question)}`);
    if (card?.kind === wanted && wanted !== 'unread-dialog') for (const part of dialog.questionIncludes ?? []) if (!card.question.replace(/\s+/g, '').includes(part.replace(/\s+/g, ''))) read.push(`Collie: question missing ${JSON.stringify(part)}: ${JSON.stringify(card.question)}`);
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
console.log(`PASS ${Object.keys(results).map(key => key === 'herdr' ? 'Ovis' : 'Collie').join(' + ')} read ${screens.length} frames: waiting dialogs, native controls and actual composers`);
