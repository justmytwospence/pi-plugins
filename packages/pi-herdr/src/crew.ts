// Crews: one repository's worktree sessions coordinated from one pi session (usually in the main
// checkout). A crew's state lives in `<git-common-dir>/pi-crew/`, which every worktree of the
// repository shares and git never commits:
//
// - `coordinator.json`: the pane (and session) that coordinates the crew, written by a claim.
// - `directives.md`: standing rules every pi in the repository gets in its system prompt.
//
// Everything else comes from herdr's `session.snapshot` (spaces with their checkout and `pr`
// token, agents with their state, completion count and `summary` token), so a crew member needs
// nothing of its own: the coordinator reads them. Each prompt the user sends the coordinator
// carries one short block of what changed in the crew since its last turn (`digest`), which never
// starts a turn; every pi in the repository gets a `crew` system prompt section (`section`) with
// the directives and, for members, who coordinates them and when to message it.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Call } from "./core/herdr.ts";
import { errorText } from "./core/herdr.ts";
import type { ChildRecord, Exec } from "./core/children.ts";
import { slugName } from "./core/children.ts";

export const CREW_DIR = "pi-crew";
export const COORDINATOR_FILE = "coordinator.json";
export const DIRECTIVES_FILE = "directives.md";
/** The session entry holding what the coordinator has seen of its crew. */
export const SEEN_ENTRY = "pi-herdr:crew-seen";
/** The custom message type of the coordinator's crew update. */
export const CREW_MESSAGE = "herdr-crew";
/** The system prompt section (an XML tag) every pi in a crew's repository gets. */
export const SECTION = "crew";
/** At most this many lines in one crew update. */
export const MAX_DIGEST_LINES = 12;
const MAX_LINE = 160;
/** How long a coordinator's liveness check is reused. */
const LIVE_TTL_MS = 20_000;

export interface Repo {
  /** The shared git directory (`git rev-parse --git-common-dir`), herdr's `repo_key`. */
  common: string;
  /** The main checkout. */
  root: string;
  dir: string;
}

export interface Coordinator {
  paneId: string;
  session?: string;
  name?: string;
  cwd: string;
  claimedAt: number;
}

export interface Worktree {
  path: string;
  branch?: string;
  main: boolean;
}

export interface SnapshotAgent {
  name?: string;
  agent?: string;
  agent_status?: string;
  pane_id?: string;
  cwd?: string;
  workspace_id?: string;
  completion_seq?: number;
  tokens?: Record<string, string>;
  agent_session?: { value?: string };
}

export interface SnapshotWorkspace {
  workspace_id: string;
  label?: string;
  tokens?: Record<string, string>;
  worktree?: { checkout_path?: string; repo_key?: string; is_linked_worktree?: boolean };
}

export interface Snapshot {
  workspaces?: SnapshotWorkspace[];
  agents?: SnapshotAgent[];
}

export interface BoardAgent {
  name?: string;
  paneId: string;
  kind: string;
  status: string;
  completionSeq?: number;
  summary?: string;
  session?: string;
}

export interface BoardRow {
  path: string;
  label: string;
  branch?: string;
  main: boolean;
  workspaceIds: string[];
  pr?: string;
  agents: BoardAgent[];
}

/** What the coordinator last saw of each worktree: its path to a fingerprint. */
export type Seen = Record<string, string>;

/** `git worktree list --porcelain`: each checkout, its branch, and which one is the main checkout. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Worktree | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9).trim(), main: out.length === 0 };
      out.push(cur);
    } else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//u, "");
    else if (cur && line === "bare") cur.main = false;
  }
  return out;
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
const oneLine = (s: string | undefined) => s?.replace(/\s+/gu, " ").trim() || undefined;
const settled = (status: string | undefined) => (status === "done" ? "idle" : status ?? "unknown");

/**
 * Each worktree with its herdr spaces and agents. An agent belongs to the worktree whose path is
 * the longest prefix of its directory (so one in the main checkout is not taken for a worktree
 * under `.worktrees/`), else to the worktree of its space.
 */
export function board(snapshot: Snapshot, worktrees: Worktree[], repo: Repo): BoardRow[] {
  const rows = worktrees.map((w): BoardRow => ({
    path: w.path,
    label: w.branch ?? basename(w.path),
    ...(w.branch ? { branch: w.branch } : {}),
    main: w.main,
    workspaceIds: [],
    agents: [],
  }));
  const byPath = new Map(rows.map((r) => [r.path, r]));
  const wsRow = new Map<string, BoardRow>();
  for (const ws of snapshot.workspaces ?? []) {
    const path = ws.worktree?.checkout_path;
    if (!path || (ws.worktree?.repo_key && ws.worktree.repo_key !== repo.common)) continue;
    const row = byPath.get(path);
    if (!row) continue;
    row.workspaceIds.push(ws.workspace_id);
    wsRow.set(ws.workspace_id, row);
    const pr = oneLine(ws.tokens?.pr);
    if (pr && !row.pr) row.pr = pr;
  }
  const longest = (cwd: string) => {
    let best: BoardRow | undefined;
    for (const r of rows) if (within(cwd, r.path) && (!best || r.path.length > best.path.length)) best = r;
    return best;
  };
  for (const a of snapshot.agents ?? []) {
    if (!a.pane_id) continue;
    const row = (a.cwd ? longest(a.cwd) : undefined) ?? (a.workspace_id ? wsRow.get(a.workspace_id) : undefined);
    if (!row) continue;
    const summary = oneLine(a.tokens?.summary);
    row.agents.push({
      ...(a.name ? { name: a.name } : {}),
      paneId: a.pane_id,
      kind: a.agent ?? "?",
      status: settled(a.agent_status),
      ...(a.completion_seq !== undefined ? { completionSeq: a.completion_seq } : {}),
      ...(summary ? { summary } : {}),
      ...(a.agent_session?.value ? { session: a.agent_session.value } : {}),
    });
  }
  return rows;
}

const clip = (s: string, max = MAX_LINE) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const fingerprint = (row: BoardRow) => JSON.stringify([
  row.workspaceIds.length > 0,
  row.pr ?? null,
  row.agents.map((a) => [a.paneId, a.kind, a.status, a.completionSeq ?? null, a.summary ?? null]),
]);

/** One worktree's line in a crew update. */
export function rowLine(row: BoardRow): string {
  const pi = row.agents.filter((a) => a.kind === "pi");
  const lead = pi[0] ?? row.agents[0];
  if (!lead) {
    const where = row.workspaceIds.length ? "its space is open but no agent runs there" : "no space and no agent";
    return clip(`- ${row.label}: ${where}${row.pr ? ` (${row.pr})` : ""}; herdr action=crew op=sync starts its pi`);
  }
  const more = row.agents.length > 1 ? `, +${row.agents.length - 1} more agent${row.agents.length > 2 ? "s" : ""}` : "";
  const who = `${lead.name ? `${lead.name} ` : ""}${lead.paneId}${lead.kind === "pi" ? "" : ` ${lead.kind}`}`;
  return clip(`- ${row.label} (${who}, ${lead.status}${row.pr ? `, ${row.pr}` : ""}${more}): ${lead.summary ?? "no turn summary yet"}`);
}

/**
 * The coordinator's crew update: one line per linked worktree whose session, state, last turn or
 * PR changed since `seen`, and one for each worktree that went away. Undefined when nothing
 * changed. `seen` undefined (the first update) lists every worktree.
 */
export function crewDigest(rows: BoardRow[], seen: Seen | undefined): { text: string; seen: Seen } | undefined {
  const next: Seen = {};
  const lines: string[] = [];
  for (const row of rows) {
    if (row.main) continue;
    const fp = fingerprint(row);
    next[row.path] = fp;
    if (seen?.[row.path] !== fp) lines.push(rowLine(row));
  }
  for (const path of Object.keys(seen ?? {})) if (!(path in next)) lines.push(clip(`- ${basename(path)}: its worktree is gone`));
  if (!lines.length) return undefined;
  const shown = lines.slice(0, MAX_DIGEST_LINES);
  if (lines.length > shown.length) shown.push(`- … and ${lines.length - shown.length} more (herdr action=crew shows them all)`);
  const head = seen
    ? "[Crew since your last turn, from pi-herdr, not the user: worktree sessions whose state, last turn or PR changed]"
    : "[Crew status from pi-herdr, not the user: every worktree session; later prompts list only what changed]";
  return { text: `${head}\n${shown.join("\n")}`, seen: next };
}

/** The `crew` system prompt section, or undefined when there is nothing to say. */
export function sectionText(opts: {
  directives?: string;
  directivesPath: string;
  role: "coordinator" | "member" | "none";
  coordinator?: { name?: string; paneId: string };
}): string | undefined {
  const parts: string[] = [];
  if (opts.role === "coordinator") {
    parts.push(
      "You coordinate this repository's worktree sessions: the pi sessions working in its other checkouts, each run by the user in its own herdr space. herdr action=crew shows them (op=status) and opens every worktree's space and session and makes them your children (op=sync).",
      "A prompt may start with a [Crew …] block from pi-herdr listing which of them changed since your last turn (state, last-turn summary, PR): it is status, not a request from the user, so act on it only as the user's prompt asks.",
      `Put standing rules that every session in the repository must follow (what not to post, shared-state hazards, decisions that bind every branch) in the directives file ${opts.directivesPath}, with edit or write: every pi in the repository gets it in its system prompt, including after compaction, so do not message the rules to each session. Leave each worktree's code to its own session.`,
    );
  } else if (opts.role === "member" && opts.coordinator) {
    const who = opts.coordinator.name ? `"${opts.coordinator.name}" (herdr pane ${opts.coordinator.paneId})` : `in herdr pane ${opts.coordinator.paneId}`;
    parts.push(
      `This checkout belongs to a repository whose worktree sessions are coordinated by the pi session ${who}. It sees your state, last-turn summary and pull request on its own, so do not report routine progress to it.`,
      `Message it (herdr action=send, name ${opts.coordinator.name ?? opts.coordinator.paneId}) only when you need a decision outside this branch's scope, when you found something that changes other branches' work (a shared contract, schema, interface or rule), or when another branch blocks you. Messages from it relay the user's decisions.`,
    );
  }
  const directives = opts.directives?.trim();
  if (directives) parts.push(`Directives for every session in this repository (${opts.directivesPath}, kept by the user and the coordinator); follow them:\n\n${directives}`);
  return parts.length ? parts.join("\n\n") : undefined;
}

export interface CrewDeps {
  call: Call;
  exec: Exec;
  selfPane: string;
  now?: () => number;
}

export interface Me {
  paneId: string;
  session?: string;
  name?: string;
  cwd: string;
}

/** Reads and writes a crew's files and herdr's view of it; caches what each prompt would repeat. */
export class Crew {
  private readonly repos = new Map<string, Promise<Repo | undefined>>();
  private readonly files = new Map<string, { mtimeMs: number; size: number; text: string }>();
  private live: { key: string; at: number; live: boolean } | undefined;
  /** What the coordinator has seen of its crew (restored from the session). */
  seen: Seen | undefined;

  private readonly deps: CrewDeps;

  constructor(deps: CrewDeps) {
    this.deps = deps;
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** The repository of `cwd`, or undefined outside git (cached per directory). */
  repo(cwd: string): Promise<Repo | undefined> {
    let p = this.repos.get(cwd);
    if (!p) {
      p = this.deps.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).then((r) => {
        if (r.code !== 0) return undefined;
        const common = r.stdout.trim().replace(/\/+$/u, "");
        if (!common) return undefined;
        const root = common.replace(/\/\.git$/u, "");
        return { common, root, dir: join(common, CREW_DIR) };
      }, () => undefined);
      this.repos.set(cwd, p);
    }
    return p;
  }

  /** A small file's text, reread only when its mtime or size changes; undefined when missing. */
  private read(path: string): string | undefined {
    let st;
    try {
      st = statSync(path);
    } catch {
      this.files.delete(path);
      return undefined;
    }
    const hit = this.files.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    try {
      const text = readFileSync(path, "utf8");
      this.files.set(path, { mtimeMs: st.mtimeMs, size: st.size, text });
      return text;
    } catch {
      return undefined;
    }
  }

  directivesPath(repo: Repo): string {
    return join(repo.dir, DIRECTIVES_FILE);
  }

  directives(repo: Repo): string | undefined {
    return this.read(this.directivesPath(repo))?.trim() || undefined;
  }

  coordinator(repo: Repo): Coordinator | undefined {
    const raw = this.read(join(repo.dir, COORDINATOR_FILE));
    if (!raw) return undefined;
    try {
      const c = JSON.parse(raw) as Coordinator;
      return typeof c?.paneId === "string" ? c : undefined;
    } catch {
      return undefined;
    }
  }

  private write(repo: Repo, c: Coordinator): void {
    mkdirSync(repo.dir, { recursive: true });
    const path = join(repo.dir, COORDINATOR_FILE);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`);
    renameSync(tmp, path);
    this.files.delete(path);
    this.live = undefined;
  }

  /** Whether the coordinator's pane still runs pi in this repository (cached briefly). */
  async isLive(repo: Repo, c: Coordinator): Promise<boolean> {
    const key = `${repo.common}\n${c.paneId}`;
    if (this.live?.key === key && this.now() - this.live.at < LIVE_TTL_MS) return this.live.live;
    const r = await this.deps.call<{ agent?: SnapshotAgent }>("agent.get", { target: c.paneId });
    const a = r.result?.agent;
    const live = !!a && a.agent === "pi" && (!a.cwd || within(a.cwd, repo.root) || within(a.cwd, repo.common));
    this.live = { key, at: this.now(), live };
    return live;
  }

  isCoordinator(c: Coordinator | undefined, me: Pick<Me, "paneId" | "session">): boolean {
    return !!c && (c.paneId === me.paneId || (!!c.session && c.session === me.session));
  }

  /** The `crew` section for this session's prompt, or undefined. */
  async section(me: Me): Promise<string | undefined> {
    const repo = await this.repo(me.cwd);
    if (!repo) return undefined;
    const c = this.coordinator(repo);
    let role: "coordinator" | "member" | "none" = "none";
    if (c && this.isCoordinator(c, me)) role = "coordinator";
    else if (c && await this.isLive(repo, c).catch(() => false)) role = "member";
    return sectionText({
      directives: this.directives(repo),
      directivesPath: this.directivesPath(repo),
      role,
      ...(role === "member" && c ? { coordinator: { ...(c.name ? { name: c.name } : {}), paneId: c.paneId } } : {}),
    });
  }

  /** Every worktree of the repository with its spaces and agents. */
  async rows(repo: Repo): Promise<BoardRow[]> {
    const [snap, list] = await Promise.all([
      this.deps.call<{ snapshot?: Snapshot }>("session.snapshot", {}),
      this.deps.exec("git", ["worktree", "list", "--porcelain"], repo.root),
    ]);
    if (snap.error) throw new Error(`herdr could not report its session: ${errorText(snap)}`);
    if (list.code !== 0) throw new Error(`git worktree list failed: ${(list.stderr || list.stdout).trim().slice(0, 300)}`);
    return board(snap.result?.snapshot ?? {}, parseWorktrees(list.stdout), repo);
  }

  /** The coordinator's crew update for this prompt, or undefined (not the coordinator, nothing changed). */
  async digest(me: Me): Promise<{ text: string; seen: Seen } | undefined> {
    const repo = await this.repo(me.cwd);
    if (!repo || !this.isCoordinator(this.coordinator(repo), me)) return undefined;
    const rows = (await this.rows(repo)).map((r) => ({ ...r, agents: r.agents.filter((a) => a.paneId !== me.paneId) }));
    return crewDigest(rows, this.seen);
  }

  /**
   * A herdr agent name for the coordinator's pane, so members can message it by name: its own, or
   * `wanted` (the name it had before a restart, else `<repo>-coordinator`) when herdr gives it.
   */
  private async ensureName(repo: Repo, me: Me, wanted?: string): Promise<string | undefined> {
    if (me.name) return me.name;
    const name = wanted ?? `${slugName(basename(repo.root)).slice(0, 18).replace(/-+$/u, "")}-coord`;
    const r = await this.deps.call("agent.rename", { target: me.paneId, name });
    return r.error ? undefined : name;
  }

  /** At session start: a coordinator restarted in its pane, or resumed in another, keeps the role. */
  async reclaim(me: Me, herdrName?: () => Promise<string | undefined>): Promise<boolean> {
    const repo = await this.repo(me.cwd);
    if (!repo) return false;
    const c = this.coordinator(repo);
    if (!c || !this.isCoordinator(c, me)) return false;
    if (!me.name && herdrName) {
      const own = await herdrName();
      if (own) me = { ...me, name: own };
    }
    const name = await this.ensureName(repo, me, c.name);
    if (c.paneId === me.paneId && c.session === me.session && c.name === name && c.cwd === me.cwd) return true;
    const { name: _old, ...rest } = c;
    this.write(repo, { ...rest, paneId: me.paneId, ...(me.session ? { session: me.session } : {}), ...(name ? { name } : {}), cwd: me.cwd });
    return true;
  }

  /** Make this session the crew's coordinator. Refuses to take over from another live one unless `takeover`. */
  async claim(me: Me, takeover = false): Promise<{ repo: Repo; text: string }> {
    const repo = await this.repo(me.cwd);
    if (!repo) throw new Error(`${me.cwd} is not in a git repository, so it has no crew.`);
    const c = this.coordinator(repo);
    if (c && !this.isCoordinator(c, me) && !takeover && await this.isLive(repo, c).catch(() => false)) {
      throw new Error(`The pi session in herdr pane ${c.paneId}${c.name ? ` ("${c.name}")` : ""} already coordinates this repository's worktree sessions. Ask the user before taking the role over (op=claim or op=sync with takeover=true).`);
    }
    const already = this.isCoordinator(c, me);
    const name = await this.ensureName(repo, me, already ? c?.name : undefined);
    this.write(repo, { paneId: me.paneId, ...(me.session ? { session: me.session } : {}), ...(name ? { name } : {}), cwd: me.cwd, claimedAt: already && c ? c.claimedAt : this.now() });
    if (!already) this.seen = undefined;
    const path = this.directivesPath(repo);
    const directives = this.directives(repo);
    return {
      repo,
      text: `${already ? "This session already coordinates" : "This session now coordinates"} the worktree sessions of ${repo.root}. Every pi in the repository gets the directives file ${path} in its system prompt${directives ? "" : " (it does not exist yet; create it with write when there is a standing rule)"}: put rules every session must follow there instead of messaging each one.`,
    };
  }

  /** The board: every worktree, its spaces, agents, PR and last turn, then the directives. */
  async status(me: Me, children: Map<string, ChildRecord>): Promise<string> {
    const repo = await this.repo(me.cwd);
    if (!repo) throw new Error(`${me.cwd} is not in a git repository, so it has no crew.`);
    const rows = await this.rows(repo);
    const c = this.coordinator(repo);
    const coord = !c
      ? "no coordinator (op=claim or op=sync makes this session it)"
      : this.isCoordinator(c, me)
        ? "this session coordinates it"
        : `coordinated by herdr pane ${c.paneId}${c.name ? ` ("${c.name}")` : ""}${await this.isLive(repo, c).catch(() => false) ? "" : ", which no longer runs pi there"}`;
    const childPanes = new Map<string, string>();
    for (const r of children.values()) if (!r.closed && !r.peer) childPanes.set(r.paneId, r.name);
    const lines = rows.map((row) => {
      const place = row.main ? "main checkout" : row.workspaceIds.length ? `space ${row.workspaceIds.join(",")}` : "no space";
      const agents = row.agents.length
        ? row.agents.map((a) => `${a.kind}${a.name ? ` ${a.name}` : ""} ${a.paneId} ${a.status}${a.paneId === me.paneId ? " [this session]" : childPanes.has(a.paneId) ? " [child]" : ""}${a.summary ? ` | ${a.summary}` : ""}`).join("; ")
        : "no agent";
      return `- ${row.label} (${place}${row.pr ? `, ${row.pr}` : ""}): ${agents}`;
    });
    const path = this.directivesPath(repo);
    const directives = this.directives(repo);
    return [
      `Crew of ${repo.root}: ${coord}.`,
      ...lines,
      "",
      directives ? `Directives (${path}):\n${directives}` : `No directives yet (${path}).`,
    ].join("\n");
  }
}

export interface SyncOps {
  /** This session's live children and awaited agents. */
  children: Map<string, ChildRecord>;
  /** A herdr agent name not taken by a live agent or a child. */
  uniqueName(wanted: string): Promise<string>;
  /** Record an existing pane as this session's child. */
  attach(opts: { name: string; paneId: string; cwd: string; branch?: string; workspaceId?: string; session?: string }): ChildRecord;
  readyPollMs?: number;
}

/**
 * Claim the crew, then give every linked worktree a space and a pi, made this session's children:
 * a pi already there is attached (and named, if it has no herdr name); a worktree without one gets
 * its space opened (without focus) and `pi --continue` started, resuming its latest session there,
 * with no task. Other agents are left alone. One line per worktree.
 */
export async function syncCrew(crew: Crew, deps: CrewDeps, me: Me, ops: SyncOps, takeover = false): Promise<string> {
  const { repo, text: claimed } = await crew.claim(me, takeover);
  const rows = await crew.rows(repo);
  const lines: string[] = [];
  const childByPane = new Map<string, ChildRecord>();
  for (const r of ops.children.values()) if (!r.closed && !r.peer) childByPane.set(r.paneId, r);
  for (const row of rows) {
    if (row.main) continue;
    try {
      const pi = row.agents.find((a) => a.kind === "pi" && a.paneId !== me.paneId);
      if (pi) {
        const known = childByPane.get(pi.paneId);
        if (known) {
          lines.push(`- ${row.label}: already your child ${known.name} (${pi.paneId}, ${pi.status})`);
          continue;
        }
        let name = pi.name;
        if (!name) {
          name = await ops.uniqueName(crewAgentName(row));
          const renamed = await deps.call("agent.rename", { target: pi.paneId, name });
          if (renamed.error) name = pi.paneId;
        }
        ops.attach({ name, paneId: pi.paneId, cwd: row.path, ...(row.branch ? { branch: row.branch } : {}), ...(row.workspaceIds[0] ? { workspaceId: row.workspaceIds[0] } : {}), ...(pi.session ? { session: pi.session } : {}) });
        lines.push(`- ${row.label}: attached its pi as your child ${name} (${pi.paneId}, ${pi.status})`);
        continue;
      }
      if (row.agents.length) {
        lines.push(`- ${row.label}: runs ${[...new Set(row.agents.map((a) => a.kind))].join(", ")}, not pi; left alone`);
        continue;
      }
      const name = await ops.uniqueName(crewAgentName(row));
      let paneId: string | undefined;
      let workspaceId = row.workspaceIds[0];
      if (!workspaceId) {
        const open = await deps.call("worktree.open", { cwd: repo.root, path: row.path, focus: false }, 15_000);
        if (open.error) throw new Error(`herdr could not open its space: ${errorText(open)}`);
        workspaceId = open.result?.workspace?.workspace_id;
        if (!open.result?.already_open) paneId = open.result?.root_pane?.pane_id;
      }
      if (!paneId) {
        const tab = await deps.call("tab.create", { workspace_id: workspaceId, cwd: row.path, label: name, focus: false });
        paneId = tab.result?.root_pane?.pane_id;
        if (!paneId) throw new Error(`herdr could not add a tab to its space: ${errorText(tab)}`);
      }
      const params = { name, kind: "pi", pane_id: paneId, args: ["--continue"], timeout_ms: 90_000 };
      let start = await deps.call("agent.start", params, 95_000);
      for (let i = 0; start.error?.code === "agent_pane_busy" && i < 30; i++) {
        await new Promise((r) => setTimeout(r, ops.readyPollMs ?? 500));
        start = await deps.call("agent.start", params, 95_000);
      }
      if (start.error && start.error.code !== "agent_not_ready") throw new Error(`pi did not start in its pane ${paneId}: ${errorText(start)}`);
      ops.attach({ name, paneId, cwd: row.path, ...(row.branch ? { branch: row.branch } : {}), ...(workspaceId ? { workspaceId } : {}) });
      lines.push(`- ${row.label}: ${row.workspaceIds.length ? "added a tab to its space" : "opened its space"} and resumed its latest pi session there as your child ${name} (${paneId})${start.error ? "; it waits on a dialog the user has to answer" : ""}`);
    } catch (error) {
      lines.push(`- ${row.label}: not synced: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return `${claimed}\n\n${lines.length ? lines.join("\n") : "The repository has no other worktrees."}\n\nTheir replies to your sends come back as messages; your prompts carry a crew update when any of them changes.`;
}

/** A herdr agent name for a worktree's session, from its branch or directory. */
export function crewAgentName(row: Pick<BoardRow, "label">): string {
  const slug = row.label
    .replace(/^(feature|feat|fix|chore|refactor|docs)[/-]/u, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 24)
    .replace(/-+$/u, "");
  if (!slug) return "worktree";
  return /^[a-z]/u.test(slug) ? slug : `w-${slug}`.slice(0, 24).replace(/-+$/u, "");
}
