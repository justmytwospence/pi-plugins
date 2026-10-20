// The Herdr side of Sidebar: create its pane beside main, park it in a hidden tab (the process
// keeps running) and bring it back. The park/show approach follows herdr-sidekick
// (github.com/qapquiz/herdr-sidekick). Commands go through the Herdr CLI, whose output is JSON.
import { execFile } from "node:child_process";

export type Runner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const cliRunner: Runner = (args) =>
  new Promise((resolve) => {
    execFile(process.env.HERDR_BIN_PATH || "herdr", args, { timeout: 130_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message ?? "") });
    });
  });

export interface PaneInfo {
  pane_id: string;
  tab_id: string;
  workspace_id?: string;
  label?: string;
  focused?: boolean;
}

export interface TabInfo {
  tab_id: string;
  label?: string;
}

export const PARK_TAB_LABEL = "sidebar-parked";

export function sidebarLabel(mainPaneId: string): string {
  return `sidebar ${mainPaneId}`;
}

export type Direction = "right" | "down";

/**
 * Beside main when both halves keep `minColumns` columns, otherwise below it. Without a known size,
 * beside.
 */
export function splitDirection(rect: { width: number } | undefined, minColumns: number): Direction {
  if (!rect) return "right";
  return rect.width >= 2 * minColumns + 1 ? "right" : "down";
}

/** Herdr's --ratio is the share the existing (left or top) pane keeps; ours is Sidebar's share. */
export function targetShare(sidebarShare: number): string {
  return String(Math.round((1 - sidebarShare) * 100) / 100);
}

export function inHerdr(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID;
}

export class Herdr {
  constructor(private readonly run: Runner = cliRunner, private readonly sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))) {}

  private async json(args: string[]): Promise<any> {
    const { code, stdout, stderr } = await this.run(args);
    let parsed: any;
    try {
      parsed = stdout.trim() ? JSON.parse(stdout) : undefined;
    } catch {
      parsed = undefined;
    }
    if (code !== 0 || parsed?.error) {
      const message = parsed?.error?.message ?? (stderr.trim() || stdout.trim() || `exit ${code}`);
      throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${message}`);
    }
    return parsed;
  }

  async pane(paneId: string): Promise<PaneInfo | undefined> {
    try {
      return (await this.json(["pane", "get", paneId]))?.result?.pane;
    } catch {
      return undefined;
    }
  }

  async panes(workspaceId?: string): Promise<PaneInfo[]> {
    const args = ["pane", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])];
    return (await this.json(args))?.result?.panes ?? [];
  }

  async tabs(workspaceId?: string): Promise<TabInfo[]> {
    const args = ["tab", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])];
    return (await this.json(args))?.result?.tabs ?? [];
  }

  async findByLabel(label: string): Promise<PaneInfo | undefined> {
    return (await this.panes()).find((pane) => pane.label === label);
  }

  /** A pane's size in cells, from its tab's layout. */
  async rect(paneId: string): Promise<{ width: number; height: number } | undefined> {
    try {
      const layout = (await this.json(["pane", "layout", "--pane", paneId]))?.result?.layout;
      return layout?.panes?.find((p: { pane_id: string }) => p.pane_id === paneId)?.rect;
    } catch {
      return undefined;
    }
  }

  async split(target: string, opts: { direction: Direction; ratio: number; cwd: string; env: Record<string, string>; focus: boolean }): Promise<string> {
    const args = ["pane", "split", target, "--direction", opts.direction, "--ratio", targetShare(opts.ratio), "--cwd", opts.cwd, opts.focus ? "--focus" : "--no-focus"];
    for (const [key, value] of Object.entries(opts.env)) args.push("--env", `${key}=${value}`);
    const id = (await this.json(args))?.result?.pane?.pane_id;
    if (!id) throw new Error("herdr could not split the pane");
    return id;
  }

  async rename(paneId: string, label: string): Promise<void> {
    await this.json(["pane", "rename", paneId, label]);
  }

  /** Starts pi in a fresh pane, retrying while its shell is still starting. */
  async startPi(name: string, paneId: string, args: string[]): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await this.sleep(attempt === 1 ? 700 : 1500);
      try {
        await this.json(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "120000", "--", ...args]);
        return;
      } catch (error) {
        lastError = error;
        if (!/busy|not ready|prompt/i.test(String((error as Error).message))) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** Moves a pane beside or below `target`, in target's tab. Returns its (possibly new) id. */
  async show(paneId: string, target: PaneInfo, direction: Direction, ratio: number, focus: boolean): Promise<string> {
    const result = await this.json([
      "pane", "move", paneId, "--tab", target.tab_id, "--split", direction, "--target-pane", target.pane_id,
      "--ratio", targetShare(ratio), focus ? "--focus" : "--no-focus",
    ]);
    return result?.result?.move_result?.pane?.pane_id ?? paneId;
  }

  /** Moves a pane into the hidden parking tab of its workspace, creating that tab when needed. */
  async park(paneId: string, workspaceId?: string): Promise<string> {
    const parked = (await this.tabs(workspaceId)).find((tab) => tab.label === PARK_TAB_LABEL);
    // With --new-tab, --label names the new tab (not the pane).
    const args = parked
      ? ["pane", "move", paneId, "--tab", parked.tab_id, "--split", "down", "--no-focus"]
      : ["pane", "move", paneId, "--new-tab", ...(workspaceId ? ["--workspace", workspaceId] : []), "--label", PARK_TAB_LABEL, "--no-focus"];
    const result = await this.json(args);
    return result?.result?.move_result?.pane?.pane_id ?? paneId;
  }

  async close(paneId: string): Promise<void> {
    await this.json(["pane", "close", paneId]);
  }

  async focusTab(tabId: string): Promise<void> {
    await this.json(["tab", "focus", tabId]);
  }
}
