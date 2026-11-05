// Background work other extensions announce on pi's event bus (the channels pi-herdr shows as the
// `bg` token). A move closes this session's pane, so it waits until none is running.
export const HOLD_CHANNELS = ["herdr:background", "herdr:working"] as const;
export type HoldChannel = (typeof HOLD_CHANNELS)[number];

export interface HoldEvent {
  active?: boolean;
  label?: string;
  id?: string;
}

interface Hold {
  channel: HoldChannel;
  label: string;
  id?: string;
}

export class Holds {
  private holds: Hold[] = [];

  apply(channel: HoldChannel, event: HoldEvent | undefined): void {
    if (event?.active) {
      this.holds.push({ channel, label: event.label?.trim() || "background", id: event.id });
      return;
    }
    const i = event?.id !== undefined
      ? this.holds.findIndex((h) => h.channel === channel && h.id === event.id)
      : this.holds.findIndex((h) => h.channel === channel);
    if (i >= 0) this.holds.splice(i, 1);
  }

  labels(): string[] {
    return this.holds.map((h) => h.label);
  }
}
