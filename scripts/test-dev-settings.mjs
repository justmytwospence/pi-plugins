// .pi/settings.json makes a Pi session in any checkout of this repository load
// that checkout's suite instead of the installed (pinned) git copy. Resolve the
// packages offline against a fake installed copy and check exactly that.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const { DefaultPackageManager, SettingsManager } = await import(process.env.PI_TEST_SDK || '@earendil-works/pi-coding-agent');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).pi;
const agentDir = mkdtempSync(join(tmpdir(), 'pi-dev-settings-'));
try {
  const fake = join(agentDir, 'git', 'github.com', 'justmytwospence', 'pi-plugins');
  mkdirSync(join(fake, 'ext'), { recursive: true });
  writeFileSync(join(fake, 'package.json'), JSON.stringify({ name: 'fake-suite', pi: { extensions: ['./ext/a.ts'], themes: ['./theme.json'] } }));
  writeFileSync(join(fake, 'ext', 'a.ts'), 'export default () => {};\n');
  writeFileSync(join(fake, 'theme.json'), '{}\n');
  const git = (...args) => execFileSync('git', ['-C', fake, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  const sha = git('rev-parse', 'HEAD');
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [`git:github.com/justmytwospence/pi-plugins@${sha}`] }));

  const settingsManager = SettingsManager.create(root, agentDir, { projectTrusted: true });
  const pm = new DefaultPackageManager({ cwd: root, agentDir, settingsManager });
  const resolved = await pm.resolve(async () => 'error');

  const fakeReal = realpathSync(fake) + sep;
  const real = (p) => { try { return realpathSync(p); } catch { return p; } };
  for (const r of [...resolved.extensions, ...resolved.themes]) {
    if (r.enabled) assert.ok(!real(r.path).startsWith(fakeReal), `pinned suite resource still enabled: ${r.path}`);
  }
  const enabled = (list) => new Set(list.filter((r) => r.enabled).map((r) => real(r.path)));
  const extensions = enabled(resolved.extensions);
  for (const entry of manifest.extensions) {
    assert.ok(extensions.has(realpathSync(resolve(root, entry))), `checkout extension not enabled: ${entry}`);
  }
  const themes = enabled(resolved.themes);
  for (const entry of manifest.themes) {
    assert.ok(themes.has(realpathSync(resolve(root, entry))), `checkout theme not enabled: ${entry}`);
  }
  console.log(`ok dev-settings: ${manifest.extensions.length} checkout extensions, pinned suite disabled`);
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
