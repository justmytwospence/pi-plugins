import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SidebarFamilyBinding } from "../child.ts";
import { FAMILY_CHANNEL, FAMILY_ENTRY, type FamilyMembership, type FamilyRequest, type FamilyService, type FamilyViewOptions } from "../family-contract.ts";
import type { MainState } from "../main-state.ts";
import { formatFamilyStatus } from "./context.ts";
import { consumeHandoff, handoffPending, membershipFromEntries, retainedFamily, retainFamily, reserveHandoff } from "./handoff.ts";
import { FamilyKernel } from "./kernel.ts";
import { FamilyRetrievalBudget, registerFamilyTools, type FamilyToolSource } from "./tools.ts";

/** Runtime-owned adapter. Kernels retain only its detachable observation subscription. */
export class SidebarHost implements FamilyToolSource {
  kernel: FamilyKernel | undefined;
  membership: FamilyMembership | undefined;
  private detach: (() => void) | undefined;
  private disposed = false;
  private budget = new FamilyRetrievalBudget();
  private offDiscovery: () => void;
  private pendingHandoffs = new Set<string>();
  readonly service: FamilyService;
  readonly binding: SidebarFamilyBinding;

  constructor(private readonly pi: ExtensionAPI, private readonly main: MainState, view: (options: FamilyViewOptions) => Promise<void>) {
    const ready = () => {
      if (this.disposed || !this.kernel || !this.membership) throw new Error("Sidebar family is not available in this runtime");
      return { kernel: this.kernel, member: this.membership };
    };
    this.service = {
      prepare: (descriptor, signal) => { const { kernel, member } = ready(); return kernel.prepareChild(member.agentId, descriptor, signal); },
      focus: (id) => ready().kernel.focus(id),
      view: (options) => { ready(); return view(options); },
      prepareHandoff: async () => {
        const { kernel, member } = ready();
        const prepared = await kernel.prepareChild(member.agentId, { kind: "implementation", label: "Implementation" });
        this.pendingHandoffs.add(prepared.agentId);
        const membership = reserveHandoff(prepared.membership);
        Object.defineProperty(membership, "cancel", { enumerable: false, value: () => {
          if (!this.pendingHandoffs.delete(prepared.agentId)) return;
          kernel.cancelReservation(prepared.agentId);
          consumeHandoff(membership);
          prepared.dispose();
        } });
        return membership;
      },
    };
    this.offDiscovery = pi.events.on(FAMILY_CHANNEL, (data: unknown) => {
      const request = data as FamilyRequest;
      if (!this.disposed && this.kernel && request?.version === 1 && !request.service) request.service = this.service;
    });
    this.binding = {
      append: (messages) => ready().kernel.appendExchange(randomUUID(), messages),
      capture: () => formatFamilyStatus(this.snapshot()),
      beginQuestion: (attachedBytes = 0) => {
        this.budget = new FamilyRetrievalBudget();
        const reservation = this.budget.reserve(attachedBytes);
        reservation.finish(reservation.bytes);
      },
      extension: (cpi) => {
        registerFamilyTools(cpi, this, () => this.budget);
        const off = cpi.events.on(FAMILY_CHANNEL, (data: unknown) => {
          const request = data as FamilyRequest;
          if (!this.disposed && request?.version === 1 && !request.service) request.service = {
            prepare: this.service.prepare,
            focus() {},
            async view() { throw new Error("Sidebar research children have no primary view"); },
            async prepareHandoff() { throw new Error("Sidebar is read-only"); },
          };
        });
        cpi.on("session_shutdown", () => off());
      },
    };
  }

  async start(ctx: ExtensionContext): Promise<void> {
    if (this.disposed) throw new Error("Sidebar host has been disposed");
    const sessionId = ctx.sessionManager.getSessionId();
    const entries = ctx.sessionManager.getEntries();
    let membership = membershipFromEntries(entries, sessionId);
    let kernel = membership ? retainedFamily<FamilyKernel>(membership.familyId) : undefined;
    const handedOff = membership ? consumeHandoff(membership) : false;
    if (!kernel) {
      kernel = await FamilyKernel.create({
        ...(membership ? { familyId: membership.familyId, agentId: membership.agentId } : {}),
        root: { kind: "main", label: "Main", sessionId, leafId: ctx.sessionManager.getLeafId() },
      });
      retainFamily(kernel.familyId, kernel);
    }
    membership ??= { version: 1, familyId: kernel.familyId, agentId: kernel.rootId, sessionId };
    if (membership.agentId !== kernel.anchorId && !handedOff) {
      // A valid persisted implementer is an existing anchor after a process restart.
      if (!kernel.snapshot().agents.some(a => a.agentId === membership!.agentId)) throw new Error("Family anchor membership is unavailable");
    }
    this.kernel = kernel;
    this.membership = membership;
    if (handedOff) kernel.setAnchor(membership.agentId);
    kernel.focus(membership.agentId);
    this.pi.appendEntry(FAMILY_ENTRY, membership);
    await kernel.store.migrateThread(ctx.sessionManager.getBranch());
    kernel.messages = await kernel.store.readThread();
    this.detach?.();
    this.detach = kernel.attachHost({ agentId: membership.agentId, snapshot: () => this.main.snapshot(), onChange: listener => this.main.onChange(listener) });
  }

  snapshot() { return this.disposed ? undefined : this.kernel?.snapshot(); }
  async transcript(query: Parameters<FamilyKernel["transcript"]>[0]) {
    if (this.disposed || !this.kernel) return { agentId: query.agentId, revision: 0, coverage: "unavailable" as const, text: "", unavailable: "Family observation unavailable" };
    return this.kernel.transcript(query);
  }
  async reset(): Promise<void> { await this.kernel?.resetThread(); }
  async append(messages: readonly AgentMessage[]): Promise<void> { await this.kernel?.appendExchange(randomUUID(), messages); }
  preferences(value: { model?: string; draft?: string; open?: boolean; sidebarFocused?: boolean }): void { this.kernel?.setPreferences(value); }
  async dispose(reason: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.offDiscovery();
    this.detach?.(); this.detach = undefined;
    const kernel = this.kernel;
    // A successful replacement consumed its reservation at the next session_start. Cancel any
    // unused handoff reservations on ordinary shutdown; reload leaves the actual family intact.
    // A reservation already adopted by a replacement session belongs to that session now.
    if (reason !== "new") {
      for (const id of this.pendingHandoffs) {
        if (!handoffPending(id)) continue;
        consumeHandoff({ version: 1, familyId: kernel?.familyId ?? "", agentId: id });
        try { kernel?.cancelReservation(id); } catch { /* observed since reservation: keep it */ }
      }
    }
    this.pendingHandoffs.clear();
    await kernel?.store.flush();
    this.kernel = undefined;
    this.membership = undefined;
  }
}
