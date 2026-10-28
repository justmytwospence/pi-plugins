// Long, realistic tool logs trimmed by live Jev through Pi's model registry, and a conversation
// compacted by it, as an eval target (`npm run -s eval -- lean`, or `--package pi-cache-guard`). Every
// line that carries a failure must survive the trim, a trim may keep at most `maxKeptShare` of the
// lines, and the compaction keeps the requirements verbatim and drops the routine exploration. The
// runner prints the report and the spend, records the run in evals/results/lean.jsonl and exits
// non-zero when `pass` is false: a Jev call that gives no answer, or any check that misses.
import { defineEval } from "../../../evals/shared/target.ts";
import { DEFAULT_SETTINGS } from "../src/core.ts";
import { JEV_MODELS, askJev } from "../src/jev.ts";
import { assemble, boolAnswer, choiceAnswer, keepQuestions, keepState, makeBlocks, prefilter, trimQuestions } from "../src/lean.ts";
import { extractUnits } from "../src/units.ts";

const JEV = JEV_MODELS[0]!;
/** The per-call timeout these checks always ran with. */
const TIMEOUT_MS = 30_000;

const repeat = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));

interface Case {
  name: string;
  intent: string;
  command: string;
  lines: string[];
  mustKeep: string[];
}

export const CASES: Case[] = [
  {
    name: "vitest with one failure",
    intent: "Running the test suite to see what fails.",
    command: "npx vitest run",
    lines: [...repeat(800, (i) => ` ✓ test/unit/module${i}.test.ts (${(i % 9) + 1} tests) ${i % 40}ms`), " FAIL  test/unit/retry.test.ts > retries three times", "AssertionError: expected 1 to be 3 // Object.is equality", " ❯ test/unit/retry.test.ts:42:18", ...repeat(300, (i) => ` ✓ test/integration/flow${i}.test.ts (2 tests) 12ms`), " Test Files  1 failed | 1100 passed (1101)"],
    mustKeep: ["AssertionError: expected 1 to be 3", "retry.test.ts:42:18", "1 failed | 1100 passed"],
  },
  {
    name: "tsc errors",
    intent: "Typechecking after the refactor.",
    command: "npx tsc --noEmit",
    lines: [...repeat(600, (i) => `src/generated/schema${i}.ts: info: skipped declaration emit`), "src/client.ts(88,14): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.", ...repeat(400, (i) => `src/generated/types${i}.ts: info: skipped declaration emit`), "src/retry.ts(12,3): error TS2304: Cannot find name 'backoff'.", "Found 2 errors in 2 files."],
    mustKeep: ["error TS2345", "error TS2304", "Found 2 errors"],
  },
  {
    name: "npm install noise with a peer conflict",
    intent: "Installing dependencies.",
    command: "npm install",
    lines: [...repeat(900, (i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} ${i % 50}ms (cache hit)`), "npm ERR! code ERESOLVE", "npm ERR! Could not resolve dependency: peer react@\"^18\" from react-dom@18.3.1", ...repeat(200, (i) => `npm timing reify:audit Completed in ${i}ms`)],
    mustKeep: ["ERESOLVE", "peer react@"],
  },
  {
    name: "pytest failure",
    intent: "Running pytest for the parser.",
    command: "pytest -q",
    lines: [...repeat(1000, (i) => `tests/test_mod_${i}.py ........                                   [ ${Math.floor(i / 10)}%]`), "=================================== FAILURES ===================================", "____________________________ test_parse_empty ____________________________", "    def test_parse_empty():", ">       assert parse('') == []", "E       AssertionError: assert None == []", "tests/test_parser.py:17: AssertionError", "1 failed, 8000 passed in 41.20s"],
    mustKeep: ["assert parse('') == []", "AssertionError: assert None == []", "1 failed, 8000 passed"],
  },
  {
    name: "cargo build warning flood and one error",
    intent: "Building the crate.",
    command: "cargo build",
    lines: [...repeat(700, (i) => `   Compiling dep-${i} v0.${i % 9}.0`), "error[E0308]: mismatched types", "  --> src/main.rs:31:20", "   |", "31 |     let n: u32 = config.retries;", "   |                  ^^^^^^^^^^^^^^ expected `u32`, found `i64`", ...repeat(200, (i) => `warning: unused import: \`std::fmt::${i}\``), "error: could not compile `app` (bin \"app\") due to 1 previous error; 200 warnings emitted"],
    mustKeep: ["error[E0308]: mismatched types", "src/main.rs:31:20", "could not compile `app`"],
  },
  {
    name: "grep with many matches, looking for the definition",
    intent: "Finding where retryPolicy is defined.",
    command: "rg -n retryPolicy",
    lines: [...repeat(900, (i) => `src/callers/caller${i}.ts:${i % 300}:  client.get(url, { retryPolicy })`), "src/http/policy.ts:5:export const retryPolicy = { attempts: 3, backoff: 'exponential' };", ...repeat(100, (i) => `test/fixtures/f${i}.ts:3:  retryPolicy,`)],
    mustKeep: ["export const retryPolicy"],
  },
  {
    name: "docker build failure",
    intent: "Building the image.",
    command: "docker build .",
    lines: [...repeat(800, (i) => `#${i} sha256:${(i * 7919).toString(16).padStart(12, "0")} ${i % 100}MB / 300MB 2.${i % 10}s`), "#811 [build 6/9] RUN npm run build", "#811 ERROR: process \"/bin/sh -c npm run build\" did not complete successfully: exit code: 1", "> [build 6/9] RUN npm run build:", "Module not found: Error: Can't resolve './config.local' in '/app/src'"],
    mustKeep: ["did not complete successfully: exit code: 1", "Can't resolve './config.local'"],
  },
  {
    name: "eslint report",
    intent: "Linting before committing.",
    command: "npx eslint .",
    lines: [...repeat(1000, (i) => `/app/src/file${i}.ts`).flatMap((f) => [f]), "/app/src/auth.ts", "  14:7  error  'token' is assigned a value but never used  no-unused-vars", "✖ 1 problem (1 error, 0 warnings)"],
    mustKeep: ["'token' is assigned a value but never used", "1 problem (1 error"],
  },
  {
    name: "go test with a panic",
    intent: "Running the Go tests.",
    command: "go test ./...",
    lines: [...repeat(900, (i) => `ok  \tgithub.com/acme/app/pkg/p${i}\t0.0${i % 9}s`), "--- FAIL: TestRetry (0.00s)", "panic: runtime error: index out of range [3] with length 3 [recovered]", "\tretry_test.go:28 +0x1d4", "FAIL\tgithub.com/acme/app/pkg/retry\t0.012s"],
    mustKeep: ["--- FAIL: TestRetry", "index out of range [3] with length 3", "retry_test.go:28"],
  },
  {
    name: "migration log with one failed statement",
    intent: "Running the database migrations locally.",
    command: "npm run migrate",
    lines: [...repeat(700, (i) => `[migrate] applied ${String(i).padStart(4, "0")}_create_table_${i}.sql (${i % 20}ms)`), "[migrate] applying 0701_add_users_email_index.sql", "[migrate] ERROR: relation \"users_email_idx\" already exists", "[migrate] rolled back 0701_add_users_email_index.sql", "[migrate] 700 applied, 1 failed"],
    mustKeep: ["relation \"users_email_idx\" already exists", "700 applied, 1 failed"],
  },
];

/** The compaction case: a conversation of five units, and the units that must come out verbatim. */
const COMPACTION = {
  goal: "Make the retry tests pass.",
  messages: [
    { role: "user", content: "Add retries to the HTTP client. Use exponential backoff, max 3 attempts, and never retry POST requests." },
    { role: "assistant", content: [{ type: "text", text: "Let me look around the repo." }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] },
    { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "README.md\nsrc\ntest\npackage.json" }], isError: false },
    { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npm test" } }] },
    { role: "toolResult", toolCallId: "c2", toolName: "bash", content: [{ type: "text", text: "FAIL test/retry.test.ts: POST request was retried 3 times (expected 0)" }], isError: true },
  ],
};

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

/** The trim request of a case: what Jev is asked, exactly as the check ran it. */
function trimRequest(c: Case) {
  const settings = DEFAULT_SETTINGS.trim;
  const text = c.lines.join("\n");
  const candidates = text.length > settings.stateBudgetChars ? prefilter(c.lines, settings.stateBudgetChars) : [...c.lines.keys()];
  const blocks = makeBlocks(c.lines, candidates, settings.maxBlocks);
  const state = {
    intent: { user_request: "Fix whatever is broken.", agent_said: c.intent, tool: "bash", arguments: JSON.stringify({ command: c.command }) },
    output: Object.fromEntries(blocks.map((b) => [b.id, b.text])),
  };
  return { text, blocks, state, questions: trimQuestions(blocks) };
}

/** The compaction request: the goal and the units, as the check asked them. */
function compactionRequest() {
  const units = extractUnits(COMPACTION.messages);
  return { units, state: keepState(COMPACTION.goal, units), questions: keepQuestions(units) };
}

export default defineEval({
  id: "lean",
  title: "Trim long tool output and compact a conversation with Jev",
  package: "pi-cache-guard",
  kind: "cases",

  plan() {
    const trims = CASES.map((c) => Object.keys(trimRequest(c).questions).length);
    const keeps = Object.keys(compactionRequest().questions).length;
    const questions = trims.reduce((n, q) => n + q, 0);
    return {
      calls: CASES.length + 1,
      notes: `${CASES.length} trims (${questions} questions in all, ${trims.join(", ")}) and 1 compaction (${keeps} questions)`,
    };
  },

  async run(ctx) {
    const settings = DEFAULT_SETTINGS.trim;
    const lines: string[] = [];
    const misses: string[] = [];
    const metrics: Record<string, number> = {};
    let failures = 0;
    let mustKeepFound = 0;
    let mustKeepTotal = 0;
    let worst: number | undefined;

    // One Jev request per case, a bounded number in flight; the report keeps the case order.
    const trims = new Array<string[]>(CASES.length);
    await ctx.pool(CASES, ctx.concurrency, async (c, i) => {
      const request = trimRequest(c);
      const outcome = await askJev(ctx.registry, JEV, TIMEOUT_MS, request.state, request.questions);
      ctx.spend.addOutcome(outcome);
      if (!outcome.ok) {
        failures++;
        trims[i] = [`${c.name}: FAILED: ${outcome.reason}`];
        return;
      }
      const kept = request.blocks.filter((b) => (boolAnswer(outcome.answers, `block::${b.id}`) ?? 1) >= settings.keepThreshold);
      const result = assemble(c.lines, kept, settings, "/tmp/full.txt");
      const share = result.keptLines / result.totalLines;
      trims[i] = [`${c.name}: kept ${result.keptLines}/${result.totalLines} lines, ${Math.round((100 * result.text.length) / request.text.length)}% of chars, needs_all ${boolAnswer(outcome.answers, "needs_all")}, ${outcome.latencyMs} ms, ${outcome.usage?.input} tokens`];
      metrics[`keptShare.${slug(c.name)}`] = share;
      worst = Math.max(worst ?? share, share);
      mustKeepTotal += c.mustKeep.length;
      for (const line of c.mustKeep) {
        if (result.text.includes(line)) mustKeepFound++;
        else misses.push(`${c.name}: trimmed output lost ${JSON.stringify(line)}`);
      }
      if (share > settings.maxKeptShare) misses.push(`${c.name}: kept ${share.toFixed(2)} of the lines, above ${settings.maxKeptShare}`);
    });
    lines.push(...trims.flat());

    // The compaction: one request for the units, then the three checks on how they are kept.
    const request = compactionRequest();
    const outcome = await askJev(ctx.registry, JEV, TIMEOUT_MS, request.state, request.questions);
    ctx.spend.addOutcome(outcome);
    let compactionHits = 0;
    if (!outcome.ok) {
      failures++;
      lines.push(`compaction: FAILED: ${outcome.reason}`);
    } else {
      const keep = Object.fromEntries(request.units.map((u) => [u.id, choiceAnswer(outcome.answers, `keep::${u.id}`)]));
      lines.push(`compaction: ${JSON.stringify(keep)}`);
      const checks: Array<[string, boolean, string]> = [
        ["U001", keep.U001 === "verbatim", "verbatim"],
        ["U003", keep.U003 !== "verbatim", "not verbatim"],
        ["U004", keep.U004 === "verbatim", "verbatim"],
      ];
      for (const [id, ok, want] of checks) {
        if (ok) compactionHits++;
        else misses.push(`compaction: ${id} is not ${want} (${keep[id] ?? "unanswered"})`);
      }
    }

    if (worst !== undefined) metrics.worstKeptShare = worst;
    Object.assign(metrics, {
      cases: CASES.length,
      maxKeptShare: settings.maxKeptShare,
      mustKeepFound,
      mustKeepTotal,
      compactionHits,
      compactionChecks: 3,
      misses: misses.length,
    });
    const report = [...lines, ...(misses.length ? ["misses:", ...misses.map((m) => `  ${m}`)] : [])].join("\n");
    return { metrics, report, pass: failures === 0 && misses.length === 0, failures };
  },
});
