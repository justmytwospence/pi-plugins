import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const components = manifest.pi.extensions.map(p => p.split('/')[2]);
const identical = [
  ['pi-bg','pi-subagents','pi-marimo','pi-plan-mode','pi-herdr'].map(p => `packages/${p}/src/activity.ts`),
  ['pi-bg','pi-status-footer'].map(p => `packages/${p}/src/working-message.ts`),
  ['pi-bg','pi-marimo'].map(p => `packages/${p}/src/pill.ts`),
  ['pi-bg','pi-marimo'].map(p => `packages/${p}/src/frame.ts`),
  ['packages/pi-plan-mode/src/app/pi-chat.ts','packages/pi-sidebar/src/pi-chat.ts','packages/pi-subagents/src/ui/pi-chat.ts'],
  ['pi-auto-effort','pi-copy','pi-next-prompt','pi-subagents','pi-tool-gate'].map(p => `packages/${p}/src/jev.ts`),
  ['pi-auto-effort','pi-copy','pi-next-prompt','pi-subagents'].map(p => `packages/${p}/src/transcript.ts`),
  ['pi-auto-effort','pi-next-prompt','pi-tool-gate','pi-marimo'].map(p => `packages/${p}/src/config.ts`),
  ['pi-copy','pi-subagents'].map(p => `packages/${p}/src/config.ts`),
  ['pi-ask-user-question','pi-copy','pi-tool-gate'].map(p => `packages/${p}/src/herdr.ts`),
  ['pi-plan-mode','pi-compact-plan','pi-marimo'].map(p => `packages/${p}/src/editor-contract.ts`),
  ['pi-plan-mode','pi-compact-plan'].map(p => `packages/${p}/src/herdr-blocked.ts`),
  ['pi-plan-mode','pi-compact-plan'].map(p => `packages/${p}/src/review-card.ts`),
  ['packages/pi-cc-render/src/renderer/tool/bash-layout.ts','packages/pi-tool-gate/src/bash-layout.ts'],
];
for (const group of identical) {
  const expected = readFileSync(resolve(root, group[0]), 'utf8');
  for (const file of group.slice(1)) assert.equal(readFileSync(resolve(root,file),'utf8'),expected, `intentional helper copy drift: ${file}`);
}
const shared = resolve(root,'evals','shared');
// The shared eval helpers are never loaded as an extension and no package can supply their
// dependencies, so they use Node built-ins and each other only.
for (const entry of readdirSync(shared)) {
  if (!entry.endsWith('.ts')) continue;
  for (const match of readFileSync(resolve(shared,entry),'utf8').matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
    assert(match[1].startsWith('node:') || match[1].startsWith('./'),`evals/shared/${entry} may import Node built-ins and its siblings only: ${match[1]}`);
  }
}
// The target list is explicit: evals/targets.ts imports the shared helpers and the packages' `eval/<id>.target.ts`
// files and nothing else, and every such file is listed there, named after the id it declares.
const targetsFile = readFileSync(resolve(root,'evals','targets.ts'),'utf8');
for (const match of targetsFile.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
  assert(/^\.\/shared\/[\w.-]+\.ts$/.test(match[1]) || /^\.\.\/packages\/pi-[\w-]+\/eval\/[\w-]+\.target\.ts$/.test(match[1]),`evals/targets.ts may import shared helpers and packages' eval targets only: ${match[1]}`);
}
for (const name of readdirSync(resolve(root,'packages'))) {
  const evalDir = resolve(root,'packages',name,'eval');
  if (!existsSync(evalDir)) continue;
  for (const entry of readdirSync(evalDir)) {
    if (!entry.endsWith('.target.ts')) continue;
    const stem = entry.slice(0,-'.target.ts'.length);
    assert(targetsFile.includes(`../packages/${name}/eval/${entry}`),`evals/targets.ts must import packages/${name}/eval/${entry}`);
    const code = readFileSync(resolve(evalDir,entry),'utf8');
    assert(/export\s+default\s+defineEval\s*\(/.test(code),`${name}/eval/${entry} must default-export defineEval({...})`);
    assert.equal(code.match(/^\s*id:\s*["']([^"']+)["']/m)?.[1],stem,`${name}/eval/${entry} must declare id: "${stem}"`);
    assert.equal(code.match(/^\s*package:\s*["']([^"']+)["']/m)?.[1],name,`${name}/eval/${entry} must declare package: "${name}"`);
  }
}
const hosts = new Set(['@earendil-works/pi-ai','@earendil-works/pi-agent-core','@earendil-works/pi-coding-agent','@earendil-works/pi-tui','typebox']);
function* files(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir,{withFileTypes:true})) {
    const path = resolve(dir,entry.name);
    if (entry.isDirectory()) { if (!['node_modules','.git','test','tests'].includes(entry.name)) yield* files(path); }
    else if (/\.(?:ts|js|mjs)$/.test(entry.name)) yield path;
  }
}
for (const name of components) {
  const component = resolve(root,'packages',name);
  const pkg = JSON.parse(readFileSync(resolve(component,'package.json'),'utf8'));
  assert(existsSync(resolve(component,'LICENSE')),`${name} keeps its license`);
  assert.equal(pkg.version,manifest.version,`${name} must use the suite version`);
  assert.equal(pkg.repository?.url,manifest.repository.url,`${name} repository metadata`);
  assert.equal(pkg.repository?.directory,`packages/${name}`);
  for (const file of files(component)) {
    const code = readFileSync(file,'utf8');
    for (const match of code.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
      const spec = match[1];
      if (spec.startsWith('.')) {
        const dest = resolve(dirname(file),spec);
        // Evals are dev-only and may use the shared eval helpers; nothing else may leave the component.
        const sharedEval = relative(component,file).startsWith(`eval${sep}`) && !relative(shared,dest).startsWith('..');
        assert(sharedEval || !relative(component,dest).startsWith('..'),`${name} imports a runtime sibling: ${relative(root,file)} -> ${spec}`);
      }
      const host = [...hosts].find(h => spec === h || spec.startsWith(h+'/'));
      if (host) assert.equal(pkg.peerDependencies?.[host],'*',`${name} must declare host peer ${host}`);
    }
  }
  const lockPath = resolve(component,'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath,'utf8'));
    assert.equal(lock.version,manifest.version,`${name} lock version`);
    assert.equal(lock.packages?.['']?.version,manifest.version,`${name} lock root version`);
  }
}
const { plugins } = await import('../site/src/data/plugins.mjs');
const names = plugins.map(p => p.id ?? p.name ?? p.slug);
assert.deepEqual(new Set(names),new Set(components),'public catalog matches selectable manifest');
console.log(`PASS ${components.length} component metadata, host peers, runtime independence, helper parity, shared eval helpers, eval target registry and public catalog`);
