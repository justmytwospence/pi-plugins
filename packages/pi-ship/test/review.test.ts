import { describe, expect, it } from "vitest";
import { dedupe, type Finding, lensTask, parseFindings, verify } from "../src/review.ts";
import type { System1Outcome } from "../src/system1.ts";

const f = (over: Partial<Finding> = {}): Finding => ({ path: "a.ts", line: 10, severity: "minor", title: "t", body: "b", lens: "correctness", ...over });
const block = (v: unknown) => `Here you go.\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\`\n`;

describe("parseFindings", () => {
  it("reads the last json block and validates each finding", () => {
    const text = `${block([{ path: "x", line: 1, title: "old", body: "" }])}\n${block([{ path: "a.ts", line: 3, severity: "blocking", title: "T", body: "B" }, { path: "", line: 1, title: "t", body: "b" }, { path: "b.ts", line: 0, title: "t", body: "b" }, { path: "c.ts", line: 2, severity: "weird", title: "t", body: "b" }, null])}`;
    expect(parseFindings(text, "security").findings).toEqual([
      { path: "a.ts", line: 3, severity: "blocking", title: "T", body: "B", lens: "security" },
      { path: "c.ts", line: 2, severity: "minor", title: "t", body: "b", lens: "security" },
    ]);
  });
  it("reports a missing, unparsable or non-array block", () => {
    expect(parseFindings("nothing", "docs")).toEqual({ findings: [], error: "docs: no json block in the answer" });
    expect(parseFindings("```json\n{nope\n```", "docs").error).toBe("docs: the json block does not parse");
    expect(parseFindings(block({ a: 1 }), "docs").error).toBe("docs: the json block is not an array");
    expect(parseFindings(block([]), "docs")).toEqual({ findings: [] });
  });
});

describe("dedupe", () => {
  it("drops findings within two lines of one on the same path, keeping blocking ones first", () => {
    const out = dedupe([f({ line: 10, title: "minor" }), f({ line: 11, severity: "blocking", title: "blocking" }), f({ line: 40, title: "far" }), f({ path: "b.ts", line: 10, title: "other file" })]);
    expect(out.map((x) => x.title)).toEqual(["blocking", "far", "other file"]);
  });
});

describe("lensTask", () => {
  it("names the diff, the lens and the answer format", () => {
    const t = lensTask("tests", "/r", "abc", "HEAD");
    expect(t).toContain("`git diff abc..HEAD` in /r for tests: changed behavior without tests");
    expect(t).toContain("exactly one ```json fenced block");
  });
});

describe("verify", () => {
  const answer = (p: number): System1Outcome => ({ ok: true, answers: { supported: { type: "bool", probability: p } }, latencyMs: 1 }) as unknown as System1Outcome;
  const hunk = async (path: string) => `hunk of ${path}`;

  it("keeps findings at or above the threshold and drops the rest", async () => {
    const probs: Record<string, number> = { keep: 0.6, drop: 0.59, high: 0.9 };
    const asked: Array<Record<string, unknown>> = [];
    const ask = async (state: Record<string, unknown>) => {
      asked.push(state);
      return answer(probs[(state.finding as { title: string }).title]!);
    };
    const out = await verify([f({ title: "keep" }), f({ title: "drop", line: 30 }), f({ title: "high", line: 50 })], hunk, ask, 0.6, 20);
    expect(out.map((x) => x.title)).toEqual(["keep", "high"]);
    expect(out.every((x) => !x.unverified)).toBe(true);
    expect(asked[0]).toMatchObject({ hunk: "hunk of a.ts", finding: { title: "keep", line: 10 } });
  });

  it("keeps a finding System 1 could not judge, marked unverified", async () => {
    const ask = async () => ({ ok: false, code: "disabled", reason: "off", attempts: [], latencyMs: 1 }) as unknown as System1Outcome;
    expect(await verify([f()], hunk, ask, 0.6, 20)).toEqual([{ ...f(), unverified: true }]);
  });

  it("judges at most the cap", async () => {
    let calls = 0;
    const ask = async () => (calls++, answer(1));
    const many = Array.from({ length: 30 }, (_, i) => f({ line: i * 10, title: String(i) }));
    expect(await verify(many, hunk, ask, 0.6, 20)).toHaveLength(20);
    expect(calls).toBe(20);
  });
});
