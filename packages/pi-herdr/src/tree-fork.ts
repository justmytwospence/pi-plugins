import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { TreeSelectorComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Call, errorText, splitDirection } from "./core/herdr.ts";
import { createTreeFork } from "./fork-session.ts";
import { PI_CHILD } from "./session.ts";

export const FORK_TITLE = "Open fork in Herdr?";
export const FORK_DESTINATIONS = ["New tab", "Split beside this pane"];

interface ForkDependencies {
  call: Call;
  selfPane: string;
  /** Capture the current runtime generation; the returned guard must survive awaits. */
  runtimeCurrent(): () => boolean;
  uniqueName(wanted: string): Promise<string>;
}

interface PaneOptions {
  call: Call;
  selfPane: string;
  isCurrent(): boolean;
  where: "tab" | "split";
  cwd: string;
  name: string;
  file: string;
  model?: string;
  thinking?: string;
}

/** Launch an independent idle session. Never register child ownership or deliver input. */
export async function openForkPane(opts: PaneOptions): Promise<string> {
  const { call, selfPane, name, cwd, file } = opts;
  let paneId: string | undefined;
  let startAttempted = false;
  const assert = () => {
    if (!opts.isCurrent()) throw new Error("Source session switched or reloaded; fork startup stopped");
  };
  try {
    assert();
    const self = await call("pane.get", { pane_id: selfPane });
    assert();
    const workspace = self.result?.pane?.workspace_id;
    if (!workspace) throw new Error(`herdr could not resolve the source workspace: ${errorText(self)}`);
    if (opts.where === "split") {
      const layout = await call("pane.layout", { pane_id: selfPane });
      assert();
      if (layout.error) throw new Error(`herdr could not read the pane layout: ${errorText(layout)}`);
      const me = layout.result?.layout?.panes?.find((p: { pane_id: string }) => p.pane_id === selfPane);
      const split = await call("pane.split", { target_pane_id: selfPane, direction: splitDirection(me?.rect), cwd, focus: false });
      paneId = split.result?.pane?.pane_id;
      if (!paneId) throw new Error(`herdr could not split the pane: ${errorText(split)}`);
    } else {
      const tab = await call("tab.create", { workspace_id: workspace, cwd, label: name, focus: false });
      paneId = tab.result?.root_pane?.pane_id;
      if (!paneId) throw new Error(`herdr could not create a tab: ${errorText(tab)}`);
    }
    assert();
    const args = [...PI_CHILD.args({ task: "", cwd, model: opts.model, thinking: opts.thinking }, name), "--session", file];
    for (let retry = 0; ; retry++) {
      assert();
      startAttempted = true;
      const start = await call("agent.start", { name, kind: "pi", pane_id: paneId, args, timeout_ms: 90_000 }, 95_000);
      if (start.error?.code === "agent_pane_busy" && retry < 30) {
        // A busy response definitively means Pi has not started.
        startAttempted = false;
        assert();
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (start.error) {
        if (start.error.code === "agent_not_ready") {
          throw new Error(`Fork ${name} (${paneId}) is waiting on a startup dialog; answer it in that pane`);
        }
        // Transport failures can hide a successful start. Never close or retry them.
        if (!["timeout", "socket", "closed", "parse"].includes(start.error.code)) {
          startAttempted = false;
        }
        throw new Error(`Fork ${name} (${paneId}) startup failed or is uncertain: ${errorText(start)}`);
      }
      assert();
      return paneId;
    }
  } catch (error) {
    if (paneId && !startAttempted) await call("pane.close", { pane_id: paneId });
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Session file retained: ${file}${paneId ? `. Fork pane: ${paneId}` : ""}`);
  }
}

export function registerTreeFork(pi: ExtensionAPI, deps: ForkDependencies): void {
  if (typeof pi.registerCommand !== "function") return;
  let running = false;
  pi.registerCommand("tree-fork", {
    description: "Fork a session-tree point into a new Herdr tab or split",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui" || !ctx.hasUI) return ctx.ui.notify("/tree-fork requires interactive Pi in Herdr.", "warning");
      if (args.trim()) return ctx.ui.notify("Usage: /tree-fork", "warning");
      if (running) return ctx.ui.notify("/tree-fork is already open.", "warning");
      running = true;
      try {
        const manager = ctx.sessionManager;
        const file = manager.getSessionFile();
        if (!file || !existsSync(file) || statSync(file).size === 0) return ctx.ui.notify("Save this session before using /tree-fork.", "warning");
        const tree = structuredClone(manager.getTree());
        if (!tree.length) return ctx.ui.notify("This session tree is empty.", "warning");
        const sessionId = manager.getSessionId();
        const leaf = manager.getLeafId();
        const sessionDir = manager.getSessionDir();
        const cwd = ctx.cwd;
        const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
        const thinking = pi.getThinkingLevel();
        const runtimeCurrent = deps.runtimeCurrent();
        const current = () => runtimeCurrent() && manager.getSessionId() === sessionId && manager.getSessionFile() === file;
        const assert = () => { if (!current()) throw new Error("Source session switched or reloaded; /tree-fork cancelled."); };
        assert();
        const hold = `tree-fork:${randomUUID()}`;
        let entryId: string | undefined;
        let destination: string | undefined;
        pi.events.emit("herdr:blocked", { active: true, id: hold, label: "Fork session tree" });
        try {
          entryId = await ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
            const picker = new TreeSelectorComponent(tree, leaf, tui.terminal.rows, (id) => done(id), () => done(undefined), undefined, leaf ?? undefined, "default");
            picker.getTreeList().onLabelEdit = undefined;
            return picker;
          });
          assert();
          if (entryId === undefined) return;
          destination = await ctx.ui.select(FORK_TITLE, FORK_DESTINATIONS);
          assert();
        } finally {
          pi.events.emit("herdr:blocked", { active: false, id: hold });
        }
        if (!destination || entryId === undefined) return;
        const name = await deps.uniqueName(`fork-${entryId}`);
        assert();
        const forkFile = createTreeFork(file, sessionDir, cwd, entryId);
        const paneId = await openForkPane({ call: deps.call, selfPane: deps.selfPane, isCurrent: current, where: destination === FORK_DESTINATIONS[0] ? "tab" : "split", cwd, name, file: forkFile, model, thinking });
        assert();
        ctx.ui.notify(`Fork opened in ${name} (${paneId}). Original session unchanged.`, "info");
      } catch (error) {
        // A disposed runtime cannot display a notification; retain the recovery error for live UIs.
        try { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } catch { /* disposed */ }
      } finally {
        running = false;
      }
    },
  });
}
