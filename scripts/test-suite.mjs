// Keep offline suites independent of the user's selected System 1 backend and stored auth.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = mkdtempSync(join(tmpdir(), 'pi-suite-tests-'));
const scripts = [
  ['scripts/test-loader.mjs'],
  ['scripts/test-shortcuts.mjs'],
  ['scripts/test-contracts.mjs'],
  ['scripts/test-question-flow.mjs'],
  ['scripts/test-dialog-focus.mjs'],
  ['--test', 'scripts/remote-clients/client-paths.test.mjs'],
  ['--test', 'scripts/set-version.test.mjs'],
  ['scripts/test-lifecycle.mjs'],
  ['scripts/test-family-sidebar.mjs'],
  ['scripts/test-mode-flow.mjs'],
  ['scripts/test-linked-flow.mjs'],
  ['scripts/test-footer-controls.mjs'],
  ['scripts/test-transcript-navigation.mjs'],
  ['scripts/test-checkpoint-pty.mjs'],
  ['--test', 'evals/shared/*.test.ts'],
  ['scripts/test-system1.mjs'],
];
const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
// A delegated checker must exercise main-session services, not its own worker-only lifecycle.
delete env.PI_SUBAGENT;
delete env.PI_SUBAGENT_DEPTH;
try {
  // This private dependency is not a selectable Pi extension, so the
  // component runner cannot discover its standalone quota/credential tests.
  const shared = spawnSync('npm', ['--prefix', 'packages/pi-subscription-usage', 'run', 'check'], {
    cwd: root, stdio: 'inherit', env,
  });
  if (shared.error || shared.status !== 0) {
    console.error(`FAIL shared usage library${shared.error ? `: ${shared.error.message}` : ''}`);
    process.exitCode = shared.status || 1;
  }
  for (const args of process.exitCode ? [] : scripts) {
    const result = spawnSync(process.execPath, args, {
      cwd: root, stdio: 'inherit', env,
    });
    if (result.error || result.status !== 0) {
      console.error(`FAIL ${args.join(' ')}${result.error ? `: ${result.error.message}` : ''}`);
      process.exitCode = result.status || 1;
      break;
    }
  }
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
