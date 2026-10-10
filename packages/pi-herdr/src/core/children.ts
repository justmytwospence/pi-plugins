// Shared verbatim by pi-herdr and opencode-herdr (src/core).
//
// Herdr children: interactive agent sessions (pi children for pi, opencode children for opencode)
// that this session starts in a herdr tab, a split beside it, or a new worktree's space, gives a
// task, and hears back from. Unlike a subagent (headless, living for one call), a child is an
// ordinary interactive session in its own pane: you can watch it, type to it, take it over, and it
// outlives this session's turn.
//
// The parent prompts the child through herdr (`agent.prompt`), then watches herdr's semantic state
// for that pane. When a turn the parent asked for settles (idle/done after it was seen working, or
// a new `completion_seq`), the host reads the reply from the child's session, which herdr's
// integration for that agent reports (a pi session file, an opencode session id). Turns the user
// starts in the child's pane are not sent back.
import { type Call, errorText, splitDirection } from "./herdr.ts";

export type Where = "tab" | "split" | "worktree";

export interface ChildRecord {
  name: string;
  paneId: string;
  where: Where;
  cwd: string;
  branch?: string;
  workspaceId?: string;
  model?: string;
  thinking?: string;
  task: string;
  createdAt: number;
  /** A turn the parent asked for is still running. */
  awaiting: boolean;
  /** herdr's sequence numbers when that turn was asked for. */
  baseline?: { completionSeq?: number; stateSeq?: number };
  sawWorking?: boolean;
  /** The child's session as herdr reports it: a pi session path, an opencode session id. */
  session?: string;
  closed?: boolean;
}

/** What differs between hosts: which agent herdr starts, how, and how its reply is read. */
export interface ChildAgent {
  /** herdr's agent kind (`agent.start`), also the session kind: "pi", "opencode". */
  kind: string;
  /** Command-line arguments for the child, after herdr's canonical executable. */
  args(opts: SpawnOptions, name: string): string[];
  /** The child's last reply, read from its session, or undefined. */
  reply(rec: ChildRecord): Promise<string | undefined>;
}

export interface Exec {
  (cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ChildrenDeps {
  call: Call;
  agent: ChildAgent;
  /** This session's own pane. */
  selfPane: string;
  exec: Exec;
  /** Save the record (a session entry), so the list survives a restart. */
  persist(rec: ChildRecord): void;
  /** A reply (or a notice that none will come) for the parent. */
  deliver(rec: ChildRecord, text: string, reply: string | undefined): void;
  /** Hold or release `herdr:background` for an awaited child. */
  hold(rec: ChildRecord, active: boolean): void;
  pollMs?: number;
  readyPollMs?: number;
}

export interface SpawnOptions {
  task: string;
  name?: string;
  where?: Where;
  branch?: string;
  model?: string;
  thinking?: string;
  focus?: boolean;
  cwd: string;
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/u;
const STOP_WORDS = new Set(["a", "an", "the", "and", "or", "to", "of", "in", "on", "for", "with", "please", "this", "that", "it", "is"]);

/** A herdr agent name from a label or task: lowercase words joined by dashes, at most 24 characters. */
export function slugName(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/gu, " ")
    .split(/[\s-]+/u)
    .filter((w) => w && !STOP_WORDS.has(w));
  let out = "";
  for (const w of words) {
    const next = out ? `${out}-${w}` : w;
    if (next.length > 24) break;
    out = next;
    if (out.split("-").length >= 3) break;
  }
  if (!out) out = "child";
  if (!/^[a-z]/u.test(out)) out = `c-${out}`;
  return out.slice(0, 24);
}

export function childPreamble(kind: string, parentPane: string, rec: Pick<ChildRecord, "where" | "branch" | "cwd">): string {
  const lines = [
    `[You are a child ${kind} session. Another ${kind} session (herdr pane ${parentPane}) started you and gave you the task below. Your final reply to each of its messages is sent back to it, so end each turn with a self-contained answer: what you did, what you found, and what is left. The user can also talk to you directly in this pane.`,
  ];
  if (rec.where === "worktree" && rec.branch) lines.push(`You are in a git worktree of your own (${rec.cwd}) on branch ${rec.branch}: work and commit there.`);
  return `${lines.join(" ")}]\n\n`;
}

interface AgentInfo {
  name?: string;
  agent?: string;
  agent_status?: string;
  completion_seq?: number;
  state_change_seq?: number;
  agent_session?: { kind?: string; value?: string };
  pane_id?: string;
}

export class Children {
  readonly records = new Map<string, ChildRecord>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  private readonly deps: ChildrenDeps;

  constructor(deps: ChildrenDeps) {
    this.deps = deps;
  }

  restore(records: Iterable<ChildRecord>): void {
    for (const rec of records) this.records.set(rec.name, { ...rec });
    for (const rec of this.records.values()) if (rec.awaiting && !rec.closed) this.deps.hold(rec, true);
    this.ensureLoop();
  }

  get(name: string): ChildRecord {
    const rec = this.records.get(name);
    if (!rec) {
      const known = [...this.records.keys()];
      throw new Error(`No child "${name}".${known.length ? ` Children: ${known.join(", ")}.` : " This session has started none."}`);
    }
    return rec;
  }

  private save(rec: ChildRecord): void {
    this.records.set(rec.name, rec);
    this.deps.persist({ ...rec });
  }

  private async liveNames(): Promise<Set<string>> {
    const r = await this.deps.call<{ agents?: AgentInfo[] }>("agent.list", {});
    return new Set((r.result?.agents ?? []).map((a) => a.name).filter((n): n is string => !!n));
  }

  async uniqueName(wanted: string): Promise<string> {
    const base = NAME_RE.test(wanted) && wanted.length <= 28 ? wanted : slugName(wanted);
    const taken = await this.liveNames();
    for (const rec of this.records.values()) if (!rec.closed) taken.add(rec.name);
    if (!taken.has(base)) return base;
    for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  }

  private async worktreePane(opts: SpawnOptions, name: string): Promise<{ paneId: string; workspaceId?: string; cwd: string }> {
    const { exec, call } = this.deps;
    if (!opts.branch) throw new Error("where=worktree needs `branch`.");
    const made = await exec("worktree", ["new", opts.branch, "--no-open"], opts.cwd);
    if (made.code !== 0) throw new Error(`worktree new failed: ${(made.stderr || made.stdout).trim()}`);
    const p = await exec("worktree", ["path", opts.branch], opts.cwd);
    const path = p.stdout.trim().split("\n").pop()?.trim();
    if (p.code !== 0 || !path) throw new Error(`worktree path failed: ${(p.stderr || p.stdout).trim()}`);
    const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts.cwd);
    const root = common.code === 0 ? common.stdout.trim().replace(/\/\.git\/?$/u, "") : opts.cwd;
    const open = await call("worktree.open", { cwd: root, path, focus: !!opts.focus }, 15_000);
    if (open.error) throw new Error(`herdr could not open the worktree: ${errorText(open)}`);
    const workspaceId: string | undefined = open.result?.workspace?.workspace_id;
    if (!open.result?.already_open && open.result?.root_pane?.pane_id) return { paneId: open.result.root_pane.pane_id, workspaceId, cwd: path };
    // Already open (someone works there): the child gets a tab of its own in that space.
    const tab = await call("tab.create", { workspace_id: workspaceId, cwd: path, label: name, focus: !!opts.focus });
    if (!tab.result?.root_pane?.pane_id) throw new Error(`herdr could not add a tab to the worktree's space: ${errorText(tab)}`);
    return { paneId: tab.result.root_pane.pane_id, workspaceId, cwd: path };
  }

  async spawn(opts: SpawnOptions): Promise<ChildRecord> {
    const { call, selfPane } = this.deps;
    const where = opts.where ?? "tab";
    const name = await this.uniqueName(opts.name?.trim() || opts.task);
    const self = await call("pane.get", { pane_id: selfPane });
    const selfWorkspace: string | undefined = self.result?.pane?.workspace_id;

    let paneId: string | undefined;
    let workspaceId = selfWorkspace;
    let cwd = opts.cwd;
    if (where === "worktree") {
      ({ paneId, workspaceId, cwd } = await this.worktreePane(opts, name));
    } else if (where === "split") {
      const layout = await call("pane.layout", { pane_id: selfPane });
      const me = layout.result?.layout?.panes?.find((p: { pane_id: string }) => p.pane_id === selfPane);
      const r = await call("pane.split", { target_pane_id: selfPane, direction: splitDirection(me?.rect), cwd, focus: !!opts.focus });
      paneId = r.result?.pane?.pane_id;
      if (!paneId) throw new Error(`herdr could not split the pane: ${errorText(r)}`);
    } else {
      const r = await call("tab.create", { workspace_id: selfWorkspace, cwd, label: name, focus: !!opts.focus });
      paneId = r.result?.root_pane?.pane_id;
      if (!paneId) throw new Error(`herdr could not create a tab: ${errorText(r)}`);
    }

    const { agent } = this.deps;
    const args = agent.args(opts, name);
    // A new pane's shell takes a moment to reach its prompt (agent_pane_busy until then).
    let start = await call("agent.start", { name, kind: agent.kind, pane_id: paneId, args, timeout_ms: 90_000 }, 95_000);
    for (let i = 0; start.error?.code === "agent_pane_busy" && i < 30; i++) {
      await new Promise((r) => setTimeout(r, this.deps.readyPollMs ?? 500));
      start = await call("agent.start", { name, kind: agent.kind, pane_id: paneId, args, timeout_ms: 90_000 }, 95_000);
    }
    const rec: ChildRecord = {
      name,
      paneId,
      where,
      cwd,
      branch: opts.branch,
      workspaceId,
      model: opts.model,
      thinking: opts.thinking,
      task: opts.task,
      createdAt: Date.now(),
      awaiting: false,
    };
    if (start.error) {
      if (start.error.code === "agent_not_ready") {
        this.save(rec);
        throw new Error(`${agent.kind} started in ${name}'s pane (${paneId}) but is waiting on a dialog, so the task was not sent. Ask the user to answer it there, then use action=send.`);
      }
      if (where !== "worktree" || !workspaceId) await call("pane.close", { pane_id: paneId });
      throw new Error(`${agent.kind} did not start in the new pane: ${errorText(start)}`);
    }
    // agent.start returns before the agent takes input (pi: its extensions still loading).
    await this.waitReady(rec);
    await this.prompt(rec, childPreamble(agent.kind, selfPane, rec) + opts.task);
    return rec;
  }

  private async waitReady(rec: ChildRecord, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const a = await this.deps.call<{ agent?: AgentInfo & { interactive_ready?: boolean } }>("agent.get", { target: rec.paneId });
      const info = a.result?.agent;
      if (info?.agent_status === "blocked") {
        this.save(rec);
        throw new Error(`${this.deps.agent.kind} started in ${rec.name}'s pane (${rec.paneId}) but is waiting on a dialog, so the task was not sent. Ask the user to answer it there, then use action=send.`);
      }
      // Over the socket agent.start returns at once (launch_pending); herdr sets interactive_ready
      // once the agent takes input.
      if (info?.interactive_ready === true && (info.agent_status === "idle" || info.agent_status === "done")) return;
      if (Date.now() > deadline) {
        this.save(rec);
        throw new Error(`${this.deps.agent.kind} in ${rec.name}'s pane (${rec.paneId}) did not become ready for input; the task was not sent. Use action=send once it is.`);
      }
      await new Promise((r) => setTimeout(r, this.deps.readyPollMs ?? 500));
    }
  }

  /** Ask the child something; its reply arrives through deliver(). */
  async prompt(rec: ChildRecord, text: string): Promise<void> {
    const { call } = this.deps;
    if (rec.closed) throw new Error(`${rec.name} is closed.`);
    const a = await call<{ agent?: AgentInfo }>("agent.get", { target: rec.paneId });
    const info = a.result?.agent;
    if (!info) throw new Error(`${rec.name} is not running ${this.deps.agent.kind} any more (${errorText(a)}).`);
    if (info.agent_status === "blocked") throw new Error(`${rec.name} is waiting on a dialog in its pane (${rec.paneId}); the user has to answer it there first.`);
    rec.baseline = { completionSeq: info.completion_seq, stateSeq: info.state_change_seq };
    rec.sawWorking = info.agent_status === "working";
    if (info.agent_session?.value) rec.session = info.agent_session.value;
    let r = await call("agent.prompt", { target: rec.paneId, text }, 15_000);
    for (let i = 0; r.error?.code === "agent_not_ready" && i < 10; i++) {
      await new Promise((res) => setTimeout(res, this.deps.readyPollMs ?? 500));
      r = await call("agent.prompt", { target: rec.paneId, text }, 15_000);
    }
    if (r.error) throw new Error(`herdr could not prompt ${rec.name}: ${errorText(r)}`);
    if (!rec.awaiting) this.deps.hold(rec, true);
    rec.awaiting = true;
    this.save(rec);
    this.ensureLoop();
  }

  async send(name: string, message: string): Promise<ChildRecord> {
    const rec = this.get(name);
    await this.prompt(rec, message);
    return rec;
  }

  private finish(rec: ChildRecord, text: string, reply: string | undefined, closed = false): void {
    if (rec.awaiting) this.deps.hold(rec, false);
    rec.awaiting = false;
    if (closed) rec.closed = true;
    this.save(rec);
    this.deps.deliver(rec, text, reply);
  }

  /** One pass over the awaited children. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const rec of [...this.records.values()]) {
        if (!rec.awaiting || rec.closed) continue;
        await this.check(rec);
      }
    } finally {
      this.ticking = false;
      if (![...this.records.values()].some((r) => r.awaiting && !r.closed)) this.stopLoop();
    }
  }

  private async check(rec: ChildRecord): Promise<void> {
    const { call } = this.deps;
    const a = await call<{ agent?: AgentInfo }>("agent.get", { target: rec.paneId });
    const info = a.result?.agent;
    if (!info) {
      if (a.error?.code === "timeout" || a.error?.code === "socket") return;
      const pane = await call("pane.get", { pane_id: rec.paneId });
      if (pane.error?.code === "timeout" || pane.error?.code === "socket") return;
      const gone = !!pane.error;
      this.finish(rec, gone ? `Herdr child "${rec.name}" was closed before it replied.` : `${this.deps.agent.kind} exited in herdr child "${rec.name}"'s pane (${rec.paneId}) before it replied.`, undefined, gone);
      return;
    }
    if (info.agent_session?.value) rec.session = info.agent_session.value;
    const status = info.agent_status;
    if (status === "working" || status === "blocked") {
      rec.sawWorking = true;
      return;
    }
    if (status !== "idle" && status !== "done") return;
    const seq = info.completion_seq;
    const completed = (seq !== undefined && seq !== rec.baseline?.completionSeq) || rec.sawWorking;
    if (!completed) return;
    const reply = rec.session ? await this.deps.agent.reply(rec) : undefined;
    const where = rec.where === "worktree" && rec.branch ? `worktree ${rec.branch}` : rec.where;
    const text = reply
      ? `Herdr child "${rec.name}" (${where}, pane ${rec.paneId}) replied:\n\n${reply}`
      : `Herdr child "${rec.name}" (${where}, pane ${rec.paneId}) finished its turn, but its reply could not be read${rec.session ? ` from ${rec.session}` : ""}. Use action=read.`;
    this.finish(rec, text, reply);
  }

  async read(name: string, lines = 80): Promise<string> {
    const rec = this.get(name);
    const { call } = this.deps;
    const a = await call<{ agent?: AgentInfo }>("agent.get", { target: rec.paneId });
    const status = a.result?.agent?.agent_status ?? (rec.closed ? "closed" : "gone");
    if (a.result?.agent?.agent_session?.value) rec.session = a.result.agent.agent_session.value;
    if (status === "idle" || status === "done" || status === "closed" || status === "gone") {
      const reply = rec.session ? await this.deps.agent.reply(rec) : undefined;
      return `${rec.name}: ${status}${rec.awaiting ? " (reply pending)" : ""}\n\n${reply ? `Last reply:\n${reply}` : "No reply yet."}`;
    }
    const r = await call("agent.read", { target: rec.paneId, source: "recent_unwrapped", lines: Math.min(Math.max(lines, 10), 400) });
    return `${rec.name}: ${status}${rec.awaiting ? " (reply pending)" : ""}\n\nScreen:\n${r.result?.read?.text ?? errorText(r)}`;
  }

  async list(): Promise<string> {
    if (!this.records.size) return "This session has started no herdr children.";
    const rows: string[] = [];
    for (const rec of this.records.values()) {
      let status = rec.closed ? "closed" : "?";
      if (!rec.closed) {
        const a = await this.deps.call<{ agent?: AgentInfo }>("agent.get", { target: rec.paneId });
        status = a.result?.agent?.agent_status ?? "gone";
      }
      const where = rec.where === "worktree" && rec.branch ? `worktree ${rec.branch}` : rec.where;
      rows.push(`${rec.name}  ${status}${rec.awaiting ? " (reply pending)" : ""}  ${where}  pane ${rec.paneId}  ${rec.task.replace(/\s+/gu, " ").slice(0, 70)}`);
    }
    return rows.join("\n");
  }

  async interrupt(name: string): Promise<string> {
    const rec = this.get(name);
    const r = await this.deps.call("agent.send_keys", { target: rec.paneId, keys: ["esc"] });
    if (r.error) throw new Error(`herdr could not interrupt ${rec.name}: ${errorText(r)}`);
    return `Sent Escape to ${rec.name}; its interrupted turn still reports back when it settles.`;
  }

  async close(name: string): Promise<string> {
    const rec = this.get(name);
    const r = await this.deps.call("pane.close", { pane_id: rec.paneId });
    // Already gone (herdr says pane_not_found, not_found, ...): closing it is done.
    if (r.error && !/not_found$/u.test(r.error.code)) throw new Error(`herdr could not close ${rec.name}: ${errorText(r)}`);
    if (rec.awaiting) this.deps.hold(rec, false);
    rec.awaiting = false;
    rec.closed = true;
    this.save(rec);
    const kept = rec.where === "worktree" && rec.branch ? ` Its checkout and branch ${rec.branch} stay (worktree rm ${rec.branch} removes the checkout).` : "";
    return `Closed ${rec.name}'s pane; its ${this.deps.agent.kind} session stays${rec.session ? ` (${rec.session})` : ""}.${kept}`;
  }

  /** Release every hold (session end); the records stay saved. */
  shutdown(): void {
    this.stopLoop();
    for (const rec of this.records.values()) if (rec.awaiting) this.deps.hold(rec, false);
  }

  private ensureLoop(): void {
    if (this.timer || ![...this.records.values()].some((r) => r.awaiting && !r.closed)) return;
    this.timer = setInterval(() => void this.tick(), this.deps.pollMs ?? 2_000);
    this.timer.unref?.();
  }

  private stopLoop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
