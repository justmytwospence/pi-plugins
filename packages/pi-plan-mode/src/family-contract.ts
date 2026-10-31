// Structural optional integration contract. Keep identical in Sidebar, subagents and plan-mode.
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

export const FAMILY_CHANNEL = "pi-plugins.agent-family.v1";
export const FAMILY_ENTRY = "sidebar:family";
export type FamilyPhase = "starting" | "working" | "waiting" | "idle" | "done" | "failed" | "stopped" | "disconnected";
export interface FamilyMembership {
  version: 1;
  familyId: string;
  agentId: string;
  sessionId?: string;
  /** Runtime-only reservation cancellation; never persisted with membership. */
  cancel?(): void;
}
export interface AgentDescriptor {
  kind: string;
  label: string;
  sessionId?: string;
  leafId?: string | null;
  operationId?: string;
}
export interface PreparedAgent {
  agentId: string;
  membership: FamilyMembership;
  observer: ExtensionFactory;
  extensions: string[];
  env: Record<string, string>;
  finish(phase: "done" | "failed" | "stopped", error?: string): void;
  dispose(): void;
}
export interface FamilyViewOptions {
  factory(
    tui: TUI,
    theme: unknown,
    keybindings: unknown,
    done: () => void,
    viewport: () => { width: number; height: number },
  ): Component | Promise<Component>;
}
export interface FamilyService {
  prepare(descriptor: AgentDescriptor, signal?: AbortSignal): Promise<PreparedAgent>;
  focus(agentId: string | undefined): void;
  view(options: FamilyViewOptions): Promise<void>;
  prepareHandoff(): Promise<FamilyMembership>;
}
export interface FamilyRequest {
  version: 1;
  service?: FamilyService;
}
export function discoverFamily(events: { emit(channel: string, data: unknown): void }): FamilyService | undefined {
  const request: FamilyRequest = { version: 1 };
  events.emit(FAMILY_CHANNEL, request);
  return request.service;
}
