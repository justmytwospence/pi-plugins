// Process-local parcels contain family-owned plain state, never an ExtensionAPI or UI context.
import type { FamilyMembership } from "../family-contract.ts";

const KEY = Symbol.for("pi-sidebar.families.v1");
interface Registry {
  families: Map<string, unknown>;
  reservations: Map<string, FamilyMembership>;
}
function registry(): Registry {
  const global = globalThis as unknown as Record<symbol, unknown>;
  return (global[KEY] ??= { families: new Map(), reservations: new Map() }) as Registry;
}
export function retainFamily<T>(familyId: string, family: T): void {
  registry().families.set(familyId, family);
}
export function retainedFamily<T>(familyId: string): T | undefined {
  return registry().families.get(familyId) as T | undefined;
}
export function forgetFamily(familyId: string): void {
  registry().families.delete(familyId);
}
export function reserveHandoff(membership: FamilyMembership): FamilyMembership {
  registry().reservations.set(membership.agentId, structuredClone(membership));
  return structuredClone(membership);
}
export function consumeHandoff(membership: FamilyMembership): boolean {
  const reserved = registry().reservations.get(membership.agentId);
  if (!reserved || reserved.familyId !== membership.familyId) return false;
  registry().reservations.delete(membership.agentId);
  return true;
}
/** Whether a reserved handoff is still waiting for its replacement session to adopt it. */
export function handoffPending(agentId: string): boolean {
  return registry().reservations.has(agentId);
}
export function membershipFromEntries(entries: readonly unknown[], sessionId: string): FamilyMembership | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string; customType?: string; data?: Partial<FamilyMembership> };
    const data = entry?.data;
    // Forks/clones copy custom entries: only the actual original session may adopt this family.
    if (entry?.type !== "custom" || entry.customType !== "sidebar:family" || data?.version !== 1 || data.sessionId !== sessionId) continue;
    if (typeof data.familyId === "string" && typeof data.agentId === "string") return data as FamilyMembership;
  }
  return undefined;
}
