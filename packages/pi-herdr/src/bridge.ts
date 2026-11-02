// The event-bus bridge: other extensions emit these on `pi.events` and pi-herdr does the herdr
// work, so they need no herdr code of their own. Without pi-herdr (or outside herdr) nothing
// listens and the events do nothing.
//
//   herdr:token  { key, value?, ttlMs? }        set (value) or clear (no value) the pane token `$key`
//   herdr:notify { title, body?, sound?, unlessFocused? }   a herdr notification
//   herdr:zoom   { active }                      zoom the pane while any hold is active
//   herdr:split  { command, cwd?, done? }        run `command` in a split beside the pane; the split
//                                                closes when it exits; done(ok, message) reports back
//   herdr:probe  { reply }                       reply() runs at once when pi-herdr is active
//
// pi-herdr emits `herdr:ready` once it is active, so an extension that set a token before pi-herdr
// loaded can send it again. `herdr:blocked` is not handled here: herdr's own pi integration
// reads it.
import { type Call, errorText, splitDirection } from "./core/herdr.ts";
import type { PaneReporter } from "./core/report.ts";

export interface TokenEvent {
  key: string;
  value?: string;
  ttlMs?: number;
}

export interface NotifyEvent {
  title: string;
  body?: string;
  sound?: "none" | "done" | "request";
  /** Skip the notification while this pane is focused. */
  unlessFocused?: boolean;
}

export interface SplitEvent {
  command: string;
  cwd?: string;
  done?: (ok: boolean, message: string) => void;
}

interface Layout {
  zoomed?: boolean;
  focused_pane_id?: string;
  panes?: { pane_id: string; focused?: boolean; rect?: { width: number; height: number } }[];
}

export interface BridgeLocation {
  paneId(): string;
  guarded(current: () => boolean): Call;
}

export class Bridge {
  private zoomHolds = 0;
  /** Whether pi-herdr zoomed the pane (and so should unzoom it). */
  private zoomedByUs = false;
  private zoomChain: Promise<unknown> = Promise.resolve();
  private locationEpoch = 0;

  private readonly call: Call;
  private readonly pane: PaneReporter;

  private readonly location: BridgeLocation;

  constructor(call: Call, pane: PaneReporter, location?: BridgeLocation) {
    this.call = call;
    this.pane = pane;
    this.location = location ?? { paneId: () => pane.paneId, guarded: () => call };
  }

  /** Ownership belongs to the departed tab; holds still belong to this session. */
  relocated(): void {
    this.locationEpoch++;
    this.zoomedByUs = false;
  }

  token(e: TokenEvent | undefined): Promise<unknown> {
    if (!e || typeof e.key !== "string") return Promise.resolve();
    return this.pane.setToken(e.key, typeof e.value === "string" ? e.value : undefined, e.ttlMs);
  }

  async notify(e: NotifyEvent | undefined): Promise<void> {
    if (!e?.title) return;
    if (e.unlessFocused) {
      const pane = await this.call("pane.get", { pane_id: this.location.paneId() });
      if (pane.result?.pane?.focused === true) return;
    }
    await this.call("notification.show", { title: e.title, body: e.body, sound: e.sound ?? "none" });
  }

  private layout(): Promise<Layout | undefined> {
    return this.call("pane.layout", { pane_id: this.location.paneId() }).then((r) => r.result?.layout);
  }

  zoom(active: boolean): Promise<unknown> {
    const epoch = this.locationEpoch;
    const call = this.location.guarded(() => epoch === this.locationEpoch);
    this.zoomChain = this.zoomChain.then(async () => {
      if (active) {
        this.zoomHolds++;
        if (this.zoomHolds > 1) return;
        const l = await this.layout();
        if (l?.zoomed !== false || epoch !== this.locationEpoch) return;
        const r = await call("pane.zoom", { pane_id: this.location.paneId(), mode: "on" });
        if (epoch === this.locationEpoch) this.zoomedByUs = !r.error;
        return;
      }
      if (this.zoomHolds === 0) return;
      this.zoomHolds--;
      if (this.zoomHolds > 0 || !this.zoomedByUs || epoch !== this.locationEpoch) return;
      this.zoomedByUs = false;
      await call("pane.zoom", { pane_id: this.location.paneId(), mode: "off" });
    });
    return this.zoomChain;
  }

  async split(e: SplitEvent | undefined): Promise<void> {
    if (!e?.command) return;
    const report = (ok: boolean, message: string) => e.done?.(ok, message);
    const epoch = this.locationEpoch;
    const call = this.location.guarded(() => epoch === this.locationEpoch);
    // A split needs the pane unzoomed; a zoom hold stays counted but is not re-applied.
    if ((this.zoomedByUs || (await this.layout())?.zoomed) && epoch === this.locationEpoch) {
      await call("pane.zoom", { pane_id: this.location.paneId(), mode: "off" });
      if (epoch === this.locationEpoch) this.zoomedByUs = false;
    }
    const l = await this.layout();
    const me = l?.panes?.find((p) => p.pane_id === this.location.paneId());
    const r = await this.call("pane.split", {
      target_pane_id: this.location.paneId(),
      direction: splitDirection(me?.rect),
      cwd: e.cwd,
      focus: true,
    });
    const paneId: string | undefined = r.result?.pane?.pane_id;
    if (!paneId) return report(false, "herdr could not open a split");
    // The split starts a shell; exit it with the command so the pane closes when it ends.
    const run = await this.call("pane.send_input", { pane_id: paneId, text: `${e.command}; exit`, keys: ["enter"] });
    if (run.error) {
      // e.g. macOS refuses input longer than the terminal's line limit (herdr 0.9.4+):
      // do not leave a bare shell behind.
      await this.call("pane.close", { pane_id: paneId });
      return report(false, `herdr opened a split but could not run the command: ${errorText(run)}`);
    }
    report(true, paneId);
  }

  /** Drop every hold (session end); unzooms if pi-herdr zoomed. */
  async reset(): Promise<void> {
    const epoch = this.locationEpoch;
    const call = this.location.guarded(() => epoch === this.locationEpoch);
    if (this.zoomedByUs) await call("pane.zoom", { pane_id: this.location.paneId(), mode: "off" });
    this.zoomHolds = 0;
    this.zoomedByUs = false;
  }
}
