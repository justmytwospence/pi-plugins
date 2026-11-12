import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const consumers = ['pi-vim', 'pi-copy', 'pi-sticky-last-prompt'];
export const transcriptHelpers = [
  ['transcript-contract.ts', [...consumers, 'pi-cc-render', 'pi-clear-screen', 'pi-interactive-shell', 'pi-plan-mode', 'pi-subagents', 'pi-bg', 'pi-herdr']],
  ['transcript-index.ts', consumers],
  ['transcript-viewport.ts', consumers],
  ['tui-runtime.ts', ['pi-vim', 'pi-cc-render']],
  ['transcript-style.ts', ['pi-cc-render', 'pi-bg', 'pi-todo', 'pi-ask-user-question', 'pi-system1', 'pi-subagents', 'pi-herdr', 'pi-plan-mode', 'pi-tool-gate', 'pi-status-footer', 'pi-cache-guard', 'pi-reload-all', 'pi-recap', 'pi-sidebar', 'pi-compact-plan', 'pi-context', 'pi-trends']],
].map(([name, packages]) => ({ source: `shared/transcript/${name}`, copies: packages.map(pkg => `packages/${pkg}/src/${name}`) }));

export function syncTranscriptHelpers(check = false) {
  let failed = false;
  for (const { source, copies } of transcriptHelpers) {
    const content = readFileSync(resolve(root, source), 'utf8');
    for (const copy of copies) {
      let actual;
      try { actual = readFileSync(resolve(root, copy), 'utf8'); } catch { /* Missing generated file. */ }
      if (actual === content) continue;
      if (check) { console.error(`Transcript helper drift: ${copy}`); failed = true; }
      else { mkdirSync(dirname(resolve(root, copy)), { recursive: true }); writeFileSync(resolve(root, copy), content); }
    }
  }
  return !failed;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = syncTranscriptHelpers(process.argv.includes('--check')) ? 0 : 1;
