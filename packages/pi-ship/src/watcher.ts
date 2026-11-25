// Following one pushed commit's GitHub Actions runs until they finish, and handing the outcome on:
// nothing for green, a fixed message with the failing logs and the revert range for red.
import type { Exec } from "./exec.ts";
import { failedLog, listRuns, resolveSha, type RunInfo } from "./github.ts";
import type { PushedRef } from "./push.ts";

export interface CiConfig {
  watch: boolean;
  /** Workflow names that never count (deploys, releases). */
  ignore: string[];
  /** After this many red pushes in a row on a branch the agent is no longer woken. */
  maxRounds: number;
}

export type WatchStatus = "running" | "done" | "failed" | "stopped";

export interface Watch {
  key: string;
  repo: string;
  branch: string;
  sha: string;
  label: string;
  status: WatchStatus;
  detail: string;
  startedAt: number;
  endedAt?: number;
  urls: string[];
}

export interface WatcherDeps {
  exec: Exec;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** The suite's event bus. */
  emit(channel: string, data: unknown): void;
  /** Hands text to the agent: `wake` starts a turn. `id` is the `bg:external` id that may consume it. */
  deliver(id: string, text: string, wake: boolean): void;
  /** Something shown changed. */
  changed(): void;
}

const APPEAR_EVERY_MS = 15_000;
const APPEAR_FOR_MS = 180_000;
const FOLLOW_EVERY_MS = 30_000;
const FOLLOW_FOR_MS = 90 * 60_000;
const KEEP_MS = 30 * 60_000;
const RED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

const sha7 = (s: string) => s.slice(0, 7);

interface Live {
  watch: Watch;
  ref: PushedRef;
  stopped: boolean;
  timer?: unknown;
  wake?: () => void;
}

export class CiWatcher {
  private readonly lives = new Map<string, Live>();
  private readonly red = new Map<string, number>();
  private readonly done: Watch[] = [];

  constructor(private readonly deps: WatcherDeps) {}

  /** Starts following a pushed ref; resolves when the watch has ended. */
  async watch(ref: PushedRef, cfg: CiConfig, cwd: string): Promise<void> {
    const group = `${ref.repo}@${ref.branch}`;
    const previous = this.lives.get(group);
    const sha = await this.fullSha(ref, cwd);
    const watch: Watch = { key: `ci:${sha ? sha7(sha) : sha7(ref.newSha)}`, repo: ref.repo, branch: ref.branch, sha: sha ?? ref.newSha, label: `CI ${ref.branch}`, status: "running", detail: "waiting for runs", startedAt: this.deps.now(), urls: [] };
    if (previous) this.end(previous, "stopped", `superseded by ${watch.key.slice(3)}`);
    const live: Live = { watch, ref, stopped: false };
    this.lives.set(group, live);
    this.deps.emit("bg:external", { id: watch.key, label: watch.label, state: "running", summary: watch.detail });
    this.deps.changed();
    if (!sha) {
      this.end(live, "failed", `could not resolve ${ref.newSha} on GitHub`);
      return;
    }
    try {
      await this.follow(live, cfg, cwd);
    } catch (error) {
      if (!live.stopped) this.end(live, "failed", `watching failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stops following one watch (never a GitHub run). */
  stop(key: string): void {
    for (const live of this.lives.values()) if (live.watch.key === key) this.end(live, "stopped", "stopped");
  }

  /** Running watches, then ended ones from the last 30 minutes. */
  entries(now: number): Watch[] {
    const running = [...this.lives.values()].map((l) => l.watch);
    const ended = this.done.filter((w) => now - (w.endedAt ?? 0) <= KEEP_MS).reverse();
    return [...running, ...ended];
  }

  dispose(): void {
    for (const live of [...this.lives.values()]) this.end(live, "stopped", "session ended", false);
  }

  private async fullSha(ref: PushedRef, cwd: string): Promise<string | undefined> {
    let name = ref.newSha;
    if (!/^[0-9a-f]{7,40}$/.test(name)) {
      const local = await this.deps.exec("git", ["rev-parse", name], cwd, 10_000).catch(() => undefined);
      if (!local || local.code !== 0) return undefined;
      name = local.stdout.trim();
    }
    return /^[0-9a-f]{40}$/.test(name) ? name : resolveSha(this.deps.exec, cwd, ref.repo, name);
  }

  private sleep(live: Live, ms: number): Promise<void> {
    return new Promise((resolve) => {
      live.wake = resolve;
      live.timer = this.deps.setTimeout(resolve, ms);
    });
  }

  private end(live: Live, status: WatchStatus, detail: string, notify = true): void {
    if (live.stopped) return;
    live.stopped = true;
    if (live.timer !== undefined) this.deps.clearTimeout(live.timer);
    live.wake?.();
    const w = live.watch;
    w.status = status;
    w.detail = detail;
    w.endedAt = this.deps.now();
    const group = `${live.ref.repo}@${live.ref.branch}`;
    if (this.lives.get(group) === live) this.lives.delete(group);
    this.done.push(w);
    if (this.done.length > 20) this.done.shift();
    if (notify) {
      this.deps.emit("bg:external", { id: w.key, label: w.label, state: status === "failed" ? "failed" : "done", summary: detail });
      this.deps.changed();
    }
  }

  private async follow(live: Live, cfg: CiConfig, cwd: string): Promise<void> {
    const { exec } = this.deps;
    const w = live.watch;
    const visible = async (): Promise<RunInfo[]> => (await listRuns(exec, cwd, w.repo, w.sha)).filter((r) => !cfg.ignore.includes(r.workflowName));
    let runs: RunInfo[] = [];
    for (const start = this.deps.now(); ; ) {
      runs = await visible();
      if (live.stopped) return;
      if (runs.length) break;
      if (this.deps.now() - start >= APPEAR_FOR_MS) return this.end(live, "done", "no CI runs");
      await this.sleep(live, APPEAR_EVERY_MS);
      if (live.stopped) return;
    }
    w.detail = `${runs.length} run${runs.length === 1 ? "" : "s"}`;
    this.deps.changed();
    let confirmed = -1;
    for (const start = this.deps.now(); ; ) {
      w.urls = runs.map((r) => r.url);
      if (runs.every((r) => r.status === "completed")) {
        // Workflows can start a little after the first ones finish: one more look at the same set.
        if (confirmed === runs.length) break;
        confirmed = runs.length;
        await this.sleep(live, APPEAR_EVERY_MS);
      } else {
        confirmed = -1;
        if (this.deps.now() - start >= FOLLOW_FOR_MS) return this.end(live, "failed", `CI still running after 90 min: ${w.urls.join(" ")}`);
        w.detail = `${runs.filter((r) => r.status === "completed").length}/${runs.length} runs done`;
        this.deps.changed();
        await this.sleep(live, FOLLOW_EVERY_MS);
      }
      if (live.stopped) return;
      runs = await visible();
      if (live.stopped) return;
    }
    const group = `${w.repo}@${w.branch}`;
    const failed = runs.filter((r) => RED.has(r.conclusion));
    if (!failed.length) {
      this.red.delete(group);
      return this.end(live, "done", `green: ${runs.length} run${runs.length === 1 ? "" : "s"}`);
    }
    const rounds = (this.red.get(group) ?? 0) + 1;
    this.red.set(group, rounds);
    const sections: string[] = [];
    for (const r of failed.slice(0, 3)) {
      const log = await failedLog(exec, cwd, w.repo, r.databaseId);
      if (live.stopped) return;
      sections.push(`### ${r.workflowName}: ${r.conclusion} (${r.url})\n${log ? `\`\`\`text\n${log}\n\`\`\`` : "(no failed-step log available)"}`);
    }
    if (failed.length > 3) sections.push(`(${failed.length - 3} more failed runs: ${failed.slice(3).map((r) => r.url).join(" ")})`);
    const { oldSha, forced } = live.ref;
    const undo = oldSha && !forced ? `Undo this push: \`git revert --no-edit ${oldSha}..${sha7(w.sha)}\`\n\n` : "";
    const wake = rounds < cfg.maxRounds;
    const last = wake
      ? "Fix the cause and push again; pi-ship watches the new push."
      : `CI has failed ${rounds} pushes in a row on ${w.branch}; pi-ship stops waking the agent for this branch until CI is green. Ask the user how to proceed.`;
    const text = `CI failed for ${w.branch} ${sha7(w.sha)} in ${w.repo}: ${failed.length} of ${runs.length} runs.\n\n${sections.join("\n\n")}\n\n${undo}${last}`;
    this.end(live, "failed", `${failed.length} of ${runs.length} runs failed`, false);
    this.deps.emit("bg:external", { id: w.key, label: w.label, state: "failed", summary: w.detail, result: text });
    this.deps.deliver(w.key, text, wake);
    this.deps.changed();
  }
}
