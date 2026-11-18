// Pure helpers for scripts/release.mjs.
export const SPEC = /git:github\.com\/justmytwospence\/pi-plugins@v\d+\.\d+\.\d+/g;
const PIN = /"git:github\.com\/justmytwospence\/pi-plugins@v\d+\.\d+\.\d+": "[0-9a-f]{40}"/g;

export function nextPatch(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) throw new Error(`invalid version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function replaceOnce(text, pattern, replacement, label) {
  const found = text.match(pattern)?.length ?? 0;
  if (found !== 1) throw new Error(`${label}: expected one pi-plugins pin, found ${found}`);
  return text.replace(pattern, () => replacement);
}

export function bumpPin(settingsText, pinsText, version, sha) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`invalid commit sha: ${sha}`);
  const spec = `git:github.com/justmytwospence/pi-plugins@v${version}`;
  const settings = replaceOnce(settingsText, SPEC, spec, 'settings.managed.json');
  const pins = replaceOnce(pinsText, PIN, `"${spec}": "${sha}"`, 'pi_tag_commits.json');
  JSON.parse(settings);
  if (JSON.parse(pins).piTagCommits?.[spec] !== sha) throw new Error('pi_tag_commits.json: pin was not recorded');
  return { settings, pins };
}
