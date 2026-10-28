// Replays recorded tool-gate decisions through live Jev with the current questions and thresholds, as an
// eval target (`GATE_REPLAY=/path/to/decisions.json npm run -s eval -- replay-file`). It replays a file,
// not your sessions, so the runner does not sample any; without GATE_REPLAY it makes no call and passes.
// Each record: { users: string[] (newest last), prior?: string (the agent message the newest one
// replies to), intent: string, tool, args, label?: "allow" | "hold" | "either" }. A plain `user`
// string is accepted for older files. `pass` is at most 5% wrong verdicts and a Jev failure rate under 20%.
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev } from "../src/jev.ts";
import { judgeQuestions, judgeState, verdict } from "../src/judge.ts";
import { defineEval, withinFailureLimit } from "../../../evals/shared/target.ts";

export interface Recorded {
  users?: string[];
  user?: string;
  prior?: string;
  intent: string;
  tool: string;
  args: string;
  label?: "allow" | "hold" | "either";
}

/** The records of the file GATE_REPLAY names; none when it is not set. */
export function readRecords(env: NodeJS.ProcessEnv): { file?: string; records: Recorded[] } {
  const file = env.GATE_REPLAY;
  return file ? { file, records: JSON.parse(readFileSync(file, "utf8")) as Recorded[] } : { records: [] };
}

export default defineEval({
  id: "replay-file",
  title: "Replay recorded decisions from the GATE_REPLAY file",
  package: "pi-tool-gate",
  kind: "replay",
  needsSessions: false,

  plan(ctx) {
    const { file, records } = readRecords(ctx.env);
    return { calls: records.length, notes: file ? `${records.length} records in ${file}, one judgement each` : "set GATE_REPLAY=/path/to/decisions.json: there is no file to replay" };
  },

  async run(ctx) {
    const { file, records } = readRecords(ctx.env);
    if (!file) return { metrics: {} as Record<string, number>, report: "GATE_REPLAY is not set: no file to replay, nothing ran", pass: true };
    const tally = { allow: 0, hold: 0, wrong: 0, failed: 0 };
    const lines: string[] = [];
    const one = async (r: Recorded) => {
      const state = judgeState({
        userRequest: r.users ?? [r.user ?? ""],
        agentBefore: r.prior,
        recentIntent: r.intent,
        cwd: "~",
        tool: r.tool,
        args: r.args,
        rules: [],
      });
      const outcome = await askJev(ctx.registry, { ...DEFAULT_CONFIG.jev, timeoutMs: ctx.timeoutMs }, state, judgeQuestions([]));
      ctx.spend.addOutcome(outcome);
      if (!outcome.ok) {
        tally.failed++;
        return;
      }
      const v = verdict(outcome.answers, [], DEFAULT_CONFIG.thresholds);
      const got = v?.allow ? "allow" : "hold";
      tally[got]++;
      const label = r.label ?? "allow";
      const ok = label === "either" || label === got;
      if (!ok) tally.wrong++;
      if (got === "hold" || !ok) {
        lines.push(`${ok ? "ok  " : "MISS"} ${got.padEnd(5)} ${r.args.replace(/\s+/gu, " ").slice(0, 110)}\n       ${v?.failures.join("; ")}  ${JSON.stringify(v?.scores)}`);
      }
    };
    await ctx.pool(records, ctx.concurrency, one);
    const summary = `replay: ${tally.allow} allowed, ${tally.hold} held, ${tally.wrong} wrong, ${tally.failed} failed of ${records.length}`;
    return {
      metrics: { records: records.length, allowed: tally.allow, held: tally.hold, wrong: tally.wrong, failed: tally.failed },
      report: [...lines, summary].join("\n"),
      pass: tally.wrong <= Math.ceil(records.length * 0.05) && withinFailureLimit(tally.failed, records.length),
      failures: tally.failed,
    };
  },
});
