import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { BorderedLoader, TreeSelectorComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Call, errorText, splitDirection } from "./core/herdr.ts";
import { slugName } from "./core/children.ts";
import { captureForkNameContext, generateForkTitle } from "./fork-name.ts";
import { projectForkTree } from "./fork-points.ts";
import { createTreeFork } from "./fork-session.ts";
import { PI_CHILD } from "./session.ts";

export const FORK_TITLE = "Open fork in Herdr?";
export const FORK_DESTINATIONS = ["New tab", "Split beside this pane", "New space"];

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
  where: "tab" | "split" | "space";
  cwd: string;
  name: string;
  title: string;
  file: string;
  model?: string;
  thinking?: string;
}

/** Launch an independent idle session. Never register child ownership or deliver input. */
export async function openForkPane(opts: PaneOptions): Promise<string> {
  const { call, selfPane, name, title, cwd, file } = opts;
  let paneId: string | undefined;
  let workspaceId: string | undefined;
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
    } else if (opts.where === "space") {
      const space = await call("workspace.create", { cwd, label: title, focus: false });
      workspaceId = space.result?.workspace?.workspace_id;
      paneId = space.result?.root_pane?.pane_id;
      if (space.error || !workspaceId || !paneId) throw new Error(`herdr could not create a space: ${errorText(space)}`);
    } else {
      const tab = await call("tab.create", { workspace_id: workspace, cwd, label: title, focus: false });
      paneId = tab.result?.root_pane?.pane_id;
      if (!paneId) throw new Error(`herdr could not create a tab: ${errorText(tab)}`);
    }
    assert();
    const args = [...PI_CHILD.args({ task: "", cwd, model: opts.model, thinking: opts.thinking }, title), "--session", file];
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
    let cleanupError = "";
    if (!startAttempted && (workspaceId || paneId)) {
      try {
        const closed = workspaceId
          ? await call("workspace.close", { workspace_id: workspaceId })
          : opts.where !== "space" ? await call("pane.close", { pane_id: paneId }) : undefined;
        if (closed?.error) throw new Error(errorText(closed));
      } catch (cleanup) {
        cleanupError = `. Cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`;
      }
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}. Session file retained: ${file}${workspaceId ? `. Fork space: ${workspaceId}` : ""}${paneId ? `. Fork pane: ${paneId}` : ""}${cleanupError}`);
  }
}

export function registerTreeFork(pi: ExtensionAPI, deps: ForkDependencies): void {
  if (typeof pi.registerCommand !== "function") return;
  let running = false;
  for (const command of ["tree-fork", "fork-here"] as const) {
    const direct = command === "fork-here";
    pi.registerCommand(command, {
      description: direct ? "Fork the current session into a new Herdr tab, split or space" : "Fork a session-tree point into a new Herdr tab, split or space",
      handler: async (args, ctx) => {
        if (ctx.mode !== "tui" || !ctx.hasUI) return ctx.ui.notify(`/${command} requires interactive Pi in Herdr.`, "warning");
        if (!direct && args.trim()) return ctx.ui.notify("Usage: /tree-fork", "warning");
        const explicitTitle = args.trim();
        if (direct && (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(args) || explicitTitle.length > 60)) {
          return ctx.ui.notify("Usage: /fork-here [name] (one line, at most 60 characters).", "warning");
        }
        if (running) return ctx.ui.notify(`/${command} is already open.`, "warning");
        const requireIdle = () => {
          if (!direct || ctx.isIdle()) return true;
          ctx.ui.notify("Wait for the current turn to finish before using /fork-here.", "warning");
          return false;
        };
        if (!requireIdle()) return;
        running = true;
        try {
          const manager = ctx.sessionManager;
          const file = manager.getSessionFile();
          if (!file || !existsSync(file) || statSync(file).size === 0) return ctx.ui.notify(`Save this session before using /${command}.`, "warning");
          const leafId = manager.getLeafId();
          if (direct && !leafId) return ctx.ui.notify("This session has no current point to fork.", "warning");
          const projection = direct ? undefined : projectForkTree(structuredClone(manager.getTree()), leafId);
          if (projection && !projection.tree.length) return ctx.ui.notify("No user prompts or completed answers to fork from.", "warning");
          const sessionId = manager.getSessionId();
          const sessionDir = manager.getSessionDir();
          const cwd = ctx.cwd;
          const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
          const thinking = pi.getThinkingLevel();
          const runtimeCurrent = deps.runtimeCurrent();
          const current = () => runtimeCurrent() && manager.getSessionId() === sessionId && manager.getSessionFile() === file;
          const assert = () => { if (!current()) throw new Error(`Source session switched or reloaded; /${command} cancelled.`); };
          assert();
          const hold = `${command}:${randomUUID()}`;
          let entryId: string | undefined = direct ? leafId ?? undefined : undefined;
          let context = entryId === undefined ? undefined : captureForkNameContext(manager, entryId);
          let destination: string | undefined;
          let title: string | undefined;
          pi.events.emit("herdr:blocked", { active: true, id: hold, label: direct ? "Fork current session" : "Fork session tree" });
          try {
            if (projection) {
              const { tree, leafId: leaf, ids } = projection;
              entryId = await ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) => {
                const picker = new TreeSelectorComponent(tree, leaf, tui.terminal.rows, (id) => done(id), () => done(undefined), undefined, leaf ?? undefined, "default");
                picker.getTreeList().onLabelEdit = undefined;
                return picker;
              });
              assert();
              if (entryId === undefined) return;
              if (!ids.has(entryId)) throw new Error("Selected entry is not an available fork point.");
              context = captureForkNameContext(manager, entryId);
            }
            if (!context) return;
            const nameContext = context;
            destination = await ctx.ui.select(FORK_TITLE, FORK_DESTINATIONS);
            assert();
            if (!destination) return;
            title = direct && explicitTitle ? explicitTitle : await ctx.ui.custom<string | undefined>((tui, theme, _kb, done) => {
              const loader = new BorderedLoader(tui, theme, "Naming fork…");
              let settled = false;
              const finish = (result: string | undefined) => {
                if (settled) return;
                settled = true;
                loader.dispose();
                done(result);
              };
              loader.onAbort = () => finish(undefined);
              void generateForkTitle(ctx.modelRegistry, nameContext, { signal: loader.signal }).then(finish, () => finish(undefined));
              return loader;
            });
            assert();
          } finally {
            pi.events.emit("herdr:blocked", { active: false, id: hold });
          }
          if (!destination || entryId === undefined || title === undefined) return;
          const where = destination === FORK_DESTINATIONS[0] ? "tab"
            : destination === FORK_DESTINATIONS[1] ? "split"
            : destination === FORK_DESTINATIONS[2] ? "space" : undefined;
          if (!where) throw new Error("Unknown fork destination.");
          const name = await deps.uniqueName(slugName(title));
          assert();
          if (!requireIdle()) return;
          const forkFile = createTreeFork(file, sessionDir, cwd, entryId);
          const paneId = await openForkPane({ call: deps.call, selfPane: deps.selfPane, isCurrent: current, where, cwd, name, title, file: forkFile, model, thinking });
          assert();
          ctx.ui.notify(`Fork opened: ${title} (${name}, ${paneId}). Original session unchanged.`, "info");
        } catch (error) {
          // A disposed runtime cannot display a notification; retain the recovery error for live UIs.
          try { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } catch { /* disposed */ }
        } finally {
          running = false;
        }
      },
    });
  }
}
