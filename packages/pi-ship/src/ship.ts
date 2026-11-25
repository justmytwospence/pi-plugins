// /ship: the repository's own publish steps in a fixed order. Nothing here is up to the agent:
// checks, tidy, review, the human gate, publish, then the CI watch.
import { requestDiffReview } from "./diff-review-contract.ts";
import { type Exec, shell, tail } from "./exec.ts";
import { type Ask, dedupe, type Finding, type Lens, LENSES, lensTask, parseFindings, verify } from "./review.ts";
import { githubRepo, parsePushOutput, type PushedRef } from "./push.ts";
import { requestSubagents } from "./subagents-run-contract.ts";
import type { CiConfig, CiWatcher } from "./watcher.ts";

export interface ShipConfig extends Record<string, unknown> {
  check: string;
  publish: string;
  base: string;
  review: { always: boolean; paths: string[]; lenses: string[]; threshold: number; maxFindings: number };
  humanPaths: string[];
  ci: CiConfig;
  system1: { enabled: boolean; provider: string; model: string; timeoutMs: number };
}

export const DEFAULT_CONFIG: ShipConfig = {
  check: "",
  publish: "git push",
  base: "",
  review: { always: false, paths: [], lenses: ["correctness", "security", "tests", "docs"], threshold: 0.6, maxFindings: 20 },
  humanPaths: [],
  ci: { watch: true, ignore: [], maxRounds: 3 },
  system1: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 5_000 },
};

export interface ShipCtx {
  cwd: string;
  hasUI: boolean;
  modelRegistry?: unknown;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
  waitForIdle?(): Promise<void>;
}

export interface ShipDeps {
  exec: Exec;
  events: { emit(channel: string, data: unknown): void };
  watcher: CiWatcher;
  /** Hands a message to the agent's session; `wake` starts a turn. */
  deliver(text: string, wake: boolean): void;
  /** System 1, bound to the session's registry and the configured classifier. */
  ask(ctx: ShipCtx, cfg: ShipConfig): Ask;
}

const CHECK_MS = 30 * 60_000;
const PUBLISH_MS = 60 * 60_000;
const GIT_MS = 60_000;

const globs = (paths: string[]) => paths.map((p) => `:(glob)${p}`);

export function dryRun(cfg: ShipConfig): string {
  const lines = [
    `check: ${cfg.check || "(none)"}`,
    "tidy: git tidy when the range has fixup!, amend! or squash! commits",
    `review: ${cfg.review.always ? "every ship" : cfg.review.paths.length ? `when the range touches ${cfg.review.paths.join(", ")}` : "never (no review.paths)"}; lenses ${cfg.review.lenses.join(", ")}; System 1 threshold ${cfg.review.threshold}`,
    `human gate: findings, and ${cfg.humanPaths.length ? cfg.humanPaths.join(", ") : "no humanPaths"}`,
    `publish: ${cfg.publish}`,
    `watch CI: ${cfg.ci.watch ? `yes (ignoring ${cfg.ci.ignore.join(", ") || "nothing"}; stops waking the agent after ${cfg.ci.maxRounds} red pushes)` : "no"}`,
  ];
  return `/ship would run:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

export async function runShip(deps: ShipDeps, ctx: ShipCtx, cfg: ShipConfig, args: string): Promise<void> {
  const { exec, events } = deps;
  const status = (step: string | undefined) => ctx.ui.setStatus("pi-ship", step ? `ship: ${step}…` : undefined);
  const git = async (cwd: string, ...a: string[]) => exec("git", a, cwd, GIT_MS);
  const out = async (cwd: string, ...a: string[]) => (await git(cwd, ...a)).stdout.trim();
  try {
    if (args.split(/\s+/).includes("--dry")) {
      ctx.ui.notify(dryRun(cfg), "info");
      return;
    }
    await ctx.waitForIdle?.();

    status("base");
    const top = await git(ctx.cwd, "rev-parse", "--show-toplevel");
    if (top.code !== 0) return ctx.ui.notify("/ship: not inside a git repository", "error");
    const root = top.stdout.trim();
    let base = cfg.base;
    if (!base) {
      const upstream = await git(root, "rev-parse", "--abbrev-ref", "@{upstream}");
      if (upstream.code === 0) base = upstream.stdout.trim();
      else if ((await git(root, "rev-parse", "--verify", "origin/HEAD")).code === 0) base = "origin/HEAD";
      else return ctx.ui.notify("/ship: no upstream branch or origin/HEAD; set `base` in .pi/pi-ship.json", "error");
    }
    const mergeBase = await out(root, "merge-base", "HEAD", base);
    if (!mergeBase) return ctx.ui.notify(`/ship: no merge base with ${base}`, "error");
    const range = `${mergeBase}..HEAD`;
    const commits = Number.parseInt(await out(root, "rev-list", "--count", range), 10) || 0;
    if (commits === 0 && cfg.publish === "git push") return ctx.ui.notify("/ship: nothing to publish", "info");
    const dirty = (await out(root, "status", "--porcelain", "--untracked-files=no")).split("\n").filter(Boolean).length;

    if (cfg.check) {
      status("check");
      const r = await shell(exec, cfg.check, root, CHECK_MS);
      if (r.code !== 0) return deps.deliver(`/ship stopped: \`${cfg.check}\` failed (exit ${r.code}).\n\n\`\`\`text\n${tail(r.output, 80)}\n\`\`\``, true);
    }

    status("tidy");
    const subjects = (await out(root, "log", "--format=%s", range)).split("\n");
    if (subjects.some((s) => /^(fixup|amend|squash)! /.test(s))) {
      const r = await shell(exec, `git tidy ${JSON.stringify(base)}`, root, GIT_MS * 5);
      if (r.code !== 0) return deps.deliver(`/ship stopped: \`git tidy\` failed.\n\n\`\`\`text\n${tail(r.output, 40)}\n\`\`\``, false);
    }

    const notes: string[] = [];
    let findings: Finding[] = [];
    let reviewed = "not needed";
    const touched = async (paths: string[]) => (paths.length ? (await out(root, "diff", "--name-only", range, "--", ...globs(paths))).split("\n").filter(Boolean) : []);
    if (cfg.review.always || (await touched(cfg.review.paths)).length) {
      status("review");
      const lenses = cfg.review.lenses.filter((l): l is Lens => l in LENSES);
      const result = requestSubagents(events, { ctx, tasks: lenses.map((lens) => ({ task: lensTask(lens, root, mergeBase, "HEAD"), label: `ship review: ${lens}`, agent: "reviewer", cwd: root })) });
      if (!result) {
        reviewed = "skipped";
        notes.push("review skipped: pi-subagents is not loaded");
      } else {
        const done = await result;
        let all: Finding[] = [];
        for (const run of done.runs) {
          const lens = run.label.replace(/^ship review: /, "");
          if (run.error || run.status !== "done") {
            notes.push(`review ${lens}: ${run.error ?? run.status}`);
            continue;
          }
          const parsed = parseFindings(run.output, lens);
          if (parsed.error) notes.push(`review ${parsed.error}`);
          all = all.concat(parsed.findings);
        }
        const unique = dedupe(all);
        status("verify");
        findings = cfg.system1.enabled
          ? await verify(unique, async (path) => (await out(root, "diff", "-U20", range, "--", path)).slice(0, 6_000), deps.ask(ctx, cfg), cfg.review.threshold, cfg.review.maxFindings)
          : unique.slice(0, cfg.review.maxFindings).map((f) => ({ ...f, unverified: true }));
        reviewed = `${findings.length} finding${findings.length === 1 ? "" : "s"}`;
      }
    }

    const human = await touched(cfg.humanPaths);
    if (findings.length || human.length) {
      status("review gate");
      let fallback = findings.map((f) => `${f.path}:${f.line} ${f.title}`);
      if (findings.length) {
        const comments = findings.map((f) => ({ path: f.path, line: f.line, body: `[ship · ${f.lens} · ${f.severity}${f.unverified ? ", unverified" : ""}] ${f.title}\n\n${f.body}` }));
        const review = requestDiffReview(events, { ctx, scope: mergeBase, comments });
        if (review) {
          fallback = [];
          const r = await review;
          if (r.sent > 0) return deps.deliver(`/ship paused: ${r.sent} review comment${r.sent === 1 ? "" : "s"} went to the agent. Run /ship again after the fixes.`, false);
        }
      }
      if (!ctx.hasUI) return deps.deliver("/ship stopped: it needs your confirmation (findings or files that need your review) and there is no UI.", false);
      const lines = [`${findings.length} finding${findings.length === 1 ? "" : "s"}`, human.length ? `files that need your review: ${human.join(", ")} (/diff shows them)` : "", ...fallback].filter(Boolean);
      status(undefined);
      if (!(await ctx.ui.confirm("Publish?", lines.join("\n")))) return ctx.ui.notify("/ship cancelled", "info");
    }

    status("publish");
    const published = await shell(exec, cfg.publish, root, PUBLISH_MS);
    if (published.code !== 0) return deps.deliver(`/ship stopped: \`${cfg.publish}\` failed (exit ${published.code}).\n\n\`\`\`text\n${tail(published.output, 40)}\n\`\`\``, false);
    let refs: PushedRef[] = parsePushOutput(published.output);
    if (!refs.length) {
      const repo = githubRepo(await out(root, "remote", "get-url", "origin"));
      const head = await out(root, "rev-parse", "HEAD");
      const branch = await out(root, "branch", "--show-current");
      if (repo && head && branch) refs = [{ repo, oldSha: mergeBase, newSha: head, branch, forced: false }];
    }
    let watching = "CI not watched";
    if (cfg.ci.watch && refs.length) {
      for (const ref of refs) void deps.watcher.watch(ref, cfg.ci, root);
      watching = "watching CI";
    }
    const summary = `Shipped ${commits} commit${commits === 1 ? "" : "s"} (${range.slice(0, 7)}..HEAD): ${cfg.check ? "check ✓" : "no check"}, review ${reviewed}, published with \`${cfg.publish}\`, ${watching}.`;
    deps.deliver([summary, ...notes.map((n) => `- ${n}`), dirty ? `${dirty} uncommitted file${dirty === 1 ? " was" : "s were"} not part of this ship.` : ""].filter(Boolean).join("\n"), false);
  } finally {
    status(undefined);
  }
}
