import type { Call, Reply } from "./core/herdr.ts";
import { HerdrSubscription, type HerdrEvent } from "./events.ts";

export interface PaneLocation {
  paneId: string;
  workspaceId: string;
  tabId: string;
  terminalId: string;
}

export interface LocationDependencies {
  call: Call;
  callerPaneId: string;
  socketPath?: string;
  subscribe?: (onEvent: (e: HerdrEvent) => void, onResync: () => void) => { close(): void };
  onChange(previous: PaneLocation | undefined, next: PaneLocation): void;
}

const unavailable = (message: string): Reply<never> => ({ error: { code: "self_location_unavailable", message } });
const inactive = (): Reply<never> => unavailable("location tracking is inactive");

export class SelfLocation {
  private active = false;
  private epoch = 0;
  private location: PaneLocation | undefined;
  private readonly aliases: Set<string>;
  private version = 0;
  private pending: Promise<Reply<PaneLocation>> | undefined;
  private dirty = false;
  private subscription: { close(): void } | undefined;

  constructor(private readonly deps: LocationDependencies) {
    this.aliases = new Set([deps.callerPaneId]);
  }

  get paneId(): string { return this.location?.paneId ?? this.deps.callerPaneId; }
  get current(): PaneLocation | undefined { return this.location; }
  get revision(): number { return this.version; }

  start(): Promise<Reply<PaneLocation>> {
    if (this.active) return this.resolve();
    this.active = true;
    const epoch = ++this.epoch;
    const result = this.resolve();
    const onResync = () => {
      if (!this.active || this.epoch !== epoch) return;
      this.reconcile();
    };
    const onEvent = (e: HerdrEvent) => {
      if (!this.active || this.epoch !== epoch || e.event !== "pane_moved") return;
      const pane = e.data?.pane;
      if (this.aliases.has(e.data?.previous_pane_id) ||
          (this.location && pane?.terminal_id === this.location.terminalId)) this.reconcile();
    };
    if (this.deps.subscribe) this.subscription = this.deps.subscribe(onEvent, onResync);
    else if (this.deps.socketPath) this.subscription = new HerdrSubscription({
      socketPath: this.deps.socketPath,
      subscriptions: [{ type: "pane.moved" }], onEvent, onResync,
    });
    return result;
  }

  private reconcile(): void {
    if (this.pending) {
      this.dirty = true;
      const epoch = this.epoch;
      // An event can land after the lookup loop finishes but before its promise is cleared.
      void this.pending.then(() => {
        if (this.active && this.epoch === epoch && this.dirty && !this.pending) void this.resolve();
      });
    } else void this.resolve();
  }

  resolve(): Promise<Reply<PaneLocation>> {
    if (!this.active) return Promise.resolve(inactive());
    if (!this.deps.callerPaneId) return Promise.resolve(unavailable("missing inherited caller pane ID"));
    if (this.pending) return this.pending;
    const epoch = this.epoch;
    const run = async (): Promise<Reply<PaneLocation>> => {
      let reply: Reply<PaneLocation>;
      do {
        this.dirty = false;
        let raw: Reply;
        try {
          raw = await this.deps.call("pane.current", { caller_pane_id: this.deps.callerPaneId });
        } catch (error) {
          raw = { error: { code: "transport", message: String(error) } };
        }
        if (!this.active || this.epoch !== epoch) return inactive();
        const p = raw.result?.pane;
        if (raw.error) reply = unavailable(`${raw.error.message} (${raw.error.code})`);
        else if (![p?.pane_id, p?.workspace_id, p?.tab_id, p?.terminal_id].every((v) => typeof v === "string" && v.length > 0)) {
          reply = unavailable("invalid pane.current response");
        } else if (this.location && this.location.terminalId !== p.terminal_id) {
          reply = unavailable("pane.current returned a different terminal");
        } else {
          const next: PaneLocation = { paneId: p.pane_id, workspaceId: p.workspace_id, tabId: p.tab_id, terminalId: p.terminal_id };
          const previous = this.location;
          if (!previous || previous.paneId !== next.paneId || previous.workspaceId !== next.workspaceId || previous.tabId !== next.tabId) {
            this.location = next;
            this.aliases.add(next.paneId);
            this.version++;
            this.deps.onChange(previous, next);
          }
          reply = { result: this.location };
        }
      } while (this.dirty && this.active && this.epoch === epoch);
      return reply;
    };
    const pending = run().finally(() => { if (this.pending === pending) this.pending = undefined; });
    this.pending = pending;
    return pending;
  }

  async require(): Promise<PaneLocation> {
    const epoch = this.epoch;
    // A command must not adopt a snapshot taken before it began (an unobserved move can
    // happen while a background metadata lookup is still in flight).
    if (this.pending) await this.pending;
    const reply = !this.active || epoch !== this.epoch ? inactive() : await this.resolve();
    if (!reply.result || !this.active || epoch !== this.epoch) throw new Error(`Cannot resolve this Pi session's current Herdr pane; nothing was sent: ${reply.error?.message ?? "no reply"}`);
    return reply.result;
  }

  readonly call: Call = (method, params, timeoutMs) => this.dispatch(method, params, timeoutMs);

  guarded(current: () => boolean): Call {
    return (method, params, timeoutMs) => this.dispatch(method, params, timeoutMs, current);
  }

  private async dispatch<T>(method: string, params: Record<string, unknown>, timeoutMs?: number, guard?: () => boolean): Promise<Reply<T>> {
    const epoch = this.epoch;
    const resolved = await this.resolve();
    if (!this.active || this.epoch !== epoch) return inactive();
    if (!resolved.result) return { error: resolved.error };
    if (guard && !guard()) return { error: { code: "stale_location", message: "location is no longer current" } };
    const normalized = { ...params };
    for (const key of ["pane_id", "target_pane_id", "target"]) {
      const value = normalized[key];
      if (typeof value === "string" && this.aliases.has(value)) normalized[key] = resolved.result.paneId;
    }
    return this.deps.call<T>(method, normalized, timeoutMs);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.epoch++;
    this.subscription?.close();
    this.subscription = undefined;
    this.pending = undefined;
    this.dirty = false;
  }
}
