import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { DefaultResourceLoader, SettingsManager } = await import(process.env.PI_TEST_SDK
  ? pathToFileURL(process.env.PI_TEST_SDK).href : '@earendil-works/pi-coding-agent');

test('production checkout loads using SDK aliases without local dev dependencies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-history-production-'));
  try {
    const extension = join(dir, 'extension');
    cpSync(new URL('../src', import.meta.url), join(extension, 'src'), { recursive: true });
    cpSync(new URL('../package.json', import.meta.url), join(extension, 'package.json'));
    const loader = new DefaultResourceLoader({
      cwd: dir, agentDir: dir,
      settingsManager: SettingsManager.inMemory({ packages: [extension] }),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0].commands.has('history-search'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
