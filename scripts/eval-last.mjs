#!/usr/bin/env node
// `npm run -s eval:last -- <target>`: the last recorded live run of an eval (evals/results/<target>.jsonl)
// and the numeric change against the run before it, as one JSON object on stdout:
// `{ target, runs, last, previous, diff }`; `last` is null with no history, `previous` and `diff` null with one run.
import { diffRecords, last } from "../evals/shared/results.ts";

const target = process.argv[2];
if (!target) {
  console.error("usage: npm run -s eval:last -- <target>   (auto-effort, tool-gate)");
  process.exit(2);
}
let records;
try {
  records = last(target, 2);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const next = records.at(-1) ?? null;
const prev = records.length > 1 ? records[0] : null;
if (!next) console.error(`no recorded runs for ${target}`);
console.log(JSON.stringify({ target, runs: records.length, last: next, previous: prev, diff: next && prev ? diffRecords(prev, next) : null }));
