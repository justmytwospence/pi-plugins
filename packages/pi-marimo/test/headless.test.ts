import { expect, test } from "vitest";
import { HeadlessSessions, socketUrl } from "../src/core/headless.js";

class FakeSocket {
  static all: FakeSocket[] = [];
  static mode: "ready" | "silent" | "error" = "ready";
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
    queueMicrotask(() => {
      if (FakeSocket.mode === "error") this.onerror?.({});
      else if (FakeSocket.mode === "ready") this.onmessage?.({ data: '{"op": "kernel-ready", "data": {}}' });
    });
  }
  close() {
    this.closed = true;
    this.onclose?.({});
  }
}

const fresh = () => {
  FakeSocket.all = [];
  FakeSocket.mode = "ready";
  return new HeadlessSessions(FakeSocket);
};

test("the address is the one marimo's page uses: the server's /ws with a session id, the file and the token", () => {
  const url = new URL(socketUrl("http://127.0.0.1:2718/", "/w/my nb.py", "s_1", "tok"));
  expect(url.protocol).toBe("ws:");
  expect(url.host).toBe("127.0.0.1:2718");
  expect(url.pathname).toBe("/ws");
  expect(Object.fromEntries(url.searchParams)).toEqual({ session_id: "s_1", file: "/w/my nb.py", access_token: "tok" });
  expect(socketUrl("https://h.example", "/a.py", "s_2").startsWith("wss://h.example/ws?")).toBe(true);
});

test("attach resolves with the session id once the kernel is ready, and holds the socket; a second attach reuses it", async () => {
  const h = fresh();
  const id = await h.attach("http://127.0.0.1:2718", "/w/a.py");
  expect(id).toMatch(/^s_[0-9a-f]{8}$/u);
  expect(h.has("http://127.0.0.1:2718/", "/w/a.py")).toBe(true);
  expect(await h.attach("http://127.0.0.1:2718", "/w/a.py")).toBe(id);
  expect(FakeSocket.all).toHaveLength(1);
  // Concurrent attaches share one socket.
  const [a, b] = await Promise.all([h.attach("http://127.0.0.1:2719", "/w/b.py"), h.attach("http://127.0.0.1:2719", "/w/b.py")]);
  expect(a).toBe(b);
  expect(FakeSocket.all).toHaveLength(2);
  // Sessions on servers Pi started stay open through a reload.
  h.closeAll((url) => url === "http://127.0.0.1:2719");
  expect(h.has("http://127.0.0.1:2718", "/w/a.py")).toBe(false);
  expect(h.has("http://127.0.0.1:2719", "/w/b.py")).toBe(true);
  h.closeAll();
  expect(FakeSocket.all.every((s) => s.closed)).toBe(true);
  expect(h.has("http://127.0.0.1:2719", "/w/b.py")).toBe(false);
});

test("an unreachable server and a kernel that never starts reject, and leave nothing held", async () => {
  const h = fresh();
  FakeSocket.mode = "error";
  await expect(h.attach("http://127.0.0.1:1", "/w/a.py")).rejects.toThrow("could not reach");
  FakeSocket.mode = "silent";
  await expect(h.attach("http://127.0.0.1:2", "/w/a.py", undefined, 20)).rejects.toThrow("did not start");
  expect(FakeSocket.all.at(-1)?.closed).toBe(true);
  expect(h.has("http://127.0.0.1:2", "/w/a.py")).toBe(false);
  // A dropped connection frees the slot, so the next attach opens a new one.
  FakeSocket.mode = "ready";
  await h.attach("http://127.0.0.1:3", "/w/a.py");
  FakeSocket.all.at(-1)!.close();
  expect(h.has("http://127.0.0.1:3", "/w/a.py")).toBe(false);
});

test("without a WebSocket in this Node it says so", async () => {
  await expect(new HeadlessSessions(null).attach("http://x", "/a.py")).rejects.toThrow("no WebSocket");
});
