// Canonical: shared/transcript/tui-runtime.ts. Sync: node scripts/sync-transcript-helpers.mjs
/**
 * Pi passes a stable TUI Proxy while replacing the renderer. Method reads are
 * bound, but reflection/deletion are not forwarded. Resolve the live receiver
 * before capturing instance handlers or restoring their property descriptors.
 */
const RECEIVER = Symbol("pi-plugins.tui-receiver");

export function resolveTuiRuntime(tui: object): object {
  let receiver = tui;
  try {
    if (!Reflect.set(tui, RECEIVER, function (this: object) { return this; })) return tui;
    const read = Reflect.get(tui, RECEIVER);
    if (typeof read === "function") {
      const actual = read.call(tui);
      if (typeof actual === "object" && actual !== null) receiver = actual;
    }
    return receiver;
  } catch {
    return tui;
  } finally {
    Reflect.deleteProperty(receiver, RECEIVER);
  }
}
