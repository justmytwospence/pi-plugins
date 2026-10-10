// Sessions ranked by live Jev through Pi's model registry: `npm run eval`. The piece the user is
// after must be in the top 3 of Suggested.
import { beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev } from "../src/jev.ts";
import { piecesToJudge, rankQuestions, rankState, readJudgments, suggested } from "../src/rank.ts";
import { extractSegments } from "../src/segments.ts";
import { hasCredentials, installedRegistry } from "./registry.ts";

const u = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const a = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const bash = (command: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: command, name: "bash", arguments: { command } }] } });

const SESSIONS: Array<{ name: string; entries: unknown[]; want: string }> = [
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

describe.skipIf(!hasCredentials)("pi-copy live eval", () => {
  let registry: unknown;
  beforeAll(async () => {
    registry = await installedRegistry();
  });

  test.each(SESSIONS)("$name", async (s) => {
    const segments = extractSegments(s.entries);
    const pieces = piecesToJudge(segments, DEFAULT_CONFIG.rank);
    const recent = s.entries.filter((e: any) => e.message.role === "user").map((e: any) => e.message.content as string).slice(-3);
    const outcome = await askJev(registry, { ...DEFAULT_CONFIG.jev, timeoutMs: 15_000 }, rankState(pieces, recent, DEFAULT_CONFIG.rank), rankQuestions(pieces));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const top = suggested(segments, readJudgments(pieces, outcome.answers), DEFAULT_CONFIG.rank).slice(0, 3);
    console.log(`${s.name} (${outcome.latencyMs} ms): ${top.map((t) => `${t.kind}:${t.text.slice(0, 40).replace(/\n/gu, " ")}`).join(" | ")}`);
    expect(top.some((t) => t.text.includes(s.want))).toBe(true);
  });
});
