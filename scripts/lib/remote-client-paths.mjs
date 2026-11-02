import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const executable = file => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

export function resolveOvisDirectory({ env = process.env, home = homedir(), exists = existsSync, list = readdirSync, isExecutable = executable } = {}) {
  const bundle = directory => {
    const bun = path.join(directory, 'bin/bun');
    return exists(path.join(directory, 'server/prompt.ts')) && isExecutable(bun)
      ? { directory, kind: 'bundle', bun } : undefined;
  };
  const explicit = env.OVIS_DIR || env.HERDR_WEB_UI_DIR;
  if (explicit) {
    const found = bundle(explicit);
    if (found) return found;
    if (exists(path.join(explicit, 'server/prompt.ts')) && exists(path.join(explicit, 'package.json')) && exists(path.join(explicit, 'scripts/check.ts'))) {
      return { directory: explicit, kind: 'source', bun: 'bun' };
    }
    throw new Error(`Ovis parser directory is invalid: ${explicit}`);
  }

  const roots = ['herdr-web-ui', 'ovis'].map(name => path.join(home, '.local/share', name));
  const candidates = roots.flatMap((root, index) => exists(root)
    ? list(root).filter(name => /^remote-v\d+$/.test(name)).map(name => ({ directory: path.join(root, name), version: BigInt(name.slice(8)), index }))
    : []);
  candidates.sort((a, b) => a.version === b.version ? a.index - b.index : a.version > b.version ? -1 : 1);
  for (const candidate of candidates) {
    const found = bundle(candidate.directory);
    if (found) return found;
  }
  return undefined;
}

export function assertRemoteClientsPresent({ ovis, collie }, required) {
  if (!required) return;
  const missing = [!ovis && 'Ovis', !collie && 'Collie'].filter(Boolean);
  if (missing.length) throw new Error(`Required remote client parsers missing: ${missing.join(', ')}`);
}
