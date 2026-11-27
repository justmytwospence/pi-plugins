// Root integration suite. Fast tier by default; --full adds the slow tier (PI_TEST_FULL=1).
// Tasks run in parallel, each with its own agent dir, except the timing-sensitive serial ones.
//   node scripts/test-suite.mjs [--full] [--only a,b] [--list]
// PI_CHECK_JOBS=1 runs one task at a time with live output.
import { mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, jobs, printDone, report, requireNode, runTasks } from './lib/pool.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const script = (name, extra = {}) => ({ command: node, args: [`scripts/${name}`], ...extra });

// tier 'full' tasks run only with --full (or when named with --only); serial tasks have
// sub-second or 1.5 s timing assertions and run alone after the pool.
// This private dependency is not a selectable Pi extension, so the component runner
// cannot discover its standalone quota/credential tests.
const TASKS = {
  'subscription-usage': { command: 'npm', args: ['--prefix', 'packages/pi-subscription-usage', 'run', 'check'] },
  loader: script('test-loader.mjs'),
  shortcuts: script('test-shortcuts.mjs'),
  contracts: script('test-contracts.mjs'),
  'question-flow': script('test-question-flow.mjs'),
  'dialog-focus': script('test-dialog-focus.mjs', { serial: true }),
  'client-paths': { command: node, args: ['--test', 'scripts/remote-clients/client-paths.test.mjs'] },
  'set-version': { command: node, args: ['--test', 'scripts/set-version.test.mjs'] },
  'changed-checks': { command: node, args: ['--test', 'scripts/check-changed.test.mjs'] },
  release: { command: node, args: ['--test', 'scripts/release.test.mjs'] },
  lifecycle: script('test-lifecycle.mjs'),
  'family-sidebar': script('test-family-sidebar.mjs'),
  'mode-flow': script('test-mode-flow.mjs'),
  'cache-prefix': script('test-cache-prefix.mjs'),
  'plan-pair': script('test-plan-pair.mjs'),
  'footer-controls': script('test-footer-controls.mjs', { serial: true, tier: 'full' }),
  'transcript-navigation': script('test-transcript-navigation.mjs'),
  'checkpoint-pty': script('test-checkpoint-pty.mjs', { serial: true, tier: 'full' }),
  evals: { command: node, args: ['--test', 'evals/shared/*.test.ts'] },
  system1: script('test-system1.mjs'),
};
const tierOf = (task) => task.tier ?? 'fast';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const only = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : null;

if (flag('--list')) {
  for (const [name, task] of Object.entries(TASKS)) console.log(`${name}\t${tierOf(task)}`);
  process.exit(0);
}
requireNode();
const full = flag('--full');
for (const name of only ?? []) {
  if (!TASKS[name]) {
    console.error(`unknown suite task: ${name}; known: ${Object.keys(TASKS).join(', ')}`);
    process.exit(2);
  }
}
const selected = Object.entries(TASKS).filter(([name, task]) => only ? only.includes(name) : full || tierOf(task) === 'fast');

const agentDirs = [];
const tasks = selected.map(([name, task]) => {
  const agentDir = mkdtempSync(join(tmpdir(), `pi-suite-${name}-`));
  agentDirs.push(agentDir);
  const env = { ...cleanEnv(), PI_CODING_AGENT_DIR: agentDir };
  if (full || process.env.PI_TEST_FULL === '1') env.PI_TEST_FULL = '1';
  return { name, command: task.command, args: task.args, serial: task.serial, cwd: root, env };
});
const concurrency = jobs(Math.min(availableParallelism(), 8));
try {
  const results = await runTasks(tasks, { concurrency, onDone: concurrency === 1 ? () => {} : printDone });
  process.exitCode = report(results) ? 0 : 1;
} finally {
  for (const dir of agentDirs) rmSync(dir, { recursive: true, force: true });
}
