#!/usr/bin/env node
// Deprecated alias of `npm run -s eval -- --last --json <id>`, kept so the /eval extension keeps working until it
// reads the registry: `npm run -s eval:last -- <target>` prints `{ target, runs, last, previous, diff }` as one JSON
// object on stdout (`last` is null with no history, `previous` and `diff` null with one run). The old names
// `auto-effort` and `tool-gate` map to their target ids; a history recorded under the old name (before the port) is
// read when the id has none. The records are the runner's (evals/shared/results.ts).
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { diffRecords, last } = await jiti.import("../evals/shared/results.ts");

const IDS = { "auto-effort": "replay", "tool-gate": "sessions" };
const target = process.argv[2];
if (!target) {
  console.error("usage: npm run -s eval:last -- <target>   (a target id, or the old names auto-effort and tool-gate); superseded by npm run -s eval -- --last");
  process.exit(2);
}
let records;
try {
  records = last(IDS[target] ?? target, 2);
  if (!records.length && IDS[target]) records = last(target, 2);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const next = records.at(-1) ?? null;
const prev = records.length > 1 ? records[0] : null;
if (!next) console.error(`no recorded runs for ${target}`);
console.log(JSON.stringify({ target, runs: records.length, last: next, previous: prev, diff: next && prev ? diffRecords(prev, next) : null }));
