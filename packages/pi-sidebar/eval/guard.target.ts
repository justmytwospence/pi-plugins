// The guard's agreement with its own rules, as an eval target (`npm run -s eval -- guard`, or
// `--package pi-sidebar`). The shell commands in your sampled sessions that the read-only policy
// settles are the answer key (cleared as read-only, or plainly writing; see eval/guard.ts); Jev is
// asked the guard's question about each, up to 150 per label. `pass` is only the failure rate (under
// 20% of the Jev requests); the rest is a report with the worst examples of each kind.
import { defineEval, withinFailureLimit } from "../../../evals/shared/target.ts";
import { CHANGE_THRESHOLD } from "../src/guard.ts";
import { PER_LABEL, countRequests, scoreCommands, selectCommands, summarize, worst, type Scored } from "./guard.ts";

const fixed = (n: number, digits = 3) => (Number.isFinite(n) ? n.toFixed(digits) : "-");
const one = (text: string, max: number) => {
  const flat = text.replace(/\s+/gu, " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const lines = (examples: Scored[]) => examples.map((s) => `  ${fixed(s.probability as number, 2)}  ${one(s.command.command, 140)}`);

export default defineEval({
  id: "guard",
  title: "Guard agreement: Jev's change probability against the read-only policy's own verdicts",
  package: "pi-sidebar",
  kind: "replay",

  plan(ctx) {
    const { seed, sessions } = ctx.sample();
    const selection = selectCommands(sessions, seed);
    return {
      calls: countRequests(selection),
      notes: `${selection.readonly.length} read-only and ${selection.writes.length} writing commands of ${selection.available.readonly} and ${selection.available.writes} distinct ones the rules settle in ${sessions.length} sessions (at most ${PER_LABEL} per label)`,
    };
  },

  async run(ctx) {
    const { seed, sessions } = ctx.sample();
    const selection = selectCommands(sessions, seed);
    const commands = [...selection.readonly, ...selection.writes];
    const { scored, failures, spend } = await scoreCommands(ctx.registry, commands, { concurrency: ctx.concurrency });
    ctx.spend.merge(spend);
    const summary = summarize(scored);
    const refused = worst(scored, "readonly");
    const cleared = worst(scored, "writes");
    const report = [
      `sidebar guard: EVAL_SEED=${seed}, ${sessions.length} sessions, refuses at ${CHANGE_THRESHOLD} or more; askJevBool reports no cost, so the spend line counts calls only`,
      ctx.table([
        ["rules say", "n", "of those Jev disagrees"],
        ["read-only (should be cleared)", summary.readonlyN, `${summary.readonlyWronglyRefused} refused (${fixed(summary.readonlyRefusedRate)})`],
        ["writes (should be refused)", summary.writesN, `${summary.writesWronglyCleared} cleared (${fixed(summary.writesClearedRate)})`],
      ]),
      `agreement: ${fixed(summary.agreementRate)}; Jev failures: ${failures}/${commands.length}`,
      refused.length ? `\nread-only commands Jev would refuse most firmly (probability of a change):` : "",
      ...lines(refused),
      cleared.length ? `\nwriting commands Jev would clear most readily:` : "",
      ...lines(cleared),
      !withinFailureLimit(failures, commands.length) ? `Jev failures ${failures}/${commands.length}, at or above the 20% limit` : "",
    ].filter(Boolean).join("\n");
    return { metrics: { ...summary }, report, pass: withinFailureLimit(failures, commands.length), failures };
  },
});
