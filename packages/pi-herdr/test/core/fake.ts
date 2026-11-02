import type { Call, Reply } from "../../src/core/herdr.ts";

export interface Logged {
  method: string;
  params: Record<string, any>;
}

/** A fake herdr: handlers by method; every call is logged. Unknown methods answer `{}`. */
export function fakeCall(handlers: Record<string, (params: Record<string, any>) => Reply | Promise<Reply>> = {}) {
  const log: Logged[] = [];
  const call: Call = async (method, params) => {
    log.push({ method, params });
    const h = handlers[method];
    if (h) return await h(params);
    // Legacy integration fixtures describe only pane.get. Give them an explicit caller read;
    // relocation tests override this and reject every obsolete layout address themselves.
    if (method === "pane.current") {
      const own = handlers["pane.get"] ? await handlers["pane.get"]({ pane_id: params.caller_pane_id }) : undefined;
      if (own?.error) return own;
      return { result: { pane: {
        pane_id: params.caller_pane_id, workspace_id: "w1", tab_id: "fixture-tab",
        terminal_id: `fixture-terminal:${params.caller_pane_id}`, ...own?.result?.pane,
      } } };
    }
    if (method === "workspace.get") return { result: { workspace: { workspace_id: params.workspace_id } } };
    return { result: {} };
  };
  return { call, log, of: (method: string) => log.filter((l) => l.method === method) };
}
