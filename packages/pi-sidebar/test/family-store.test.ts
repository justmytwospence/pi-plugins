import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, appendFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { FamilyStore } from "../src/family/store.ts";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function store() { const dir = await mkdtemp(path.join(tmpdir(), "family-store-")); dirs.push(dir); return new FamilyStore(randomUUID(), dir); }
const message = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1 });
describe("family durable store", () => {
  it("serializes and deduplicates concurrent exchanges across resets and reopen", async () => {
    const s = await store(); await Promise.all(Array.from({ length: 10 }, () => s.appendExchange("same", [message("one")])));
    expect(await s.readThread()).toEqual([message("one")]);
    await s.resetThread("reset"); await s.appendExchange("same", [message("duplicate")]); await s.appendExchange("two", [message("two")]);
    expect(await s.readThread()).toEqual([message("two")]);
    const reopened = new FamilyStore(s.familyId, path.resolve(s.directory, "../../..")); expect(await reopened.readThread()).toEqual([message("two")]);
    expect((await stat(path.join(s.directory, "thread.jsonl"))).mode & 0o777).toBe(0o600);
  });
  it("migrates once and preserves an explicitly emptied thread", async () => {
    const s = await store(); const branch = [{ type: "custom", customType: "sidebar:exchange", data: { messages: [message("legacy")] } }];
    await s.migrateThread(branch); await s.migrateThread(branch); expect(await s.readThread()).toHaveLength(1);
    await s.resetThread(); await s.migrateThread(branch); expect(await s.readThread()).toEqual([]);
  });
  it("repairs a torn tail and bounds latest transcript storage", async () => {
    const s = await store(); await s.appendExchange("first", [message("first")]);
    await appendFile(path.join(s.directory, "thread.jsonl"), '{"torn":');
    await s.appendExchange("last", [message("last")]); expect(await s.readThread()).toHaveLength(2);
    const id = randomUUID(); await s.writeTranscript(id, { revision: 2, coverage: "partial", text: "new" }); await s.writeTranscript(id, { revision: 1, coverage: "complete", text: "old" });
    expect((await s.readTranscript(id))?.text).toBe("new");
    expect(() => s.readTranscript("../escape")).toThrow("Invalid"); await s.flush();
  });
});
