// Working-row statistics: extends pi's working indicator message while the
// agent runs, keeping pi's own spinner and base label:
//   Working (↓ 1,234 tokens · 12s)
// Tokens start as a chars/4 estimate of the streamed text and thinking, and
// switch to the provider's `usage.output` as soon as the stream carries one.
// Elapsed time appears once the run has lasted SHOW_TIMER_AFTER_MS, or as
// soon as there are tokens to show.
// Ported from pi-cc-extensions' working-message (MIT, (c) minuque).
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";

export const WORKING_REFRESH_MS = 1_000;
/** Elapsed time is only shown once the run has lasted this long. */
export const SHOW_TIMER_AFTER_MS = 3_000;

const count = new Intl.NumberFormat("en-US");

/** Milliseconds as "1h 2m 3s", "2m 3s" or "3s"; under a second, "0s". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The message for pi's working indicator, or undefined to leave pi's default. */
export function workingMessage(tokens: number, elapsedMs: number, base = "Working"): string | undefined {
  const parts: string[] = [];
  if (tokens > 0) parts.push(`\u2193 ${count.format(tokens)} token${tokens === 1 ? "" : "s"}`);
  if (elapsedMs >= SHOW_TIMER_AFTER_MS || tokens > 0) parts.push(formatElapsed(elapsedMs));
  return parts.length ? `${base} (${parts.join(" \u00b7 ")})` : undefined;
}

type Partial = Pick<AssistantMessage, "content" | "usage">;

/** Visible text/thinking length per content index; indexes without such a block stay sparse. */
function blockLengths(message: Partial | undefined): number[] {
  const lengths: number[] = [];
  const content = message?.content;
  if (!Array.isArray(content)) return lengths;
  content.forEach((block, index) => {
    if (block?.type === "text" && typeof block.text === "string") lengths[index] = block.text.length;
    else if (block?.type === "thinking" && typeof block.thinking === "string") lengths[index] = block.thinking.length;
  });
  return lengths;
}

function outputUsage(message: Partial | undefined): number {
  const value = Number(message?.usage?.output);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** Streamed-output accounting for one run: a live estimate until the provider reports a count. */
export class WorkingStats {
  private lengths: number[] = [];
  private chars = 0;
  private providerOutput = 0;

  /** Start over, optionally from a message already in progress. */
  reset(message?: Partial): void {
    this.lengths = blockLengths(message);
    this.chars = this.lengths.reduce((sum, length) => sum + length, 0);
    this.providerOutput = outputUsage(message);
  }

  /** Output tokens so far: the provider's count when known, else the chars/4 estimate. */
  tokens(): number {
    return this.providerOutput || Math.max(0, Math.round(this.chars / 4));
  }

  private setLength(index: number, length: number): void {
    const previous = this.lengths[index] ?? 0;
    this.lengths[index] = Math.max(0, length);
    this.chars = Math.max(0, this.chars + this.lengths[index] - previous);
  }

  private usage(message: Partial | undefined): void {
    const output = outputUsage(message);
    if (output > 0) this.providerOutput = output;
  }

  apply(event: AssistantMessageEvent): void {
    switch (event.type) {
      case "start": this.reset(event.partial); break;
      case "text_start": case "thinking_start":
        this.setLength(event.contentIndex, 0); this.usage(event.partial); break;
      case "text_delta": case "thinking_delta":
        this.setLength(event.contentIndex, (this.lengths[event.contentIndex] ?? 0) + (typeof event.delta === "string" ? event.delta.length : 0));
        this.usage(event.partial); break;
      case "text_end": case "thinking_end":
        this.setLength(event.contentIndex, typeof event.content === "string" ? event.content.length : 0);
        this.usage(event.partial); break;
      case "done": this.reset(event.message); break;
      case "error": this.reset(event.error); break;
      default: this.usage(event.partial);
    }
  }
}
