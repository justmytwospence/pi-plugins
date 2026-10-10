// Shows the kernel hold (core/hold.ts) in herdr through pi-herdr's event-bus bridge: while the
// kernel holds, the pane token `marimo` (`$marimo` in a sidebar row) says what runs; when the run
// ends the token is cleared and a notification with the done sound says it finished, unless the
// pane is focused. pi-herdr does the herdr work (only in an interactive pi inside herdr); without
// it nothing listens. opencode-marimo keeps its own socket reporter; claude-marimo uses the CLI.
//
// herdr's pi and opencode integrations are the sole authority over the pane's idle/working state,
// so this never reports state.
import { HERDR_TOKEN, type HoldChange } from "./core/hold.js";

export interface EventBus {
  emit(channel: string, data: unknown): void;
}

/** Turns hold changes into pi-herdr events. */
export class HerdrHold {
  private value: string | undefined;
  private readonly events: EventBus | undefined;

  constructor(events: EventBus | undefined) {
    this.events = events;
  }

  apply(change: HoldChange): Promise<void> {
    const events = this.events;
    if (!events || change.kind === "none") return Promise.resolve();
    if (change.kind === "held") {
      this.value = change.value;
      events.emit("herdr:token", { key: HERDR_TOKEN, value: change.value });
      return Promise.resolve();
    }
    if (this.value !== undefined) events.emit("herdr:token", { key: HERDR_TOKEN, value: undefined });
    this.value = undefined;
    if (change.kind === "finished") events.emit("herdr:notify", { title: change.title, body: change.body, sound: "done", unlessFocused: true });
    return Promise.resolve();
  }

  /** pi-herdr became active during a hold: send the token again. */
  resend(): void {
    if (this.events && this.value !== undefined) this.events.emit("herdr:token", { key: HERDR_TOKEN, value: this.value });
  }
}
