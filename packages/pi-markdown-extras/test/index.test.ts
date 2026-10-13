import type { ExtensionAPI, MarkdownTransformer } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, test } from "vitest";
import extension, {
  deCircled,
  loadMermaid,
  normalizeMultilineLinks,
  renderAdmonitions,
  renderDiagrams,
  setMermaid,
  transform,
} from "../src/index.ts";

const ctx = (over: Partial<{ messageType: "user" | "assistant" | "assistant-thinking"; isStreaming: boolean; availableWidth: number }> = {}) => ({
  messageType: "assistant" as const,
  isStreaming: false,
  availableWidth: 80,
  ...over,
});

beforeAll(async () => {
  expect(await loadMermaid()).not.toBeNull();
});

describe("registration", () => {
  test("registers exactly one markdown transformer", () => {
    const transformers: MarkdownTransformer[] = [];
    const pi = { registerMarkdownTransformer: (t: MarkdownTransformer) => transformers.push(t) } as unknown as ExtensionAPI;
    extension(pi);
    expect(transformers).toHaveLength(1);
    expect(transformers[0]("> [!NOTE] hi", ctx())).toBe("> **Note:** hi\n");
  });
});

describe("bare URLs are not linkified (regression)", () => {
  test("bold bare URL passes through unchanged", () => {
    const md = "**https://example.com/a**";
    expect(transform(md, ctx())).toBe(md);
  });

  test("plain and trailing-punctuation URLs pass through unchanged", () => {
    const md = "See https://example.com/path, then (https://example.com/x) and <https://example.com/y>.";
    expect(transform(md, ctx())).toBe(md);
  });
});

describe("admonitions", () => {
  test("single line", () => {
    expect(renderAdmonitions("> [!WARNING] Careful")).toBe("> **Warning:** Careful\n");
  });

  test("multi-line body is joined, trailing blank quote lines dropped, label is plain text", () => {
    const md = ["> [!TIP]", "> first", "> second", ">", "after"].join("\n");
    expect(renderAdmonitions(md)).toBe("> **Tip:** first second\n\nafter");
  });

  test("each type gets its label and is case-insensitive", () => {
    expect(renderAdmonitions("> [!note] a")).toBe("> **Note:** a\n");
    expect(renderAdmonitions("> [!IMPORTANT] a")).toBe("> **Important:** a\n");
    expect(renderAdmonitions("> [!CAUTION] a")).toBe("> **Caution:** a\n");
  });

  test("consecutive admonitions stay separate", () => {
    const md = "> [!NOTE] a\n> [!TIP] b";
    expect(renderAdmonitions(md)).toBe("> **Note:** a\n\n> **Tip:** b\n");
  });

  test("unknown types and fenced code are untouched", () => {
    expect(renderAdmonitions("> [!FOO] a")).toBe("> [!FOO] a");
    const md = "```\n> [!NOTE] a\n```";
    expect(renderAdmonitions(md)).toBe(md);
  });

  test("output has no emoji", () => {
    for (const t of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
      expect(renderAdmonitions(`> [!${t}] x`)).toMatch(/^[\x20-\x7e\n]+$/);
    }
  });
});

describe("circled numbers", () => {
  test("rewrites U+2460..U+2473 to (n)", () => {
    expect(deCircled("\u2460 one \u2473 twenty")).toBe("(1) one (20) twenty");
  });

  test("leaves other text alone", () => {
    expect(deCircled("plain (1) text")).toBe("plain (1) text");
  });
});

describe("multi-line link labels", () => {
  test("joins label lines and trims padding", () => {
    expect(normalizeMultilineLinks("[a  \n   b](https://x)")).toBe("[a b](https://x)");
  });

  test("single-line links and fenced code are untouched", () => {
    expect(normalizeMultilineLinks("[a](https://x)")).toBe("[a](https://x)");
    const md = "```\n[a\nb](https://x)\n```";
    expect(normalizeMultilineLinks(md)).toBe(md);
  });

  test("brackets without a following paren are untouched", () => {
    expect(normalizeMultilineLinks("[a\nb] c")).toBe("[a\nb] c");
  });
});

describe("mermaid dialects", () => {
  const fence = (lang: string, body: string) => `\`\`\`${lang}\n${body}\n\`\`\``;

  test("statediagram fence renders to inline-code rows with hard breaks", () => {
    const out = renderDiagrams(fence("statediagram", "[*] --> A\nA --> [*]"), 80);
    expect(out).not.toContain("```");
    expect(out).toContain("  \n");
    expect(out.split("\n").every((l) => l.startsWith("`"))).toBe(true);
  });

  test("mermaid fence renders too", () => {
    const out = renderDiagrams(fence("mermaid", "flowchart LR\nA --> B"), 80);
    expect(out).not.toContain("```");
    expect(out).toContain("A");
  });

  test("too narrow a width shows the framed source", () => {
    const out = renderDiagrams(fence("mermaid", "flowchart LR\nA --> B --> C --> D --> E"), 10);
    expect(out.startsWith("```\n")).toBe(true);
    expect(out).toContain("A --> B");
  });

  test("unclosed fences, other languages and inline code are untouched", () => {
    const open = "```mermaid\nflowchart LR\nA --> B";
    expect(renderDiagrams(open, 80)).toBe(open);
    const other = fence("ts", "const a = 1;");
    expect(renderDiagrams(other, 80)).toBe(other);
    const inline = "use `mermaid` here";
    expect(renderDiagrams(inline, 80)).toBe(inline);
  });

  test("passes through when grok-mermaid is unavailable", async () => {
    const md = fence("mermaid", "flowchart LR\nA --> B");
    setMermaid(null);
    try {
      expect(renderDiagrams(md, 80)).toBe(md);
    } finally {
      await loadMermaid();
    }
  });
});

describe("context handling", () => {
  const md = "\u2460 [a\nb](https://x)\n> [!NOTE] n";

  test("thinking is returned verbatim", () => {
    expect(transform(md, ctx({ messageType: "assistant-thinking" }))).toBe(md);
  });

  test("streaming only normalizes multi-line links", () => {
    expect(transform(md, ctx({ isStreaming: true }))).toBe("\u2460 [a b](https://x)\n> [!NOTE] n");
  });

  test("final render applies every transform", () => {
    expect(transform(md, ctx())).toBe("(1) [a b](https://x)\n> **Note:** n\n");
  });

  test("missing context is treated as a final assistant render", () => {
    expect(transform("\u2461")).toBe("(2)");
  });
});
