// Runs each component's own `npm run check`, in parallel.
//   node scripts/check-components.mjs [names...] [--shard k/n] [--install] [--full]
// --install runs `npm ci` in each package first (CI); --full sets PI_TEST_FULL=1.
// PI_CHECK_JOBS=1 runs one package at a time with live output.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, jobs, printDone, report, requireNode, runTasks } from './lib/pool.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
requireNode();
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json')));
const all = [...new Set(manifest.pi.extensions.map((entry) => entry.split('/')[2]))].sort();

const argv = process.argv.slice(2);
const names = [];
let shard = null;
let install = false;
let full = false;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--install') install = true;
  else if (arg === '--full') full = true;
  else if (arg === '--shard') {
    const match = /^(\d+)\/(\d+)$/.exec(argv[++i] ?? '');
    if (!match || Number(match[1]) < 1 || Number(match[1]) > Number(match[2])) {
      console.error('--shard needs k/n with 1 <= k <= n');
      process.exit(2);
    }
    shard = [Number(match[1]), Number(match[2])];
  } else if (arg.startsWith('--')) {
    console.error(`unknown option: ${arg}`);
    process.exit(2);
  } else names.push(arg);
}
for (const name of names) {
  if (!all.includes(name)) {
    console.error(`unknown component: ${name}`);
    process.exit(2);
  }
}
let selected = names.length ? all.filter((name) => names.includes(name)) : all;
if (shard) selected = selected.filter((_, index) => index % shard[1] === shard[0] - 1);
if (!selected.length) {
  console.log('no components selected');
  process.exit(0);
}

const agentDirs = [];
const tasks = selected.map((name) => {
  // Component fixtures own approval configuration independently of the parent agent.
  const agentDir = mkdtempSync(resolve(tmpdir(), `pi-check-${name}-`));
  agentDirs.push(agentDir);
  const env = { ...cleanEnv(), PI_CODING_AGENT_DIR: agentDir };
  if (full) env.PI_TEST_FULL = '1';
  const cwd = resolve(root, 'packages', name);
  return install
    ? { name, command: 'sh', args: ['-c', 'npm ci --no-audit --no-fund && npm run check'], cwd, env }
    : { name, command: 'npm', args: ['run', 'check'], cwd, env };
});
const concurrency = jobs(Math.max(2, Math.floor(availableParallelism() / 4)));
try {
  const results = await runTasks(tasks, { concurrency, onDone: concurrency === 1 ? () => {} : printDone });
  process.exitCode = report(results) ? 0 : 1;
} finally {
  for (const dir of agentDirs) rmSync(dir, { recursive: true, force: true });
}
