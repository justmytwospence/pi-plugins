import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { FAMILY_CHANNEL, type AgentDescriptor, type FamilyRequest, type FamilyService, type PreparedAgent } from "../family-contract.ts";
import { MainState } from "../main-state.ts";
import { COALESCE_MS, OBSERVER_ENV, validCredentials, type MemberCredentials, type ObservationSnapshot } from "./protocol.ts";
import { FamilyClient } from "./transport.ts";
import { projectTranscript } from "./transcript.ts";

export function installEnvironmentObserver(pi: ExtensionAPI): void | Promise<void> {
  const raw = process.env[OBSERVER_ENV];
  if (!raw) return;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid family observer enrollment"); }
  if (!validCredentials(value)) throw new Error("Invalid family observer enrollment");
  return createObserver(value)(pi);
}

interface ObservedState {
  snapshot(): ObservationSnapshot;
  onChange(listener: () => void): () => void;
  dispose(): void;
}
/** Prepare process or SDK enrollment without loading Sidebar UI or retaining its parent runtime. */
export function preparedAgent(credentials: MemberCredentials, finish: PreparedAgent["finish"], observerDisposers = new Set<() => void>(), localPublish?: (snapshot: ObservationSnapshot) => void): PreparedAgent {
  let disposed = false;
  let finished = false;
  return {
    agentId: credentials.agentId,
    membership: { version: 1, familyId: credentials.familyId, agentId: credentials.agentId },
    observer: createObserver(credentials, observerDisposers, localPublish),
    extensions: [fileURLToPath(new URL("./observer-entry.ts", import.meta.url))],
    env: { [OBSERVER_ENV]: JSON.stringify(credentials) },
    finish(phase, error) { if (!finished) { finished = true; finish(phase, error); } },
    dispose() { if (disposed) return; disposed = true; for (const dispose of observerDisposers) dispose(); observerDisposers.clear(); },
  };
}
/** One discovery service per member. Its only remote authority is reserving direct descendants. */
export function createObserver(credentials: MemberCredentials, disposers = new Set<() => void>(), localPublish?: (snapshot: ObservationSnapshot) => void): ExtensionFactory {
  if (!validCredentials(credentials)) throw new Error("Invalid family observer credentials");
  return pi => {
    // ExtensionAPI wrappers differ per extension; synchronize through the runtime's event bus.
    const channel = "pi-plugins.agent-family.observer-installed.v1";
    const probe = { agentId: credentials.agentId, familyId: credentials.familyId, installed: false };
    pi.events.emit(channel, probe);
    if (probe.installed) return;
    const offInstalled = pi.events.on(channel, (raw: unknown) => {
      const request = raw as typeof probe;
      if (request?.agentId === credentials.agentId && request.familyId === credentials.familyId) request.installed = true;
    });
    let state: ObservedState | undefined;
    let client: FamilyClient | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let stopped = false;
    const snapshot = (): ObservationSnapshot => {
      if (!state) throw new Error("Family observation unavailable");
      const value = state.snapshot();
      // Minimize the wire data before framing: request payloads never cross the socket.
      const projection = projectTranscript(value.messages);
      return { sessionId: value.sessionId, leafId: value.leafId, revision: value.revision, model: value.model, request: value.request ? { model: value.request.model } : undefined, messages: [], projected: projection, live: { state: value.live.state } };
    };
    const publish = () => { if (!stopped && client && state) { try { const value = snapshot(); if (localPublish) localPublish(value); else client.send("update", value); } catch { /* reconnect sends a fresh bounded snapshot */ } } };
    const service: FamilyService = {
      async prepare(descriptor: AgentDescriptor, signal?: AbortSignal) {
        signal?.throwIfAborted();
        if (stopped || !client) throw new Error("Family observer is not connected");
        const owner = client;
        const child = await owner.request("prepare", descriptor);
        if (!validCredentials(child)) throw new Error("Invalid family reservation reply");
        const prepared = preparedAgent(child, (phase, error) => {
          void owner.request("finish", { agentId: child.agentId, phase, error }).catch(() => { /* disconnected status remains explicit */ });
        });
        if (signal?.aborted) { prepared.finish("stopped"); prepared.dispose(); signal.throwIfAborted(); }
        const abort = () => prepared.finish("stopped"); signal?.addEventListener("abort", abort, { once: true });
        const dispose = prepared.dispose; prepared.dispose = () => { signal?.removeEventListener("abort", abort); dispose(); };
        return prepared;
      },
      focus() { /* Headless members do not own the family's view. */ },
      async view() { throw new Error("Family primary view is unavailable in a member process"); },
      async prepareHandoff() { throw new Error("Family handoff requires the anchor host"); },
    };
    const offDiscovery = pi.events.on(FAMILY_CHANNEL, (value: unknown) => {
      const request = value as FamilyRequest;
      if (!stopped && request?.version === 1 && !request.service) request.service = service;
    });
    const offStart = pi.on("session_start", () => {
      if (stopped || state) return;
      state = new MainState(pi) as unknown as ObservedState;
      // MainState was constructed after this dispatch began; bind using the supplied start context below.
    });
    const offBind = pi.on("session_start", (_event, ctx) => {
      if (stopped || !state) return;
      (state as unknown as MainState).bind(ctx);
      client = new FamilyClient(credentials, snapshot); client.start();
      if (localPublish) publish();
      unsubscribe = state.onChange(() => { if (!timer) { timer = setTimeout(() => { timer = undefined; publish(); }, COALESCE_MS); timer.unref(); } });
    });
    const dispose = () => {
      if (stopped) return; publish(); stopped = true;
      if (timer) clearTimeout(timer); unsubscribe?.(); unsubscribe = undefined;
      client?.dispose(); client = undefined; state?.dispose(); state = undefined;
      offInstalled(); offDiscovery(); if (typeof offStart === "function") (offStart as () => void)(); if (typeof offBind === "function") (offBind as () => void)();
      disposers.delete(dispose);
    };
    disposers.add(dispose);
    pi.on("session_shutdown", dispose);
  };
}
