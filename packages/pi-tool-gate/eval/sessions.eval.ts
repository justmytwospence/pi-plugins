// Real Pi sessions replayed through the gate, with live Jev: `npm run eval -- eval/sessions.eval.ts`.
// Paid: one Jev request per call the gate would judge (two for a call that runs a script, with
// EVAL_COMPARE=1). Samples recent sessions with eval/sessions.ts (EVAL_RECENT, EVAL_SAMPLE, EVAL_SEED,
// EVAL_MIN_PROMPTS, EVAL_MIN_TOOLS; the seed is printed), walks each current branch's tool calls in
// order, plans each one as the gate does in auto mode (`planCall`: clear allows, always-held calls,
// the directory policy, the judge) with this machine's settings, rules and project grants, and asks
// Jev about the judged ones with the conversation as it stood when the call was made.
//
// Labels come from each call's result: a call whose result is not a tool-gate block ran, so it
// counts as allowed; one the user blocked (Block, Block with a message) counts as held. Calls the
// gate stopped on its own (a push-back, chat or plan mode) are not labeled. A hold on an allowed
// call is an extra prompt; an allow on a held call is a miss. Script content is read from disk now,
// not as it was then.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.ts";
import { BranchDownloads } from "../src/downloads.ts";
import { grantsFile, loadGrants } from "../src/grants.ts";
import { loadFileRules, localGrants } from "../src/permissions.ts";
import { blockedBy, DEFAULT_CONFIG, type GateConfig, judgeStateOf, type Plan, planCall, scriptOfCall } from "../src/index.ts";
import { askJev } from "../src/jev.ts";
import { judgeQuestions, verdict } from "../src/judge.ts";
import { loadRules } from "../src/rules.ts";
import { hasCredentials, installedRegistry } from "./registry.ts";
import { branchOf, type Session, sampleSessions } from "./sessions.ts";

const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;
const COMPARE = process.env.EVAL_COMPARE === "1";
const DOWNLOADED = /, downloaded in this session$/u;

type Label = "allowed" | "held";

interface Judged {
  label: Label;
  tool: string;
  args: string;
  rules: string[];
  state: Record<string, unknown>;
  /** The same state without the script, when the call runs one. */
  bare?: Record<string, unknown>;
}

interface Row {
  n: number;
  allowed: number;
  held: number;
}

interface Outcomes {
  n: number;
  failed: number;
  holds: number;
  /** Holds on calls the user allowed. */
  extra: number;
  /** Allows on calls the user held. */
  misses: number;
}

const row = (): Row => ({ n: 0, allowed: 0, held: 0 });
const outcomes = (): Outcomes => ({ n: 0, failed: 0, holds: 0, extra: 0, misses: 0 });
const count = (r: Row, label: Label | undefined) => {
  r.n++;
  if (label) r[label]++;
};

/** The project's checkouts as the gate finds them: the git checkout and, for a worktree, its main one. */
function projectsOf(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    const [top, common] = out.split("\n").map((l) => l.trim());
    if (!top) return [path.resolve(cwd)];
    const main = common && path.basename(common) === ".git" ? path.dirname(common) : undefined;
    return main && main !== top ? [top, main] : [top];
  } catch {
    return [path.resolve(cwd)];
  }
}

interface Message {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  isError?: boolean;
}

/** Every labeled tool call of the sessions, planned as the gate does; the judged ones with their state. */
export function collect(sessions: readonly Session[]) {
  const walked = row();
  const stopped = { n: 0 };
  const clearAllow = row();
  const clearHold = row();
  const toJudge = row();
  const downloaded = { holds: row(), added: row() };
  const judged: Judged[] = [];

  for (const session of sessions) {
    const branch = branchOf(session.entries);
    const cwd = session.cwd;
    const config = loadConfig("tool-gate", DEFAULT_CONFIG, cwd) as GateConfig;
    const projects = projectsOf(cwd);
    const saved = loadGrants(projects[projects.length - 1] ?? cwd);
    const grants = new Set(saved.map((g) => g.key));
    // The rules in force on this machine: this project's saved ones and the config files'.
    const permissions = [...localGrants(saved, grantsFile()).rules, ...loadFileRules(cwd).rules];
    const rules = loadRules(cwd);
    const results = new Map<string, Message>();
    for (const entry of branch) {
      const m = entry.type === "message" ? (entry.message as Message | undefined) : undefined;
      if (m?.role === "toolResult" && typeof m.toolCallId === "string") results.set(m.toolCallId, m);
    }
    const tracker = new BranchDownloads(cwd);
    branch.forEach((entry, i) => {
      const m = entry.type === "message" ? (entry.message as Message | undefined) : undefined;
      if (m?.role === "assistant" && Array.isArray(m.content)) {
        // The conversation as it stood when the calls were made: up to the message that made them.
        const before = branch.slice(0, i + 1);
        for (const block of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
          if (block?.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
          const result = results.get(block.id);
          if (!result) continue;
          const who = blockedBy(result);
          if (who === "gate") {
            stopped.n++;
            continue;
          }
          const label: Label = who === "user" ? "held" : "allowed";
          count(walked, label);
          const tool = block.name;
          const input = (block.arguments ?? {}) as Record<string, unknown>;
          const context = { config, projects, granted: (key: string) => grants.has(key), rules: permissions, root: projects[0] };
          const p: Plan = planCall(tool, input, cwd, { ...context, downloads: tracker.downloads });
          if (p.kind === "allow") count(clearAllow, label);
          else if (p.kind === "deny") count(clearHold, label);
          else if (p.kind === "ask") {
            count(clearHold, label);
            if (p.reasons.some((r) => DOWNLOADED.test(r))) {
              count(downloaded.holds, label);
              if (planCall(tool, input, cwd, context).kind !== "ask") count(downloaded.added, label);
            }
          } else {
            count(toJudge, label);
            const script = scriptOfCall(tool, input, cwd, tracker.downloads);
            const call = { cwd, tool, args: p.args, rules };
            judged.push({
              label,
              tool,
              args: p.args,
              rules,
              state: judgeStateOf(before, { ...call, script }),
              ...(script && COMPARE ? { bare: judgeStateOf(before, call) } : {}),
            });
          }
        }
      }
      tracker.add(entry);
    });
  }

  return { walked, stopped, clearAllow, clearHold, toJudge, downloaded, judged };
}

describe.skipIf(!hasCredentials)("tool-gate on real sessions", () => {
  let registry: unknown;
  beforeAll(async () => {
    registry = await installedRegistry();
  });

  test("replay", async () => {
    const { seed, sessions } = sampleSessions();
    const { walked, stopped, clearAllow, clearHold, toJudge, downloaded, judged } = collect(sessions);

    const all = outcomes();
    const withScript = outcomes();
    const withoutContent = outcomes();
    const lines: string[] = [];
    const judge = async (j: Judged, state: Record<string, unknown>, script: boolean, into: Outcomes[]) => {
      const outcome = await askJev(registry, { ...DEFAULT_CONFIG.jev, timeoutMs: TIMEOUT_MS }, state, judgeQuestions(j.rules, { script }));
      for (const o of into) o.n++;
      if (!outcome.ok) {
        for (const o of into) o.failed++;
        return undefined;
      }
      const v = verdict(outcome.answers, j.rules, DEFAULT_CONFIG.thresholds);
      const hold = Boolean(v && !v.allow);
      for (const o of into) {
        if (hold) o.holds++;
        if (hold && j.label === "allowed") o.extra++;
        if (!hold && j.label === "held") o.misses++;
      }
      return { hold, v };
    };
    let next = 0;
    const one = async (j: Judged) => {
      const hasScript = j.state.script !== undefined;
      const got = await judge(j, j.state, hasScript, hasScript ? [all, withScript] : [all]);
      if (j.bare) await judge(j, j.bare, false, [withoutContent]);
      if (got && got.hold !== (j.label === "held")) {
        const kind = got.hold ? "EXTRA" : "MISS ";
        const shown = `${j.tool} ${j.args.replace(/\s+/gu, " ").slice(0, 100)}`;
        lines.push(`${kind} ${hasScript ? "[script] " : ""}${shown}\n       ${got.v?.failures.join("; ") ?? ""}`);
      }
    };
    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        while (next < judged.length) await one(judged[next++] as Judged);
      }),
    );

    const table = (header: string[], rows: (string | number)[][]) => {
      const cells = [header, ...rows.map((r) => r.map(String))];
      const widths = header.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
      return cells.map((r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i] as number) : c.padStart(widths[i] as number))).join("  ").trimEnd()).join("\n");
    };
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "-");
    const plans = table(
      ["calls (EVAL_SEED=" + seed + ")", "n", "user allowed", "user held"],
      [
        ["walked", walked.n, walked.allowed, walked.held],
        ["  clear allow", clearAllow.n, clearAllow.allowed, clearAllow.held],
        ["  clear hold", clearHold.n, clearHold.allowed, clearHold.held],
        ["    downloaded code", downloaded.holds.n, downloaded.holds.allowed, downloaded.holds.held],
        ["    of those, new holds", downloaded.added.n, downloaded.added.allowed, downloaded.added.held],
        ["  judged", toJudge.n, toJudge.allowed, toJudge.held],
        ["stopped by the gate itself", stopped.n, "", ""],
      ],
    );
    const jev = table(
      ["Jev", "n", "failed", "holds", "extra prompts", "misses"],
      [
        ["judged calls", all.n, all.failed, all.holds, `${all.extra} (${pct(all.extra, toJudge.allowed)})`, `${all.misses} (${pct(all.misses, toJudge.held)})`],
        ["  running a script", withScript.n, withScript.failed, withScript.holds, withScript.extra, withScript.misses],
        ...(COMPARE ? [["  same, without its content", withoutContent.n, withoutContent.failed, withoutContent.holds, withoutContent.extra, withoutContent.misses]] : []),
      ],
    );
    // The disagreements, at most 25 of each kind.
    const shown = ["EXTRA", "MISS "].flatMap((kind) => {
      const of = lines.filter((l) => l.startsWith(kind)).sort();
      return of.length > 25 ? [...of.slice(0, 25), `${kind.trim()}: ${of.length - 25} more`] : of;
    });
    console.log(`${sessions.length} sessions\n\n${plans}\n\n${jev}${shown.length ? `\n\n${shown.join("\n")}` : ""}`);
    expect(all.failed).toBeLessThan(Math.max(1, all.n * 0.2));
  }, 3_600_000);
});
