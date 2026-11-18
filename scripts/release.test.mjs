import assert from 'node:assert/strict';
import test from 'node:test';
import { bumpPin, nextPatch } from './lib/release.mjs';

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
