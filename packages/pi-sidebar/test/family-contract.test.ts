import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { FAMILY_CHANNEL, discoverFamily, type FamilyService } from "../src/family-contract.ts";
import { FrameDecoder, MAX_FRAME, encodeFrame, validCredentials, type WireFrame } from "../src/family/protocol.ts";
import { projectTranscript, transcriptPage } from "../src/family/transcript.ts";

describe("family structural and wire contracts", () => {
  it("discovers only an explicitly installed synchronous service", () => {
    expect(discoverFamily({ emit() {} })).toBeUndefined();
    const service = {} as FamilyService;
    expect(discoverFamily({ emit(channel, data) { expect(channel).toBe(FAMILY_CHANNEL); (data as { service?: FamilyService }).service = service; } })).toBe(service);
  });
  it("frames partial UTF8 safely and rejects oversized/invalid frames", () => {
    const frame: WireFrame = { version: 1, familyId: randomUUID(), agentId: randomUUID(), capability: "a".repeat(64), epoch: randomUUID(), seq: 1, type: "update", data: "漢字" };
    const bytes = Buffer.from(encodeFrame(frame)); const decoder = new FrameDecoder();
    expect(decoder.push(bytes.subarray(0, bytes.length - 3))).toEqual([]);
    expect(decoder.push(bytes.subarray(bytes.length - 3))).toEqual([frame]);
    expect(() => new FrameDecoder().push(Buffer.alloc(MAX_FRAME))).toThrow("1 MiB");
    expect(() => new FrameDecoder().push(Buffer.from("{}\n"))).toThrow("Invalid");
    expect(validCredentials({ ...frame, socketPath: "relative" })).toBe(false);
  });
  it("projects only evidence and pages by revision with bounded UTF8 size", () => {
    const projection = projectTranscript([{ role: "assistant", responseId: "SECRET", content: [{ type: "text", text: "answer", textSignature: "SECRET" }, { type: "image", data: "SECRET" }] }, { role: "toolResult", details: "SECRET", content: [{ type: "text", text: "x".repeat(9000) }] }]);
    expect(projection.text).not.toContain("SECRET"); expect(projection.coverage).toBe("partial"); expect(projection.text).toContain("omitted");
    const record = { revision: 2, coverage: "complete" as const, text: "漢字".repeat(60000) };
    const query = { agentId: randomUUID(), limitChars: 65536 };
    const page = transcriptPage(query, record);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
    expect(page.nextCursor).toBeDefined();
    expect(transcriptPage({ ...query, cursor: page.nextCursor }, { ...record, revision: 3 }).unavailable).toContain("stale");
    expect(transcriptPage({ ...query, revision: 1 }, record).coverage).toBe("unavailable");
  });
});
