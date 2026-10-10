// Shared verbatim by pi-herdr and opencode-herdr (src/core).
//
// Work that runs outside the agent's turn, shown as the pane token `bg`: holds on pi's event bus
// (pi-herdr), or the host's own awaited children (both hosts).
//
// In pi, extensions hold a channel with `{ active: true, label, id? }` and release it with
// `{ active: false, id? }`:
//   herdr:background  background work that will wake the agent (async subagents, herdr children)
//   herdr:working     work running outside the main turn (pi-plan-mode's planner runs)
// A release without an id ends the oldest hold on that channel.
//
// herdr itself still shows the pane idle or done meanwhile: only herdr's own integration for the
// agent reports state. The token is what says the agent is not finished.

export const ACTIVITY_CHANNELS = ["herdr:background", "herdr:working"] as const;
export type ActivityChannel = (typeof ACTIVITY_CHANNELS)[number];

export interface HoldEvent {
  active?: boolean;
  label?: string;
  id?: string;
}

interface Hold {
  channel: ActivityChannel;
  label: string;
  id?: string;
}

export class Activity {
  private holds: Hold[] = [];

  apply(channel: ActivityChannel, event: HoldEvent | undefined): void {
    if (event?.active) {
      this.holds.push({ channel, label: event.label?.trim() || (channel === "herdr:working" ? "working" : "background"), id: event.id });
      return;
    }
    const i = event?.id !== undefined ? this.holds.findIndex((h) => h.channel === channel && h.id === event.id) : this.holds.findIndex((h) => h.channel === channel);
    if (i >= 0) this.holds.splice(i, 1);
  }

  clear(): void {
    this.holds = [];
  }

  get size(): number {
    return this.holds.length;
  }

  /** The `bg` token: the labels, repeated ones counted ("subagents (2) · child auth ×2"), or undefined. */
  token(): string | undefined {
    if (!this.holds.length) return undefined;
    const counts = new Map<string, number>();
    for (const h of this.holds) counts.set(h.label, (counts.get(h.label) ?? 0) + 1);
    return [...counts].map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(" · ");
  }
}
