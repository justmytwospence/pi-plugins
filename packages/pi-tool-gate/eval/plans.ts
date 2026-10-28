// Plans every labeled tool call of sampled sessions as the gate does (eval/sessions.target.ts uses this
// for both its dry run, `npm run -s eval -- --dry sessions`, and its live run). No Jev call is made here.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { BranchDownloads } from "../src/downloads.ts";
import { grantsFile, loadGrants } from "../src/grants.ts";
import { loadFileRules, localGrants } from "../src/permissions.ts";
import { blockedBy, DEFAULT_CONFIG, type GateConfig, judgeStateOf, type Plan, planCall, scriptOfCall } from "../src/index.ts";
import { loadRules } from "../src/rules.ts";
import { branchOf, type Session } from "../../../evals/shared/sessions.ts";

const DOWNLOADED = /, downloaded in this session$/u;

export type Label = "allowed" | "held";

export interface Judged {
  label: Label;
  tool: string;
  args: string;
  rules: string[];
  state: Record<string, unknown>;
  /** The same state without the script, when the call runs one. */
  bare?: Record<string, unknown>;
}

export interface Row {
  n: number;
  allowed: number;
  held: number;
}

export interface Outcomes {
  n: number;
  failed: number;
  holds: number;
  /** Holds on calls the user allowed. */
  extra: number;
  /** Allows on calls the user held. */
  misses: number;
}

export const row = (): Row => ({ n: 0, allowed: 0, held: 0 });
export const outcomes = (): Outcomes => ({ n: 0, failed: 0, holds: 0, extra: 0, misses: 0 });
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
export function collect(sessions: readonly Session[], compare = false) {
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
              ...(script && compare ? { bare: judgeStateOf(before, call) } : {}),
            });
          }
        }
      }
      tracker.add(entry);
    });
  }

  return { walked, stopped, clearAllow, clearHold, toJudge, downloaded, judged };
}

export type Collected = ReturnType<typeof collect>;

/** The Jev calls the replay makes for the planned calls: one per judged call, a second for each script call compared without its content. */
export function countCalls(collected: Pick<Collected, "judged">): number {
  return collected.judged.reduce((n, j) => n + 1 + (j.bare ? 1 : 0), 0);
}
