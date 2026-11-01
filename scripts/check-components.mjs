import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json')));
const plugins = manifest.pi.extensions.map(entry => ({ name: entry.split('/')[2] }));
let failed = false;
for (const plugin of plugins) {
  console.log(`\n=== ${plugin.name} ===`);
  const agentDir = mkdtempSync(resolve(tmpdir(), `pi-check-${plugin.name}-`));
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
  delete env.PI_SUBAGENT;
  delete env.PI_SUBAGENT_DEPTH;
  try {
    const result = spawnSync('npm', ['run', 'check'], {
      cwd: resolve(root, 'packages', plugin.name), stdio: 'inherit',
      env,
    });
    if (result.error || result.status !== 0) {
      console.error(`${plugin.name} failed`, result.error || result.status);
      failed = true;
    }
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}
process.exitCode = failed ? 1 : 0;
