import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// The config module reads its file at import time; isolate it from the real home directory.
let agentDir: string;
beforeAll(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-cc-render-render-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});
afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
});

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

describe("rich diffs", () => {
  test("parseDiff counts added and removed lines", async () => {
    const { parseDiff } = await import("../src/renderer/tool/diff/diff-parse.ts");
    const parsed = parseDiff(["  1 const a = 1;", "- 2 const b = 2;", "+ 2 const b = 3;", "+ 3 const c = 4;"].join("\n"));
    expect(parsed.stats).toMatchObject({ added: 2, removed: 1 });
  });

  test("edit results render a diff with old and new lines", async () => {
    const { renderEditDiffResult, countEditDiffStats } = await import("../src/renderer/tool/diff/diff-edit-render.ts");
    const { DEFAULT_TOOL_DISPLAY_CONFIG } = await import("../src/config/config.ts");
    const details = { diff: ["  1 const a = 1;", "- 2 const b = 2;", "+ 2 const b = 3;"].join("\n") };
    expect(countEditDiffStats(details)).toEqual({ added: 1, removed: 1 });
    const component = renderEditDiffResult(
      details,
      { expanded: true, filePath: "src/a.ts" },
      { ...DEFAULT_TOOL_DISPLAY_CONFIG, diffViewMode: "unified" },
      theme,
      "edited",
    );
    const lines = plain(component.render(80));
    expect(lines.some((line) => line.includes("const b = 2;"))).toBe(true);
    expect(lines.some((line) => line.includes("const b = 3;"))).toBe(true);
    expect(lines.every((line) => line.length <= 80)).toBe(true);
  });

  test("an edit without a diff payload falls back to the result text", async () => {
    const { renderEditDiffResult } = await import("../src/renderer/tool/diff/diff-edit-render.ts");
    const { DEFAULT_TOOL_DISPLAY_CONFIG } = await import("../src/config/config.ts");
    const component = renderEditDiffResult({}, { expanded: false }, DEFAULT_TOOL_DISPLAY_CONFIG, theme, "Edited file.");
    expect(plain(component.render(60)).join("\n")).toContain("Edited file.");
  });

  test("write results show the created file's lines", async () => {
    const { renderWriteDiffResult, countWriteDiffStats } = await import("../src/renderer/tool/diff/diff-write-render.ts");
    const { DEFAULT_TOOL_DISPLAY_CONFIG } = await import("../src/config/config.ts");
    const content = "alpha\nbeta\n";
    expect(countWriteDiffStats(content, undefined, false)).toEqual({ added: 2, removed: 0 });
    expect(countWriteDiffStats("a\nb\nc\n", "a\n", true)).toEqual({ added: 2, removed: 0 });
    const component = renderWriteDiffResult(
      content,
      { expanded: true, filePath: "notes.txt", previousContent: undefined, fileExistedBeforeWrite: false },
      { ...DEFAULT_TOOL_DISPLAY_CONFIG, writeDiffCollapsedLines: 12 },
      theme,
      "Wrote 2 lines",
    );
    const text = plain(component.render(60)).join("\n");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });
});

describe("tool summaries", () => {
  test("humanizeToolLabel and toolCallSummary describe common tools", async () => {
    const { humanizeToolLabel, toolCallSummary, fitToolCallSummary } = await import("../src/renderer/tool/names.ts");
    expect(humanizeToolLabel("bash")).toBe("Bash");
    expect(humanizeToolLabel("ask_user_question")).toMatch(/Ask/);
    const bash = toolCallSummary("bash", { command: "ls -la" });
    expect(`${bash.main} ${bash.detail}`).toContain("Bash");
    expect(`${bash.main} ${bash.detail}`).toContain("ls -la");
    const read = toolCallSummary("read", { path: "/tmp/project/src/index.ts" }, { cwd: "/tmp/project" });
    expect(`${read.main} ${read.detail} ${read.path ?? ""}`).toContain("src/index.ts");
    expect(stripTerminalSequences(fitToolCallSummary(bash, 12)).length).toBeLessThanOrEqual(12);
  });
});

describe("renderer gates", () => {
  test("shouldRenderRichDiff only applies to successful edit/write in mode on", async () => {
    const { shouldRenderRichDiff } = await import("../src/renderer/default-mode.ts");
    expect(shouldRenderRichDiff("on", "edit", false)).toBe(true);
    expect(shouldRenderRichDiff("on", "write", false)).toBe(true);
    expect(shouldRenderRichDiff("on", "write", true)).toBe(false);
    expect(shouldRenderRichDiff("compact", "edit", false)).toBe(false);
    expect(shouldRenderRichDiff("on", "bash", false)).toBe(false);
  });

  test("excludeRenderers keeps a tool's own renderer (how sibling plugins opt out)", async () => {
    const { preservesOriginalRenderer } = await import("../src/renderer/default-mode.ts");
    const custom = { renderResult: () => undefined };
    expect(preservesOriginalRenderer(custom, "bg_run", undefined, ["bg_run"])).toBe(true);
    expect(preservesOriginalRenderer(custom, "bg_run", undefined, [])).toBe(false);
    expect(preservesOriginalRenderer({}, "bash", undefined, ["bash"])).toBe(false);
    expect(preservesOriginalRenderer({}, "bash", { renderShell: "self" }, ["bash"])).toBe(true);
  });
});

describe("agent summary", () => {
  test("summaryMarkdown formats a round's tool statistics", async () => {
    const { AgentRunSummary, summaryMarkdown, classifyTool } = await import("../src/feature/agent-summary/core.ts");
    expect(classifyTool("mcp.read")).toBe("read");
    expect(classifyTool("powershell")).toBe("bash");
    const run = new AgentRunSummary();
    run.recordToolStart("read", { path: "a.ts" });
    run.recordToolResult(false);
    run.recordToolStart("edit", { path: "a.ts" });
    run.recordToolResult(false);
    run.recordToolStart("bash", { command: "ls" });
    run.recordToolResult(true);
    const markdown = summaryMarkdown(run.snapshot());
    expect(markdown.startsWith("> *")).toBe(true);
    expect(markdown).toMatch(/1 file read|Read 1 file/i);
    expect(markdown).toMatch(/failed/);
  });

  test("bindAgentSummary reports after agent_end when at least two tools ran", async () => {
    const { bindAgentSummary } = await import("../src/feature/agent-summary/core.ts");
    const handlers = new Map<string, Array<(event: any) => unknown>>();
    const pi = { on: (name: string, handler: (event: any) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
    const reports: unknown[] = [];
    bindAgentSummary(pi as any, (data) => reports.push(data));
    const emit = async (name: string, event: any) => {
      for (const handler of handlers.get(name) ?? []) await handler(event);
    };
    await emit("agent_start", {});
    await emit("tool_execution_start", { toolName: "read", args: { path: "x" } });
    await emit("tool_execution_end", { isError: false });
    await emit("agent_end", {});
    expect(reports).toHaveLength(0);
    await emit("agent_start", {});
    await emit("tool_execution_start", { toolName: "read", args: { path: "a.ts" } });
    await emit("tool_execution_end", { isError: false });
    await emit("tool_execution_start", { toolName: "bash", args: { command: "ls" } });
    await emit("tool_execution_end", { isError: true });
    await emit("agent_end", {});
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reads: 1, commands: 1, failed: 1 });
  });
});

describe("startup header", () => {
  test("renders a two-column header that fits the width and a stacked one when narrow", async () => {
    const { renderHeaderLines } = await import("../src/feature/shell/startup-header.ts");
    const headerTheme = { ...theme, getFgAnsi: () => "\x1b[38;2;80;160;255m" };
    const wide = renderHeaderLines(100, headerTheme);
    expect(wide).toHaveLength(5);
    expect(plain(wide).every((line) => line.length <= 100)).toBe(true);
    expect(plain(wide).join("\n")).toContain("yours");
    const narrow = renderHeaderLines(30, headerTheme);
    expect(narrow.length).toBeGreaterThan(5);
    expect(plain(narrow).every((line) => line.length <= 30)).toBe(true);
  });
});
