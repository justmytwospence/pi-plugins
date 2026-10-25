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

export class Bridge {
  private zoomHolds = 0;
  /** Whether pi-herdr zoomed the pane (and so should unzoom it). */
  private zoomedByUs = false;
  private zoomChain: Promise<unknown> = Promise.resolve();

  private readonly call: Call;
  private readonly pane: PaneReporter;

  constructor(call: Call, pane: PaneReporter) {
    this.call = call;
    this.pane = pane;
  }

  token(e: TokenEvent | undefined): Promise<unknown> {
    if (!e || typeof e.key !== "string") return Promise.resolve();
    return this.pane.setToken(e.key, typeof e.value === "string" ? e.value : undefined, e.ttlMs);
  }

  async notify(e: NotifyEvent | undefined): Promise<void> {
    if (!e?.title) return;
    if (e.unlessFocused) {
      const pane = await this.call("pane.get", { pane_id: this.pane.paneId });
      if (pane.result?.pane?.focused === true) return;
    }
    await this.call("notification.show", { title: e.title, body: e.body, sound: e.sound ?? "none" });
  }

  private layout(): Promise<Layout | undefined> {
    return this.call("pane.layout", { pane_id: this.pane.paneId }).then((r) => r.result?.layout);
  }

  zoom(active: boolean): Promise<unknown> {
    this.zoomChain = this.zoomChain.then(async () => {
      if (active) {
        this.zoomHolds++;
        if (this.zoomHolds > 1) return;
        const l = await this.layout();
        if (l?.zoomed !== false) return;
        const r = await this.call("pane.zoom", { pane_id: this.pane.paneId, mode: "on" });
        this.zoomedByUs = !r.error;
        return;
      }
      if (this.zoomHolds === 0) return;
      this.zoomHolds--;
      if (this.zoomHolds > 0 || !this.zoomedByUs) return;
      this.zoomedByUs = false;
      await this.call("pane.zoom", { pane_id: this.pane.paneId, mode: "off" });
    });
    return this.zoomChain;
  }

  async split(e: SplitEvent | undefined): Promise<void> {
    if (!e?.command) return;
    const report = (ok: boolean, message: string) => e.done?.(ok, message);
    // A split needs the pane unzoomed; a zoom hold stays counted but is not re-applied.
    if (this.zoomedByUs || (await this.layout())?.zoomed) {
      await this.call("pane.zoom", { pane_id: this.pane.paneId, mode: "off" });
      this.zoomedByUs = false;
    }
    const l = await this.layout();
    const me = l?.panes?.find((p) => p.pane_id === this.pane.paneId);
    const r = await this.call("pane.split", {
      target_pane_id: this.pane.paneId,
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
    if (this.zoomedByUs) await this.call("pane.zoom", { pane_id: this.pane.paneId, mode: "off" });
    this.zoomHolds = 0;
    this.zoomedByUs = false;
  }
}
