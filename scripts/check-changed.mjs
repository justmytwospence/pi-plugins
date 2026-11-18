// Checks only what changed since a base (default origin/main): touched components, the
// components that depend on a touched shared package, and the root suites those paths need.
//   node scripts/check-changed.mjs [base]
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const base = process.argv[2] ?? 'origin/main';
const mergeBase = git('merge-base', 'HEAD', base)[0];
const changed = [...new Set([
  ...git('diff', '--name-only', mergeBase),
  ...git('ls-files', '--others', '--exclude-standard'),
])];

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const plugins = new Set(manifest.pi.extensions.map((entry) => entry.split('/')[2]));
const touched = new Set(changed.map((path) => /^packages\/([^/]+)\//.exec(path)?.[1]).filter(Boolean));

// A package that others depend on through file:../<name> re-runs its dependents.
for (const name of [...touched]) {
  for (const dir of readdirSync(resolve(root, 'packages'))) {
    const file = resolve(root, 'packages', dir, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (Object.values(deps).includes(`file:../${name}`)) touched.add(dir);
  }
}
const components = [...touched].filter((name) => plugins.has(name)).sort();

const known = execFileSync(process.execPath, ['scripts/test-suite.mjs', '--list'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean).map((line) => line.split('\t')[0]);
const suite = new Set();
const runtime = changed.some((path) => !path.startsWith('site/') && !path.endsWith('.md')
  && !/^packages\/[^/]+\/(test|eval)\//.test(path));
if (runtime) for (const name of ['loader', 'contracts', 'cache-prefix']) suite.add(name);
for (const path of changed) {
  const test = /^scripts\/test-(.+)\.mjs$/.exec(path)?.[1];
  if (test && known.includes(test)) suite.add(test);
  if (path.startsWith('packages/pi-subscription-usage/')) suite.add('subscription-usage');
  if (path === 'scripts/lib/dialog-focus-fixture.mjs') suite.add('dialog-focus');
  if (path.startsWith('evals/shared/')) suite.add('evals');
  if (/^scripts\/set-version/.test(path)) suite.add('set-version');
  if (/^scripts\/release/.test(path) || path === 'scripts/lib/release.mjs') suite.add('release');
  if (path.startsWith('scripts/remote-clients/') || path === 'scripts/lib/remote-client-paths.mjs') suite.add('client-paths');
}
const tasks = [...suite].filter((name) => known.includes(name));

console.log(`changed: ${changed.length} files; suite: ${tasks.join(', ') || 'none'}; components: ${components.join(', ') || 'none'}`);
if (!tasks.length && !components.length) {
  console.log('nothing to check');
  process.exit(0);
}
let status = 0;
const run = (args) => { if (spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' }).status !== 0) status = 1; };
if (tasks.length) run(['scripts/test-suite.mjs', '--only', tasks.join(',')]);
if (components.length) run(['scripts/check-components.mjs', ...components]);
process.exit(status);
