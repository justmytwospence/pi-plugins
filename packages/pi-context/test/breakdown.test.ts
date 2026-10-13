import { formatSkillsForPrompt, type SessionEntry, type Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  assembleReport,
  capParts,
  collectContextBreakdown,
  type ContextPart,
  embeddedTokens,
  formatReport,
  formatTokens,
  normalizePreviewText,
  resolveUsedTokens,
  tokenEstimate,
} from "../src/breakdown.ts";

const part = (label: string, tokens: number): ContextPart => ({ label, tokens, color: "accent" });
const total = (parts: ContextPart[]) => parts.reduce((sum, p) => sum + p.tokens, 0);

describe("tokenEstimate", () => {
  test("is characters / 4, rounded up, and 0 for nothing", () => {
    expect(tokenEstimate("")).toBe(0);
    expect(tokenEstimate(undefined)).toBe(0);
    expect(tokenEstimate("abcd")).toBe(1);
    expect(tokenEstimate("abcde")).toBe(2);
  });

  test("serializes non-strings as JSON", () => {
    expect(tokenEstimate({ a: 1 })).toBe(Math.ceil('{"a":1}'.length / 4));
  });
});

describe("embeddedTokens", () => {
  test("counts a chunk only when the prompt contains it", () => {
    expect(embeddedTokens("hello world", "world")).toBe(2);
    expect(embeddedTokens("hello world", "mars")).toBe(0);
    expect(embeddedTokens("hello world", "")).toBe(0);
  });
});

describe("formatTokens", () => {
  test("formats by magnitude", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(99_949)).toBe("99.9k");
    expect(formatTokens(123_456)).toBe("123k");
  });
});

describe("capParts", () => {
  test("leaves parts alone when they fit", () => {
    const parts = [part("a", 10), part("b", 20)];
    expect(capParts(parts, 100)).toBe(parts);
  });

  test("scales the variable parts to the target and keeps the fixed prefix", () => {
    const parts = [part("fixed", 50), part("x", 300), part("y", 100)];
    const capped = capParts(parts, 250, 1);
    expect(capped[0]).toEqual(part("fixed", 50));
    expect(total(capped)).toBe(250);
    expect(capped[1].tokens).toBe(150);
    expect(capped[2].tokens).toBe(50);
  });

  test("zeroes variable parts when the fixed prefix already exceeds the target", () => {
    const capped = capParts([part("fixed", 80), part("x", 10)], 50, 1);
    expect(capped).toEqual([part("fixed", 80), part("x", 0)]);
  });

  test("puts rounding error on the last part so the total is exact", () => {
    const parts = [part("a", 1), part("b", 1), part("c", 1)];
    expect(total(capParts(parts, 2))).toBe(2);
  });
});

describe("resolveUsedTokens", () => {
  test("uses the reported count when it agrees with the percentage", () => {
    expect(resolveUsedTokens({ tokens: 10_000, percent: 5 }, 1_000, 200_000)).toBe(10_000);
  });

  test("prefers the percentage when the count disagrees with it", () => {
    expect(resolveUsedTokens({ tokens: 999_999, percent: 5 }, 1_000, 200_000)).toBe(10_000);
  });

  test("falls back to the percentage when the count is unknown", () => {
    expect(resolveUsedTokens({ tokens: null, percent: 10 }, 1_000, 200_000)).toBe(20_000);
  });

  test("falls back to the estimate without usage", () => {
    expect(resolveUsedTokens(undefined, 4_321, 200_000)).toBe(4_321);
    expect(resolveUsedTokens({ tokens: null, percent: null }, 4_321, 0)).toBe(4_321);
  });

  test("uses the estimate when the usage is far below what the content must cost", () => {
    expect(resolveUsedTokens({ tokens: 100, percent: 0.05 }, 8_000, 200_000)).toBe(8_000);
  });
});

describe("normalizePreviewText", () => {
  test("normalizes newlines, expands tabs and strips control characters", () => {
    expect(normalizePreviewText("a\r\nb\rc\td\u0007e\u001b[1mf")).toBe("a\nb\nc  de[1mf");
  });
});

const skill: Skill = {
  name: "demo",
  description: "A demo skill",
  filePath: "/skills/demo/SKILL.md",
  baseDir: "/skills/demo",
  sourceInfo: { path: "/skills/demo/SKILL.md", source: "user", scope: "user", origin: "top-level" },
  disableModelInvocation: false,
};

function entries(): SessionEntry[] {
  const base = { parentId: null, timestamp: "2026-01-01T00:00:00Z" };
  return [
    {
      ...base,
      id: "1",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "hello there" }], timestamp: 1 },
    },
    {
      ...base,
      id: "2",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "sure" },
          { type: "toolCall", id: "c1", name: "read", arguments: { path: "/a" } },
        ],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "m",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: 2,
      },
    },
    {
      ...base,
      id: "3",
      type: "message",
      message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "file body" }], isError: false, timestamp: 3 },
    },
    { ...base, id: "4", type: "compaction", summary: "earlier summary", firstKeptEntryId: "1", tokensBefore: 100 },
    { ...base, id: "5", type: "custom_message", customType: "note", content: "a custom note", display: true },
  ] as SessionEntry[];
}

describe("collectContextBreakdown", () => {
  const memory = "# AGENTS\n\nBe nice.";
  const skillsText = formatSkillsForPrompt([skill], "read").trim();
  const preamble = "You are a helpful agent.\n\n";
  const systemPrompt = `${preamble}<project_instructions path="/p/AGENTS.md">\n${memory}\n</project_instructions>\n\n${skillsText}`;
  const tools = [
    { name: "read", description: "Read a file", parameters: { type: "object" } },
    { name: "bash", description: "Run a command", parameters: { type: "object" } },
    { name: "secret", description: "Hidden", parameters: { type: "object" } },
  ];

  const breakdown = collectContextBreakdown({
    systemPrompt,
    options: { contextFiles: [{ path: "/p/AGENTS.md", content: memory }], skills: [skill], selectedTools: ["read", "bash", "secret"], hiddenTools: ["secret"] },
    tools,
    entries: entries(),
  });
  const byLabel = Object.fromEntries(breakdown.parts.map((p) => [p.label, p.tokens]));

  test("splits the system prompt into prompt, memory and skills without double counting", () => {
    expect(byLabel.Memory).toBe(tokenEstimate(memory));
    expect(byLabel.Skills).toBe(tokenEstimate(skillsText));
    expect(byLabel["System prompt"]).toBe(tokenEstimate(systemPrompt) - byLabel.Memory - byLabel.Skills);
  });

  test("counts only selected, declared tool definitions", () => {
    const expected = tools.slice(0, 2).reduce((sum, t) => sum + tokenEstimate({ name: t.name, description: t.description, parameters: t.parameters }), 0);
    expect(byLabel["Tools definition"]).toBe(expected);
    expect(breakdown.previews.tools).toContain("## Definition: read");
    expect(breakdown.previews.tools).toContain("## Definition: bash");
    expect(breakdown.previews.tools).not.toContain("secret");
  });

  test("attributes tool results and conversation separately", () => {
    expect(byLabel["Tool results"]).toBeGreaterThan(0);
    expect(breakdown.previews.toolResults).toContain("## Result: read");
    const conversation =
      tokenEstimate("hello there") +
      tokenEstimate("let me think") +
      tokenEstimate("sure") +
      tokenEstimate("read") +
      tokenEstimate({ path: "/a" }) +
      tokenEstimate("earlier summary") +
      tokenEstimate("a custom note");
    expect(byLabel.Context).toBe(conversation);
    for (const heading of ["## user", "## Assistant thinking", "## Assistant\n", "## Assistant tool call: read", "## Compaction", "## Custom: note"]) {
      expect(breakdown.previews.contextFiles).toContain(heading);
    }
  });

  test("previews memory files and skills as the model sees them", () => {
    expect(breakdown.previews.memoryFiles).toBe(`## /p/AGENTS.md\n\n${memory}`);
    expect(breakdown.previews.skills).toBe(skillsText);
    expect(breakdown.previews.systemPrompt).toBe(systemPrompt);
  });

  test("recognizes the skills hint whichever reader tool pi named", () => {
    const bashOnly = formatSkillsForPrompt([skill], "bash").trim();
    const result = collectContextBreakdown({ systemPrompt: bashOnly, options: { skills: [skill] }, tools: [], entries: [] });
    expect(result.parts.find((p) => p.label === "Skills")?.tokens).toBe(tokenEstimate(bashOnly));
    expect(result.previews.skills).toBe(bashOnly);
  });

  test("does not count a memory file that is not in the prompt", () => {
    const result = collectContextBreakdown({
      systemPrompt: "plain",
      options: { contextFiles: [{ path: "/x", content: "not embedded" }] },
      tools: [],
      entries: [],
    });
    expect(result.parts.find((p) => p.label === "Memory")?.tokens).toBe(0);
    expect(result.previews.memoryFiles).toContain("not embedded");
  });

  test("uses placeholders for empty parts and the default tool selection", () => {
    const result = collectContextBreakdown({ systemPrompt: "", options: {}, tools: [{ name: "read", description: "r", parameters: {} }, { name: "grep", description: "g", parameters: {} }], entries: [] });
    expect(result.parts.map((p) => p.tokens)).toEqual([0, 0, 0, tokenEstimate({ name: "read", description: "r", parameters: {} }), 0, 0]);
    expect(result.previews.systemPrompt).toBe("No system prompt.");
    expect(result.previews.memoryFiles).toBe("No memory files in context.");
    expect(result.previews.skills).toBe("No skills in context.");
    expect(result.previews.toolResults).toBe("No tool results in the current context.");
    expect(result.previews.contextFiles).toBe("No conversation context.");
  });
});

describe("assembleReport", () => {
  const breakdown = {
    parts: [part("System prompt", 1_000), part("Memory", 500), part("Skills", 200), part("Tools definition", 300), part("Tool results", 4_000), part("Context", 2_000)],
    previews: { systemPrompt: "", memoryFiles: "", skills: "", tools: "", toolResults: "", contextFiles: "" },
  };

  test("adds Other and Free space so the rows sum to the window", () => {
    const report = assembleReport(breakdown, { tokens: 10_000, percent: 5 }, 200_000);
    expect(report.used).toBe(10_000);
    expect(report.parts.map((p) => p.label)).toEqual(["System prompt", "Memory", "Skills", "Tools definition", "Tool results", "Context", "Other", "Free space"]);
    expect(report.parts.at(-2)?.tokens).toBe(2_000);
    expect(report.parts.at(-1)?.tokens).toBe(190_000);
    expect(total(report.parts)).toBe(200_000);
  });

  test("caps the variable parts when usage is below the estimate, never the fixed ones", () => {
    const report = assembleReport(breakdown, { tokens: 5_000, percent: 2.5 }, 200_000);
    expect(report.parts.slice(0, 4).map((p) => p.tokens)).toEqual([1_000, 500, 200, 300]);
    expect(report.parts[4].tokens + report.parts[5].tokens).toBe(3_000);
    expect(report.parts[6].tokens).toBe(0);
  });

  test("never reports less than the fixed parts", () => {
    const report = assembleReport(breakdown, { tokens: 10, percent: 0.005 }, 200_000);
    expect(report.used).toBeGreaterThanOrEqual(2_000);
  });

  test("formats a plain-text report", () => {
    const text = formatReport(assembleReport(breakdown, { tokens: 10_000, percent: 5 }, 200_000));
    expect(text.split("\n")[0]).toBe("Context: 10.0k / 200k tokens (5.0%)");
    expect(text).toContain("Free space: 190k tokens");
  });
});
