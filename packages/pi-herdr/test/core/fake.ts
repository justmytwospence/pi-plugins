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
    return h ? await h(params) : { result: {} };
  };
  return { call, log, of: (method: string) => log.filter((l) => l.method === method) };
}
