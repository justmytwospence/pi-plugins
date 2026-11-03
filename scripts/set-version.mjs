// Set the suite version in the root and every component package.json and lock.
// Edits only the version fields in place, so formatting (tabs or spaces) is kept.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function indentUnit(text) {
  const second = text.split('\n')[1] ?? '';
  return second.startsWith('\t') ? '\t' : '  ';
}

// Replace the first `"version": "<old>"` at `depth` indents, searching from `anchor`.
function replaceAt(text, anchor, depth, unit, old, next, path, field) {
  const start = anchor === null ? 0 : text.indexOf(anchor);
  if (start < 0) throw new Error(`${path}: no version "${old}" at ${field}`);
  const re = new RegExp(`^${escape(unit.repeat(depth))}"version": "${escape(old)}"`, 'm');
  const match = re.exec(text.slice(start));
  if (!match) throw new Error(`${path}: no version "${old}" at ${field}`);
  const at = start + match.index;
  return text.slice(0, at) + match[0].replace(old, next) + text.slice(at + match[0].length);
}

function updateFile(path, rel, old, next) {
  const original = readFileSync(path, 'utf8');
  const unit = indentUnit(original);
  const expected = JSON.parse(original);
  let text = original;
  expected.version = next;
  text = replaceAt(text, null, 1, unit, old, next, rel, 'version');
  if (rel.endsWith('package-lock.json')) {
    const root = expected.packages?.[''];
    if (!root) throw new Error(`${rel}: no version "${old}" at packages[""].version`);
    root.version = next;
    text = replaceAt(text, `\n${unit.repeat(2)}"": {`, 3, unit, old, next, rel, 'packages[""].version');
    for (const [key, value] of Object.entries(expected.packages)) {
      if (!key.startsWith('packages/') || value.version !== old) continue;
      value.version = next;
      text = replaceAt(text, `\n${unit.repeat(2)}"${key}": {`, 3, unit, old, next, rel, `packages["${key}"].version`);
    }
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${rel}: unexpected change`); }
  if (!isDeepStrictEqual(parsed, expected)) throw new Error(`${rel}: unexpected change`);
  return text;
}

export function setVersion(root, next) {
  if (!/^\d+\.\d+\.\d+$/.test(next ?? '')) throw new Error(`invalid version: ${next}`);
  const old = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (next === old) throw new Error(`already at ${old}`);
  const targets = ['package.json', 'package-lock.json'];
  for (const name of readdirSync(join(root, 'packages')).sort()) {
    for (const file of ['package.json', 'package-lock.json']) {
      if (existsSync(join(root, 'packages', name, file))) targets.push(`packages/${name}/${file}`);
    }
  }
  const results = targets.filter((rel) => existsSync(join(root, rel)))
    .map((rel) => [rel, updateFile(join(root, rel), rel, old, next)]);
  for (const [rel, text] of results) writeFileSync(join(root, rel), text);
  return results.map(([rel]) => rel);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const old = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    const changed = setVersion(root, process.argv[2]);
    console.log(`${old} -> ${process.argv[2]}: ${changed.length} files`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
