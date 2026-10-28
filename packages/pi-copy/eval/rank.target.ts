// Sessions ranked by live Jev through Pi's model registry, as an eval target (`npm run -s eval -- rank`,
// or `--package pi-copy`): the piece the user is after must be in the top 3 of Suggested. The runner
// prints the report and the spend, records the run in evals/results/rank.jsonl and exits non-zero
// when `pass` is false: a Jev call that gives no answer, or a session whose wanted piece is not in
// the top 3 (every session must hit).
import { defineEval } from "../../../evals/shared/target.ts";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev } from "../src/jev.ts";
import { piecesToJudge, rankQuestions, rankState, readJudgments, suggested } from "../src/rank.ts";
import { extractSegments } from "../src/segments.ts";

/** The per-call timeout these checks always ran with. */
const TIMEOUT_MS = 15_000;

interface Entry {
  type: "message";
  message: { role: "user" | "assistant"; content: unknown };
}

const u = (text: string): Entry => ({ type: "message", message: { role: "user", content: text } });
const a = (text: string): Entry => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const bash = (command: string): Entry => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: command, name: "bash", arguments: { command } }] } });

export const SESSIONS: Array<{ name: string; entries: Entry[]; want: string }> = [
  {
    name: "the deploy command",
    entries: [
      u("why is the build failing?"),
      bash("npm run build"),
      a("The build fails because `src/env.ts` reads `API_URL`, which is unset in CI. I set a default."),
      u("ok, how do I deploy this to staging myself?"),
      a("Run this from the repo root:\n\n```bash\nvercel deploy --prebuilt --target=staging\n```\n\nIt uses the build output in `.vercel/output`, so build first if you changed anything."),
    ],
    want: "vercel deploy --prebuilt --target=staging",
  },
  {
    name: "the commit message",
    entries: [
      u("add retries to the http client"),
      a("Done. I added exponential backoff in `src/http/retry.ts` and tests in `test/retry.test.ts`."),
      bash("npm test"),
      u("write me a commit message for this"),
      a("Here's a commit message:\n\n```\nfeat: retry failed HTTP requests with exponential backoff\n\nRetries GET requests up to 3 times on 5xx and network errors.\n```"),
    ],
    want: "feat: retry failed HTTP requests with exponential backoff",
  },
  {
    name: "the PR description paragraph",
    entries: [
      u("summarize what we changed today so I can paste it in the PR"),
      a("Sure.\n\nThis PR moves config loading to a single validated module. Config is parsed with zod at startup, invalid values fail fast with a clear message, and the three ad-hoc loaders in `src/` are removed. No behavior changes for valid configs.\n\nLet me know if you want it shorter."),
    ],
    want: "This PR moves config loading",
  },
  {
    name: "a file path",
    entries: [
      u("where is the rate limiter implemented?"),
      a("It's in `src/middleware/rate-limit.ts`. The token bucket itself is `src/lib/bucket.ts`, and the tests are in `test/rate-limit.test.ts`."),
      u("I want to open the middleware file"),
    ],
    want: "src/middleware/rate-limit.ts",
  },
  {
    name: "the SQL query",
    entries: [
      u("how many users signed up last week?"),
      a("I can't reach the database, but this query gives you the number:\n\n```sql\nSELECT count(*) FROM users WHERE created_at >= now() - interval '7 days';\n```\n\nRun it against the read replica."),
      u("thanks, I'll run it myself"),
    ],
    want: "SELECT count(*) FROM users",
  },
];

const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

/** The request of a session: the pieces judged, the recent user messages, and the questions. */
function request(entries: Entry[]) {
  const segments = extractSegments(entries);
  const pieces = piecesToJudge(segments, DEFAULT_CONFIG.rank);
  const recent = entries.filter((e) => e.message.role === "user").map((e) => e.message.content as string).slice(-3);
  return { segments, pieces, state: rankState(pieces, recent, DEFAULT_CONFIG.rank), questions: rankQuestions(pieces) };
}

export default defineEval({
  id: "rank",
  title: "Rank the pieces of a session the way the picker suggests them",
  package: "pi-copy",
  kind: "cases",

  plan() {
    const requests = SESSIONS.map((s) => request(s.entries));
    const pieces = requests.reduce((n, r) => n + r.pieces.length, 0);
    const questions = requests.reduce((n, r) => n + Object.keys(r.questions).length, 0);
    return {
      calls: SESSIONS.length,
      notes: `${SESSIONS.length} sessions, one request each: ${pieces} pieces and ${questions} questions in all`,
    };
  },

  async run(ctx) {
    const lines = new Array<string>(SESSIONS.length);
    const misses: string[] = [];
    const metrics: Record<string, number> = {};
    let failures = 0;
    let hits = 0;

    await ctx.pool(SESSIONS, ctx.concurrency, async (s, i) => {
      const r = request(s.entries);
      const outcome = await askJev(ctx.registry, { ...DEFAULT_CONFIG.jev, timeoutMs: TIMEOUT_MS }, r.state, r.questions);
      ctx.spend.addOutcome(outcome);
      if (!outcome.ok) {
        failures++;
        lines[i] = `${s.name}: FAILED: ${outcome.reason}`;
        return;
      }
      const top = suggested(r.segments, readJudgments(r.pieces, outcome.answers), DEFAULT_CONFIG.rank).slice(0, 3);
      lines[i] = `${s.name} (${outcome.latencyMs} ms): ${top.map((t) => `${t.kind}:${t.text.slice(0, 40).replace(/\n/gu, " ")}`).join(" | ")}`;
      const hit = top.some((t) => t.text.includes(s.want));
      metrics[`hit.${slug(s.name)}`] = hit ? 1 : 0;
      if (hit) hits++;
      else misses.push(`${s.name}: ${JSON.stringify(s.want)} is not in the top 3`);
    });

    Object.assign(metrics, { sessions: SESSIONS.length, hits, misses: misses.length });
    const report = [...lines, ...(misses.length ? ["misses:", ...misses.map((m) => `  ${m}`)] : [])].join("\n");
    return { metrics, report, pass: failures === 0 && misses.length === 0, failures };
  },
});
