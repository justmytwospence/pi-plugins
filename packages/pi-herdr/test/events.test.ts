// HerdrSubscription (src/events.ts) against a fake herdr on a temporary Unix socket: the
// subscribe request, pushed events, and a reconnect with a resync after `events_lost`.
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HerdrSubscription } from "../src/events.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const until = async (ok: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

it("subscribes, delivers pushed events, and reconnects with a resync after events_lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-sub-"));
  dirs.push(dir);
  const path = join(dir, "s.sock");
  const requests: any[] = [];
  const sockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.on("data", (d) => {
      const req = JSON.parse(d.toString().trim());
      requests.push(req);
      sock.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);
      if (requests.length === 1) {
        // Two events in one chunk, one split across chunks, then the subscriber falls behind.
        sock.write(`${JSON.stringify({ event: "workspace_metadata_updated", data: { workspace: { workspace_id: "w1" } } })}\n${JSON.stringify({ event: "workspace_metadata_updated", data: { workspace: { workspace_id: "w2" } } })}\n{"event":"workspace_metadata_up`);
        setTimeout(() => {
          sock.write(`dated","data":{"workspace":{"workspace_id":"w3"}}}\n`);
          sock.write(`${JSON.stringify({ id: req.id, error: { code: "events_lost", message: "behind" } })}\n`);
          sock.end();
        }, 20);
      }
    });
  });
  await new Promise<void>((r) => server.listen(path, r));
  const events: string[] = [];
  let resyncs = 0;
  const sub = new HerdrSubscription({
    socketPath: path,
    subscriptions: [{ type: "workspace.metadata_updated" }],
    onEvent: (e) => events.push(e.data.workspace.workspace_id),
    onResync: () => resyncs++,
    minBackoffMs: 20,
  });
  await until(() => resyncs === 2);
  expect(requests[0]).toMatchObject({ method: "events.subscribe", params: { subscriptions: [{ type: "workspace.metadata_updated" }] } });
  expect(requests).toHaveLength(2);
  expect(events).toEqual(["w1", "w2", "w3"]);
  sub.close();
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});
