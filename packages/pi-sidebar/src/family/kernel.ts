import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentDescriptor, FamilyPhase, PreparedAgent } from "../family-contract.ts";
import { FamilyStore } from "./store.ts";
import { FamilyServer } from "./transport.ts";
import { preparedAgent } from "./observer.ts";
import { assertId, COALESCE_MS, type AgentSummary, type FamilyHost, type FamilySnapshot, type MemberCredentials, type ObservationSnapshot, type TranscriptPage, type TranscriptQuery, type TranscriptRecord, type WireFrame } from "./protocol.ts";
import { projectTranscript, transcriptPage } from "./transcript.ts";

export interface KernelOptions { familyId?: string; agentId?: string; root: AgentDescriptor; agentDir?: string }
export class FamilyKernel {
  readonly familyId: string;
  readonly rootId: string;
  readonly store: FamilyStore;
  readonly server: FamilyServer;
  anchorId: string;
  focusId: string;
  revision = 0;
  messages: AgentMessage[] = [];
  model?: string;
  draft = "";
  open = false;
  sidebarFocused = false;
  private disposed = false;
  private readonly agents = new Map<string, AgentSummary>();
  private readonly transcripts = new Map<string, TranscriptRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly hosts = new Map<string, () => void>();
  private persistenceError?: unknown;
  private constructor(options: KernelOptions) {
    this.familyId = options.familyId ?? randomUUID(); this.rootId = options.agentId ?? randomUUID();
    assertId(this.familyId); assertId(this.rootId);
    this.anchorId = this.focusId = this.rootId;
    this.store = new FamilyStore(this.familyId, options.agentDir);
    this.server = new FamilyServer(this.familyId, (id, frame) => this.receive(id, frame), id => this.disconnected(id), (id, value) => this.validateObservation(id, value as ObservationSnapshot));
    this.add(this.rootId, undefined, options.root);
  }
  static async create(options: KernelOptions): Promise<FamilyKernel> {
    const kernel = new FamilyKernel(options);
    const state = await kernel.store.loadState();
    if (state) {
      if (state.familyId !== kernel.familyId || !state.agents.some(a => a.agentId === kernel.rootId)) throw new Error("Family membership does not match stored state");
      kernel.agents.clear();
      for (const a of state.agents) { assertId(a.agentId); kernel.agents.set(a.agentId, { ...a, phase: ["done", "failed", "stopped"].includes(a.phase) ? a.phase : "disconnected" }); }
      kernel.revision = state.revision; kernel.anchorId = state.anchorId; kernel.focusId = state.focusId;
      const prefs = state as FamilySnapshot & { model?: string; draft?: string; open?: boolean; sidebarFocused?: boolean };
      kernel.model = prefs.model; kernel.draft = prefs.draft ?? ""; kernel.open = prefs.open === true; kernel.sidebarFocused = prefs.sidebarFocused === true;
    }
    kernel.messages = await kernel.store.readThread();
    await kernel.server.start();
    kernel.changed();
    return kernel;
  }
  private alive(): void { if (this.disposed) throw new Error("Family kernel disposed"); }
  private add(agentId: string, parentId: string | undefined, descriptor: AgentDescriptor): void {
    if (typeof descriptor.kind !== "string" || typeof descriptor.label !== "string" || descriptor.kind.length > 100 || descriptor.label.length > 500) throw new Error("Invalid family descriptor");
    for (const [name, value] of [["sessionId", descriptor.sessionId], ["operationId", descriptor.operationId], ["leafId", descriptor.leafId]] as const) {
      if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 1000)) throw new Error(`Invalid family descriptor ${name}`);
    }
    const now = Date.now();
    // Explicit allowlist: descriptor cannot inject identity, phase or transport fields.
    this.agents.set(agentId, { agentId, parentId, kind: descriptor.kind, label: descriptor.label, sessionId: descriptor.sessionId, leafId: descriptor.leafId, operationId: descriptor.operationId, phase: "starting", createdAt: now, updatedAt: now, revision: 0, transcriptRevision: 0, coverage: "unavailable" });
  }
  snapshot(focusId = this.focusId): FamilySnapshot {
    this.alive();
    return structuredClone({ familyId: this.familyId, revision: this.revision, anchorId: this.anchorId, focusId: this.agents.has(focusId) ? focusId : this.anchorId, agents: [...this.agents.values()] });
  }
  subscribe(listener: () => void): () => void { this.alive(); this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void {
    this.revision++;
    const state = { ...this.snapshot(), model: this.model, draft: this.draft, open: this.open, sidebarFocused: this.sidebarFocused };
    void this.store.saveState(state).catch(error => { this.persistenceError = error; });
    for (const listener of this.listeners) { try { listener(); } catch { /* observers are isolated */ } }
  }
  attachHost(host: FamilyHost): () => void {
    this.alive(); if (!this.agents.has(host.agentId)) throw new Error("Host is not a family member");
    this.hosts.get(host.agentId)?.();
    let current: FamilyHost | undefined = host;
    const id = host.agentId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => { if (current) this.observe(id, current.snapshot()); };
    let unsubscribe: (() => void) | undefined = host.onChange(() => { if (!timer) { timer = setTimeout(() => { timer = undefined; try { publish(); } catch { this.disconnected(id); } }, COALESCE_MS); timer.unref(); } });
    const detach = () => { if (!current) return; current = undefined; unsubscribe?.(); unsubscribe = undefined; if (timer) clearTimeout(timer); if (this.hosts.get(id) === detach) this.hosts.delete(id); };
    this.hosts.set(id, detach);
    try { publish(); } catch (error) { detach(); throw error; }
    return detach;
  }
  private validateObservation(id: string, value: ObservationSnapshot): void {
    const agent = this.agents.get(id); if (!agent) throw new Error("Agent is not enrolled");
    if (!value || !Number.isSafeInteger(value.revision) || !Array.isArray(value.messages) || !value.live || typeof value.live.state !== "string") throw new Error("Invalid family observation");
    if (agent.sessionId && agent.sessionId !== value.sessionId) throw new Error("Observation session does not match enrollment");
    if (value.sessionId !== undefined && (typeof value.sessionId !== "string" || value.sessionId.length > 1000)) throw new Error("Invalid observation session ID");
    if (value.leafId !== undefined && value.leafId !== null && (typeof value.leafId !== "string" || value.leafId.length > 1000)) throw new Error("Invalid observation leaf ID");
    if (value.model !== undefined && (typeof value.model !== "string" || value.model.length > 1000)) throw new Error("Invalid observation model");
    if (value.request?.model !== undefined && (typeof value.request.model !== "string" || value.request.model.length > 1000)) throw new Error("Invalid observation model");
    if (value.projected && (typeof value.projected.text !== "string" || value.projected.text.length > 600000 || !["complete", "partial", "unavailable"].includes(value.projected.coverage))) throw new Error("Invalid projected transcript");
  }
  private observe(id: string, value: ObservationSnapshot): void {
    const agent = this.agents.get(id); if (!agent || this.disposed) return;
    this.validateObservation(id, value);
    const source = value.projected ?? projectTranscript(value.messages);
    const projected = { ...source, text: source.text.replaceAll(this.server.socketPath, "[family socket omitted]").replace(/\b[a-f0-9]{64}\b/gi, "[opaque credential omitted]") };
    if (projected.text !== source.text && projected.coverage === "complete") projected.coverage = "partial";
    const previous = this.transcripts.get(id);
    if (!previous || previous.text !== projected.text || previous.coverage !== projected.coverage) {
      const record = { ...projected, revision: agent.transcriptRevision + 1 };
      this.transcripts.set(id, record); agent.transcriptRevision = record.revision; agent.coverage = record.coverage;
      void this.store.writeTranscript(id, record).catch(error => { this.persistenceError = error; });
    }
    const terminal = ["done", "failed", "stopped"].includes(agent.phase);
    const state = value.live.state;
    Object.assign(agent, { sessionId: value.sessionId, leafId: value.leafId, model: value.model ?? value.request?.model, phase: terminal ? agent.phase : state === "waiting" ? "waiting" : state === "working" ? "working" : "idle", updatedAt: Date.now(), revision: agent.revision + 1 });
    this.changed();
  }
  private reserve(parentId: string, descriptor: AgentDescriptor): MemberCredentials {
    this.alive(); if (!this.agents.has(parentId)) throw new Error("Parent is not enrolled");
    if (this.agents.size >= 4096) throw new Error("Family member limit reached");
    const id = randomUUID(); this.add(id, parentId, descriptor); const credentials = this.server.reserve(id); this.changed(); return credentials;
  }
  async prepareChild(parentId: string, descriptor: AgentDescriptor, signal?: AbortSignal): Promise<PreparedAgent> {
    signal?.throwIfAborted(); const credentials = this.reserve(parentId, descriptor);
    if (signal?.aborted) { this.finish(credentials.agentId, "stopped"); signal.throwIfAborted(); }
    const prepared = preparedAgent(credentials, (phase, error) => this.finish(credentials.agentId, phase, error), new Set(), value => this.observe(credentials.agentId, value));
    const abort = () => prepared.finish("stopped"); signal?.addEventListener("abort", abort, { once: true });
    const dispose = prepared.dispose; prepared.dispose = () => { signal?.removeEventListener("abort", abort); dispose(); };
    return prepared;
  }
  private async receive(id: string, frame: WireFrame): Promise<unknown> {
    if (frame.type === "hello" || frame.type === "update") { this.observe(id, frame.data as ObservationSnapshot); return; }
    if (frame.type === "prepare") return this.reserve(id, frame.data as AgentDescriptor);
    if (frame.type === "finish") {
      const data = frame.data as { agentId?: string; phase?: FamilyPhase; error?: string };
      const target = data.agentId ?? id;
      if (target !== id && this.agents.get(target)?.parentId !== id) throw new Error("Cannot finish another member");
      if (!["done", "failed", "stopped"].includes(data.phase ?? "")) throw new Error("Invalid terminal phase");
      this.finish(target, data.phase as "done" | "failed" | "stopped", data.error); return;
    }
  }
  cancelReservation(agentId: string): void {
    this.alive();
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (agentId === this.rootId || agentId === this.anchorId || this.hosts.has(agentId) || agent.revision !== 0 || agent.coverage !== "unavailable" || this.transcripts.has(agentId)) throw new Error("Cannot discard an observed family member");
    this.server.revoke(agentId);
    this.agents.delete(agentId); this.transcripts.delete(agentId);
    if (this.focusId === agentId) this.focusId = this.anchorId;
    this.changed();
  }
  private finish(id: string, phase: "done" | "failed" | "stopped", error?: string): void {
    if (this.disposed) return;
    const agent = this.agents.get(id); if (!agent || ["done", "failed", "stopped"].includes(agent.phase)) return;
    agent.phase = phase; agent.updatedAt = Date.now(); agent.revision++; agent.activity = error ? "Agent reported an error (details omitted)" : undefined;
    this.changed();
  }
  private disconnected(id: string): void { const a = this.agents.get(id); if (!a || this.disposed || ["done", "failed", "stopped"].includes(a.phase)) return; a.phase = "disconnected"; a.updatedAt = Date.now(); this.changed(); }
  async transcript(query: TranscriptQuery): Promise<TranscriptPage> {
    this.alive();
    if (!this.agents.has(query.agentId)) return { agentId: query.agentId, revision: 0, coverage: "unavailable", text: "", unavailable: "Agent is not enrolled in this family" };
    const cached = this.transcripts.get(query.agentId);
    if (cached) return transcriptPage(query, cached);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const record = await Promise.race([this.store.readTranscript(query.agentId), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Transcript retrieval timed out")), 2000); })]);
      return transcriptPage(query, record);
    } catch (error) {
      return { agentId: query.agentId, revision: 0, coverage: "unavailable", text: "", unavailable: "Transcript archive unavailable" };
    } finally { if (timer) clearTimeout(timer); }
  }
  focus(id?: string): void { this.alive(); if (id && !this.agents.has(id)) throw new Error("Agent is not enrolled"); const next = id ?? this.anchorId; if (next === this.focusId) return; this.focusId = next; this.changed(); }
  setAnchor(id: string): void { this.alive(); if (!this.agents.has(id)) throw new Error("Agent is not enrolled"); if (this.anchorId === id) return; this.anchorId = id; this.changed(); }
  setPreferences(value: { model?: string; draft?: string; open?: boolean; sidebarFocused?: boolean }): void {
    this.alive();
    const model = "model" in value ? value.model : this.model;
    const draft = value.draft ?? this.draft;
    const open = value.open ?? this.open;
    const sidebarFocused = value.sidebarFocused ?? this.sidebarFocused;
    if (model === this.model && draft === this.draft && open === this.open && sidebarFocused === this.sidebarFocused) return;
    this.model = model; this.draft = draft; this.open = open; this.sidebarFocused = sidebarFocused; this.changed();
  }
  async appendExchange(id: string, messages: readonly AgentMessage[]): Promise<void> { this.alive(); await this.store.appendExchange(id, messages); this.messages = await this.store.readThread(); this.changed(); }
  async resetThread(): Promise<void> { this.alive(); await this.store.resetThread(); this.messages = []; this.changed(); }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    for (const detach of this.hosts.values()) detach(); this.listeners.clear();
    this.disposed = true; await this.server.dispose(); await this.store.flush(); if (this.persistenceError) throw this.persistenceError;
  }
}
