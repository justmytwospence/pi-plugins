/**
 * SDK 1.1.0 passes a stable TUI Proxy to editors while replacing its renderer.
 * Method reads are bound to that renderer, but reflection/deletion are not
 * forwarded. A synchronous, temporary receiver method resolves the real TUI
 * without retaining the Proxy's freshly bound functions or leaking a property.
 */
const RECEIVER = Symbol("pi-vim.tui-receiver");

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
