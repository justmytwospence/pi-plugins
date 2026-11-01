// Real CLI keyboard routing, not only SDK fixtures. The Python test uses an isolated
// profile and verified OS network denial; unsupported hosts report an explicit skip.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const result = spawnSync('python3', [fileURLToPath(new URL('./test-checkpoint-pty.py', import.meta.url))], { stdio: 'inherit' });
if (result.error?.code === 'ENOENT') {
  console.log('SKIP checkpoint PTY: python3 unavailable');
} else if (result.error || result.status !== 0) {
  console.error('FAIL checkpoint PTY', result.error ?? `exit ${result.status ?? result.signal}`);
  process.exitCode = result.status || 1;
}
