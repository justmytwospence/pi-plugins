// Compatibility depends on every package, including new and private ones, and these root inputs.
const rootInputs = new Set([
  'package.json', 'package-lock.json', '.nvmrc', '.github/compat-switchyard.json',
  '.github/workflows/switchyard.yml', 'scripts/check-switchyard.mjs',
  'scripts/check-changed.mjs', 'scripts/check-changed.test.mjs',
  'scripts/lib/switchyard-changes.mjs', 'scripts/test-contracts.mjs',
]);

export const needsSwitchyard = (paths) => paths.some((path) => path.startsWith('packages/') || rootInputs.has(path));
