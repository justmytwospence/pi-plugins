import assert from 'node:assert/strict';
import test from 'node:test';
import { bumpPin, nextPatch, waitForReleaseCi } from './lib/release.mjs';

const OLD = 'git:github.com/justmytwospence/pi-plugins@v0.1.93';
const SHA = 'a'.repeat(40);
const OLD_SHA = '264f0d3a6cba0b7eb1a37f2f722a36caf9458f58';
const settings = `{
  "packages": [
    "npm:other@1.2.3",
    "${OLD}",
    "git:github.com/justmytwospence/other@v0.0.1"
  ]
}
`;
const pins = `{
  "unrelated": "keep",
  "piTagCommits": {
    "${OLD}": "${OLD_SHA}"
  }
}
`;

function ciFixture(responses = {}) {
  const calls = [];
  const watched = [];
  const sleeps = [];
  const logs = [];
  const success = { databaseId: 42, status: 'completed', conclusion: 'success', url: 'https://example.test/run', headSha: SHA };
  const run = (command, args) => {
    calls.push([command, args]);
    const workflow = args[args.indexOf('--workflow') + 1];
    const queue = responses[workflow];
    const value = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : success;
    if (value instanceof Error) throw value;
    return JSON.stringify(value ? [value] : []);
  };
  const options = { run, watch: async (id) => { watched.push(id); }, sleep: async (ms) => { sleeps.push(ms); }, log: (line) => logs.push(line) };
  return { calls, watched, sleeps, logs, options, success };
}

test('release CI queries both push workflows on exact HEAD', async () => {
  const f = ciFixture();
  await waitForReleaseCi(SHA, f.options);
  assert.deepEqual(f.calls, ['checks.yml', 'switchyard.yml'].map((workflow) => ['gh', ['run', 'list', '--workflow', workflow,
    '--commit', SHA, '--event', 'push', '--limit', '1', '--json', 'databaseId,status,conclusion,url,headSha']]));
  assert.deepEqual(f.logs, ['Checks: success', 'Switchyard: success']);
});

test('release CI rejects mismatched HEAD before and after watching', async () => {
  for (const wrong of ['b'.repeat(40), '0'.repeat(40)]) {
    const f = ciFixture({ 'checks.yml': [{ headSha: wrong }] });
    await assert.rejects(waitForReleaseCi(SHA, f.options), /does not match/);
  }
  const f = ciFixture();
  const pending = { ...f.success, status: 'in_progress', conclusion: null };
  const mismatch = { ...f.success, headSha: 'b'.repeat(40) };
  const g = ciFixture({ 'checks.yml': [pending, mismatch] });
  await assert.rejects(waitForReleaseCi(SHA, g.options), /does not match/);
  assert.deepEqual(g.watched, [42]);
});

test('release CI waits for missing Switchyard run and fails closed', async () => {
  const f = ciFixture({ 'switchyard.yml': [null] });
  await assert.rejects(waitForReleaseCi(SHA, f.options), /no Switchyard run/);
  assert.equal(f.sleeps.length, 18);
  assert.ok(f.sleeps.every((ms) => ms === 10_000));
});

test('release CI rejects failure, cancellation and API errors', async () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const f = ciFixture({ 'switchyard.yml': [{ databaseId: 1, headSha: SHA, status: 'completed', conclusion }] });
    await assert.rejects(waitForReleaseCi(SHA, f.options), new RegExp(conclusion));
  }
  const f = ciFixture({ 'checks.yml': [new Error('API unavailable')] });
  await assert.rejects(waitForReleaseCi(SHA, f.options), /API unavailable/);
});

test('release CI watches pending runs and rejects disappearance', async () => {
  const f = ciFixture();
  const pending = { ...f.success, status: 'queued', conclusion: null };
  const g = ciFixture({ 'checks.yml': [pending, f.success] });
  await waitForReleaseCi(SHA, g.options);
  assert.deepEqual(g.watched, [42]);
  const missing = ciFixture({ 'checks.yml': [pending, null] });
  await assert.rejects(waitForReleaseCi(SHA, missing.options), /disappeared/);
});

test('release CI dry run reports missing workflows without waiting', async () => {
  const f = ciFixture({ 'checks.yml': [null], 'switchyard.yml': [null] });
  await waitForReleaseCi(SHA, { ...f.options, dryRun: true });
  assert.deepEqual(f.logs, ['Checks: no run yet for aaaaaaa', 'Switchyard: no run yet for aaaaaaa']);
  assert.deepEqual(f.sleeps, []);
  assert.deepEqual(f.watched, []);
});

test('nextPatch bumps the patch and rejects anything else', () => {
  assert.equal(nextPatch('0.1.93'), '0.1.94');
  assert.equal(nextPatch('1.9.9'), '1.9.10');
  assert.throws(() => nextPatch('1.2'), /invalid version: 1\.2/);
  assert.throws(() => nextPatch('v1.2.3'), /invalid version: v1\.2\.3/);
});

test('bumpPin replaces only the pi-plugins entries and keeps the rest byte-identical', () => {
  const next = bumpPin(settings, pins, '0.1.94', SHA);
  assert.equal(next.settings, settings.replace('v0.1.93', 'v0.1.94'));
  assert.equal(next.pins, pins.replace('v0.1.93', 'v0.1.94').replace(OLD_SHA, SHA));
});

test('bumpPin refuses a missing or repeated pin and a short sha', () => {
  assert.throws(() => bumpPin('{}', pins, '0.1.94', SHA), /expected one pi-plugins pin, found 0/);
  assert.throws(() => bumpPin(settings.replace('"npm:other@1.2.3"', `"${OLD}"`), pins, '0.1.94', SHA),
    /expected one pi-plugins pin, found 2/);
  assert.throws(() => bumpPin(settings, '{ "piTagCommits": {} }', '0.1.94', SHA), /expected one pi-plugins pin, found 0/);
  assert.throws(() => bumpPin(settings, pins, '0.1.94', 'abc123'), /invalid commit sha/);
});
