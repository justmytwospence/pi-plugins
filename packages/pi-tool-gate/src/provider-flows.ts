import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FLOW_ENTRY, type FlowAssignment, type FlowAvailability, type FlowBus, type FlowExecution,
  type FlowSnapshot, type FlowState, type FlowTransitionResult, type FlowWorkflow, type ProviderFlow,
} from "./flow-contract.ts";
export type { OperatingMode, FlowAssignment, ProviderFlow, FlowState } from "./flow-contract.ts";

export const FLOW_BUSY = "Wait for the current turn before changing the linked flow.";
export const FLOW_TRANSITION = "A linked flow transition is in progress. Try again when it finishes.";
export const FLOW_RECOVERY = "Use /flow independent or select a valid /flow linked <provider>.";
export const ROLE_MODEL = "subagents:role-model";
export const ROLE_MODEL_READY = "subagents:role-model-ready";
const phases = ["work", "chat", "plan", "exec"] as const;
const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const copy = <T>(value: T): T => structuredClone(value);

export function parseProviderFlow(value: unknown): ProviderFlow | undefined {
  if (!record(value) || typeof value.provider !== "string" || !value.provider || typeof value.anchorModel !== "string" || !value.anchorModel || !record(value.roles)) return;
  const roles = {} as ProviderFlow["roles"];
  for (const phase of phases) {
    const assignment = value.roles[phase];
    if (!record(assignment) || assignment.provider !== value.provider || typeof assignment.modelId !== "string" || !assignment.modelId) return;
    if (assignment.suggestedThinking !== undefined && (typeof assignment.suggestedThinking !== "string" || !thinkingLevels.has(assignment.suggestedThinking))) return;
    roles[phase] = { provider: value.provider, modelId: assignment.modelId, ...(typeof assignment.suggestedThinking === "string" ? { suggestedThinking: assignment.suggestedThinking } : {}) };
  }
  // Work and Chat are a single General resolution, not independently configurable roles.
  if (JSON.stringify(roles.work) !== JSON.stringify(roles.chat)) return;
  return { provider: value.provider, anchorModel: value.anchorModel, roles };
}
export function parseFlowState(value: unknown): FlowState | undefined {
  if (!record(value) || value.version !== 1 || !["independent", "linked"].includes(String(value.operatingMode)) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0) return;
  const selectedFlow = parseProviderFlow(value.selectedFlow);
  // Invalid Linked snapshots retain the lock and become blocked, never implicitly Independent.
  return { version: 1, operatingMode: value.operatingMode as FlowState["operatingMode"], revision: value.revision as number, ...(selectedFlow ? { selectedFlow } : {}) };
}
export function restoreFlowState(entries: readonly unknown[]): FlowState {
  let state: FlowState = { version: 1, operatingMode: "independent", revision: 0 };
  for (const entry of entries) {
    if (!record(entry) || entry.type !== "custom" || entry.customType !== FLOW_ENTRY) continue;
    const parsed = parseFlowState(entry.data);
    if (parsed) state = parsed;
    else if (record(entry.data) && entry.data.version === 1 && entry.data.operatingMode === "linked") {
      // A damaged known Linked record must not silently remove its model lock.
      state = { version: 1, operatingMode: "linked", revision: state.revision };
    }
  }
  return state;
}
/** getAvailable() is the authentication boundary. Virtual entries share the chat catalog. */
export function isPhysicalChatModel(model: { api?: string; type?: string }): boolean {
  return typeof model.api === "string" && model.api !== "pi-virtual" && (model.type === undefined || model.type === "chat");
}
export function validateProviderFlow(flow: ProviderFlow, available: readonly Model<Api>[]): string | undefined {
  if (!parseProviderFlow(flow)) return "Invalid provider flow snapshot.";
  for (const phase of phases) {
    const assignment = flow.roles[phase];
    if (!available.some(model => model.provider === flow.provider && model.id === assignment.modelId && isPhysicalChatModel(model))) {
      return `${phase}: ${flow.provider}/${assignment.modelId} is not an available authenticated physical chat model.`;
    }
  }
  return undefined;
}
interface RoleRequest {
  role: string; parent: string; thinking: string; cwd: string;
  availableModels: readonly { provider: string; id: string }[];
  reply?: { model: string; thinking?: string };
}
/** Synchronous role discovery over a previously authenticated catalog; no inference calls. */
export function resolveProviderFlow(provider: string, anchor: string, available: readonly Model<Api>[], cwd: string, events: FlowBus): ProviderFlow {
  const resolve = (role: string): FlowAssignment => {
    const request: RoleRequest = { role, parent: `${provider}/${anchor}`, thinking: "medium", cwd, availableModels: available.map(({ provider, id }) => ({ provider, id })) };
    events.emit(ROLE_MODEL, request);
    if (!request.reply) throw new Error("Role defaults unavailable: pi-subagents has not provided subagents:role-model.");
    const prefix = `${provider}/`;
    if (!request.reply.model.startsWith(prefix)) throw new Error(`${role}: role default must stay inside ${provider}.`);
    const thinking = request.reply.thinking ?? "medium";
    if (!thinkingLevels.has(thinking)) throw new Error(`${role}: unsupported suggested thinking level ${thinking}.`);
    return { provider, modelId: request.reply.model.slice(prefix.length), suggestedThinking: thinking };
  };
  const general = resolve("general");
  const flow: ProviderFlow = { provider, anchorModel: anchor, roles: { work: general, chat: { ...general }, plan: resolve("planner"), exec: resolve("worker") } };
  const failure = validateProviderFlow(flow, available);
  if (failure) throw new Error(failure);
  return flow;
}

/** Structural guard lease: implementation is private to model-guard, never exposed on the bus. */
export interface FlowModelLease {
  available: boolean;
  pauseAvailable: boolean;
  pause(): boolean;
  apply<T>(target: { provider: string; id: string }, revision: number, run: () => Promise<T>): Promise<T>;
  dispose(): void;
}
export interface FlowHost {
  events: FlowBus;
  workflow(): FlowWorkflow;
  lease(): FlowModelLease | undefined;
  setModel(model: Model<Api>): Promise<boolean>;
  getThinking(): string;
  setThinking(thinking: string): void;
  persist(state: FlowState): void;
  changed(): void;
  /** False is an explicit teardown. Undefined permits a synchronous readiness probe. */
  roleReady?(): boolean | undefined;
}

export class ProviderFlowController {
  private state: FlowState = { version: 1, operatingMode: "independent", revision: 0 };
  private blocked?: string;
  private explicitRecovery = false;
  private roleProbed = false;
  private ready = false;
  private generation = 0;
  private pending = 0;
  private activation = false;
  private selecting = false;
  private queue: Promise<unknown> = Promise.resolve();
  private shutdownPromise?: Promise<void>;
  constructor(private readonly host: FlowHost) {}
  snapshot(): FlowSnapshot {
    return { ...copy(this.state), workflow: this.host.workflow(), ready: this.ready, guardAvailable: this.host.lease()?.available === true && this.host.lease()?.pauseAvailable === true, ...(this.blocked ? { blocked: this.blocked } : {}), transitioning: this.pending > 0 };
  }
  get inFlight(): boolean { return this.pending > 0 || this.activation; }
  /** The initial activation is locked too, before durable Linked metadata is committed. */
  guardPolicy(): { linked: boolean; revision: number } {
    return { linked: this.state.operatingMode === "linked" || this.inFlight || this.selecting || this.explicitRecovery, revision: this.state.revision };
  }
  private result(error?: string): FlowTransitionResult { return { ok: !error, snapshot: this.snapshot(), ...(error ? { error } : {}) }; }
  private async available(ctx: ExtensionContext): Promise<Model<Api>[]> {
    if (!ctx.modelRegistry?.getAvailable) throw new Error("Model availability is unavailable in this session.");
    return [...await ctx.modelRegistry.getAvailable()].filter(isPhysicalChatModel);
  }
  async listFlows(ctx: ExtensionContext): Promise<FlowAvailability> {
    const available = await this.available(ctx);
    const flows: ProviderFlow[] = [];
    const failures: FlowAvailability["failures"] = [];
    for (const provider of [...new Set(available.map(model => model.provider))].sort()) {
      const models = available.filter(model => model.provider === provider).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const anchor = models.find(model => model.provider === ctx.model?.provider && model.id === ctx.model.id) ?? models[0]!;
      try {
        if (this.host.roleReady?.() === false) throw new Error("Role defaults unavailable: pi-subagents is not ready.");
        flows.push(resolveProviderFlow(provider, anchor.id, available, ctx.cwd, this.host.events));
      } catch (error) { failures.push({ provider, reason: errorText(error) }); }
    }
    return { flows, failures };
  }
  private fence(ctx: ExtensionContext) {
    const generation = this.generation;
    const revision = this.state.revision;
    const manager = ctx.sessionManager;
    const session = manager.getSessionId?.();
    const leaf = manager.getLeafId?.();
    return () => {
      if (!this.ready || generation !== this.generation || revision !== this.state.revision || manager.getSessionId?.() !== session) throw new Error("Flow transition cancelled: the session, branch, or selection changed.");
      // Appending model/thinking entries is allowed. Moving to an unrelated branch is not.
      if (leaf && !manager.getBranch().some(entry => entry.id === leaf)) throw new Error("Flow transition cancelled: the branch changed.");
    };
  }
  private enqueue(ctx: ExtensionContext, operation: (check: () => void) => Promise<void>): Promise<FlowTransitionResult> {
    const check = this.fence(ctx);
    this.pending++;
    this.host.changed();
    const run = async () => {
      try { check(); await operation(check); return this.result(); }
      catch (error) { return this.result(errorText(error)); }
      finally { this.pending--; this.host.changed(); }
    };
    const next = this.queue.then(run, run);
    this.queue = next;
    // Snapshot after finally, so consumers do not mistake a completed operation for an active one.
    return next.then(result => ({ ...result, snapshot: this.snapshot() }));
  }
  private async activate(flow: ProviderFlow, phase: FlowWorkflow, ctx: ExtensionContext, check: () => void, initial = false, probeReadiness = false): Promise<void> {
    const lease = this.host.lease();
    if (!lease?.available || !lease.pauseAvailable) throw new Error("Linked mode needs an installed, supported model guard with queue-preserving pause.");
    if (this.host.roleReady?.() === false) throw new Error("Role defaults unavailable: pi-subagents is not ready.");
    const available = await this.available(ctx);
    check();
    const failure = validateProviderFlow(flow, available);
    if (failure) throw new Error(failure);
    // Older optional providers may not publish readiness. Probe only for a response;
    // changed role defaults must not invalidate or replace a durable activation snapshot.
    if (probeReadiness && !this.roleProbed && this.host.roleReady?.() === undefined) {
      const request: RoleRequest = { role: "general", parent: `${flow.provider}/${flow.anchorModel}`, thinking: "medium", cwd: ctx.cwd, availableModels: available.map(({ provider, id }) => ({ provider, id })) };
      this.host.events.emit(ROLE_MODEL, request);
      if (!request.reply) throw new Error("Role defaults unavailable: pi-subagents has not provided subagents:role-model.");
      this.roleProbed = true;
    }
    const assignment = flow.roles[phase];
    const model = available.find(model => model.provider === assignment.provider && model.id === assignment.modelId)!;
    const thinking = initial ? assignment.suggestedThinking ?? "medium" : this.host.getThinking();
    check();
    const previous = ctx.model;
    const liveDestination = this.fence(ctx);
    let applied = false;
    this.activation = true;
    try {
      if (ctx.model?.provider !== model.provider || ctx.model.id !== model.id) {
        const success = await lease.apply({ provider: model.provider, id: model.id }, this.state.revision, () => this.host.setModel(model));
        check();
        if (!success) throw new Error(`Model activation failed: ${model.provider}/${model.id}.`);
        applied = true;
      }
      // Native setModel may apply a per-model default. Restore the user's requested effort,
      // using the native setter's capability clamp, not another role suggestion.
      this.host.setThinking(thinking);
      check();
    } catch (error) {
      // The native setter normally fails before mutation. A post-mutation extension
      // failure cannot honestly be reported as an unchanged old tuple.
      let live = true;
      try { liveDestination(); } catch { live = false; }
      if (live && (applied || ctx.model?.provider !== previous?.provider || ctx.model?.id !== previous?.id)) {
        this.explicitRecovery = true;
        this.blocked = `Flow activation failed after model mutation: ${errorText(error)}. ${FLOW_RECOVERY}`;
      }
      throw error;
    } finally { this.activation = false; }
  }
  private commit(commit: () => void) {
    try { commit(); }
    catch (error) {
      this.explicitRecovery = true;
      this.blocked = `Flow commit failed after model activation: ${errorText(error)}. ${FLOW_RECOVERY}`;
      throw new Error(this.blocked);
    }
  }
  selectProvider(provider: string, ctx: ExtensionContext): Promise<FlowTransitionResult> {
    if (!ctx.isIdle()) return Promise.resolve(this.result(FLOW_BUSY));
    if (this.host.workflow() === "exec") return Promise.resolve(this.result("Provider changes and entering Linked are unavailable during Exec. Use /plan-exec for status or /flow independent."));
    return this.enqueue(ctx, async fence => {
      const check = () => {
        fence();
        if (!ctx.isIdle()) throw new Error(FLOW_BUSY);
        if (this.host.workflow() === "exec") throw new Error("Cannot change the provider during Exec.");
      };
      check();
      this.selecting = true;
      try {
        const availability = await this.listFlows(ctx);
        check();
        const flow = availability.flows.find(flow => flow.provider === provider);
        if (!flow) throw new Error(availability.failures.find(failure => failure.provider === provider)?.reason ?? `No available authenticated physical models for ${provider}.`);
        await this.activate(flow, this.host.workflow(), ctx, check, this.state.operatingMode === "independent");
        check();
        this.commit(() => {
          const next: FlowState = { version: 1, operatingMode: "linked", selectedFlow: copy(flow), revision: this.state.revision + 1 };
          this.host.persist(copy(next));
          this.state = next;
          this.roleProbed = true;
          this.blocked = undefined;
          this.explicitRecovery = false;
        });
      } finally { this.selecting = false; }
    });
  }
  setIndependent(ctx: ExtensionContext): Promise<FlowTransitionResult> {
    if (this.inFlight) return Promise.resolve(this.result(FLOW_TRANSITION));
    if (this.state.operatingMode === "independent" && !this.blocked) return Promise.resolve(this.result());
    if (!ctx.isIdle()) return Promise.resolve(this.result(FLOW_BUSY));
    return this.enqueue(ctx, async check => {
      if (!ctx.isIdle()) throw new Error(FLOW_BUSY);
      check();
      this.commit(() => {
        const next: FlowState = { version: 1, operatingMode: "independent", revision: this.state.revision + 1 };
        this.host.persist(copy(next));
        this.state = next;
        this.blocked = undefined;
        this.explicitRecovery = false;
      });
    });
  }
  prepareWorkflow(next: Exclude<FlowWorkflow, "exec">, ctx: ExtensionContext, commit: () => void = () => {}): Promise<FlowTransitionResult> {
    if (this.host.workflow() === "exec") return Promise.resolve(this.result("Exec is active. Use /plan-exec for status and recovery."));
    if (this.state.operatingMode === "independent") {
      if (this.inFlight) return Promise.resolve(this.result(FLOW_TRANSITION));
      if (this.blocked) return Promise.resolve(this.result(this.blocked));
      commit(); return Promise.resolve(this.result());
    }
    return this.enqueue(ctx, async fence => {
      const check = () => {
        fence();
        if (this.host.workflow() === "exec") throw new Error("Exec is active. Use /plan-exec for status and recovery.");
      };
      check();
      if (this.blocked) throw new Error(this.blocked);
      if (!this.state.selectedFlow) throw new Error("Linked flow snapshot is missing.");
      await this.activate(this.state.selectedFlow, next, ctx, check);
      check();
      this.commit(commit);
    });
  }
  /** A fresh approved child is already overlaid as Exec before its bootstrap commits. */
  private seededExecution(ctx: ExtensionContext, phase: Omit<FlowExecution, "commit">): boolean {
    const entries = ctx.sessionManager.getBranch();
    const latest = (type: string) => {
      const entry = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === type);
      return entry?.type === "custom" && record(entry.data) ? entry.data : undefined;
    };
    const runtime = latest("plan-implementation-runtime");
    const active = latest("plan-mode:exec");
    if (!runtime || !record(runtime.exec) || !active || active.active !== true || active.planFile !== phase.planFile) return false;
    const seed = runtime.exec;
    const saved = parseFlowState(seed.linkedFlow);
    const worker = this.state.selectedFlow?.roles.exec;
    return seed.active === true && seed.planFile === phase.planFile && !!worker &&
      seed.implementerModel === `${worker.provider}/${worker.modelId}` && active.implementerModel === seed.implementerModel &&
      saved?.operatingMode === "linked" && saved.revision === phase.expectedRevision &&
      JSON.stringify(saved.selectedFlow) === JSON.stringify(this.state.selectedFlow) &&
      // Once begin writes negotiation identity, this is an ordinary active execution,
      // not a fresh one-shot initialization. It cannot be begun again via this route.
      !record(active.negotiation);
  }
  runExecutionTransition(phase: Omit<FlowExecution, "commit">, ctx: ExtensionContext, commit: () => void): Promise<FlowTransitionResult> {
    return this.enqueue(ctx, async fence => {
      const check = () => {
        fence();
        if (phase.expectedRevision !== this.state.revision) throw new Error("Approved plan flow revision is stale.");
        const workflow = this.host.workflow();
        const seeded = phase.phase === "begin" && workflow === "exec" && this.seededExecution(ctx, phase);
        if (!seeded && workflow !== (phase.phase === "begin" ? "plan" : "exec")) throw new Error("Approved plan lifecycle changed before the flow transition.");
        if (phase.phase !== "begin") {
          const entries = ctx.sessionManager.getBranch();
          const execution = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === "plan-mode:exec");
          const data = execution?.type === "custom" ? execution.data : undefined;
          if (!record(data) || data.active !== true || data.planFile !== phase.planFile) throw new Error("Approved plan identity changed before completion.");
        }
      };
      if (this.state.operatingMode !== "linked" || !this.state.selectedFlow) throw new Error("Linked execution requires a selected provider flow.");
      if (!phase.planFile.trim()) throw new Error("Linked execution requires an approved plan identity.");
      if (this.blocked && this.explicitRecovery) throw new Error(this.blocked);
      check();
      await this.activate(this.state.selectedFlow, phase.phase === "begin" ? "exec" : "work", ctx, check, false, this.blocked !== undefined);
      check();
      this.blocked = undefined;
      this.commit(commit);
    });
  }
  /** Synchronously locks the destination before any asynchronous startup work. */
  restoreState(entries: readonly unknown[]): void {
    this.generation++;
    // The durable selection revision is part of an approved Exec identity. Preserve it
    // on resume/tree/reload; the private generation fences abandoned branch operations.
    this.state = restoreFlowState(entries);
    this.explicitRecovery = false;
    this.roleProbed = false;
    this.ready = true;
    this.blocked = this.state.operatingMode === "linked" ? "Linked flow is awaiting reconciliation." : undefined;
  }
  /** Called from the destination lifecycle, before any Linked controls are published. */
  restore(entries: readonly unknown[], ctx: ExtensionContext): Promise<FlowTransitionResult> {
    this.restoreState(entries);
    return this.reconcile(ctx);
  }
  reconcile(ctx: ExtensionContext): Promise<FlowTransitionResult> {
    if (this.state.operatingMode === "independent") return Promise.resolve(this.result());
    return this.enqueue(ctx, async check => {
      try {
        if (this.explicitRecovery) throw new Error(this.blocked ?? FLOW_RECOVERY);
        if (!this.state.selectedFlow) throw new Error("Linked flow snapshot is missing or invalid.");
        await this.activate(this.state.selectedFlow, this.host.workflow(), ctx, check, false, true);
        check();
        this.blocked = undefined;
      } catch (error) {
        // Stale completions must not block a newly restored destination.
        check();
        this.blocked = `${errorText(error)} ${FLOW_RECOVERY}`;
        throw new Error(this.blocked);
      }
    });
  }
  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.generation++;
    this.ready = false;
    const lease = this.host.lease();
    // An authorized SDK setter may already be awaiting auth. It cannot be revoked
    // after entry: drain it before the awaited session_shutdown boundary allows a
    // replacement runtime to reconcile this same manager. Fence first so neither
    // the completed operation nor queued work can persist stale flow/workflow state.
    // Do not wait for agent idle here: a tool-owned transition can belong to that run.
    this.shutdownPromise = this.queue.then(() => { lease?.dispose(); });
    return this.shutdownPromise;
  }
}
