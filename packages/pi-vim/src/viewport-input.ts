/**
 * SDK 1.1.0's fullscreen listener precedes public addInputListener hooks.
 * It dynamically calls handleViewportInput, so this narrow adapter lets an
 * explicitly marked editor own Ctrl+U/D even when native half-page bindings
 * map those keys. Other keys and unknown/non-editor focus are untouched.
 */
import { matchesKey } from "@earendil-works/pi-tui";
import { readInputContext } from "./contract.js";

type ViewportHost = {
  handleViewportInput?: (data: string) => unknown;
  getFocusedComponent?: () => unknown;
};
type Guard = { editors: Set<object>; original: (data: string) => unknown; wrapper: (data: string) => unknown; descriptor?: PropertyDescriptor };
const guards = new WeakMap<object, Guard>();

export function acquireViewportInput(tui: object, editor: object): () => void {
  const host = tui as ViewportHost;
  if (typeof host.handleViewportInput !== "function" || typeof host.getFocusedComponent !== "function") {
    return () => {};
  }
  let guard = guards.get(tui);
  if (!guard) {
    const original = host.handleViewportInput;
    const wrapper = function (this: ViewportHost, data: string) {
      if (
        guard && guard.editors.size > 0 &&
        (matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+d")) &&
        readInputContext(this.getFocusedComponent?.()) === "editor"
      ) return undefined;
      return original.call(this, data);
    };
    guard = {
      editors: new Set(), original, wrapper,
      descriptor: Object.getOwnPropertyDescriptor(host, "handleViewportInput"),
    };
    host.handleViewportInput = wrapper;
    guards.set(tui, guard);
  }
  guard.editors.add(editor);
  const shared = guard;
  return () => {
    if (!shared.editors.delete(editor) || shared.editors.size !== 0) return;
    if (host.handleViewportInput === shared.wrapper) {
      if (shared.descriptor) Object.defineProperty(host, "handleViewportInput", shared.descriptor);
      else delete host.handleViewportInput;
    }
    guards.delete(tui);
  };
}
