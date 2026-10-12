// Package-local producer for the suite's activity hosts. No sibling is required.
import type { ActivityEntry, ActivityPill, ActivitySection } from "./activity.js";
import type { PlannerAgent } from "./planner/agent.js";
import type { SubagentView } from "./subagent-progress.js";

export const PLAN_SOURCE_ID = "plan";

export interface PlannerActivityDeps {
  agents(): readonly PlannerAgent[];
  runId(): string | undefined;
  task(): string;
  open(ui: unknown): Promise<void>;
  stop(agent: PlannerAgent): void | Promise<void>;
  changed(): void;
  now?(): number;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h ? `${h}h${String(m % 60).padStart(2, "0")}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}

function tokens(n: number): string {
  return n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
      : String(n);
}

export const plannerKey = (runId: string, agent: PlannerAgent) => `${runId}:planner:${agent.id}`;
export const scoutKey = (runId: string, scout: SubagentView) => `${runId}:scout:${scout.id}`;

function plannerStatus(agent: PlannerAgent): ActivityEntry["status"] {
  if (agent.working) return "running";
  if (agent.status === "failed") return "failed";
  if (agent.status === "stopped") return "stopped";
  return "done";
}

function scoutStatus(scout: SubagentView): ActivityEntry["status"] {
  const state = scout.stats.state;
  if (state === "starting" || state === "running") return "running";
  if (state === "done") return "done";
  if (state === "cancelled") return "stopped";
  return "failed";
}

export class PlannerActivity {
  section: ActivitySection;
  private readonly hosts = new Set<string>();
  private readonly dismissed = new Set<string>();
  private readonly subscriptions = new Map<PlannerAgent, () => void>();
  private seenAt = 0;
  private lastKey = "";
  private generation = 0;
  private active = true;

  constructor(private readonly deps: PlannerActivityDeps) {
    this.section = this.createSection();
  }

  private createSection(): ActivitySection {
    const generation = this.generation;
    const current = () => this.active && generation === this.generation;
    return {
      id: PLAN_SOURCE_ID,
      title: "planners",
      noun: "planner",
      entries: (now) => (current() ? this.entries(now) : []),
      open: async (key, ui) => {
        if (current() && this.entries(this.now()).some((row) => row.key === key)) await this.deps.open(ui);
      },
      stop: (key) => {
        if (!current()) return;
        const agent = this.agentFor(key);
        if (agent?.working) return this.deps.stop(agent);
      },
      canStop: (key) => current() && Boolean(this.agentFor(key)?.working),
      dismiss: (key) => {
        if (!current() || !this.entries(this.now()).some((row) => row.key === key && row.status !== "running")) return;
        this.dismissed.add(key);
        this.refresh();
      },
      pill: (now) => (current() ? this.pill(now) : undefined),
      openDialog: async (ui) => {
        if (current()) await this.deps.open(ui);
      },
      setHosted: (on, host) => {
        if (!current()) return;
        if (on) this.hosts.add(host ?? "subagents");
        else this.hosts.delete(host ?? "subagents");
      },
    };
  }

  get available(): boolean {
    return this.active;
  }

  get hosted(): boolean {
    return this.hosts.size > 0;
  }

  resetHosts(): void {
    this.hosts.clear();
  }

  seen(now = this.now()): void {
    if (!this.active) return;
    this.seenAt = now;
    this.refresh();
  }

  /** Retained host references cannot act on a new branch/runtime, even with the same run id. */
  reset(): void {
    this.dispose();
    this.active = true;
    this.dismissed.clear();
    this.seenAt = 0;
    this.lastKey = "";
    this.section = this.createSection();
    this.refresh();
  }

  dispose(): void {
    this.active = false;
    this.generation++;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.resetHosts();
  }

  /** Subscribe to every planner (scout progress comes through the same change stream). */
  refresh(): void {
    if (!this.active) return;
    const agents = this.deps.agents();
    for (const [agent, unsubscribe] of this.subscriptions) {
      if (agents.includes(agent)) continue;
      unsubscribe();
      this.subscriptions.delete(agent);
    }
    const runId = this.deps.runId();
    for (const agent of agents) {
      if (runId && agent.working) this.dismissed.delete(plannerKey(runId, agent));
      if (!this.subscriptions.has(agent))
        this.subscriptions.set(
          agent,
          agent.subscribe(() => this.refresh()),
        );
    }
    // Use a fixed time: clock ticks are drawn by the host, while stats/progress changes notify it.
    const key = JSON.stringify([this.entries(0), this.pill(0)]);
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.deps.changed();
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private agentFor(key: string): PlannerAgent | undefined {
    const id = this.deps.runId();
    return id ? this.deps.agents().find((a) => plannerKey(id, a) === key) : undefined;
  }

  entries(now: number): ActivityEntry[] {
    const id = this.deps.runId();
    if (!this.active || !id) return [];
    const task = this.deps.task().split("\n")[0]?.trim() ?? "";
    const rows: ActivityEntry[] = [];
    for (const agent of this.deps.agents()) {
      const key = plannerKey(id, agent);
      const status = plannerStatus(agent);
      const endedAt = status === "running" ? undefined : (agent.stats.endedAt ?? agent.stats.startedAt);
      if (!this.dismissed.has(key)) {
        const what =
          status === "running"
            ? agent.status === "asking"
              ? "asking you"
              : (agent.stats.lastActivity ?? "working")
            : agent.plan
              ? `plan${agent.revision > 1 ? ` v${agent.revision}` : ""} ready`
              : agent.status;
        rows.push({
          key,
          stopToken: agent.stopToken,
          label: `Planner ${agent.id}`,
          detail: `${agent.name}${task ? ` · ${task}` : ""}`,
          status,
          stats: `${what} · ${elapsed((endedAt ?? now) - agent.stats.startedAt)} · ↓ ${tokens(agent.stats.totalTokens)} tokens`,
          startedAt: agent.stats.startedAt,
          ...(endedAt !== undefined ? { endedAt } : {}),
        });
      }
      for (const scout of agent.subagents.agents) {
        const key = scoutKey(id, scout);
        if (this.dismissed.has(key)) continue;
        const status = scoutStatus(scout);
        const endedAt = status === "running" ? undefined : (scout.stats.endedAt ?? scout.stats.startedAt);
        rows.push({
          key,
          label: `Scout ${scout.id}`,
          detail: `${scout.label} · ${scout.model}`,
          status,
          stats: `${status === "running" ? (scout.stats.lastActivity ?? "starting") : scout.stats.state} · ${elapsed((endedAt ?? now) - scout.stats.startedAt)} · ↓ ${tokens(scout.stats.totalTokens)} tokens`,
          startedAt: scout.stats.startedAt,
          ...(endedAt !== undefined ? { endedAt } : {}),
        });
      }
    }
    return rows;
  }

  pill(_now: number): ActivityPill | undefined {
    const id = this.deps.runId();
    if (!this.active || !id) return undefined;
    const rows = this.entries(0);
    const working = this.deps.agents().filter((a) => a.working).length;
    const failed = rows.filter((row) => row.status === "failed" && (row.endedAt ?? row.startedAt) > this.seenAt).length;
    if (!working && !failed) return undefined;
    return {
      label: working ? `${working} planner${working === 1 ? "" : "s"}` : "planners",
      ...(failed ? { alert: `${failed} failed` } : {}),
    };
  }
}
