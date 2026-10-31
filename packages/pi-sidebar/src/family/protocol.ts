import type { AgentDescriptor, FamilyPhase } from "../family-contract.ts";

export const MAX_FRAME = 1024 * 1024;
export const MAX_PAGE = 64 * 1024;
export const COALESCE_MS = 250;
export const HEARTBEAT_MS = 2000;
export const DISCONNECT_MS = 10000;
export const REQUEST_TIMEOUT_MS = 2000;
export const OBSERVER_ENV = "PI_SIDEBAR_FAMILY";
export type Coverage = "complete" | "partial" | "unavailable";
export interface AgentSummary extends AgentDescriptor {
  agentId: string;
  parentId?: string;
  phase: FamilyPhase;
  createdAt: number;
  updatedAt: number;
  revision: number;
  transcriptRevision: number;
  model?: string;
  activity?: string;
  coverage: Coverage;
}
export interface FamilySnapshot {
  familyId: string;
  revision: number;
  anchorId: string;
  focusId: string;
  agents: AgentSummary[];
}
export interface ObservationSnapshot {
  sessionId?: string;
  leafId?: string | null;
  revision: number;
  request?: { model?: string };
  model?: string;
  messages: readonly unknown[];
  projected?: { text: string; coverage: Coverage };
  live: { state: string };
}
export interface FamilyHost {
  agentId: string;
  snapshot(): ObservationSnapshot;
  onChange(listener: () => void): () => void;
}
export interface TranscriptQuery { agentId: string; revision?: number; cursor?: string; limitChars?: number }
export interface TranscriptPage {
  agentId: string;
  revision: number;
  coverage: Coverage;
  text: string;
  nextCursor?: string;
  unavailable?: string;
}
export interface TranscriptRecord { revision: number; coverage: Coverage; text: string }
export interface MemberCredentials { version: 1; familyId: string; agentId: string; socketPath: string; capability: string }
export interface WireFrame {
  version: 1;
  familyId: string;
  agentId: string;
  capability: string;
  epoch: string;
  seq: number;
  type: "hello" | "heartbeat" | "update" | "prepare" | "finish" | "reply";
  requestId?: string;
  data?: unknown;
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
export function assertId(value: unknown): asserts value is string {
  if (!validId(value)) throw new Error("Invalid family/member ID");
}
export function validCredentials(value: unknown): value is MemberCredentials {
  const c = value as MemberCredentials | undefined;
  return !!c && c.version === 1 && validId(c.familyId) && validId(c.agentId) && typeof c.socketPath === "string" && c.socketPath.length < 100 && /^\/tmp\/pi-sbf-[A-Za-z0-9]+\/s$/.test(c.socketPath) && typeof c.capability === "string" && /^[a-f0-9]{64}$/.test(c.capability);
}
export function validFrame(value: unknown): value is WireFrame {
  const f = value as WireFrame | undefined;
  return !!f && f.version === 1 && validId(f.familyId) && validId(f.agentId) && validId(f.epoch) && typeof f.capability === "string" && /^[a-f0-9]{64}$/.test(f.capability) && Number.isSafeInteger(f.seq) && f.seq > 0 && ["hello", "heartbeat", "update", "prepare", "finish", "reply"].includes(f.type) && (f.requestId === undefined || validId(f.requestId));
}
export function encodeFrame(frame: WireFrame): string {
  const text = JSON.stringify(frame) + "\n";
  if (Buffer.byteLength(text) > MAX_FRAME) throw new Error("Family frame exceeds 1 MiB");
  return text;
}
/** Byte-bounded framing; do not decode partial UTF-8 chunks. */
export class FrameDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): WireFrame[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const frames: WireFrame[] = [];
    let end: number;
    while ((end = this.pending.indexOf(10)) >= 0) {
      if (end + 1 > MAX_FRAME) throw new Error("Family frame exceeds 1 MiB");
      const value: unknown = JSON.parse(this.pending.subarray(0, end).toString("utf8"));
      this.pending = this.pending.subarray(end + 1);
      if (!validFrame(value)) throw new Error("Invalid family frame");
      frames.push(value);
    }
    if (this.pending.length >= MAX_FRAME) throw new Error("Family frame exceeds 1 MiB");
    return frames;
  }
}
