// Session-chrome service (version 1): another plugin that shows a different Pi session in main's
// look (pi-subagents' subagent sessions) draws this footer and editor gauge for it. Discovery is a
// synchronous request over `pi.events`: the consumer emits `{ version: 1 }` on
// `SESSION_CHROME_CHANNEL`; pi-status-footer sets `service` before `emit` returns while the footer
// is on. Consumers copy these declarations structurally.
import type { Paint, Totals } from "./index.ts";

export const SESSION_CHROME_CHANNEL = "pi-plugins.session-chrome.v1";

/** What differs between main and the session shown: everything else (accounts, statuses, git) stays main's. */
export interface SessionChromeOverrides {
  cwd: string;
  provider: string;
  model: string;
  thinking?: string;
  context: { tokens: number | null; contextWindow: number; percent: number | null };
  totals: Totals;
  phase?: string;
  queued?: boolean;
  sessionName?: string;
  /** The session's editor carries the context gauge on its borders (from `gauge`). */
  borderGauge?: boolean;
}

export interface SessionChromeService {
  /** The footer's rows for that session, as main's footer draws them. */
  footer(session: SessionChromeOverrides, width: number, theme: Paint): string[];
  /** Draw the context gauge on an editor's borders while `used()` gives a percentage; false if it has no border hooks. */
  gauge(editor: unknown, used: () => number | null, theme: () => Paint | undefined): boolean;
}

export interface SessionChromeRequest {
  version: 1;
  service?: SessionChromeService;
  provider?: string;
}
