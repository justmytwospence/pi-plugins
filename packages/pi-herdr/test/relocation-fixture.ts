import type { Reply } from "../src/core/herdr.ts";
import type { HerdrEvent } from "../src/events.ts";
import { fakeCall } from "./core/fake.ts";

type Handler = (params: Record<string, any>) => Reply | Promise<Reply>;

/** A strict Herdr model: caller aliases work only for pane.current, never ordinary targets. */
export function relocatingHerdr(handlers: Record<string, Handler> = {}) {
  const state = {
    paneId: "w1:p1", workspaceId: "w1", tabId: "tab-original", terminalId: "terminal-preserved",
    focused: false, cwd: "/repo", session: "/sessions/self.jsonl", name: "self",
    closedSubscriptions: 0,
  };
  const inherited = state.paneId;
  const aliases = new Set([inherited]);
  const tokens: Record<string, string> = {};
  const subscribers = new Set<{ onEvent(e: HerdrEvent): void; onResync(): void }>();
  const gone = () => ({ error: { code: "pane_not_found", message: "obsolete or unrelated pane" } });
  const pane = () => ({
    pane_id: state.paneId, workspace_id: state.workspaceId, tab_id: state.tabId,
    terminal_id: state.terminalId, focused: state.focused, cwd: state.cwd, tokens: { ...tokens },
  });
  const agent = () => ({ ...pane(), name: state.name, agent: "pi", agent_status: "idle", agent_session: { kind: "path", value: state.session } });
  const own = (target: unknown) => target === state.paneId || target === state.name;
  const fallback = (method: string, p: Record<string, any>): Reply | Promise<Reply> => handlers[method]?.(p) ?? gone();
  const f = fakeCall({
    ...handlers,
    "pane.current": (p) => p.caller_pane_id === inherited ? { result: { pane: pane() } } : gone(),
    "workspace.get": (p) => handlers["workspace.get"]?.(p) ?? { result: { workspace: { workspace_id: p.workspace_id } } },
    "pane.get": (p) => p.pane_id === state.paneId ? { result: { pane: pane() } } : aliases.has(p.pane_id) ? gone() : fallback("pane.get", p),
    "agent.get": (p) => own(p.target) ? { result: { agent: agent() } } : aliases.has(p.target) ? gone() : fallback("agent.get", p),
    "agent.list": (p) => handlers["agent.list"]?.(p) ?? { result: { agents: [agent()] } },
    "pane.report_metadata": (p) => {
      if (p.pane_id !== state.paneId) return gone();
      for (const [key, value] of Object.entries(p.tokens ?? {})) {
        if (value === null) delete tokens[key];
        else tokens[key] = String(value);
      }
      return { result: {} };
    },
    "pane.layout": (p) => p.pane_id === state.paneId ? { result: { layout: { zoomed: false, panes: [{ pane_id: state.paneId, rect: { width: 220, height: 50 } }] } } } : gone(),
    "pane.split": (p) => p.target_pane_id === state.paneId ? { result: { pane: { pane_id: `${state.workspaceId}:new-split` } } } : gone(),
    "tab.create": (p) => p.workspace_id === state.workspaceId ? { result: { root_pane: { pane_id: `${state.workspaceId}:new-tab` } } } : gone(),
  });
  return {
    f, state, tokens,
    subscribe: (onEvent: (e: HerdrEvent) => void, onResync: () => void) => {
      const entry = { onEvent, onResync };
      subscribers.add(entry);
      return { close: () => { if (subscribers.delete(entry)) state.closedSubscriptions++; } };
    },
    resync: () => { for (const sub of subscribers) sub.onResync(); },
    move: (paneId: string, workspaceId: string, notify = true) => {
      const previous = state.paneId;
      aliases.add(paneId);
      state.paneId = paneId;
      state.workspaceId = workspaceId;
      state.tabId = `tab-${workspaceId}`;
      if (notify) for (const sub of subscribers) sub.onEvent({ event: "pane_moved", data: { previous_pane_id: previous, pane: pane() } });
    },
  };
}
