// pi-worktree's placement provider: start a forked session in a worktree's Herdr space.
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { slugName } from "./core/children.ts";
import { type Call, errorText } from "./core/herdr.ts";
import type { CloseResult, PlaceRequest, PlaceResult } from "./place-contract.ts";
import { PI_CHILD } from "./session.ts";

export interface PlaceDeps {
  call: Call;
  selfPane(): Promise<string>;
  uniqueName(wanted: string): Promise<string>;
  isCurrent(): boolean;
  pollMs?: number;
}

const realpath = (p: string) => {
  try { return realpathSync(p); } catch { return resolve(p); }
};

/**
 * Close this session's pane after a move. Herdr refuses to close the last pane of a repository's
 * main space while worktree spaces are grouped under it (confirmation_required): that pane stays.
 */
export async function closeSelf(deps: Pick<PlaceDeps, "call" | "selfPane">): Promise<CloseResult> {
  let pane: string;
  try { pane = await deps.selfPane(); } catch (err) {
    return { ok: false, error: `Could not find this pane in Herdr: ${err instanceof Error ? err.message : String(err)}.` };
  }
  const r = await deps.call("pane.close", { pane_id: pane });
  if (!r.error) return { ok: true };
  if (r.error.code === "confirmation_required") {
    return { ok: false, error: "Herdr keeps it: it is the last pane of the repository's main space, and closing it would close the worktree spaces grouped under it." };
  }
  return { ok: false, error: `Herdr did not close it: ${errorText(r)}.` };
}

export async function placeSession(deps: PlaceDeps, req: PlaceRequest): Promise<PlaceResult> {
  const { call } = deps;
  const created: { paneId?: string } = {};
  let paneId: string | undefined;

  if (req.path === req.root) {
    const snap = await call("session.snapshot", {});
    const ws = (snap.result?.snapshot?.workspaces ?? []).find((w: any) =>
      w.worktree?.checkout_path && realpath(w.worktree.checkout_path) === realpath(req.root) && !w.worktree.is_linked_worktree);
    if (ws) {
      const tab = await call("tab.create", { workspace_id: ws.workspace_id, cwd: req.root, label: req.title, focus: true });
      paneId = tab.result?.root_pane?.pane_id;
      if (!paneId) return { ok: false, error: `herdr could not create a pane: ${errorText(tab)}` };
      created.paneId = paneId;
    } else {
      const space = await call("workspace.create", { cwd: req.root, label: basename(req.root), focus: true });
      paneId = space.result?.root_pane?.pane_id;
      if (!paneId) return { ok: false, error: `herdr could not create a pane: ${errorText(space)}` };
    }
  } else {
    const open = await call("worktree.open", { cwd: req.root, path: req.path, focus: true }, 15_000);
    if (open.error) return { ok: false, error: `herdr could not open the worktree: ${errorText(open)}` };
    if (!open.result?.already_open && open.result?.root_pane?.pane_id) {
      paneId = open.result.root_pane.pane_id;
    } else if (req.kind === "open") {
      return { ok: true, detail: `Focused ${req.path}'s space.` };
    } else {
      const tab = await call("tab.create", { workspace_id: open.result?.workspace?.workspace_id, cwd: req.path, label: req.title, focus: true });
      paneId = tab.result?.root_pane?.pane_id;
      if (!paneId) return { ok: false, error: `herdr could not create a pane: ${errorText(tab)}` };
      created.paneId = paneId;
    }
  }

  const closeCreated = async () => { if (created.paneId) await call("pane.close", { pane_id: created.paneId }); };
  if (!deps.isCurrent()) {
    await closeCreated();
    return { ok: false, error: "This session changed while placing the move; nothing started." };
  }
  const name = await deps.uniqueName(slugName(req.title));
  const args = req.kind === "move"
    ? [...PI_CHILD.args({ task: "", cwd: req.path, model: req.model, thinking: req.thinking } as any, req.title), "--session", req.file, ...(req.prompt ? ["--", req.prompt] : [])]
    : ["--continue"];
  let start = await call("agent.start", { name, kind: "pi", pane_id: paneId, args, timeout_ms: 90_000 }, 95_000);
  for (let i = 0; start.error?.code === "agent_pane_busy" && i < 30; i++) {
    await new Promise((r) => setTimeout(r, deps.pollMs ?? 500));
    start = await call("agent.start", { name, kind: "pi", pane_id: paneId, args, timeout_ms: 90_000 }, 95_000);
  }
  if (start.error) {
    if (start.error.code === "agent_not_ready") {
      return { ok: false, error: `Pi started in ${paneId} but waits on a startup dialog; answer it there. This pane stays open.` };
    }
    if (!["timeout", "socket", "closed", "parse"].includes(start.error.code)) await closeCreated();
    return { ok: false, error: `Pi did not start in ${paneId}: ${errorText(start)}` };
  }
  if (req.kind === "open") return { ok: true, detail: `Opened ${req.path} and resumed its latest session (${name}, ${paneId}).` };
  return {
    ok: true,
    detail: `Continuing in ${req.path} (${name}, ${paneId}).`,
    close: () => closeSelf(deps),
  };
}
