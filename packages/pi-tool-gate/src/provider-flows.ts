import { clampThinkingLevel, getSupportedThinkingLevels, type Model, type Api } from "@earendil-works/pi-ai";
import type { SelectionPressure } from "@justmytwospence/pi-subscription-usage";
import type { ClassifierProvenance } from "./system1.ts";
import { withEffortOrigin } from "./effort-origin.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  FLOW_ENTRY, type FlowAssignment, type FlowAvailability, type FlowBus, type FlowExecution,
  type FlowSnapshot, type FlowState, type FlowTransitionResult, type FlowWorkflow, type ProviderFlow,
} from "./flow-contract.ts";
export type { OperatingMode, FlowAssignment, ProviderFlow, FlowState } from "./flow-contract.ts";
import { executionReplanning, INVALID_REPLANNING, latestExecution } from "./modes.ts";

export const FLOW_BUSY = "Wait for the current turn before changing the linked flow.";
export const FLOW_TRANSITION = "A linked flow transition is in progress. Try again when it finishes.";
export const FLOW_RECOVERY = "Use /flow independent or select a valid /flow linked <provider>.";
export const ROLE_MODEL = "subagents:role-model";
export const ROLE_MODEL_READY = "subagents:role-model-ready";
const phases = ["work", "chat", "plan", "exec"] as const;
const canonicalPhase = (phase: FlowWorkflow): FlowEffortInput["phase"] => phase === "work" || phase === "chat" ? "general" : phase;
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
    if (Object.hasOwn(assignment, "thinkingPinned") && assignment.thinkingPinned !== true) return;
    roles[phase] = { provider: value.provider, modelId: assignment.modelId, ...(typeof assignment.suggestedThinking === "string" ? { suggestedThinking: assignment.suggestedThinking } : {}), ...(assignment.thinkingPinned === true ? { thinkingPinned: true } : {}) };
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
  reply?: { model: string; thinking?: string; thinkingPinned?: true };
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
    if (Object.hasOwn(request.reply, "thinkingPinned") && request.reply.thinkingPinned !== true) throw new Error(`${role}: invalid authored effort pin.`);
    return { provider, modelId: request.reply.model.slice(prefix.length), suggestedThinking: thinking, ...(request.reply.thinkingPinned === true ? { thinkingPinned: true } : {}) };
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
export type FlowEffortInput = {
  phase: "general" | "plan" | "exec";
  target: { provider: string; id: string };
  fallback: string;
  thinkingPinned?: true;
};
export type PreparedFlowEffort = {
  requested: string;
  source: "manual" | "configured" | "system1" | "fallback";
  pressure?: SelectionPressure;
  classifier?: ClassifierProvenance;
  isCurrent(): boolean;
};
export type FlowEffortEntry = Omit<PreparedFlowEffort, "isCurrent"> & {
  phase: FlowEffortInput["phase"];
  target: FlowEffortInput["target"];
  effective: string;
};
type ActivationPolicy = "boundary" | "restore" | "approved";
type ActivatedEffort = { entry?: FlowEffortEntry; check(): void };

export interface FlowHost {
  events: FlowBus;
  workflow(): FlowWorkflow;
  replanning?(): boolean;
  lease(): FlowModelLease | undefined;
  setModel(model: Model<Api>): Promise<boolean>;
  getThinking(): string;
  setThinking(thinking: string): void;
  chooseEffort(input: FlowEffortInput, ctx: ExtensionContext, signal: AbortSignal): Promise<PreparedFlowEffort>;
  persistEffort(entry: FlowEffortEntry): void;
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
  private effortGeneration = 0;
  private preparation?: AbortController;
  /** Explicit choices invalidate pending preparation, never pin later phases. */
  invalidateEffort(): void {
    this.effortGeneration++;
    this.preparation?.abort();
    this.preparation = undefined;
  }
  constructor(private readonly host: FlowHost) {}
  snapshot(): FlowSnapshot {
    return { ...copy(this.state), workflow: this.host.workflow(), ...(this.host.replanning?.() ? { replanning: true } : {}), ready: this.ready, guardAvailable: this.host.lease()?.available === true && this.host.lease()?.pauseAvailable === true, ...(this.blocked ? { blocked: this.blocked } : {}), transitioning: this.pending > 0 };
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
    // A newer transition supersedes inference, but cannot revoke an entered native setter.
    if (this.preparation) this.invalidateEffort();
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
  private async activate(flow: ProviderFlow, phase: FlowWorkflow, ctx: ExtensionContext, check: () => void, policy: ActivationPolicy, probeReadiness = false, approved?: FlowExecution["effort"]): Promise<ActivatedEffort> {
    const lease = this.host.lease();
    const runSignal = !ctx.isIdle() ? ctx.signal : undefined;
    const epoch = this.effortGeneration;
    const previous = { provider: ctx.model?.provider, id: ctx.model?.id, thinking: this.host.getThinking() };
    const sameModel = (provider: string | undefined, id: string | undefined) => ctx.model?.provider === provider && ctx.model?.id === id;
    const current = () => {
      check();
      if (runSignal?.aborted) throw new Error("Flow transition cancelled: the active run was aborted.");
      if (epoch !== this.effortGeneration) throw new Error("Flow effort preparation cancelled: an explicit choice or transition changed.");
      if (!lease?.available || !lease.pauseAvailable || this.host.lease() !== lease) throw new Error("Linked mode needs an installed, supported model guard with queue-preserving pause.");
      if (this.host.roleReady?.() === false) throw new Error("Role defaults unavailable: pi-subagents is not ready.");
    };
    current();
    let available = await this.available(ctx);
    current();
    const failure = validateProviderFlow(flow, available);
    if (failure) throw new Error(failure);
    // Probe capability, never replace a durable role snapshot with new defaults.
    if (probeReadiness && !this.roleProbed && this.host.roleReady?.() === undefined) {
      const request: RoleRequest = { role: "general", parent: `${flow.provider}/${flow.anchorModel}`, thinking: "medium", cwd: ctx.cwd, availableModels: available.map(({ provider, id }) => ({ provider, id })) };
      this.host.events.emit(ROLE_MODEL, request);
      if (!request.reply) throw new Error("Role defaults unavailable: pi-subagents has not provided subagents:role-model.");
      this.roleProbed = true;
    }
    const assignment = flow.roles[phase];
    const target = { provider: assignment.provider, id: assignment.modelId };
    // Supplied approval data must be exact and valid before any physical mutation.
    if (approved !== undefined && (policy !== "approved" || !record(approved) || approved.provider !== target.provider || approved.modelId !== target.id ||
        !["manual", "configured", "system1", "fallback"].includes(approved.source) ||
        (approved.thinkingLevel !== undefined && !thinkingLevels.has(approved.thinkingLevel)))) {
      throw new Error("Invalid approved effort for the assigned worker.");
    }
    let prepared: PreparedFlowEffort = { requested: approved?.thinkingLevel ?? previous.thinking, source: approved?.source ?? "fallback", isCurrent: () => true };
    if (policy === "boundary") {
      const controller = new AbortController();
      this.preparation = controller;
      // Idle recovery must not inherit a completed run's aborted signal.
      const signal = runSignal ? AbortSignal.any([controller.signal, runSignal]) : controller.signal;
      try {
        signal.throwIfAborted();
        prepared = await new Promise<PreparedFlowEffort>((resolve, reject) => {
          const abort = () => reject(new Error("Flow effort preparation cancelled."));
          signal.addEventListener("abort", abort, { once: true });
          Promise.resolve(this.host.chooseEffort({ phase: canonicalPhase(phase), target, fallback: assignment.suggestedThinking ??
            (getSupportedThinkingLevels(available.find(model => model.provider === target.provider && model.id === target.id)!).includes(previous.thinking as never) ? previous.thinking : "medium"),
            ...(assignment.thinkingPinned ? { thinkingPinned: true } : {}) }, ctx, signal))
            .then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        });
        current();
        signal.throwIfAborted();
        // Authentication/catalog may have changed while inference was pending.
        available = await this.available(ctx);
        current();
        signal.throwIfAborted();
        const failure = validateProviderFlow(flow, available);
        if (failure) throw new Error(failure);
      } finally { if (this.preparation === controller) this.preparation = undefined; }
    }
    const model = available.find(model => model.provider === target.provider && model.id === target.id)!;
    const preparedCurrent = () => {
      current();
      if (!prepared.isCurrent()) throw new Error("Flow effort preparation cancelled: the selection changed.");
    };
    preparedCurrent();
    if (!thinkingLevels.has(prepared.requested)) throw new Error("Invalid prepared thinking level.");
    // Compare to the source only before our own model write. Native defaults and clamps
    // are owned writes, not manual changes, and must not invalidate their preparation.
    if (!sameModel(previous.provider, previous.id) || this.host.getThinking() !== previous.thinking) throw new Error("Flow effort preparation cancelled: the active model or effort changed.");
    const liveDestination = this.fence(ctx);
    let applied = false;
    this.activation = true;
    try {
      if (!sameModel(target.provider, target.id)) {
        const success = await lease!.apply(target, this.state.revision, () => withEffortOrigin("flow", () => this.host.setModel(model)));
        applied = success;
        preparedCurrent();
        if (!success) throw new Error(`Model activation failed: ${target.provider}/${target.id}.`);
      }
      preparedCurrent();
      if (!sameModel(target.provider, target.id)) throw new Error("Flow activation cancelled: the destination model changed.");
      const desired = clampThinkingLevel(model, prepared.requested as Parameters<typeof clampThinkingLevel>[1]);
      if (this.host.getThinking() !== desired) {
        withEffortOrigin("flow", () => this.host.setThinking(prepared.requested));
        applied = true;
      }
      preparedCurrent();
      if (!sameModel(target.provider, target.id)) throw new Error("Flow activation cancelled: the destination model changed.");
      const effective = this.host.getThinking();
      const finalCheck = () => {
        preparedCurrent();
        if (!sameModel(target.provider, target.id) || this.host.getThinking() !== effective) throw new Error("Flow transition cancelled: the destination model or effort changed before commit.");
      };
      if (policy === "restore") return { check: finalCheck };
      const { isCurrent: _, ...metadata } = prepared;
      return { entry: { ...metadata, phase: canonicalPhase(phase), target, effective }, check: finalCheck };
    } catch (error) {
      let live = true;
      try { liveDestination(); } catch { live = false; }
      if (live && (applied || !sameModel(previous.provider, previous.id) || this.host.getThinking() !== previous.thinking)) {
        this.explicitRecovery = true;
        this.blocked = `Flow activation failed after model or effort mutation: ${errorText(error)}. ${FLOW_RECOVERY}`;
      }
      throw error;
    } finally { this.activation = false; }
  }
  private commit(commit: () => void, effort?: ActivatedEffort) {
    try { effort?.check(); commit(); if (effort?.entry) this.host.persistEffort(copy(effort.entry)); }
    catch (error) {
      this.explicitRecovery = true;
      this.blocked = `Flow commit failed after model activation: ${errorText(error)}. ${FLOW_RECOVERY}`;
      throw new Error(this.blocked);
    }
  }
  selectProvider(provider: string, ctx: ExtensionContext): Promise<FlowTransitionResult> {
    if (!ctx.isIdle()) return Promise.resolve(this.result(FLOW_BUSY));
    if (this.host.workflow() === "exec" || this.host.replanning?.()) return Promise.resolve(this.result("Provider changes and entering Linked are unavailable during Exec. Use /plan-exec for status or /flow independent."));
    return this.enqueue(ctx, async fence => {
      const check = () => {
        fence();
        if (!ctx.isIdle()) throw new Error(FLOW_BUSY);
        if (this.host.workflow() === "exec" || this.host.replanning?.()) throw new Error("Cannot change the provider during Exec or replanning.");
      };
      check();
      this.selecting = true;
      try {
        const availability = await this.listFlows(ctx);
        check();
        const flow = availability.flows.find(flow => flow.provider === provider);
        if (!flow) throw new Error(availability.failures.find(failure => failure.provider === provider)?.reason ?? `No available authenticated physical models for ${provider}.`);
        const effort = await this.activate(flow, this.host.workflow(), ctx, check, "boundary");
        check();
        this.commit(() => {
          const next: FlowState = { version: 1, operatingMode: "linked", selectedFlow: copy(flow), revision: this.state.revision + 1 };
          this.host.persist(copy(next));
          this.state = next;
          this.roleProbed = true;
          this.blocked = undefined;
          this.explicitRecovery = false;
        }, effort);
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
    if (this.host.workflow() === "exec" || this.host.replanning?.()) return Promise.resolve(this.result("Exec is active. Use /plan-exec for status and recovery."));
    if (this.state.operatingMode === "independent") {
      if (this.inFlight) return Promise.resolve(this.result(FLOW_TRANSITION));
      if (this.blocked) return Promise.resolve(this.result(this.blocked));
      commit(); return Promise.resolve(this.result());
    }
    return this.enqueue(ctx, async fence => {
      const check = () => {
        fence();
        if (this.host.workflow() === "exec" || this.host.replanning?.()) throw new Error("Exec is active. Use /plan-exec for status and recovery.");
      };
      check();
      if (this.blocked) throw new Error(this.blocked);
      if (!this.state.selectedFlow) throw new Error("Linked flow snapshot is missing.");
      const policy = canonicalPhase(next) === canonicalPhase(this.host.workflow()) ? "restore" : "boundary";
      const effort = await this.activate(this.state.selectedFlow, next, ctx, check, policy);
      check();
      this.commit(commit, effort);
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
    if (!runtime || !record(runtime.exec) || !active || active.active !== true || active.planFile !== phase.planFile ||
        Object.hasOwn(active, "replanning") || Object.hasOwn(runtime.exec, "replanning")) return false;
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
    // The bus request is mutable for its result only, not a moving approval identity.
    phase = { ...phase, ...(phase.effort !== undefined ? { effort: record(phase.effort) ? { ...phase.effort } : phase.effort } : {}) };
    return this.enqueue(ctx, async fence => {
      const check = () => {
        fence();
        if (phase.expectedRevision !== this.state.revision) throw new Error("Approved plan flow revision is stale.");
        const workflow = this.host.workflow();
        const data = latestExecution(ctx.sessionManager.getBranch());
        const suspension = executionReplanning(data);
        if (suspension.invalid) throw new Error(INVALID_REPLANNING);
        const replanning = suspension.replanning || this.host.replanning?.() === true;
        const seeded = phase.phase === "begin" && workflow === "exec" && !replanning && this.seededExecution(ctx, phase);
        const source = phase.phase === "begin" || phase.phase === "resume" || (phase.phase === "stop" && replanning) ? "plan" : "exec";
        if (!seeded && workflow !== source) throw new Error("Approved plan lifecycle changed before the flow transition.");
        if (phase.phase === "begin") {
          if (replanning || (data?.active === true && !seeded)) throw new Error("An unfinished execution cannot begin again; approve its revised plan to resume.");
          return;
        }
        const revisiting = phase.phase === "replan" || phase.phase === "resume";
        if ((phase.phase === "replan" && replanning) || (phase.phase === "resume" && !suspension.replanning) ||
            (phase.phase === "finish" && replanning)) throw new Error("Approved plan lifecycle changed before the flow transition.");
        const planFile = phase.phase === "resume" ? suspension.draftFile : data?.planFile;
        if (!data || data.active !== true || planFile !== phase.planFile) throw new Error("Approved plan identity changed before completion.");
        const negotiation = record(data.negotiation) ? data.negotiation : undefined;
        if (revisiting || phase.expectedExecutionId !== undefined) {
          if (typeof phase.expectedExecutionId !== "string" || !phase.expectedExecutionId.trim() ||
              negotiation?.executionId !== phase.expectedExecutionId) throw new Error("Approved execution identity is stale or missing.");
        }
        if (revisiting || phase.expectedPlanRevision !== undefined) {
          const revision = negotiation?.planRevision === undefined ? 1 : negotiation.planRevision;
          if (!Number.isSafeInteger(phase.expectedPlanRevision) || phase.expectedPlanRevision! < 1 ||
              !Number.isSafeInteger(revision) || (revision as number) < 1 || revision !== phase.expectedPlanRevision) {
            throw new Error("Approved plan revision is stale or missing.");
          }
        }
        if (revisiting) {
          const saved = parseFlowState(data.linkedFlow);
          if (saved?.operatingMode !== "linked" || saved.revision !== this.state.revision ||
              JSON.stringify(saved.selectedFlow) !== JSON.stringify(this.state.selectedFlow)) {
            throw new Error("The unfinished task's Linked assignments no longer match the selected flow.");
          }
        }
      };
      if (!["begin", "replan", "resume", "finish", "stop"].includes(phase.phase)) throw new Error("Invalid approved plan lifecycle phase.");
      if (this.state.operatingMode !== "linked" || !this.state.selectedFlow) throw new Error("Linked execution requires a selected provider flow.");
      if (!phase.planFile.trim()) throw new Error("Linked execution requires an approved plan identity.");
      if (this.blocked && this.explicitRecovery) throw new Error(this.blocked);
      check();
      const destination = phase.phase === "replan" ? "plan" : phase.phase === "begin" || phase.phase === "resume" ? "exec" : "work";
      const approved = phase.phase === "begin" || phase.phase === "resume";
      const effort = await this.activate(this.state.selectedFlow, destination, ctx, check, approved ? "approved" : "boundary", this.blocked !== undefined, phase.effort);
      check();
      this.blocked = undefined;
      this.commit(commit, effort);
    });
  }
  /** Synchronously locks the destination before any asynchronous startup work. */
  restoreState(entries: readonly unknown[]): void {
    this.invalidateEffort();
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
        const effort = await this.activate(this.state.selectedFlow, this.host.replanning?.() ? "plan" : this.host.workflow(), ctx, check, "restore", true);
        check();
        effort.check();
        if (executionReplanning(latestExecution(ctx.sessionManager.getBranch())).invalid) throw new Error(INVALID_REPLANNING);
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
    this.invalidateEffort();
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
