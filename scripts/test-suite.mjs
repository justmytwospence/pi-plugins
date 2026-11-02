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
  for (const args of scripts) {
    const result = spawnSync(process.execPath, args, {
      cwd: root, stdio: 'inherit', env,
    });
    if (result.error || result.status !== 0) {
      console.error(`FAIL ${args.join(' ')}${result.error ? `: ${result.error.message}` : ''}`);
      process.exitCode = result.status || 1;
      break;
    }
  }
  if (!process.exitCode) {
    const result = spawnSync('npm', ['run', 'check'], {
      cwd: join(root, 'packages/pi-subscription-usage'), stdio: 'inherit', env,
    });
    if (result.error || result.status !== 0) {
      console.error(`FAIL pi-subscription-usage check${result.error ? `: ${result.error.message}` : ''}`);
      process.exitCode = result.status || 1;
    }
  }
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
