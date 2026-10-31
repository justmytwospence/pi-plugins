import { mkdir, readFile, writeFile, rename, open, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { compactExchange, threadFromBranch } from "../thread.ts";
import { assertId, type FamilySnapshot, type TranscriptRecord } from "./protocol.ts";

type ThreadEntry = { id: string; type: "exchange" | "reset" | "migration"; messages?: AgentMessage[] };
async function optionalRead(file: string): Promise<string | undefined> {
  try { return await readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function records<T>(text: string | undefined): T[] {
  if (!text) return [];
  const lines = text.split("\n");
  // A crash may leave an incomplete final append. Interior corruption is not hidden.
  if (lines.at(-1) !== "") lines.pop();
  return lines.filter(Boolean).map(line => JSON.parse(line) as T);
}
/** Single family writer. Every read-modify-write operation shares one queue. */
export class FamilyStore {
  readonly directory: string;
  private queue: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  constructor(readonly familyId: string, agentDir = getAgentDir()) {
    assertId(familyId);
    this.directory = path.join(agentDir, "pi-sidebar", "families", familyId);
  }
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(error => { this.failure = error; });
    return result;
  }
  private async initialize(): Promise<void> { await mkdir(path.join(this.directory, "transcripts"), { recursive: true, mode: 0o700 }); }
  private async atomic(file: string, value: unknown): Promise<void> {
    await this.initialize();
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  }
  private async append(file: string, value: unknown): Promise<void> {
    await this.initialize();
    // Remove a torn final record before the next append, preserving all committed records.
    const existing = await optionalRead(file);
    if (existing && !existing.endsWith("\n")) await writeFile(file, existing.slice(0, existing.lastIndexOf("\n") + 1), { mode: 0o600 });
    const handle = await open(file, "a", 0o600);
    try { await handle.writeFile(JSON.stringify(value) + "\n"); await handle.sync(); } finally { await handle.close(); }
  }
  loadState(): Promise<FamilySnapshot | undefined> {
    return this.serialized(async () => { const text = await optionalRead(path.join(this.directory, "state.json")); return text ? JSON.parse(text) as FamilySnapshot : undefined; });
  }
  saveState(state: FamilySnapshot): Promise<void> {
    const copy = structuredClone(state);
    return this.serialized(() => this.atomic(path.join(this.directory, "state.json"), copy));
  }
  readThread(): Promise<AgentMessage[]> {
    return this.serialized(async () => {
      let messages: AgentMessage[] = [];
      for (const entry of records<ThreadEntry>(await optionalRead(path.join(this.directory, "thread.jsonl")))) {
        if (entry.type === "reset") messages = [];
        else if (entry.messages) messages.push(...entry.messages);
      }
      return messages;
    });
  }
  appendExchange(id: string, messages: readonly AgentMessage[]): Promise<void> {
    if (!id || id.length > 200) return Promise.reject(new Error("Invalid exchange ID"));
    const copy = compactExchange(messages);
    return this.serialized(async () => {
      const file = path.join(this.directory, "thread.jsonl");
      if (records<ThreadEntry>(await optionalRead(file)).some(entry => entry.id === id)) return;
      await this.append(file, { id, type: "exchange", messages: copy });
    });
  }
  resetThread(id: string = randomUUID()): Promise<void> {
    return this.serialized(async () => {
      const file = path.join(this.directory, "thread.jsonl");
      if (!records<ThreadEntry>(await optionalRead(file)).some(entry => entry.id === id)) await this.append(file, { id, type: "reset" });
    });
  }
  migrateThread(branch: readonly unknown[]): Promise<void> {
    const messages = compactExchange(threadFromBranch(branch));
    return this.serialized(async () => {
      const file = path.join(this.directory, "thread.jsonl");
      // Only an untouched family migrates; an empty reset thread must stay reset.
      if ((await optionalRead(file)) !== undefined) return;
      await this.append(file, { id: "legacy-migration", type: "migration", messages });
    });
  }
  writeTranscript(agentId: string, record: TranscriptRecord): Promise<void> {
    assertId(agentId);
    if (!Number.isSafeInteger(record.revision) || record.revision < 0 || !["complete", "partial", "unavailable"].includes(record.coverage) || typeof record.text !== "string" || Buffer.byteLength(record.text) > 600000) return Promise.reject(new Error("Invalid or oversized transcript archive"));
    const copy = structuredClone(record);
    return this.serialized(async () => {
      const file = path.join(this.directory, "transcripts", `${agentId}.jsonl`);
      const last = records<TranscriptRecord>(await optionalRead(file)).at(-1);
      if (last && last.revision >= copy.revision) return;
      // Retain the latest projected snapshot only, bounding archive disk growth.
      await this.atomic(file, copy);
    });
  }
  readTranscript(agentId: string): Promise<TranscriptRecord | undefined> {
    assertId(agentId);
    return this.serialized(async () => {
      const file = path.join(this.directory, "transcripts", `${agentId}.jsonl`);
      try { if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error("Transcript archive exceeds limit"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      return records<TranscriptRecord>(await optionalRead(file)).at(-1);
    });
  }
  async flush(): Promise<void> { await this.queue; if (this.failure) throw this.failure; }
}
