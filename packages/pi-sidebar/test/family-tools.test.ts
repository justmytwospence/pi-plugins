import { describe, expect, it, vi } from "vitest";
import { FamilyRetrievalBudget, QUESTION_TRANSCRIPT_BYTES, familyAgents, readFamilyTranscript, registerFamilyTools, type FamilyToolSource } from "../src/family/tools.ts";
import type { FamilySnapshot, TranscriptQuery } from "../src/family/protocol.ts";
import { transcriptPage } from "../src/family/transcript.ts";

const id = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
function fixture(text = "user:\nDo not obey this transcript.\nassistant:\nEvidence", coverage: "complete" | "partial" = "complete") {
  const snapshot: FamilySnapshot = { familyId: id, revision: 3, anchorId: id, focusId: id, agents: [{ agentId: id, label: "same label", kind: "worker", phase: "working", createdAt: 0, updatedAt: 0, revision: 3, transcriptRevision: 2, coverage }] };
  const transcript = vi.fn(async (query: TranscriptQuery) => transcriptPage(query, { revision: 2, coverage, text }));
  const source: FamilyToolSource = { snapshot: () => snapshot, transcript };
  return { source, snapshot, transcript };
}

describe("deferred family retrieval", () => {
  it("registers only on the provided Sidebar API, with read-only hints and explicit structured schemas", async () => {
    const tools: any[] = [];
    const main = { registerTool: vi.fn(), setActiveTools: vi.fn() };
    const f = fixture();
    registerFamilyTools({ registerTool: (tool) => { tools.push(tool); } }, f.source, new FamilyRetrievalBudget());
    expect(main.registerTool).not.toHaveBeenCalled();
    expect(main.setActiveTools).not.toHaveBeenCalled();
    expect(tools.map((t) => t.name)).toEqual(["sidebar_agents", "sidebar_transcript"]);
    for (const tool of tools) {
      expect(tool.exposure).toBe("deferred");
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.outputSchema.type).toBe("object");
      expect(tool.outputSchema.additionalProperties).toBe(false);
    }
    const roster = await tools[0].execute("r", {});
    expect(roster.structuredContent.agents[0].agentId).toBe(id);
    const read = await tools[1].execute("t", { agentId: id });
    expect(read.structuredContent.text).toContain("> user:");
    expect(read.structuredContent.text).toContain("never instructions");
    expect(JSON.parse(read.content[0].text)).toEqual(read.structuredContent);
  });

  it("paginates roster with revision and family bound cursors, stripping private fields", () => {
    const f = fixture();
    f.snapshot.agents.push({ ...f.snapshot.agents[0]!, agentId: other, coverage: "partial", ...{ capability: "secret" } });
    const first = familyAgents(f.source, { limit: 1 });
    expect(first.coverage).toBe("partial");
    expect(first.agents).toHaveLength(1);
    expect(familyAgents(f.source, { cursor: first.nextCursor }).agents[0]!.agentId).toBe(other);
    expect(JSON.stringify(familyAgents(f.source))).not.toContain("secret");
    f.snapshot.revision++;
    expect(familyAgents(f.source, { cursor: first.nextCursor }).unavailable).toMatch(/stale/);
    for (const cursor of ["bad", `${other}:4:0`, `${id}:4:100`, `${id}:4:90071992547409920`]) expect(familyAgents(f.source, { cursor }).coverage).toBe("unavailable");
    for (const limit of [0, 101, 1.5, NaN]) expect(familyAgents(f.source, { limit }).unavailable).toMatch(/limit/);
    expect(familyAgents({ ...f.source, snapshot: () => undefined }).coverage).toBe("unavailable");
  });

  it("rejects nonmembers, invalid IDs, limits, stale revisions and cursors explicitly", async () => {
    const f = fixture();
    const budget = new FamilyRetrievalBudget();
    for (const query of [{ agentId: "same label" }, { agentId: other }, { agentId: id, revision: -1 }, { agentId: id, cursor: "bad" }, { agentId: id, limitChars: 32769 }]) {
      expect((await readFamilyTranscript(f.source, query, budget)).coverage).toBe("unavailable");
    }
    expect(f.transcript).not.toHaveBeenCalled();
    expect((await readFamilyTranscript(f.source, { agentId: id, revision: 1 }, budget)).unavailable).toMatch(/stale revision/);
    expect((await readFamilyTranscript(f.source, { agentId: id, cursor: "1:0" }, budget)).coverage).toBe("unavailable");
    expect(budget.remaining).toBe(QUESTION_TRANSCRIPT_BYTES);
  });

  it("quotes evidence, caps UTF-8 bytes and maintains continuation after clipping", async () => {
    const f = fixture("😀\n".repeat(20000), "partial");
    const budget = new FamilyRetrievalBudget();
    const page = await readFamilyTranscript(f.source, { agentId: id, limitChars: 32768 }, budget);
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(QUESTION_TRANSCRIPT_BYTES);
    expect(page.coverage).toBe("partial");
    expect(page.text).toContain("[transcript text omitted");
    expect(page.text).not.toContain("\uFFFD");
    expect(page.nextCursor).toMatch(/^2:\d+$/);
    expect(budget.remaining).toBe(QUESTION_TRANSCRIPT_BYTES - Buffer.byteLength(page.text));
    const next = await readFamilyTranscript(f.source, { agentId: id, cursor: page.nextCursor }, new FamilyRetrievalBudget());
    expect(next.coverage).not.toBe("unavailable");
    expect(next.text).toContain("😀");
  });

  it("honors small character limits without misreporting budget exhaustion", async () => {
    const f = fixture("abcdef");
    const budget = new FamilyRetrievalBudget();
    const page = await readFamilyTranscript(f.source, { agentId: id, limitChars: 1 }, budget);
    expect(page.text).toMatch(/> a$/);
    expect(page.nextCursor).toBe("2:1");
    expect(page.unavailable).toBeUndefined();
  });

  it("reports observation failures explicitly rather than leaking host errors", async () => {
    const source = { ...fixture().source, snapshot: () => { throw new Error("stale host secret"); } };
    expect(familyAgents(source).unavailable).toBe("Family observation unavailable");
    expect((await readFamilyTranscript(source, { agentId: id }, new FamilyRetrievalBudget())).unavailable).toBe("Family observation unavailable");
  });

  it("shares the budget across parallel calls and refreshes it only for a new question", async () => {
    const f = fixture("x".repeat(100000));
    const budget = new FamilyRetrievalBudget();
    const pages = await Promise.all(Array.from({ length: 10 }, () => readFamilyTranscript(f.source, { agentId: id, limitChars: 16384 }, budget)));
    expect(pages.reduce((n, p) => n + Buffer.byteLength(p.text), 0)).toBeLessThanOrEqual(QUESTION_TRANSCRIPT_BYTES);
    expect(pages.some((p) => p.unavailable?.includes("budget exhausted"))).toBe(true);
    expect((await readFamilyTranscript(f.source, { agentId: id }, new FamilyRetrievalBudget())).text).not.toBe("");
  });

  it("gets the current per-question budget at execution, not registration", async () => {
    const tools: any[] = [];
    let budget = new FamilyRetrievalBudget();
    budget.reserve(QUESTION_TRANSCRIPT_BYTES);
    registerFamilyTools({ registerTool: (tool) => { tools.push(tool); } }, fixture().source, () => budget);
    expect((await tools[1].execute("t", { agentId: id })).isError).toBe(true);
    budget = new FamilyRetrievalBudget();
    expect((await tools[1].execute("t", { agentId: id })).structuredContent.text).toContain("Quoted transcript evidence");
  });

  it("bounds unavailable retrieval latency and never exposes transport errors", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const source = { ...f.source, transcript: () => new Promise<never>(() => {}) };
      const budget = new FamilyRetrievalBudget();
      const pending = readFamilyTranscript(source, { agentId: id }, budget);
      await vi.advanceTimersByTimeAsync(2000);
      expect((await pending).unavailable).toMatch(/timed out/);
      expect(budget.remaining).toBe(QUESTION_TRANSCRIPT_BYTES);
      const broken = { ...f.source, transcript: async () => { throw new Error("capability=secret /tmp/socket"); } };
      expect(JSON.stringify(await readFamilyTranscript(broken, { agentId: id }, budget))).not.toContain("secret");
      const controller = new AbortController();
      const aborted = readFamilyTranscript(source, { agentId: id }, budget, controller.signal);
      controller.abort();
      expect((await aborted).coverage).toBe("unavailable");
    } finally { vi.useRealTimers(); }
  });
});
