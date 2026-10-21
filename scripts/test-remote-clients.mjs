// Remote clients read a waiting Pi dialog off the screen and turn it into a phone card. This renders
// the suite's dialogs through Pi's real theme and components, as they sit over the one-row footer
// pi-status-footer draws while `herdr:blocked` is held, and runs every screen through each installed
// client's own reader:
//   - herdr-web-ui: `parseInteractivePrompt` from its installed bundle (AGENTS.md, "herdr-web-ui
//     compatibility");
//   - Collie: the pi adapter of a Collie checkout, given this machine's `frames.toml`.
// A client that is not installed is skipped, so this is not part of `npm test`: run it with
// `npm run check:clients` after changing a dialog, the footer or a below-editor widget.
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
  'pill+footer': (width) => [theme.fg('muted', ' 1 shell '), '', ...footer(width)],
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

// Each dialog, and what each client must make of it. `narrow` is what Collie makes of the dialog in a
// pane too narrow for its hint or an option row, a known gap with its reason: Collie joins a key hint
// wrapped onto two rows with one space, which runs `enter select` into `escape/ctrl+c cancel`, and it
// takes an option's wrapped rest only at the label's column, not behind the one-column `│` gutter
// herdr-web-ui needs. Both are pi-reader fixes for Collie upstream.
const DIALOGS = [
  { name: 'ask single', lines: (w) => questionLines([question(false)], w), herdr: { options: 4, multi: false }, collie: { kind: 'prompt-select', options: 4 }, narrow: 'unread-dialog' },
  { name: 'ask multi', lines: (w) => questionLines([question(true)], w), herdr: { multi: true }, collie: { kind: 'multi-select' }, narrow: 'unread-dialog' },
  { name: 'tool-gate approval', lines: approvalLines, herdr: { options: 3, multi: false }, collie: { kind: 'prompt-select' }, narrow: 'unread-dialog' },
  { name: 'pi select (plan approval, cache-guard)', lines: selectorLines, herdr: { options: 3, multi: false }, collie: { kind: 'prompt-select', options: 4 } },
];

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
  const dialog = DIALOGS.find((d) => d.name === screen.name);
  const label = `${screen.name} @${screen.width} over ${screen.under}`;
  const problems = [];
  const h = results.herdr?.[i];
  if (h !== undefined) {
    if (h === null) problems.push('herdr-web-ui: no card');
    else {
      if (dialog.herdr.multi !== undefined && h.multi !== dialog.herdr.multi) problems.push(`herdr-web-ui: multi_select ${h.multi}`);
      if (dialog.herdr.options !== undefined && h.options.length !== dialog.herdr.options) problems.push(`herdr-web-ui: options ${JSON.stringify(h.options)}`);
    }
  }
  const c = results.collie?.[i];
  if (c !== undefined) {
    const card = c.blocks.find((b) => b.kind !== 'raw');
    const wanted = screen.width < 60 && dialog.narrow !== undefined ? dialog.narrow : dialog.collie.kind;
    if (card?.kind !== wanted) problems.push(`Collie: ${card?.kind ?? 'no card'}, wanted ${wanted}`);
    else if (wanted === dialog.collie.kind && dialog.collie.options !== undefined && card.options.length !== dialog.collie.options) problems.push(`Collie: options ${JSON.stringify(card.options)}`);
  }
  if (problems.length) {
    failures++;
    console.log(`FAIL ${label}\n  ${problems.join('\n  ')}`);
  } else console.log(`ok   ${label}`);
});
assert.equal(failures, 0, `${failures} screen(s) not read as their client should read them`);
console.log('PASS remote clients read every dialog');
