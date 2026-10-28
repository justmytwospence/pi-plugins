// Talking to any agent in herdr, not only this session's children: list them, message them through
// the inbox (src/inbox.ts) when the target is a pi with pi-herdr, else `agent.prompt`, read what
// they said and wait for them to finish. A saved herdr machine (`machine`, as in `herdr --machine`)
// is reached through the CLI, which forwards the API over ssh.
//
// Reading a reply: a local pi's last reply comes from its session file, complete. A remote agent's
// file is out of reach and other agents have none we read, so their reply is a screen read, which
// can be cut short; the result says so when it is one.
import type { Call, Reply } from "./core/herdr.ts";
import { errorText } from "./core/herdr.ts";
import type { Exec } from "./core/children.ts";
import {
  type Delivery,
  type Envelope,
  type Outcome,
  type Sender,
  ackTokenName,
  parseAck,
  encodeEnvelope,
  INBOX_TOKEN,
  MAX_MESSAGE_BYTES,
  newMessageId,
  parseInboxToken,
} from "./inbox.ts";
import { readReply } from "./session.ts";

export interface AgentInfo {
  name?: string;
  agent?: string;
  agent_status?: string;
  pane_id?: string;
  cwd?: string;
  title?: string;
  focused?: boolean;
  tokens?: Record<string, string>;
  agent_session?: { kind?: string; value?: string };
  state_change_seq?: number;
  completion_seq?: number;
}

const SETTLED = new Set(["idle", "done", "blocked"]);
/** A broadcast reaches at most this many agents. */
export const MAX_BROADCAST = 20;
/** The pane token pi-herdr sets while the user types a draft there. */
export const TYPING_TOKEN = "typing";

/** CLI arguments for the API methods this module uses, for `herdr --machine <m> ...`. */
function cliArgs(method: string, p: Record<string, any>): string[] | undefined {
  switch (method) {
    case "agent.list": return ["agent", "list"];
    case "agent.get": return ["agent", "get", p.target];
    case "pane.get": return ["pane", "get", p.pane_id];
    case "pane.process_info": return ["pane", "process-info", "--pane", p.pane_id];
    case "pane.send_text": return ["pane", "send-text", p.pane_id, p.text];
    case "agent.prompt": return ["agent", "prompt", p.target, p.text];
    case "agent.read": return ["agent", "read", p.target, "--source", String(p.source ?? "recent_unwrapped").replaceAll("_", "-"), "--lines", String(p.lines ?? 80)];
    default: return undefined;
  }
}

/** The herdr API on a saved machine, through `herdr --machine`. Resolves like socketCall. */
export function machineCall(exec: Exec, machine: string, cwd: string): Call {
  return async <T = any>(method: string, params: Record<string, unknown>): Promise<Reply<T>> => {
    const args = cliArgs(method, params);
    if (!args) return { error: { code: "unsupported", message: `${method} is not available on another machine` } };
    const r = await exec("herdr", ["--machine", machine, ...args], cwd);
    for (const out of [r.stdout, r.stderr]) {
      const text = out.trim();
      if (!text.startsWith("{")) continue;
      try {
        const reply = JSON.parse(text);
        if (reply.error) return { error: reply.error };
        if ("result" in reply) return { result: reply.result };
      } catch { /* not JSON */ }
    }
    if (r.code === 0 && method === "agent.read") return { result: { read: { text: r.stdout } } as T };
    if (r.code === 0) return { result: {} as T };
    return { error: { code: r.code === 127 ? "socket" : "machine", message: (r.stderr || r.stdout).trim().slice(0, 300) || `herdr --machine ${machine} failed` } };
  };
}

export interface SendResult {
  via: "inbox" | "prompt";
  /** What the receiver did with an inbox message; undefined when it did not confirm in time. */
  outcome?: Outcome;
  /** Why it was held or deferred (`dialog`, `typing`, `retry`, `rate`). */
  reason?: string;
  info: AgentInfo;
}

export interface AgentsDeps {
  call: Call;
  exec: Exec;
  selfPane: string;
  cwd(): string;
  /** Who is sending: this pane, its agent name, host and directory. */
  self(): Promise<Sender>;
  ackPollMs?: number;
  ackTimeoutMs?: number;
  waitPollMs?: number;
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

/** What an acknowledgement (`outcome` or `outcome:reason`, as its token carries it) means for the sender. */
export const outcomeText = (name: string, ack: string | Outcome | undefined, reason?: string): string => {
  const parsed = parseAck(reason ? `${ack}:${reason}` : ack);
  switch (parsed?.outcome) {
    case "started": return `${name} was idle and started a turn on it.`;
    case "steered": return `${name} is working; it gets the message in its current turn, after the current tool call.`;
    case "queued": return `${name} is working; the message is queued for after its current turn.`;
    case "deferred": return `${name} has had many messages from this agent without the user answering it, so this one waits for the user's next prompt and starts no turn. Do not resend; stop messaging it until the user has answered.`;
    case "held":
      if (parsed.reason === "typing") return `${name}'s user is typing a draft in its pane, so the message is held there and delivered when they submit (it then follows their turn) or stop typing.`;
      if (parsed.reason === "retry") return `${name}'s pi could not take the message just now, so it is held there and retried when its session is next idle.`;
      return `${name} is waiting on a dialog for the user, so the message is held there and delivered when the dialog closes.`;
    default: return `${name} did not confirm receipt in time. It was sent once; check with action=read before sending again.`;
  }
};

export class Agents {
  private readonly deps: AgentsDeps;
  private readonly machines = new Map<string, Call>();

  constructor(deps: AgentsDeps) {
    this.deps = deps;
  }

  endpoint(machine?: string): Call {
    if (!machine) return this.deps.call;
    let c = this.machines.get(machine);
    if (!c) this.machines.set(machine, (c = machineCall(this.deps.exec, machine, this.deps.cwd())));
    return c;
  }

  async get(name: string, machine?: string): Promise<AgentInfo> {
    const r = await this.endpoint(machine)<{ agent?: AgentInfo }>("agent.get", { target: name });
    const info = r.result?.agent;
    if (!info?.pane_id) throw new Error(`No agent "${name}"${machine ? ` on ${machine}` : ""}: ${errorText(r)}. action=list shows the agents.`);
    return info;
  }

  /**
   * Whether a pi-herdr inbox listens in the agent's pane: `yes` when its pi is the pane's foreground
   * process; `background` when the pane advertises one but that pi is not in front (suspended with
   * Ctrl+Z, or a program runs on top of it), so anything typed would reach that program instead.
   */
  async inboxState(info: AgentInfo, machine?: string): Promise<"yes" | "no" | "background"> {
    const pid = parseInboxToken(info.tokens?.[INBOX_TOKEN]);
    if (pid === undefined || !info.pane_id) return "no";
    const r = await this.endpoint(machine)<{ process_info?: { foreground_processes?: { pid?: number }[] } }>("pane.process_info", { pane_id: info.pane_id });
    if (!r.result?.process_info) throw new Error(`herdr could not tell what runs in front in ${info.name ?? info.pane_id}'s pane, so nothing was sent: ${errorText(r)}`);
    return r.result.process_info.foreground_processes?.some((p) => p.pid === pid) ? "yes" : "background";
  }

  /**
   * Put an envelope into the agent's inbox and wait for its acknowledgement. Undefined when the
   * agent has no inbox (the caller falls back to agent.prompt). Throws, sending nothing, when its pi
   * is not in front: typing into that pane would reach whatever is.
   */
  async sendInbox(info: AgentInfo, text: string, delivery: Delivery, opts: { machine?: string; awaitsReply?: boolean } = {}): Promise<{ outcome?: Outcome; reason?: string; ack?: string } | undefined> {
    const state = await this.inboxState(info, opts.machine);
    if (state === "no") return undefined;
    if (state === "background") throw new Error(`${info.name ?? info.pane_id}'s pi is not in the foreground of its pane (suspended with Ctrl+Z, or a program runs on top of it), so nothing was sent: typing there would reach that program. Try again once pi is back in front.`);
    const call = this.endpoint(opts.machine);
    const env: Envelope = { v: 1, id: newMessageId(), from: await this.deps.self(), text, delivery, ...(opts.awaitsReply ? { awaitsReply: true } : {}) };
    const r = await call("pane.send_text", { pane_id: info.pane_id, text: encodeEnvelope(env) }, 10_000);
    if (r.error) throw new Error(`herdr could not send to ${info.name ?? info.pane_id}: ${errorText(r)}`);
    const key = ackTokenName(env.id);
    const step = this.deps.ackPollMs ?? (opts.machine ? 500 : 150);
    const deadline = Date.now() + (this.deps.ackTimeoutMs ?? (opts.machine ? 6_000 : 3_000));
    while (Date.now() < deadline) {
      await sleep(step);
      const p = await call<{ pane?: { tokens?: Record<string, string> } }>("pane.get", { pane_id: info.pane_id });
      const raw = p.result?.pane?.tokens?.[key];
      const ack = parseAck(raw);
      if (ack) return { outcome: ack.outcome, ...(ack.reason ? { reason: ack.reason } : {}), ack: raw };
    }
    return {};
  }

  async send(name: string, text: string, opts: { delivery?: Delivery; machine?: string; awaitsReply?: boolean }): Promise<SendResult> {
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error(`The message is over ${MAX_MESSAGE_BYTES / 1024} KB. Write it to a file and send the path instead.`);
    const info = await this.get(name, opts.machine);
    if (!opts.machine && info.pane_id === this.deps.selfPane) throw new Error("That is this session's own pane.");
    const label = info.name ?? info.pane_id!;
    const status = info.agent_status;
    // Steering derails the turn it lands in: that is the sender's choice to make, never a default.
    if ((status === "working" || status === "blocked") && !opts.delivery) throw new Error(`${label} is ${status} on a turn now, so nothing was sent. Read it (action=read) if you need to know what it is doing, then send again with delivery=steer to put the message into that turn (a correction to that work), or delivery=queue for after it (new or separate work).`);
    const inbox = await this.sendInbox(info, text, opts.delivery ?? "steer", { machine: opts.machine, ...(opts.awaitsReply ? { awaitsReply: true } : {}) });
    if (inbox) return { via: "inbox", outcome: inbox.outcome, ...(inbox.reason ? { reason: inbox.reason } : {}), info };
    // No inbox: herdr types the message into its terminal, after whatever draft is there.
    if (status === "blocked") throw new Error(`${label} is waiting on a dialog for the user and has no pi-herdr inbox to hold the message, so nothing was sent. Try again once the user has answered it.`);
    if (status === "working" && opts.delivery === "queue") throw new Error(`${label} has no pi-herdr inbox, so a message cannot be queued in it. Wait for it (action=wait) and send then, or use delivery=steer.`);
    const r = await this.endpoint(opts.machine)("agent.prompt", { target: info.pane_id, text }, 15_000);
    if (r.error) throw new Error(`herdr could not prompt ${label}: ${errorText(r)}`);
    return { via: "prompt", info };
  }

  /** The agent's last reply (local pi, idle) or its screen, labeled as such. */
  async read(name: string, opts: { machine?: string; lines?: number } = {}): Promise<string> {
    const info = await this.get(name, opts.machine);
    const label = info.name ?? info.pane_id!;
    const status = info.agent_status ?? "unknown";
    const file = !opts.machine && info.agent === "pi" && info.agent_session?.kind === "path" ? info.agent_session.value : undefined;
    const settled = status === "idle" || status === "done";
    if (file && settled) {
      const reply = readReply(file);
      if (reply) return `${label}: ${status}\n\nLast reply:\n${reply}`;
    }
    const lines = Math.min(Math.max(opts.lines ?? 80, 10), 400);
    const r = await this.endpoint(opts.machine)<{ read?: { text?: string } }>("agent.read", { target: info.pane_id, source: "recent_unwrapped", lines });
    const why = file
      ? settled ? "its session file has no reply text, so this is its screen" : `it is ${status}, so this is its screen`
      : opts.machine ? `screen read from ${opts.machine}: its session file is out of reach` : `screen read: herdr reports no session file for this ${info.agent ?? "agent"}`;
    const caveat = file ? "" : " The last lines of its terminal can cut a long reply short or leave out its start; if you need all of it, ask the agent to write it to a file and send you the path.";
    return `${label}: ${status} (${why}.${caveat})\n\n${r.result?.read?.text ?? errorText(r)}`;
  }

  /**
   * Wait until the agent's turn settles, then read it. An agent that is idle when the wait starts
   * gets a few seconds to start (a message just sent); if it never does, that is said.
   */
  async wait(name: string, opts: { machine?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string> {
    const first = await this.get(name, opts.machine);
    const label = first.name ?? first.pane_id!;
    const step = this.deps.waitPollMs ?? (opts.machine ? 3_000 : 1_000);
    const deadline = Date.now() + Math.min(Math.max(opts.timeoutMs ?? 600_000, 1_000), 3_600_000);
    const startGrace = Date.now() + 5_000;
    let active = !SETTLED.has(first.agent_status ?? "");
    for (;;) {
      if (opts.signal?.aborted) return `Stopped waiting for ${label}.`;
      const info = await this.get(name, opts.machine).catch(() => undefined);
      if (!info) return `${label} is gone: its pane closed or its agent exited.`;
      const settled = SETTLED.has(info.agent_status ?? "");
      // A short turn can start and settle between two polls: its state sequence still moved.
      if (!settled || info.state_change_seq !== first.state_change_seq) active = true;
      if (settled && (active || (Date.now() > startGrace && info.state_change_seq === first.state_change_seq))) {
        const read = await this.read(name, { machine: opts.machine });
        return active ? read : `${label} stayed ${info.agent_status} and did not start a turn.\n\n${read}`;
      }
      if (Date.now() > deadline) return `${label} is still ${info.agent_status} after the wait's timeout; it keeps going. Wait again or read it later.`;
      await sleep(step, opts.signal);
    }
  }

  /**
   * The agents a broadcast reaches: the named ones, or every agent working in a directory or below
   * it. Never this session's own pane; at most MAX_BROADCAST. Names that cannot be found come back
   * as `missing`, so the caller can say so per target.
   */
  async targets(opts: { names?: string[]; cwdPrefix?: string; machine?: string }): Promise<{ infos: AgentInfo[]; missing: string[] }> {
    const own = (a: AgentInfo) => !opts.machine && a.pane_id === this.deps.selfPane;
    if (opts.names?.length) {
      const names = [...new Set(opts.names.map((n) => n.trim()).filter(Boolean))];
      if (names.length > MAX_BROADCAST) throw new Error(`That is ${names.length} agents; a broadcast reaches at most ${MAX_BROADCAST}.`);
      const infos: AgentInfo[] = [];
      const missing: string[] = [];
      await Promise.all(names.map(async (n) => {
        try { infos.push(await this.get(n, opts.machine)); } catch { missing.push(n); }
      }));
      // Keep the caller's order; the lookups ran in parallel.
      const order = (a: AgentInfo) => names.findIndex((n) => n === a.name || n === a.pane_id);
      infos.sort((a, b) => order(a) - order(b));
      return { infos: infos.filter((a, i) => !own(a) && infos.findIndex((b) => b.pane_id === a.pane_id) === i), missing };
    }
    let prefix = opts.cwdPrefix?.trim() ?? "";
    if (!prefix) throw new Error("A broadcast needs `names` or `cwd_prefix`.");
    if (prefix.startsWith("~")) {
      if (opts.machine) throw new Error(`Give cwd_prefix as an absolute path on ${opts.machine}: ~ is this machine's home.`);
      prefix = `${process.env.HOME ?? ""}${prefix.slice(1)}`;
    }
    prefix = prefix.replace(/\/+$/u, "") || "/";
    const r = await this.endpoint(opts.machine)<{ agents?: AgentInfo[] }>("agent.list", {});
    if (r.error) throw new Error(`herdr could not list agents${opts.machine ? ` on ${opts.machine}` : ""}: ${errorText(r)}`);
    const infos = (r.result?.agents ?? []).filter((a) => a.pane_id && !own(a) && !!a.cwd && (a.cwd === prefix || a.cwd.startsWith(prefix === "/" ? "/" : `${prefix}/`)));
    if (infos.length > MAX_BROADCAST) throw new Error(`${infos.length} agents work under ${prefix}; a broadcast reaches at most ${MAX_BROADCAST}. Narrow the directory or name them.`);
    return { infos, missing: [] };
  }

  /** `marks`: extra labels by pane id (this session's children and awaited peers), for the machine listed. */
  async list(opts: { machine?: string; marks?: Map<string, string> } = {}): Promise<string> {
    const r = await this.endpoint(opts.machine)<{ agents?: AgentInfo[] }>("agent.list", {});
    if (r.error) throw new Error(`herdr could not list agents${opts.machine ? ` on ${opts.machine}` : ""}: ${errorText(r)}`);
    const agents = r.result?.agents ?? [];
    if (!agents.length) return `No agents${opts.machine ? ` on ${opts.machine}` : ""}.`;
    const home = process.env.HOME;
    return agents.map((a) => {
      const marks = [
        !opts.machine && a.pane_id === this.deps.selfPane ? "this session" : undefined,
        a.pane_id ? opts.marks?.get(a.pane_id) : undefined,
        parseInboxToken(a.tokens?.[INBOX_TOKEN]) !== undefined ? "inbox" : undefined,
        a.tokens?.[TYPING_TOKEN] ? "typing" : undefined,
        a.focused ? "focused" : undefined,
      ].filter(Boolean).join(", ");
      const cwd = a.cwd && home && a.cwd.startsWith(home) ? `~${a.cwd.slice(home.length)}` : a.cwd ?? "";
      const summary = a.tokens?.summary?.replace(/\s+/gu, " ").trim();
      return `${a.name ?? "-"}  ${a.pane_id}  ${a.agent ?? "?"} ${a.agent_status ?? "?"}${marks ? `  [${marks}]` : ""}  ${cwd}  ${(a.title ?? "").replace(/\s+/gu, " ").slice(0, 60)}${summary ? `  | ${summary}` : ""}`;
    }).join("\n");
  }
}
