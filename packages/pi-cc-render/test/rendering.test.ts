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

  test("pi-bg's tools read as command rows on their task", async () => {
    const { toolCallSummary, backgroundTaskTitle } = await import("../src/renderer/tool/names.ts");
    const row = (name: string, args: any) => { const s = toolCallSummary(name, args); return `${s.main}${s.detail}`; };
    expect(row("bg_run", { command: "npm test", kind: "job", name: "tests" })).toBe("Bash npm test · background job");
    expect(row("bg_run", { command: "vite", kind: "service" })).toBe("Bash vite · background service");
    expect(row("bg_wait", {})).toBe("Wait next job");
    expect(row("bg_wait", { id: "tests" })).toBe("Wait tests");
    expect(row("bg_logs", { id: "tests" })).toBe("Task log tests");
    expect(row("bg_logs", {})).toBe("Tasks");
    expect(row("bg_kill", { id: "tests" })).toBe("Stop tests");
    expect(backgroundTaskTitle("bg_run")).toBe("Bash");
    expect(toolCallSummary("bg_run", { command: "ls" }, { variant: "grouping" }).main).toBe("Bash ls");
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

describe("own result rows", () => {
  test("a tool with ccstyleOwnResult keeps its result row under the styled call row", async () => {
    const { createCcstyleTool } = await import("../src/renderer/default-mode.ts");
    const own = { name: "bg_run", label: "Background", ccstyleOwnResult: true, renderResult: () => ({ render: () => ["↳ fit running · 45%"], invalidate() {} }) };
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };
    const wrapped = createCcstyleTool(own, new Map() as any);
    const lines = wrapped.renderResult({ content: [{ type: "text", text: "Started" }] }, { expanded: false, isPartial: false }, theme, { state: {} }).render(80);
    expect(lines[0]).toBe("   ↳ fit running · 45%");
    const plain = createCcstyleTool({ ...own, ccstyleOwnResult: undefined }, new Map() as any);
    const generic = plain.renderResult({ content: [{ type: "text", text: "Started" }] }, { expanded: false, isPartial: false }, theme, { state: {} }).render(80);
    expect(stripTerminalSequences(generic[0])).toMatch(/1 line returned/);
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

describe("tool groups", () => {
  const IMAGE_ROW = "\x1b_Ga=T,f=100,q=2,C=1;AAAA\x1b\\";

  async function groupedTools() {
    const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
    const { Container } = await import("@earendil-works/pi-tui");
    const { installToolGrouping } = await import("../src/renderer/tool/grouping.ts");
    const hooks = installToolGrouping(() => true);
    hooks.setTheme(theme);
    const tool = (toolName: string, body: string[], images: string[][] = []) => {
      const value = Object.create(ToolExecutionComponent.prototype);
      Object.assign(value, {
        toolName,
        toolCallId: `${toolName}-1`,
        args: { path: "a.png", command: "echo" },
        result: { content: [{ type: "text", text: "ok" }], isError: false },
        isPartial: false,
        executionStarted: true,
        expanded: false,
        imageComponents: images.map((rows) => ({ render: () => rows })),
        // A native paint: the card, then each image after a blank row.
        render: () => [...body, ...images.flatMap((rows) => ["", ...rows])],
        invalidate: () => {},
        setExpanded: () => {},
      });
      return value;
    };
    const root = new Container();
    root.addChild(tool("bash", ["✓ Bash echo"]));
    root.addChild(tool("read", ["✓ Read a.png", "Read image file [image/png]"], [[IMAGE_ROW, "", ""]]));
    const group = root.children[0] as any;
    return { hooks, group };
  }

  test("a group draws its children's images, collapsed and expanded, once each", async () => {
    const { hooks, group } = await groupedTools();
    try {
      expect(group.constructor.name).toBe("ToolGroupComponent");
      for (const expanded of [false, true, false]) {
        group.setExpanded(expanded);
        const lines: string[] = group.render(80);
        const imageRows = lines.filter((line) => line.includes("\x1b_G"));
        expect(imageRows).toEqual([`   ${IMAGE_ROW}`]);
        const at = lines.indexOf(imageRows[0]);
        // A blank row before the image and its reserved rows after it, all at the end of the card.
        expect(lines[at - 1]).toBe("");
        expect(lines.slice(at + 1)).toEqual(["   ", "   "]);
      }
    } finally {
      hooks.shutdown();
    }
  });
});

describe("compact thinking and Ctrl+O", () => {
  test("app.tools.expand opens collapsed thinking, per component or from main's state", async () => {
    const { AssistantMessageComponent } = await import("@earendil-works/pi-coding-agent");
    const { installCompactThinking } = await import("../src/feature/compact-thinking.ts");
    const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
    const pi = {
      on: (name: string, handler: (event: any, ctx: any) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
      appendEntry: () => {},
    };
    installCompactThinking(pi as any, { useSummaryTitlesAsThinkingTitle: true, previewLines: 2, animationIntervalMs: 90 });
    let mainExpanded = false;
    const ctx = {
      mode: "tui",
      sessionManager: { getBranch: () => [], getEntries: () => [] },
      ui: { theme, setWidget: () => {}, getToolsExpanded: () => mainExpanded },
    };
    for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
    try {
      const thinking = Array.from({ length: 8 }, (_, i) => `step ${i + 1}`).join("\n");
      const message = {
        role: "assistant",
        timestamp: 1234,
        api: "anthropic-messages",
        content: [{ type: "thinking", thinking }, { type: "text", text: "done" }],
      };
      const text = (component: any) => plain(component.render(60)).join("\n");

      const own = new AssistantMessageComponent(message as never, true) as any;
      expect(typeof own.setExpanded).toBe("function");
      expect(text(own)).toContain("more lines");
      expect(text(own)).not.toContain("step 1\n");
      own.setExpanded(true);
      expect(text(own)).toContain("step 1");
      expect(text(own)).not.toContain("more lines");
      own.setExpanded(false);
      expect(text(own)).toContain("more lines");

      // A component Pi has not called setExpanded on follows main's Ctrl+O state.
      mainExpanded = true;
      const fresh = new AssistantMessageComponent(message as never, true) as any;
      expect(text(fresh)).toContain("step 1");
      // Its own state wins once set (a Sidebar keeps its own toggle).
      fresh.setExpanded(false);
      expect(text(fresh)).toContain("more lines");
    } finally {
      for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
    }
    expect(Object.hasOwn(AssistantMessageComponent.prototype, "setExpanded")).toBe(false);
  });

  test("thinking wraps at pi-prose-width's measure when it is loaded", async () => {
    const { ThinkingPreviewBlock } = await import("../src/feature/compact-thinking.ts");
    const { Markdown } = await import("@earendil-works/pi-tui");
    // pi-prose-width's shared state on the host's Markdown prototype (a separate pi-tui copy here).
    const key = Symbol.for("pi-prose-width");
    const proto = Markdown.prototype as any;
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    // Body lines only: the heading carries the expand hint.
    const longest = (lines: string[]) =>
      Math.max(...plain(lines).filter((line) => line.includes("word")).map((line) => line.trimEnd().length));
    const collapsed = new ThinkingPreviewBlock("Thinking", words, 1, 9001, (s) => s, undefined);
    const expanded = new ThinkingPreviewBlock("Thinking", words, 1, 9002, (s) => s, undefined);
    expanded.setExpanded(true);
    expect(longest(collapsed.render(120))).toBeGreaterThan(60);
    proto[key] = { active: true, measure: 40 };
    try {
      expect(longest(collapsed.render(120))).toBeLessThanOrEqual(41);
      expect(longest(expanded.render(120))).toBeLessThanOrEqual(42);
      proto[key].measure = 0;
      expect(longest(collapsed.render(120))).toBeGreaterThan(60);
    } finally {
      delete proto[key];
      expanded.setExpanded(false);
    }
  });
});
