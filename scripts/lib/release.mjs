// Pure helpers for scripts/release.mjs.
export const SPEC = /git:github\.com\/justmytwospence\/pi-plugins@v\d+\.\d+\.\d+/g;
const PIN = /"git:github\.com\/justmytwospence\/pi-plugins@v\d+\.\d+\.\d+": "[0-9a-f]{40}"/g;

export async function waitForReleaseCi(sha, { run, watch, sleep, dryRun = false, log = console.log }) {
  for (const [workflow, label] of [['checks.yml', 'Checks'], ['switchyard.yml', 'Switchyard']]) {
    const list = () => JSON.parse(run('gh', ['run', 'list', '--workflow', workflow, '--commit', sha, '--event', 'push', '--limit', '1',
      '--json', 'databaseId,status,conclusion,url,headSha']) || '[]')[0];
    const verifySha = (result) => {
      if (result.headSha !== sha) throw new Error(`${label}: run HEAD ${result.headSha} does not match ${sha}`);
    };
    let latest = list();
    for (let waited = 0; !latest && waited < 180 && !dryRun; waited += 10) {
      await sleep(10_000);
      latest = list();
    }
    if (!latest) {
      if (dryRun) {
        log(`${label}: no run yet for ${sha.slice(0, 7)}`);
        continue;
      }
      throw new Error(`no ${label} run for ${sha.slice(0, 7)}`);
    }
    verifySha(latest);
    if (dryRun) {
      log(`${label}: ${latest.status} ${latest.conclusion || ''} ${latest.url}`);
      continue;
    }
    if (latest.status !== 'completed') {
      await watch(latest.databaseId);
      latest = list();
      if (!latest) throw new Error(`${label}: run disappeared for ${sha.slice(0, 7)}`);
      verifySha(latest);
    }
    if (latest.status !== 'completed' || latest.conclusion !== 'success') {
      throw new Error(`CI is ${latest.conclusion || latest.status} on ${sha.slice(0, 7)}: ${latest.url}`);
    }
    log(`${label}: success`);
  }
}

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
