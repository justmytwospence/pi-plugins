import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Bridge } from "../src/bridge.ts";
import type { Call, Reply } from "../src/core/herdr.ts";
import { PaneReporter } from "../src/core/report.ts";
import { displayAgent, firstUserText } from "../src/identity.ts";
import { lastAssistantText, readReply } from "../src/session.ts";
import { fakeCall } from "./core/fake.ts";

describe("identity", () => {
  it("names the agent and finds the first prompt", () => {
    expect(displayAgent("claude-opus-5-5", "xhigh")).toBe("pi opus-5-5:xhigh");
    expect(displayAgent("claude-opus-5-5", "off")).toBe("pi opus-5-5");
    expect(displayAgent(undefined, "high")).toBe("pi");
    const entries = [
      { type: "custom" },
      { type: "message", message: { role: "assistant", content: "no" } },
      { type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "hello" }] } },
    ];
    expect(firstUserText(entries)).toBe("hello");
  });
});

describe("session reply", () => {
  const line = (o: unknown) => JSON.stringify(o);
  const session = [
    line({ type: "session", version: 3 }),
    line({ type: "message", message: { role: "user", content: "go" } }),
    line({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "first" }] } }),
    line({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] } }),
    line({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "Done.\n\n<next>commit it</next>" }] } }),
    line({ type: "custom", customType: "x", data: {} }),
    "",
  ].join("\n");

  it("takes the last assistant text and drops the next-prompt line", () => {
    expect(lastAssistantText(session)).toBe("Done.\n\n<next>commit it</next>");
    const dir = mkdtempSync(path.join(tmpdir(), "pi-herdr-"));
    const file = path.join(dir, "s.jsonl");
    writeFileSync(file, session);
    expect(readReply(file)).toBe("Done.");
    expect(readReply(path.join(dir, "missing.jsonl"))).toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("bridge", () => {
  function relocating(handlers: Parameters<typeof fakeCall>[0] = {}) {
    let paneId = "w1:p1";
    let zoomed = false;
    let focused = false;
    let reconcile = async () => {};
    const f = fakeCall({
      "pane.get": (p) => {
        expect(p.pane_id).toBe(paneId);
        return { result: { pane: { focused } } };
      },
      "pane.layout": (p) => {
        expect(p.pane_id).toBe(paneId);
        return { result: { layout: { zoomed, panes: [
          { pane_id: "w1:p1", rect: { width: 200, height: 40 } },
          { pane_id: paneId, rect: { width: 120, height: 100 } },
        ] } } };
      },
      "pane.zoom": (p) => {
        expect(p.pane_id).toBe(paneId);
        zoomed = p.mode === "on";
        return { result: {} };
      },
      "pane.split": (p) => {
        expect(p.target_pane_id).toBe(paneId);
        return { result: { pane: { pane_id: "split" } } };
      },
      ...handlers,
    });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"), {
      paneId: () => paneId,
      guarded: (current) => (async (method, params, timeout) => {
        await reconcile();
        return current() ? f.call(method, params, timeout) : { error: { code: "stale_location", message: "moved" } };
      }) as Call,
    });
    return {
      f, b,
      move: (id: string, destinationZoomed = false) => { paneId = id; zoomed = destinationZoomed; b.relocated(); },
      focus: (value: boolean) => { focused = value; },
      onReconcile: (fn: () => Promise<void>) => { reconcile = fn; },
    };
  }

  it("uses canonical self for focus, split placement and geometry after successive moves", async () => {
    const h = relocating();
    for (const id of ["w2:p4", "w3:p8"]) {
      h.move(id);
      h.focus(true);
      await h.b.notify({ title: "done", unlessFocused: true });
      expect(h.f.of("notification.show")).toHaveLength(id === "w2:p4" ? 0 : 1);
      expect(h.f.of("pane.get").at(-1)!.params).toEqual({ pane_id: id });
      h.focus(false);
      await h.b.notify({ title: "done", unlessFocused: true });
      await h.b.split({ command: "true" });
      expect(h.f.of("pane.split").at(-1)!.params).toMatchObject({ target_pane_id: id, direction: "down" });
    }
    expect(h.f.of("notification.show")).toHaveLength(2);
  });

  it("drops departed zoom ownership without dropping holds or unzooming the destination", async () => {
    const h = relocating();
    await h.b.zoom(true);
    h.move("w2:p4", true);
    expect(h.f.of("pane.zoom")).toHaveLength(1); // relocation itself never mutates zoom
    await h.b.zoom(true);
    await h.b.zoom(false);
    await h.b.zoom(false);
    await h.b.reset();
    expect(h.f.of("pane.zoom")).toEqual([{ method: "pane.zoom", params: { pane_id: "w1:p1", mode: "on" } }]);
    h.move("w3:p8");
    await h.b.zoom(true);
    await h.b.zoom(false);
    expect(h.f.of("pane.zoom").slice(1).map((c) => c.params)).toEqual([
      { pane_id: "w3:p8", mode: "on" }, { pane_id: "w3:p8", mode: "off" },
    ]);
  });

  it("keeps pre-move holds counted without reapplying zoom in an unzoomed destination", async () => {
    const h = relocating();
    await h.b.zoom(true);
    h.move("w2:p4");
    await h.b.zoom(true);
    await h.b.zoom(false);
    await h.b.zoom(false);
    expect(h.f.of("pane.zoom")).toHaveLength(1);
    await h.b.zoom(true);
    await h.b.zoom(false);
    expect(h.f.of("pane.zoom").slice(1).map((c) => c.params)).toEqual([
      { pane_id: "w2:p4", mode: "on" }, { pane_id: "w2:p4", mode: "off" },
    ]);
  });

  it("does not acquire zoom from a departed layout response", async () => {
    const started = deferred<void>();
    const layout = deferred<Reply>();
    const h = relocating({ "pane.layout": async () => { started.resolve(); return layout.promise; } });
    const hold = h.b.zoom(true);
    await started.promise;
    h.move("w2:p4", true);
    layout.resolve({ result: { layout: { zoomed: false } } });
    await hold;
    await h.b.zoom(false);
    await h.b.reset();
    expect(h.f.of("pane.zoom")).toEqual([]);
  });

  it("late zoom completion cannot restore departed ownership", async () => {
    const started = deferred<void>();
    const zoom = deferred<Reply>();
    const h = relocating({ "pane.zoom": async () => { started.resolve(); return zoom.promise; } });
    const hold = h.b.zoom(true);
    await started.promise;
    h.move("w2:p4", true);
    zoom.resolve({ result: {} });
    await hold;
    await h.b.zoom(false);
    await h.b.reset();
    expect(h.f.of("pane.zoom")).toEqual([{ method: "pane.zoom", params: { pane_id: "w1:p1", mode: "on" } }]);
  });

  it("a departed split's unzoom completion cannot discard newly acquired destination ownership", async () => {
    const started = deferred<void>(); const unzoom = deferred<Reply>();
    let delayed = true;
    const h = relocating({ "pane.zoom": async (p) => {
      if (p.mode === "off" && delayed) { delayed = false; started.resolve(); return unzoom.promise; }
      return { result: {} };
    } });
    await h.b.zoom(true);
    const split = h.b.split({ command: "true" });
    await started.promise;
    h.move("w2:p4");
    await h.b.zoom(false);
    await h.b.zoom(true);
    unzoom.resolve({ result: {} });
    await split;
    await h.b.zoom(false);
    expect(h.f.of("pane.zoom").map((c) => c.params)).toEqual([
      { pane_id: "w1:p1", mode: "on" }, { pane_id: "w1:p1", mode: "off" },
      { pane_id: "w2:p4", mode: "on" }, { pane_id: "w2:p4", mode: "off" },
    ]);
  });

  it.each(["on", "off", "split", "reset"])("guards %s zoom mutations after reconciliation detects a move", async (operation) => {
    const h = relocating();
    if (operation !== "on") await h.b.zoom(true);
    h.onReconcile(async () => { h.move("w2:p4", true); });
    if (operation === "on") await h.b.zoom(true);
    else if (operation === "off") await h.b.zoom(false);
    else if (operation === "split") await h.b.split({ command: "true" });
    else await h.b.reset();
    expect(h.f.of("pane.zoom")).toHaveLength(operation === "on" ? 0 : 1);
    h.onReconcile(async () => {});
    await h.b.reset();
    expect(h.f.of("pane.zoom")).toHaveLength(operation === "on" ? 0 : 1);
  });
  it("zooms while held, only if it was not zoomed", async () => {
    let zoomed = false;
    const f = fakeCall({
      "pane.layout": () => ({ result: { layout: { zoomed, panes: [{ pane_id: "w1:p1", rect: { width: 200, height: 50 } }] } } }),
      "pane.zoom": (p) => {
        zoomed = p.mode === "on";
        return { result: {} };
      },
    });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    await b.zoom(true);
    await b.zoom(true);
    await b.zoom(false);
    expect(zoomed).toBe(true);
    await b.zoom(false);
    expect(zoomed).toBe(false);
    zoomed = true;
    await b.zoom(true);
    await b.zoom(false);
    expect(zoomed).toBe(true);
    expect(f.of("pane.zoom")).toHaveLength(2);
  });

  it("runs a command in a split and reports back", async () => {
    const f = fakeCall({
      "pane.layout": () => ({ result: { layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 40 } }] } } }),
      "pane.split": () => ({ result: { pane: { pane_id: "w1:p2" } } }),
    });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    let got: [boolean, string] | undefined;
    await b.split({ command: "vi +3 'a b'", cwd: "/r", done: (ok, m) => (got = [ok, m]) });
    expect(f.of("pane.split")[0]!.params).toMatchObject({ target_pane_id: "w1:p1", direction: "down", cwd: "/r" });
    expect(f.of("pane.send_input")[0]!.params).toEqual({ pane_id: "w1:p2", text: "vi +3 'a b'; exit", keys: ["enter"] });
    expect(got).toEqual([true, "w1:p2"]);
  });

  it("closes the split when the command cannot be sent", async () => {
    const f = fakeCall({
      "pane.layout": () => ({ result: { layout: { zoomed: false, panes: [{ pane_id: "w1:p1", rect: { width: 120, height: 40 } }] } } }),
      "pane.split": () => ({ result: { pane: { pane_id: "w1:p2" } } }),
      "pane.send_input": () => ({ error: { code: "pane_send_failed", message: "too long" } }),
    });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    let got: [boolean, string] | undefined;
    await b.split({ command: "x", cwd: "/r", done: (ok, m) => (got = [ok, m]) });
    expect(f.of("pane.close")[0]!.params).toEqual({ pane_id: "w1:p2" });
    expect(got).toEqual([false, "herdr opened a split but could not run the command: too long (pane_send_failed)"]);
  });

  it("notifies unless focused", async () => {
    let focused = true;
    const f = fakeCall({ "pane.get": () => ({ result: { pane: { focused } } }) });
    const b = new Bridge(f.call, new PaneReporter(f.call, "w1:p1"));
    await b.notify({ title: "done", unlessFocused: true });
    expect(f.of("notification.show")).toHaveLength(0);
    focused = false;
    await b.notify({ title: "done", body: "x", sound: "done", unlessFocused: true });
    expect(f.of("notification.show")[0]!.params).toEqual({ title: "done", body: "x", sound: "done" });
  });
});
