import net, { type Socket } from "node:net";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { assertId, FrameDecoder, encodeFrame, validCredentials, DISCONNECT_MS, HEARTBEAT_MS, REQUEST_TIMEOUT_MS, type MemberCredentials, type WireFrame } from "./protocol.ts";

type Handler = (agentId: string, frame: WireFrame) => Promise<unknown> | unknown;
interface Member { capability: string; epoch?: string; seq: number; socket?: Socket; lastSeen: number; retired: Set<string> }
export class FamilyServer {
  private readonly members = new Map<string, Member>();
  private readonly sockets = new Set<Socket>();
  private readonly server = net.createServer(socket => this.accept(socket));
  private timer?: ReturnType<typeof setInterval>;
  private directory = "";
  socketPath = "";
  constructor(readonly familyId: string, private readonly handler: Handler, private readonly disconnected: (id: string) => void, private readonly validateHello?: (id: string, data: unknown) => void) { assertId(familyId); }
  async start(): Promise<void> {
    this.directory = await mkdtemp("/tmp/pi-sbf-");
    await chmod(this.directory, 0o700);
    this.socketPath = `${this.directory}/s`;
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.socketPath, () => { this.server.off("error", reject); resolve(); }); });
    await chmod(this.socketPath, 0o600);
    this.timer = setInterval(() => {
      for (const [id, m] of this.members) if (m.socket && Date.now() - m.lastSeen >= DISCONNECT_MS) { m.socket.destroy(); m.socket = undefined; this.disconnected(id); }
    }, HEARTBEAT_MS);
    this.timer.unref();
  }
  reserve(agentId: string): MemberCredentials {
    assertId(agentId);
    const existing = this.members.get(agentId);
    const capability = existing?.capability ?? randomBytes(32).toString("hex");
    if (!existing) this.members.set(agentId, { capability, seq: 0, lastSeen: Date.now(), retired: new Set() });
    return { version: 1, familyId: this.familyId, agentId, capability, socketPath: this.socketPath };
  }
  revoke(agentId: string): void { const m = this.members.get(agentId); this.members.delete(agentId); m?.socket?.destroy(); }
  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const decoder = new FrameDecoder();
    let memberId: string | undefined;
    let chain = Promise.resolve();
    let queued = 0;
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      const m = memberId ? this.members.get(memberId) : undefined;
      if (m?.socket === socket) { m.socket = undefined; this.disconnected(memberId!); }
    });
    const handshake = setTimeout(() => { if (!memberId) socket.destroy(); }, REQUEST_TIMEOUT_MS);
    handshake.unref(); socket.once("close", () => clearTimeout(handshake));
    socket.on("data", chunk => {
      try {
        for (const frame of decoder.push(Buffer.from(chunk))) {
          const m = this.members.get(frame.agentId);
          if (!m || frame.familyId !== this.familyId || Buffer.byteLength(frame.capability) !== Buffer.byteLength(m.capability) || !timingSafeEqual(Buffer.from(frame.capability), Buffer.from(m.capability))) throw new Error("Unauthorized family member");
          if (memberId && memberId !== frame.agentId) throw new Error("Member identity changed");
          if (!memberId) {
            if (frame.type !== "hello" || m.retired.has(frame.epoch)) throw new Error("Snapshot handshake required");
            this.validateHello?.(frame.agentId, frame.data);
            if (m.epoch && m.epoch !== frame.epoch) { m.retired.add(m.epoch); if (m.retired.size > 128) throw new Error("Too many member epochs"); m.seq = 0; }
            m.socket?.destroy(); m.epoch = frame.epoch; m.socket = socket; memberId = frame.agentId;
          }
          if (m.epoch !== frame.epoch || frame.seq <= m.seq) throw new Error("Stale family sequence");
          m.seq = frame.seq; m.lastSeen = Date.now();
          if (++queued > 64) throw new Error("Family request backlog exceeds limit");
          chain = chain.then(async () => {
            if (socket.destroyed) { queued--; return; }
            try {
              const data = await this.handler(frame.agentId, frame);
              if (frame.requestId && !socket.destroyed) socket.write(encodeFrame({ ...frame, type: "reply", data: { ok: true, value: data } }));
            } catch (error) {
              if (frame.requestId && !socket.destroyed) socket.write(encodeFrame({ ...frame, type: "reply", data: { ok: false, error: "Family request unavailable" } }));
              if (frame.type === "hello" || frame.type === "update") socket.destroy();
            }
            finally { queued--; }
          }).catch(() => { socket.destroy(); });
        }
      } catch { socket.destroy(); }
    });
  }
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()));
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.members.clear();
  }
}

export class FamilyClient {
  private socket?: Socket;
  private epoch = randomUUID();
  private seq = 0;
  private stopped = true;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly credentials: MemberCredentials, private readonly snapshot: () => unknown) { if (!validCredentials(credentials)) throw new Error("Invalid member credentials"); }
  start(): void { if (!this.stopped) return; this.stopped = false; this.connect(); }
  private connect(): void {
    if (this.stopped) return;
    const socket = net.createConnection(this.credentials.socketPath);
    this.socket = socket; this.epoch = randomUUID(); this.seq = 0;
    const decoder = new FrameDecoder();
    socket.on("connect", () => {
      try { this.send("hello", this.snapshot()); } catch { socket.destroy(); }
      this.heartbeat = setInterval(() => this.send("heartbeat"), HEARTBEAT_MS); this.heartbeat.unref();
    });
    socket.on("error", () => {});
    socket.on("data", chunk => {
      try { for (const frame of decoder.push(Buffer.from(chunk))) {
        if (frame.agentId !== this.credentials.agentId || frame.familyId !== this.credentials.familyId || frame.capability !== this.credentials.capability || frame.epoch !== this.epoch || frame.type !== "reply") throw new Error("Invalid server reply");
        const p = frame.requestId ? this.pending.get(frame.requestId) : undefined;
        if (!p) continue;
        clearTimeout(p.timer); this.pending.delete(frame.requestId!);
        const reply = frame.data as { ok?: boolean; value?: unknown; error?: string };
        if (reply.ok) p.resolve(reply.value); else p.reject(new Error(reply.error ?? "Family request failed"));
      } } catch { socket.destroy(); }
    });
    socket.on("close", () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Family connection lost")); } this.pending.clear();
      if (!this.stopped) { this.reconnect = setTimeout(() => this.connect(), 250); this.reconnect.unref(); }
    });
  }
  send(type: WireFrame["type"], data?: unknown, requestId?: string): boolean {
    if (!this.socket || this.socket.destroyed || this.socket.connecting) return false;
    const frame = encodeFrame({ ...this.credentials, epoch: this.epoch, seq: ++this.seq, type, data, requestId });
    if (this.socket.writableLength > 2 * 1024 * 1024) { this.socket.destroy(); return false; }
    this.socket.write(frame); return true;
  }
  request(type: WireFrame["type"], data: unknown): Promise<unknown> {
    if (this.pending.size >= 64) return Promise.reject(new Error("Too many pending family requests"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("Family retrieval timed out")); }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      try { if (!this.send(type, data, requestId)) throw new Error("Family connection unavailable"); } catch (e) { clearTimeout(timer); this.pending.delete(requestId); reject(e); }
    });
  }
  dispose(graceful = false): void {
    this.stopped = true; if (this.reconnect) clearTimeout(this.reconnect); if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.socket && graceful && !this.socket.connecting) {
      const socket = this.socket; socket.end();
      const deadline = setTimeout(() => socket.destroy(), REQUEST_TIMEOUT_MS); deadline.unref(); socket.once("close", () => clearTimeout(deadline));
    } else this.socket?.destroy();
    this.socket = undefined;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Family observer disposed")); } this.pending.clear();
  }
}
