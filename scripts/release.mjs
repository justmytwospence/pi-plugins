// One-command release, run once at the end of a session or batch:
//   npm run -s release -- [X.Y.Z] [--skip-ci] [--pin-only] [--dry-run]
// Pushes main, waits for green CI, runs the macOS-only PTY check, bumps the version, tags,
// pins dotfiles in a worktree, runs bin/land and verifies the installed suite here and on the NUC.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireNode } from './lib/pool.mjs';
import { bumpPin, nextPatch } from './lib/release.mjs';
import { setVersion } from './set-version.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const dryRun = flags.has('--dry-run');
const pinOnly = flags.has('--pin-only');
const skipCi = flags.has('--skip-ci');
for (const flag of flags) {
  if (!['--dry-run', '--pin-only', '--skip-ci'].includes(flag)) fail(`unknown option: ${flag}`);
}
const explicit = args.find((a) => !a.startsWith('--'));

const SETTINGS = 'home/private_dot_pi/private_agent/settings.managed.json';
const PINS = 'home/.chezmoidata/pi_tag_commits.json';
const NUC = 'spencer@nuc';
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];

function fail(message) {
  console.error(message);
  process.exit(1);
}
const step = (name) => console.log(`==> ${name}`);
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();
const git = (...argv) => run('git', argv);
const ok = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: root, stdio: 'ignore', ...opts }).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForRun(workflow, query, label, sha) {
  const list = () => JSON.parse(run('gh', ['run', 'list', '--workflow', workflow, ...query, '--limit', '1',
    '--json', 'databaseId,status,conclusion,url,headSha']) || '[]')[0];
  let latest = list();
  for (let waited = 0; !latest && waited < 180 && !dryRun; waited += 10) {
    await sleep(10_000);
    latest = list();
  }
  if (!latest) {
    if (dryRun) return console.log(`${label}: no run yet for ${sha.slice(0, 7)}`);
    fail(`no ${label} run for ${sha.slice(0, 7)}`);
  }
  if (dryRun) {
    console.log(`${label}: ${latest.status} ${latest.conclusion || ''} ${latest.url}`);
    return;
  }
  if (latest.status !== 'completed') {
    spawnSync('gh', ['run', 'watch', String(latest.databaseId), '--exit-status', '--compact', '--interval', '15'], { cwd: root, stdio: 'inherit' });
    latest = list();
  }
  if (latest.conclusion !== 'success') fail(`CI is ${latest.conclusion || latest.status} on ${sha.slice(0, 7)}: ${latest.url}`);
  console.log(`${label}: success`);
}

async function main() {
  requireNode();
  step('preconditions');
  if (git('branch', '--show-current') !== 'main') fail("release from the main checkout's main branch");
  if (git('status', '--porcelain', '--untracked-files=no')) fail('commit or drop tracked changes first');

  step('sync with origin');
  git('fetch', '-q', 'origin', 'main', '--tags');
  const head = git('rev-parse', 'HEAD');
  if (head !== git('rev-parse', 'origin/main')) {
    if (!ok('git', ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])) fail('main has diverged from origin/main; rebase first');
    if (dryRun) console.log('would push main');
    else run('git', ['push', 'origin', 'main'], { stdio: 'inherit' });
  }

  const last = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
  const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (!pinOnly) {
    step('anything to release?');
    if (Number(git('rev-list', '--count', `${last}..HEAD`)) === 0) {
      console.log(`nothing to release since ${last}`);
      return;
    }
  }

  const version = pinOnly ? current : explicit ?? nextPatch(current);
  if (!pinOnly && git('tag', '--list', `v${version}`)) fail(`tag v${version} already exists`);
  if (pinOnly && !git('tag', '--list', `v${version}`)) fail(`--pin-only needs the tag v${version}, which does not exist`);

  if (skipCi) console.log('warning: releasing without CI');
  else if (!pinOnly) {
    step('CI gate');
    await waitForRun('checks.yml', ['--commit', head, '--event', 'push'], 'Checks', head);
    // The workflow may not exist yet on the default branch (gh then fails with a 404).
    let sw;
    try {
      sw = JSON.parse(execFileSync('gh', ['run', 'list', '--workflow', 'switchyard.yml', '--branch', 'main', '--limit', '1', '--json', 'headSha'],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '[]')[0];
    } catch { sw = undefined; }
    if (!sw || ok('git', ['merge-base', '--is-ancestor', sw.headSha, last])) console.log(`switchyard: no run since ${last}`);
    else await waitForRun('switchyard.yml', ['--branch', 'main'], 'Switchyard', sw.headSha);
  }

  if (!pinOnly) {
    step('checkpoint PTY check');
    if (process.platform !== 'darwin') console.log('skipping checkpoint-pty (macOS only)');
    else if (dryRun) console.log('would run: node scripts/test-suite.mjs --full --only checkpoint-pty');
    else if (spawnSync(process.execPath, ['scripts/test-suite.mjs', '--full', '--only', 'checkpoint-pty'], { cwd: root, stdio: 'inherit' }).status !== 0) {
      fail('checkpoint-pty failed');
    }

    step(`version and tag v${version}`);
    if (dryRun) {
      const files = ['package.json', 'package-lock.json', ...readdirSync(join(root, 'packages')).flatMap((name) => ['package.json', 'package-lock.json']
        .map((f) => `packages/${name}/${f}`).filter((rel) => existsSync(join(root, rel))))];
      console.log(`would set ${current} -> ${version} in ${files.length} files, commit "chore: release ${version}", tag v${version} and push`);
    } else {
      const files = setVersion(root, version);
      git('commit', '-q', '-m', `chore: release ${version}`, '--', ...files);
      git('tag', `v${version}`);
      run('git', ['push', 'origin', 'main', `v${version}`], { stdio: 'inherit' });
    }
  }

  step('pin in dotfiles');
  const dot = process.env.DOTFILES_DIR ?? join(homedir(), 'Projects', 'dotfiles');
  const branch = `pin-pi-plugins-${version}`;
  const sha = dryRun && !git('tag', '--list', `v${version}`) ? head : git('rev-parse', `v${version}^{commit}`);
  const source = dryRun ? dot : join(dot, '.worktrees', branch);
  if (!dryRun) run('git', ['-C', dot, 'worktree', 'add', `.worktrees/${branch}`, '-b', branch, 'main'], { stdio: 'inherit' });
  const read = (rel) => readFileSync(join(source, rel), 'utf8');
  const next = bumpPin(read(SETTINGS), read(PINS), version, sha);
  if (dryRun) {
    const pin = (text) => text.split('\n').filter((line) => line.includes('justmytwospence/pi-plugins@')).map((l) => l.trim());
    console.log(`settings: ${pin(read(SETTINGS))} -> ${pin(next.settings)}`);
    console.log(`pins:     ${pin(read(PINS))} -> ${pin(next.pins)}`);
    console.log('dry run: nothing written');
    return;
  }
  writeFileSync(join(source, SETTINGS), next.settings);
  writeFileSync(join(source, PINS), next.pins);
  run('git', ['-C', source, 'commit', '-q', '-m', `chore(pi): pin pi-plugins v${version}`, '--', SETTINGS, PINS]);
  const landed = spawnSync(join(dot, 'bin', 'land'), [branch], { cwd: dot, stdio: 'inherit' });
  if (landed.status !== 0) fail('the tag is published but landing the pin failed; fix it, then: npm run -s release -- --pin-only');

  step('verify the install');
  const installed = '~/.pi/agent/git/github.com/justmytwospence/pi-plugins';
  const problems = [];
  const local = run('sh', ['-c', `git -C ${installed} rev-parse HEAD`]);
  if (local !== sha) problems.push(`local: installed ${local.slice(0, 7)}, expected ${sha.slice(0, 7)}`);
  const remote = spawnSync('ssh', [...SSH, NUC, `git -C ${installed} rev-parse HEAD`], { encoding: 'utf8' });
  if (remote.status !== 0) problems.push(`${NUC}: unreachable or no checkout`);
  else if (remote.stdout.trim() !== sha) problems.push(`${NUC}: installed ${remote.stdout.trim().slice(0, 7)}, expected ${sha.slice(0, 7)}`);
  if (problems.length) fail(problems.join('\n'));
  console.log(`released v${version}; installed here and on ${NUC}`);
}

main().catch((error) => fail(error.message));
