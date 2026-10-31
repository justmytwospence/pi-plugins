/** Let exactly the hosted SessionView receive keys before Pi's fullscreen viewport. */
type Host = {
  shouldDeferViewportInputToOverlay?: () => boolean;
  getFocusedComponent?: () => unknown;
};
type Guard = { owners: Map<object, number>; wrapper: () => boolean; descriptor?: PropertyDescriptor };
const guards = new WeakMap<object, Guard>();
const RECEIVER = Symbol("pi-subagents.tui-receiver");

/** Pi's stable proxy binds methods to the current renderer but does not forward reflection. */
function resolveRuntime(tui: object): object {
  let receiver = tui;
  try {
    if (!Reflect.set(tui, RECEIVER, function (this: object) { return this; })) return tui;
    const method = Reflect.get(tui, RECEIVER);
    if (typeof method === "function") {
      const actual = method.call(tui);
      if (actual && typeof actual === "object") receiver = actual;
    }
    return receiver;
  } catch {
    return tui;
  } finally {
    try { Reflect.deleteProperty(receiver, RECEIVER); } catch { /* Unsupported renderer. */ }
  }
}

export function acquireViewportInput(tui: unknown, owner: object): () => void {
  if (!tui || typeof tui !== "object") return () => {};
  const runtime = resolveRuntime(tui);
  const host = runtime as Host;
  if (typeof host.shouldDeferViewportInputToOverlay !== "function" || typeof host.getFocusedComponent !== "function") return () => {};
  let guard = guards.get(runtime);
  if (!guard) {
    const original = host.shouldDeferViewportInputToOverlay;
    const owners = new Map<object, number>();
    const wrapper = function (this: Host) {
      return original.call(this) || owners.has(this.getFocusedComponent?.() as object);
    };
    guard = { owners, wrapper, descriptor: Object.getOwnPropertyDescriptor(host, "shouldDeferViewportInputToOverlay") };
    try {
      if (!Reflect.set(host, "shouldDeferViewportInputToOverlay", wrapper)) return () => {};
    } catch { return () => {}; }
    guards.set(runtime, guard);
  }
  guard.owners.set(owner, (guard.owners.get(owner) ?? 0) + 1);
  const shared = guard;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = shared.owners.get(owner) ?? 0;
    if (count > 1) shared.owners.set(owner, count - 1);
    else shared.owners.delete(owner);
    if (shared.owners.size) return;
    if (host.shouldDeferViewportInputToOverlay === shared.wrapper) {
      if (shared.descriptor) Object.defineProperty(host, "shouldDeferViewportInputToOverlay", shared.descriptor);
      else delete host.shouldDeferViewportInputToOverlay;
    }
    guards.delete(runtime);
  };
}
