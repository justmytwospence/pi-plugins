import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { stat } from "node:fs/promises";
import { FamilyClient, FamilyServer } from "../src/family/transport.ts";
import { encodeFrame, type MemberCredentials, type WireFrame } from "../src/family/protocol.ts";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.useRealTimers(); });
async function server(handler: ConstructorParameters<typeof FamilyServer>[1] = () => undefined) {
  const s = new FamilyServer(randomUUID(), handler, () => {}); await s.start(); cleanup.push(() => s.dispose()); return s;
}
async function connect(c: MemberCredentials, frame: Partial<WireFrame> = {}) {
  const socket = net.createConnection(c.socketPath); cleanup.push(() => { socket.destroy(); });
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(encodeFrame({ ...c, epoch: randomUUID(), seq: 1, type: "hello", ...frame })); return socket;
}
describe("private member transport", () => {
  it("uses private sockets and denies incorrect capabilities/nonmembers", async () => {
    let calls = 0; const s = await server(() => { calls++; }); const c = s.reserve(randomUUID());
    expect((await stat(s.socketPath)).mode & 0o777).toBe(0o600);
    expect((await stat(s.socketPath.slice(0, s.socketPath.lastIndexOf("/")))).mode & 0o777).toBe(0o700);
    const socket = await connect(c, { capability: "f".repeat(64) }); await new Promise(resolve => socket.once("close", resolve)); expect(calls).toBe(0);
    const unknown = await connect({ ...c, agentId: randomUUID() }); await new Promise(resolve => unknown.once("close", resolve)); expect(calls).toBe(0);
  });
  it("rejects replayed sequences and retired connection epochs", async () => {
    const s = await server(); const c = s.reserve(randomUUID()); const epoch = randomUUID();
    const first = await connect(c, { epoch });
    const closed = new Promise(resolve => first.once("close", resolve));
    first.write(encodeFrame({ ...c, epoch, seq: 1, type: "heartbeat" })); await closed;
    const next = await connect(c); await new Promise(resolve => setTimeout(resolve, 10));
    const replay = await connect(c, { epoch }); await new Promise(resolve => replay.once("close", resolve)); expect(next.destroyed).toBe(false);
  });
  it("marks a silent member disconnected after ten seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const disconnected = vi.fn(); const s = new FamilyServer(randomUUID(), () => undefined, disconnected); await s.start(); cleanup.push(() => s.dispose());
    const c = s.reserve(randomUUID()); const epoch = randomUUID(); const socket = await connect(c, { epoch });
    // Request an acknowledged hello before advancing the server heartbeat clock.
    const ready = new Promise<void>(resolve => socket.once("data", () => resolve()));
    socket.write(encodeFrame({ ...c, epoch, seq: 2, type: "heartbeat", requestId: randomUUID() }));
    await ready;
    vi.advanceTimersByTime(10000);
    expect(disconnected).toHaveBeenCalledWith(c.agentId);
  });
  it("reconnects with a full snapshot and supports bounded requests", async () => {
    let hellos = 0; const s = await server((_id, frame) => { if (frame.type === "hello") hellos++; return { reserved: true }; }); const c = s.reserve(randomUUID());
    const client = new FamilyClient(c, () => ({ revision: 1 })); cleanup.push(() => client.dispose()); client.start();
    await new Promise(resolve => setTimeout(resolve, 20)); expect(hellos).toBe(1);
    expect(await client.request("prepare", { kind: "test" })).toEqual({ reserved: true });
    // A severed connection requires a new epoch and snapshot, not delta replay.
    (client as unknown as { socket: net.Socket }).socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 300)); expect(hellos).toBe(2);
  });
});
