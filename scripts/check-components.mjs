import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json')));
const plugins = manifest.pi.extensions.map(entry => ({ name: entry.split('/')[2] }));
let failed = false;
for (const plugin of plugins) {
  console.log(`\n=== ${plugin.name} ===`);
  const result = spawnSync('npm', ['run', 'check'], { cwd: resolve(root, 'packages', plugin.name), stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`${plugin.name} failed`, result.error || result.status);
    failed = true;
  }
}
process.exitCode = failed ? 1 : 0;
