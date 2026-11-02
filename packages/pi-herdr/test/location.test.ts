import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { socketCall, type Call, type Reply } from "../src/core/herdr.ts";
import type { HerdrEvent } from "../src/events.ts";
import { SelfLocation } from "../src/location.ts";

const pane = (id: string, terminal = "term") => ({ pane_id: id, workspace_id: `w-${id}`, tab_id: `t-${id}`, terminal_id: terminal });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

it("tracks successive locations via the original caller and normalizes only self target fields", async () => {
  let current = pane("one");
  const requests: Array<{ method: string; params: Record<string, unknown>; timeout?: number }> = [];
  const raw: Call = async (method, params, timeout) => {
    requests.push({ method, params, timeout });
    return method === "pane.current" ? { result: { pane: current } as any } : { result: "ok" as any };
  };
  const changes = vi.fn();
  const loc = new SelfLocation({ call: raw, callerPaneId: "original", onChange: changes });
  expect(loc.paneId).toBe("original");
  await loc.start();
  await loc.resolve();
  expect(loc.revision).toBe(1);
  current = pane("two");
  await loc.resolve();
  current = pane("three");
  await loc.call("write", { pane_id: "original", target_pane_id: "one", target: "two", text: "original", nested: { pane_id: "one" }, other: "unrelated" }, 123);
  expect(requests.at(-1)).toEqual({ method: "write", params: { pane_id: "three", target_pane_id: "three", target: "three", text: "original", nested: { pane_id: "one" }, other: "unrelated" }, timeout: 123 });
  await loc.call("write", { target: "remote:original", pane_id: "other" });
  expect(requests.at(-1)?.params).toEqual({ target: "remote:original", pane_id: "other" });
  expect(requests.filter((r) => r.method === "pane.current").every((r) => r.params.caller_pane_id === "original")).toBe(true);
  expect(changes).toHaveBeenCalledTimes(3);
  expect(loc.revision).toBe(3);
  loc.stop();
});

it("coalesces lookups, reconciles a relevant event during lookup, and ignores unrelated events", async () => {
  let onEvent!: (e: HerdrEvent) => void;
  let onResync!: () => void;
  const first = deferred<Reply>();
  let calls = 0;
  const raw: Call = async () => (++calls === 1 ? first.promise : { result: { pane: pane("new") } }) as any;
  const loc = new SelfLocation({ call: raw, callerPaneId: "original", onChange: () => {}, subscribe: (event, resync) => {
    onEvent = event; onResync = resync; return { close() {} };
  } });
  const a = loc.start();
  const b = loc.resolve();
  onEvent({ event: "pane_moved", data: { previous_pane_id: "other", pane: pane("other") } });
  expect(calls).toBe(1);
  onEvent({ event: "pane_moved", data: { previous_pane_id: "original", pane: pane("new") } });
  first.resolve({ result: { pane: pane("old") } });
  expect((await a).result?.paneId).toBe("new");
  expect((await b).result?.paneId).toBe("new");
  expect(calls).toBe(2);
  onEvent({ event: "pane_moved", data: { previous_pane_id: "unknown", pane: pane("another") } });
  await until(() => calls === 3);
  onResync();
  await until(() => calls === 4);
  loc.stop();
});

it("fails closed on transport, malformed and mismatched results; never retries a mutation", async () => {
  const missingCall = vi.fn();
  const missing = new SelfLocation({ call: missingCall, callerPaneId: "", onChange() {} });
  expect((await missing.start()).error?.code).toBe("self_location_unavailable");
  expect(missingCall).not.toHaveBeenCalled();
  missing.stop();
  let response: Reply = { result: { pane: pane("one") } };
  let mutations = 0;
  const raw: Call = async (method) => method === "pane.current" ? response as any : (++mutations, { error: { code: "timeout", message: "uncertain" } });
  const loc = new SelfLocation({ call: raw, callerPaneId: "original", onChange() {} });
  await loc.start();
  for (response of [
    { error: { code: "pane_not_found", message: "missing" } },
    { error: { code: "socket", message: "disconnected" } },
    { result: { pane: { ...pane("bad"), tab_id: "" } } },
    { result: { pane: pane("bad", "other-terminal") } },
  ]) {
    expect((await loc.call("mutation", { pane_id: "original" })).error?.code).toBe("self_location_unavailable");
    await expect(loc.require()).rejects.toThrow("nothing was sent");
  }
  expect(mutations).toBe(0);
  response = { result: { pane: pane("one") } };
  expect((await loc.call("mutation", {})).error?.code).toBe("timeout");
  expect(mutations).toBe(1);
  loc.stop();
  expect((await loc.call("mutation", {})).error?.code).toBe("self_location_unavailable");
  expect(mutations).toBe(1);
});

it("checks guards after resolution and invalidates in-flight work across stop and restart", async () => {
  let current = pane("one");
  let delayed: ReturnType<typeof deferred<Reply>> | undefined;
  let writes = 0;
  let closes = 0;
  const changes = vi.fn();
  const raw: Call = async (method) => method === "pane.current" ? (delayed ? delayed.promise : { result: { pane: current } }) as any : (++writes, { result: {} as any });
  const loc = new SelfLocation({ call: raw, callerPaneId: "original", onChange: changes, subscribe: () => ({ close: () => closes++ }) });
  await loc.start();
  current = pane("two");
  expect((await loc.guarded(() => loc.revision === 1)("write", {})).error?.code).toBe("stale_location");
  delayed = deferred<Reply>();
  const oldLookup = delayed;
  const old = loc.call("write", {});
  loc.stop();
  loc.stop();
  delayed = undefined;
  current = pane("three");
  await loc.start();
  oldLookup.resolve({ result: { pane: pane("obsolete") } });
  expect((await old).error?.code).toBe("self_location_unavailable");
  expect(loc.paneId).toBe("three");
  expect(changes).toHaveBeenCalledTimes(3);
  expect(closes).toBe(1);
  expect(writes).toBe(0);
  loc.stop();
});

it("a command obtains a fresh snapshot after an older in-flight lookup and cannot cross a restart", async () => {
  let current = pane("one");
  let delayed: ReturnType<typeof deferred<Reply>> | undefined;
  const raw: Call = async () => delayed ? delayed.promise as any : { result: { pane: current } as any };
  const loc = new SelfLocation({ call: raw, callerPaneId: "original", onChange() {} });
  await loc.start();
  delayed = deferred<Reply>();
  const older = delayed;
  const lookup = loc.resolve();
  current = pane("two");
  const command = loc.require();
  delayed = undefined;
  older.resolve({ result: { pane: pane("one") } });
  await lookup;
  expect((await command).paneId).toBe("two");
  delayed = deferred<Reply>();
  const interrupted = delayed;
  const pending = loc.resolve();
  const staleCommand = loc.require();
  const rejected = expect(staleCommand).rejects.toThrow("nothing was sent");
  loc.stop();
  delayed = undefined;
  current = pane("three");
  await loc.start();
  interrupted.resolve({ result: { pane: pane("two") } });
  await pending;
  await rejected;
  expect(loc.paneId).toBe("three");
  loc.stop();
});

it("uses the real socket transport and subscription with move and reconnect resync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-location-"));
  const path = join(dir, "s.sock");
  const sockets = new Set<net.Socket>();
  const subscriptions: Array<{ socket: net.Socket; id: string }> = [];
  const requests: any[] = [];
  let current = pane("one");
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const req = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        requests.push(req);
        if (req.method === "events.subscribe") {
          subscriptions.push({ socket, id: req.id });
          socket.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);
        } else if (req.method === "pane.current") {
          const result = req.params.caller_pane_id === "original" ? { result: { pane: current } } : { error: { code: "pane_not_found", message: "missing" } };
          socket.write(`${JSON.stringify({ id: req.id, ...result })}\n`);
        } else {
          const ok = req.params.pane_id === current.pane_id;
          socket.write(`${JSON.stringify({ id: req.id, ...(ok ? { result: { ok: true } } : { error: { code: "stale", message: "obsolete pane" } }) })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  const loc = new SelfLocation({ call: socketCall(path), socketPath: path, callerPaneId: "original", onChange() {} });
  try {
    await loc.start();
    await until(() => subscriptions.length === 1 && requests.filter((r) => r.method === "pane.current").length >= 2);
    expect(requests.find((r) => r.method === "events.subscribe").params).toEqual({ subscriptions: [{ type: "pane.moved" }] });
    current = pane("two");
    subscriptions[0].socket.write(`${JSON.stringify({ event: "pane_moved", data: { previous_pane_id: "one", pane: current } })}\n`);
    await until(() => loc.paneId === "two");
    expect((await loc.call("write", { pane_id: "original" })).result).toEqual({ ok: true });
    current = pane("three"); // missed event; reconnect must reconcile
    subscriptions[0].socket.write(`${JSON.stringify({ id: subscriptions[0].id, error: { code: "events_lost", message: "behind" } })}\n`);
    await until(() => subscriptions.length === 2 && loc.paneId === "three");
    expect((await loc.call("write", { pane_id: "one" })).result).toEqual({ ok: true });
    expect(requests.filter((r) => r.method === "pane.current").every((r) => r.params.caller_pane_id === "original")).toBe(true);
  } finally {
    loc.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
