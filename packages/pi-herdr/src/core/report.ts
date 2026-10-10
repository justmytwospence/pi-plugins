// Shared verbatim by pi-herdr and opencode-herdr (src/core).
//
// Display-only metadata for this pane (tokens, title, displayed agent name) and its workspace
// (tokens). herdr's pi integration stays the only authority over the pane's state: none of this
// changes working/blocked/idle, waits or notifications.
//
// Tokens carry a TTL so a crashed pi cannot leave them behind; tokens that should last are
// re-sent before it runs out. Every report goes through one queue with increasing `seq`, so herdr
// keeps the latest one even if two connections race.
import { type Call, MAX_TTL_MS } from "./herdr.ts";

export const SOURCE = "pi-herdr";

interface Token {
  value: string;
  ttlMs: number;
  sentAt: number;
}

let seqCounter = 0;
const nextSeq = () => Date.now() * 1000 + (seqCounter++ % 1000);

/** Token names herdr accepts: 1-32 ASCII letters, digits, `_` or `-`. */
export function validTokenName(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/u.test(key);
}

abstract class Reporter {
  protected readonly tokens = new Map<string, Token>();
  private chain: Promise<unknown> = Promise.resolve();

  protected readonly call: Call;
  /** herdr orders reports by `seq` per source, so two reporters on one pane need two sources. */
  readonly source: string;

  constructor(call: Call, source = SOURCE) {
    this.call = call;
    this.source = source;
  }

  protected abstract send(params: Record<string, unknown>): Promise<unknown>;

  protected enqueue(params: Record<string, unknown>): Promise<unknown> {
    this.chain = this.chain.then(() => this.send({ ...params, source: this.source, seq: nextSeq() }));
    return this.chain;
  }

  /** Set (or with undefined/"" clear) a `$key` token. A TTL under a day is refreshed by `refresh()`. */
  setToken(key: string, value: string | undefined, ttlMs = MAX_TTL_MS): Promise<unknown> {
    if (!validTokenName(key)) return Promise.resolve();
    const v = value?.trim() ? value.trim().slice(0, 80) : undefined;
    const prev = this.tokens.get(key);
    if (v === undefined) {
      if (!prev) return Promise.resolve();
      this.tokens.delete(key);
      return this.enqueue({ tokens: { [key]: null } });
    }
    if (prev && prev.value === v && prev.ttlMs === ttlMs) return Promise.resolve();
    const ttl = Math.min(Math.max(ttlMs, 1_000), MAX_TTL_MS);
    this.tokens.set(key, { value: v, ttlMs: ttl, sentAt: Date.now() });
    return this.enqueue({ tokens: { [key]: v }, ttl_ms: ttl });
  }

  /** Re-send tokens that are a third of the way to expiring. */
  refresh(now = Date.now()): Promise<unknown> {
    const due: Record<string, string> = {};
    let ttl = MAX_TTL_MS;
    for (const [key, t] of this.tokens) {
      if (now - t.sentAt < t.ttlMs / 3) continue;
      due[key] = t.value;
      t.sentAt = now;
      ttl = Math.min(ttl, t.ttlMs);
    }
    if (!Object.keys(due).length) return Promise.resolve();
    return this.enqueue({ tokens: due, ttl_ms: ttl });
  }

  /** Clear every token this reporter set. */
  clearTokens(): Promise<unknown> {
    if (!this.tokens.size) return this.chain;
    const tokens = Object.fromEntries([...this.tokens.keys()].map((k) => [k, null]));
    this.tokens.clear();
    return this.enqueue({ tokens });
  }
}

export class PaneReporter extends Reporter {
  private title: string | undefined;
  private displayAgent: string | undefined;

  readonly paneId: string;
  /** The agent herdr's own integration reports for this pane: "pi", "opencode". */
  readonly agent: string;

  constructor(call: Call, paneId: string, agent = "pi", source = SOURCE) {
    super(call, source);
    this.paneId = paneId;
    this.agent = agent;
  }

  protected send(params: Record<string, unknown>) {
    return this.call("pane.report_metadata", { pane_id: this.paneId, ...params });
  }

  /**
   * The pane's title and displayed agent name, shown only while herdr's integration for the agent
   * holds the pane (`applies_to_source`), so a shell left behind after it exits keeps its own.
   */
  setPresentation(title: string | undefined, displayAgent: string | undefined): Promise<unknown> {
    const t = title?.trim() ? title.trim().slice(0, 80) : undefined;
    const d = displayAgent?.trim() ? displayAgent.trim().slice(0, 80) : undefined;
    if (t === this.title && d === this.displayAgent) return Promise.resolve();
    this.title = t;
    this.displayAgent = d;
    return this.enqueue({
      agent: this.agent,
      applies_to_source: `herdr:${this.agent}`,
      ...(t ? { title: t } : { clear_title: true }),
      ...(d ? { display_agent: d } : { clear_display_agent: true }),
    });
  }

  clearAll(): Promise<unknown> {
    const p = this.title || this.displayAgent ? this.setPresentation(undefined, undefined) : Promise.resolve();
    return p.then(() => this.clearTokens());
  }
}

export class WorkspaceReporter extends Reporter {
  readonly workspaceId: string;

  constructor(call: Call, workspaceId: string, source = SOURCE) {
    super(call, source);
    this.workspaceId = workspaceId;
  }

  protected send(params: Record<string, unknown>) {
    return this.call("workspace.report_metadata", { workspace_id: this.workspaceId, ...params });
  }
}
