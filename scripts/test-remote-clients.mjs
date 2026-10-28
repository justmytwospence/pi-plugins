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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createJiti } from 'jiti';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { stripVTControlCharacters } from 'node:util';
import { setKeybindings } from '@earendil-works/pi-tui';

const sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
const { KeybindingsManager } = await import(new URL('./core/keybindings.js', sdkUrl));
const { ExtensionSelectorComponent } = await import(new URL('./modes/interactive/components/extension-selector.js', sdkUrl));
const themeModule = await import(new URL('./modes/interactive/theme/theme.js', sdkUrl));
const jiti = createJiti(import.meta.url);
const { QuestionDialog } = await jiti.import('../packages/pi-ask-user-question/src/dialog.ts');
const { askApproval } = await jiti.import('../packages/pi-tool-gate/src/prompt.ts');
const { CustomEditor } = await import(new URL('./modes/interactive/components/custom-editor.js', sdkUrl));
const { sidebarScreen } = await import('./remote-clients/sidebar.mjs');
const { TerminalPanel } = await jiti.import('../packages/pi-interactive-shell/src/panel.ts');
const { choiceMenu, coldTitle } = await jiti.import('../packages/pi-cache-guard/src/index.ts');

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
const tui = { terminal: { rows: 40, columns: 120 }, requestRender() {} };

// What stands under a dialog while it waits: pi-status-footer's one row, alone or under pi-bg's pill.
const footer = (width) => [theme.fg('dim', ` pi-plugins · main · opus · Context 12% used · waiting`.slice(0, width))];
const UNDERS = {
  footer: (width) => footer(width),
  'pill+footer': (width) => [theme.fg('muted', ' 1 task '), '', ...footer(width)],
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

async function approvalLines(width) {
  let lines;
  const ctx = {
    mode: 'tui',
    ui: {
      custom: (factory) => new Promise(() => { lines = factory(tui, theme, kb, () => {}).render(width); }),
      select: async () => undefined,
    },
  };
  void askApproval(ctx, {
    view: { tool: 'bash', subject: '', body: { kind: 'code', lang: 'bash', text: 'git push --force origin main' } },
    held: 'force-pushes main/master',
    agentCase: 'The rebase rewrote the branch.',
    options: ['Allow once', 'Block'],
  }, 'Allow?');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return lines;
}

function selectorLines(width) {
  const selector = new ExtensionSelectorComponent('Implement this plan? ~/.pi/agent/plans/example.md', ['Implement', 'Implement in yolo mode', 'Keep planning'], () => {}, () => {});
  return selector.render(width);
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

// Each dialog, and what each client must make of it.
const DIALOGS = [
  { name: 'ask single', lines: (w) => questionLines([question(false)], w), herdr: { options: 4, multi: false }, collie: { kind: 'prompt-select', options: 4 }, },
  { name: 'ask multi', lines: (w) => questionLines([question(true)], w), herdr: { multi: true }, collie: { kind: 'multi-select' }, },
  { name: 'tool-gate approval', lines: approvalLines, herdr: { options: 3, multi: false }, collie: { kind: 'prompt-select' }, },
  { name: 'pi select (plan approval)', lines: selectorLines, herdr: { options: 3, multi: false }, collie: { kind: 'prompt-select', options: 4 } },
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
const idleFooter = (width) => [theme.fg('dim', ' pi-plugins · main · opus'.slice(0, width)), theme.fg('dim', ' Context 12% used · idle'.slice(0, width))];
const IDLE = [['without Sidebar', { open: false }], ['Sidebar open, main focused', { focused: false }], ['Sidebar open, Sidebar focused', { focused: true }]];
// Known gap: Collie finds the editor by its frame and knows nothing of Sidebar's split. Below main
// it takes Sidebar's empty composer for the editor; beside main, no rule is a whole row, so it finds
// none. A known screen that starts reading right fails, so this list cannot go stale.
const KNOWN = { collie: (screen) => screen.name === 'idle editor' && screen.under.startsWith('Sidebar open') };
for (const width of [46, 120, 180]) {
  const baseline = screens.length;
  for (const [under, options] of IDLE) {
    const { lines: screen } = sidebarScreen({ width, height: HEIGHT, dock: (w) => editor.render(w), footer: idleFooter, ...options });
    screens.push({ name: 'idle editor', width, under, idle: baseline, ansi: screen.join('\n') });
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
const known = [];
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
    if (c) {
      const same = kinds(c[i]) === kinds(c[screen.idle]);
      if (KNOWN.collie(screen)) {
        if (same) problems.push('Collie: reads as without Sidebar now; drop it from KNOWN');
        else known.push(`${label}\n  Collie: ${kinds(c[i])}, without Sidebar ${kinds(c[screen.idle])}`);
      } else if (!same) problems.push(`Collie: ${kinds(c[i])}, without Sidebar ${kinds(c[screen.idle])}`);
    }
    report(label, problems);
    return;
  }
  const dialog = DIALOGS.find((d) => d.name === screen.name);
  const h = results.herdr?.[i];
  if (h !== undefined) {
    if (h === null) problems.push('herdr-web-ui: no card');
    else {
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
    if (card?.kind !== wanted) read.push(`Collie: ${card?.kind ?? 'no card'}, wanted ${wanted}`);
    else if (wanted === dialog.collie.kind && dialog.collie.options !== undefined && card.options.length !== dialog.collie.options) read.push(`Collie: options ${JSON.stringify(card.options)}`);
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
for (const line of known) console.log(`KNOWN ${line}`);
assert.equal(failures, 0, `${failures} screen(s) not read as their client should read them`);
console.log('PASS remote clients read every dialog');
