import { AsyncLocalStorage } from "node:async_hooks";

const KEY = Symbol.for("pi-plugins.effort-origin.v1");
const shared = globalThis as typeof globalThis & { [KEY]?: AsyncLocalStorage<string> };
const origins = shared[KEY] ?? new AsyncLocalStorage<string>();
shared[KEY] = origins;

/** Write provenance only; asynchronous native model/default events inherit their owner. */
export function withEffortOrigin<T>(origin: string, run: () => T): T {
  return origins.run(origin, run);
}

export function effortOrigin(): string | undefined {
  return origins.getStore();
}
