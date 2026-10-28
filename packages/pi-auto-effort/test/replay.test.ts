import { describe, expect, test } from "vitest";
import {
  type Assessment,
  CURRENT,
  OLD,
  type ReplaySession,
  assess,
  countCalls,
  metricsOf,
  needsJev,
  fromSession,
  notChosen,
  percentile,
  replaySession,
  report,
  sessionLabel,
  runVariant,
  summarize,
  walk,
} from "../eval/replay.ts";
import type { SessionEntry } from "../../../evals/shared/sessions.ts";
import { DEFAULT_POLICY } from "../src/policy.ts";
import { answers, fakeJev } from "./harness.ts";

const user = (text: string): SessionEntry => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string): SessionEntry => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const tool = (): SessionEntry => ({ type: "message", message: { role: "toolResult", toolName: "bash", content: [] } });
const level = (thinkingLevel: string): SessionEntry => ({ type: "thinking_level_change", thinkingLevel });
const model = (): SessionEntry => ({ type: "model_change", provider: "anthropic", modelId: "claude-sonnet-5-5" });
const state = (data: Record<string, unknown>): SessionEntry => ({ type: "custom", customType: "auto-effort:state", data });

describe("replaySession", () => {
  // As Pi writes it: auto-effort's level change, then its state entry, then the user's message.
  const branch: SessionEntry[] = [
    model(),
    level("high"),
    level("medium"),
    state({ phase: "prompt", from: "high", level: "medium", reason: "down", p: 0.5 }),
    user("fix the flaky test"),
    assistant("Looking."),
    level("xhigh"),
    state({ phase: "run", from: "medium", level: "xhigh", reason: "up" }),
    tool(),
    assistant("Fixed."),
    // You pick low by hand after the run.
    level("low"),
    state({ phase: "prompt", from: "low", level: "low", reason: "hold" }),
    user("Yes, go ahead"),
    assistant("Done."),
    // A model switch brings that model's level: not a choice of level.
    model(),
    level("high"),
    { type: "message", message: { role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }] } },
    user("now the docs"),
    assistant("ok"),
    level("xhigh"),
    level("max"),
  ];

  test("prompts with their recorded pressure, live level and your overrides", () => {
    const replay = replaySession("s.jsonl", branch);
    expect(replay.start).toBe("high");
    expect(replay.prompts).toEqual([
      { index: 4, text: "fix the flaky test", p: 0.5, live: "medium", override: "low" },
      { index: 12, text: "Yes, go ahead", p: 0, live: "low" },
      // The image-only message is no prompt; the last of several changes is your choice.
      { index: 17, text: "now the docs", p: 0, override: "max" },
    ]);
  });

  test("which level changes are not yours", () => {
    expect(notChosen(branch, 2)).toBe(true); // followed by the state entry recording it
    expect(notChosen(branch, 6)).toBe(true); // mid-run, same
    expect(notChosen(branch, 10)).toBe(false); // yours: the next state entry starts from it
    expect(notChosen(branch, 15)).toBe(true); // right after a model change
    expect(notChosen(branch, 19)).toBe(false);
    // A state entry recording the move just before the change counts too.
    expect(notChosen([state({ from: "low", level: "high" }), level("high")], 1)).toBe(true);
    expect(notChosen([state({ from: "low", level: "low" }), level("high")], 1)).toBe(false);
    // After its own model switch auto-effort restores its decision over Pi's per-model level.
    const restore = [assistant("ok"), model(), level("medium"), level("high"), state({ phase: "prompt", from: "high", level: "high", reason: "hold" }), user("next")];
    expect(notChosen(restore, 2)).toBe(true);
    expect(notChosen(restore, 3)).toBe(true);
    // Without the model switch the same pair is yours (twice: the last one is your choice).
    const twice = [assistant("ok"), level("medium"), level("high"), state({ phase: "prompt", from: "high", level: "high", reason: "hold" }), user("next")];
    expect(notChosen(twice, 1)).toBe(false);
    expect(notChosen(twice, 2)).toBe(false);
  });

  test("the start level: the first prompt's `from`, else the last change before it, else Pi's default", () => {
    expect(replaySession("s", [level("low"), user("a")]).start).toBe("low");
    expect(replaySession("s", [state({ phase: "run", from: "xhigh" }), level("low"), user("a")]).start).toBe("low");
    expect(replaySession("s", [user("a")]).start).toBe("medium");
    expect(replaySession("s", []).prompts).toEqual([]);
  });

  test("fromSession replays the current branch", () => {
    const entries = [
      { type: "message", id: "a", parentId: null, message: { role: "user", content: "first" } },
      { type: "message", id: "b", parentId: "a", message: { role: "user", content: "abandoned" } },
      { type: "message", id: "c", parentId: "a", message: { role: "user", content: "second" } },
    ];
    const replay = fromSession({ file: "f", cwd: "/x", entries });
    expect(replay.prompts.map((p) => p.text)).toEqual(["first", "second"]);
    expect(replay.cwd).toBe("/x");
  });
});

const jev = (depth: number): Assessment => ({ kind: "jev", outcome: { ok: true, answers: {}, model: "m", latencyMs: 100 }, judgment: judgmentOf(depth) });
const failed: Assessment = { kind: "jev", outcome: { ok: false, reason: "timed out" }, judgment: undefined };
const goAhead: Assessment = { kind: "go-ahead" };

/** need(L) for a preset depth (0 trivial to 3 hard), as the harness's fake Jev answers it. */
function judgmentOf(depth: number) {
  const need = [
    { low: 1, medium: 0.15, high: 0.05, xhigh: 0.01 },
    { low: 1, medium: 0.85, high: 0.15, xhigh: 0.05 },
    { low: 1, medium: 0.95, high: 0.75, xhigh: 0.15 },
    { low: 1, medium: 0.98, high: 0.95, xhigh: 0.7 },
  ][depth]!;
  return { need, ack: 0.05 };
}

const session = (prompts: Array<{ p?: number; override?: string; live?: string }>, start = "medium"): ReplaySession => ({
  file: "/s/--proj--/one.jsonl",
  cwd: "/work/proj",
  branch: [],
  start,
  prompts: prompts.map((p, i) => ({ index: i, text: `prompt ${i}`, p: p.p ?? 0, ...(p.override ? { override: p.override } : {}), ...(p.live ? { live: p.live } : {}) })),
});

describe("walk", () => {
  test("decide() from the level the last step left; a go-ahead or a failure keeps it; an override replaces it", () => {
    const s = session([{}, {}, {}, { override: "low" }, {}, {}]);
    const steps = walk(s, [jev(3), goAhead, failed, jev(2), jev(2), jev(0)]);
    expect(steps).toEqual([
      { from: "medium", level: "xhigh", reason: "up" },
      { from: "xhigh", level: "xhigh", reason: "go-ahead" },
      { from: "xhigh", level: "xhigh", reason: "unavailable" },
      // need(xhigh) 0.15 is well below theta: down to high. You then pick low.
      { from: "xhigh", level: "high", reason: "down" },
      { from: "low", level: "high", reason: "up" },
      { from: "high", level: "low", reason: "down" },
    ]);
  });

  test("the recorded pressure raises theta", () => {
    // need(high) 0.75 clears theta 0.5 at no pressure but not 0.85 at critical pressure.
    expect(walk(session([{ p: 0 }]), [jev(2)])[0]!.level).toBe("high");
    expect(walk(session([{ p: 1 }]), [jev(2)])[0]!.level).toBe("medium");
    expect(DEFAULT_POLICY.bounds).toBe("free");
  });
});

describe("assess", () => {
  const branch: SessionEntry[] = [user("Add caching"), assistant("Done; one test fails."), user("thanks!"), assistant("You're welcome."), user("now fix the test")];
  const replay = replaySession("s", branch);

  test("the current variant: go-aheads settled without a call, the agent's reply untrusted, 20 s timeout", async () => {
    const fake = fakeJev(() => answers(2));
    const out = await assess(fake.registry, [replay], CURRENT);
    expect(out[0]!.map((a) => a.kind)).toEqual(["jev", "go-ahead", "jev"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.options.timeoutMs).toBe(20_000);
    // Each state is built from the entries before its message.
    expect(fake.calls[0]!.state).toMatchObject({ request: "Add caching", previous_requests: ["(none: this is the first request)"], agent_reply_untrusted: "(none)" });
    expect(fake.calls[1]!.state).toMatchObject({ request: "now fix the test", previous_requests: ["Add caching", "thanks!"], agent_reply_untrusted: "You're welcome." });
    expect(fake.calls[1]!.questions.depth.instructions).toContain("agent_reply_untrusted");
    const first = out[0]![0]!;
    expect(first.kind === "jev" && first.judgment?.need.high).toBeCloseTo(0.75);
  });

  test("countCalls is what assess would call: the same predicate, no Jev, the old variant has no pre-filter", async () => {
    expect(needsJev(CURRENT, { text: "thanks!" })).toBe(false);
    expect(needsJev(OLD, { text: "thanks!" })).toBe(true);
    expect(countCalls([replay], [CURRENT])).toBe(2);
    expect(countCalls([replay], [CURRENT, OLD])).toBe(5);
    const fake = fakeJev(() => answers(2));
    await assess(fake.registry, [replay], CURRENT);
    expect(fake.calls).toHaveLength(countCalls([replay], [CURRENT]));
  });

  test("runVariant counts spend per call and metricsOf flattens the summary", async () => {
    const fake = fakeJev(() => answers(2));
    const result = await runVariant(fake.registry, [replay], CURRENT);
    expect(result.spend.calls).toBe(2);
    const metrics = metricsOf(result.summary);
    expect(metrics).toMatchObject({ sessions: 1, prompts: 3, settledByPrefilter: 1, jevCalls: 2, jevFailures: 0 });
    expect(Object.values(metrics).every((v) => typeof v === "number")).toBe(true);
    expect(metrics.p50).toBeTypeOf("number");
  });

  test("the old variant: every prompt to Jev, `last_outcome` and the old questions", async () => {
    const fake = fakeJev(() => answers(2));
    const out = await assess(fake.registry, [replay], OLD, { timeoutMs: 5_000 });
    expect(out[0]!.map((a) => a.kind)).toEqual(["jev", "jev", "jev"]);
    expect(fake.calls[1]!.state).toMatchObject({ request: "thanks!", last_outcome: "Done; one test fails." });
    expect(fake.calls[1]!.state).not.toHaveProperty("agent_reply_untrusted");
    expect(fake.calls[1]!.questions.depth.instructions).toContain("`last_outcome`");
    expect(fake.calls[0]!.options.timeoutMs).toBe(5_000);
  });

  test("at most `concurrency` calls at a time, results in prompt order, failures kept", async () => {
    let inFlight = 0;
    let most = 0;
    const registry = {
      findOfType: () => ({}),
      classify: async (_m: unknown, context: { state: { request: string } }) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        if (context.state.request === "prompt 7") return { model: "m", stopReason: "error", answers: {}, errorMessage: "boom" };
        return { model: "m", stopReason: "stop", answers: answers(Number(context.state.request.slice(-1)) % 4) };
      },
    };
    const many = replaySession("s", Array.from({ length: 20 }, (_, i) => user(`prompt ${i}`)));
    let progress = 0;
    const out = await assess(registry, [many], CURRENT, { concurrency: 3, progress: (done, total) => (progress = done / total) });
    expect(most).toBe(3);
    expect(progress).toBe(1);
    expect(out[0]).toHaveLength(20);
    const depths = out[0]!.map((a) => (a.kind === "jev" && a.judgment ? Math.round(a.judgment.need.xhigh! * 100) : undefined));
    expect(depths[3]).toBe(70);
    expect(depths[4]).toBe(1);
    expect(out[0]![7]).toEqual({ kind: "jev", outcome: { ok: false, reason: "boom" }, judgment: undefined });
  });
});

describe("the report", () => {
  test("summarize: overrides matched exactly or within a step, the direction of misses, levels, changes, failures", () => {
    const s = session([{ override: "xhigh", live: "high" }, { override: "low" }, {}, { override: "medium", live: "medium" }, {}], "medium");
    const assessed = [jev(3), jev(3), goAhead, failed, jev(0)];
    const steps = walk(s, assessed);
    // xhigh (= xhigh); xhigh held (two above low); the go-ahead and the failure keep low (one below
    // medium); from medium down to low.
    expect(steps.map((x) => x.level)).toEqual(["xhigh", "xhigh", "low", "low", "low"]);
    const sum = summarize([s], [assessed], [steps]);
    expect(sum).toMatchObject({ sessions: 1, prompts: 5, prefiltered: 1, calls: 4, failures: 1, overrides: 3, exact: 1, withinOne: 2, above: 1, below: 1, live: 2, sameAsLive: 0 });
    expect(sum.levels).toEqual({ xhigh: 2, low: 3 });
    expect(sum.latencies).toEqual([100, 100, 100]);
    // medium to xhigh, medium to low.
    expect(sum.changes).toEqual([2]);
  });

  test("sessionLabel", () => {
    expect(sessionLabel({ file: "/s/--a--/2026-10-27T16-12-15-542Z_01a1.jsonl", cwd: "/Users/me/Projects/pi-plugins/" })).toBe("pi-plugins 2026-10-27T16-12");
    expect(sessionLabel({ file: "x.jsonl", cwd: "/a/very-long-project-name-that-goes-on" })).toBe("very-long-project-name-… x.jsonl");
  });

  test("percentile", () => {
    expect(percentile([], 0.5)).toBeUndefined();
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3);
    expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95);
  });

  test("runVariant and report: one row per session and the totals side by side", async () => {
    const fake = fakeJev(() => answers(3));
    const replay = replaySession("/x/--proj--/2026-10-27T16-12-15-542Z_01a1.jsonl", [user("add retries"), assistant("ok"), level("low"), user("yes"), user("redesign the scheduler")], "/work/proj");
    const results = [await runVariant(fake.registry, [replay], CURRENT), await runVariant(fake.registry, [replay], OLD)];
    const text = report(42, [replay], results);
    expect(text).toContain("auto-effort replay: EVAL_SEED=42, 1 sessions");
    expect(text).toMatch(/^proj 2026-10-27T16-12\s+3\s+1\s+1\s+0\s+\d+\s+0\s+0\s+\d+$/mu);
    expect(text).toMatch(/settled by the pre-filter\s+1 \(33%\)\s+0 \(0%\)/u);
    expect(text).toMatch(/Jev calls\s+2\s+3/u);
    expect(text).toMatch(/user overrides\s+1\s+1/u);
    expect(text).toMatch(/^\s+current\s+old$/mu);
    expect(results[0]!.summary.failures).toBe(0);
  });
});
