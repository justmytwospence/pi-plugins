import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
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
    const long = toolCallSummary("bash", { command: "cd ~/Projects/app && npm run check 2>&1 | tail -20 && git status" });
    expect(long.main).toBe("Bash Run check (npm), then git status in app");
    expect(toolCallSummary("bash", { command: "# Run the tests\nnpm test" }).main).toBe("Bash Run the tests");
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
  test.each(["bg_run", "ask_planner", "finish_plan"])("%s with ccstyleOwnResult keeps its result row under the styled call row", async (name) => {
    const { createCcstyleTool } = await import("../src/renderer/default-mode.ts");
    const own = { name, label: "Background", ccstyleOwnResult: true, renderResult: () => ({ render: () => ["↳ fit running · 45%"], invalidate() {} }) };
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t };
    const wrapped = createCcstyleTool(own, new Map() as any);
    for (const isPartial of [true, false]) {
      const lines = wrapped.renderResult({ content: [{ type: "text", text: "Started" }] }, { expanded: false, isPartial }, theme, { state: {} }).render(80);
      expect(lines[0]).toBe("   ↳ fit running · 45%");
    }
    const plain = createCcstyleTool({ ...own, ccstyleOwnResult: undefined }, new Map() as any);
    const generic = plain.renderResult({ content: [{ type: "text", text: "Started" }] }, { expanded: false, isPartial: false }, theme, { state: {} }).render(80);
    expect(stripTerminalSequences(generic[0])).toMatch(/1 line returned/);
  });
});

describe("real Pi execution cards with cc-render", () => {
  // Public contract with managed excludeRenderers; never read the private dotfiles checkout.
  const exclusions = ["ask_planner", "finish_plan"];
  const question = "Keep the approved scope?";
  const args = {
    ask_planner: { message: question },
    finish_plan: { report: "Implemented approved scope.", verification: "Unit tests passed.", concerns: "Manual check not run." },
  };

  async function fixture() {
    const { ToolExecutionComponent, initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme("dark", false);
    const base = import.meta.resolve("@earendil-works/pi-coding-agent");
    const { theme: nativeTheme } = await import(new URL("./modes/interactive/theme/theme.js", base).href);
    const { CustomMessageComponent } = await import(new URL("./modes/interactive/components/custom-message.js", base).href);
    // Dynamic sibling import keeps its implementation out of this package's rootDir.
    const { registerExec } = await import(new URL("../../pi-plan-mode/src/exec.ts", import.meta.url).href);
    const tools = new Map<string, any>();
    const messages = new Map<string, any>();
    registerExec({
      on() {},
      registerCommand() {},
      registerTool: (definition: any) => tools.set(definition.name, definition),
      registerMessageRenderer: (name: string, renderer: any) => messages.set(name, renderer),
      events: { on() {}, emit() {} },
    } as any, {} as any);
    const { config } = await import("../src/config/config.ts");
    const { installDefaultMode } = await import("../src/renderer/default-mode.ts");
    const saved = { mode: config.mode, excludeRenderers: config.excludeRenderers };
    const ui = { requestRender() {} };
    const make = (name: keyof typeof args) => new ToolExecutionComponent(name, `${name}-composed`, args[name], {}, tools.get(name), ui as any, "/tmp");
    return { tools, messages, nativeTheme, CustomMessageComponent, config, installDefaultMode, saved, make };
  }

  function details(name: keyof typeof args, state: "pending" | "success" | "error") {
    return name === "ask_planner"
      ? { question, planner: "Planner", number: 1, pending: state === "pending", reply: "Preserve the approved scope.", ...(state === "error" ? { error: "Consultation failed." } : {}) }
      : {
        ...args.finish_plan, planFile: "/tmp/plan.md", round: 1, pending: state === "pending",
        changes: { edited: ["composed-detail.ts"], outside: [] },
        ...(state === "error" ? {
          error: "Review failed.",
          action: "Ask to retry the review.",
          negotiation: { phase: "paused", attempts: 1, pause: { reason: "failure", action: "Ask to retry the review." } },
        } : {}),
        ...(state === "success" ? { completion: "accepted" } : {}),
        decision: { outcome: "accepted", summary: "Preserve the approved scope.", evidence: ["Reviewed composed evidence."], limitations: ["Planner did not rerun checks."], findings: [] },
      };
  }

  // Count only the rendered tree, not unused shell variants allocated by native Pi.
  // Sibling lockfiles may load distinct Box constructors, so instanceof is insufficient.
  function shells(component: any): number {
    return Number(component.constructor.name === "Box") + (component.children ?? []).reduce((n: number, child: any) => n + shells(child), 0)
      + (component.child ? shells(component.child) : 0);
  }

  function expectNativeShell(component: any, width: number, nativeTheme: any, color: string) {
    const lines: string[] = component.render(width);
    expect(shells(component)).toBe(1);
    expect(lines[0]).toBe(""); // Pi's sole inter-message spacer is outside the shell.
    const background = nativeTheme.getBgAnsi(color);
    expect(background).toMatch(/\x1b\[/);
    const painted = lines.slice(1);
    expect(painted.length).toBeGreaterThan(2);
    expect(painted[0]).toBe(nativeTheme.bg(color, " ".repeat(width)));
    expect(painted.at(-1)).toBe(nativeTheme.bg(color, " ".repeat(width)));
    for (const line of painted) {
      expect(visibleWidth(line)).toBe(width);
      // Inspect the emitted SGR stream, including text and right padding: an arbitrary
      // foreground escape is not evidence that the native background was painted.
      let active = "";
      for (const part of line.split(/(\x1b\[[\d;]*m)/)) {
        if (part.startsWith("\x1b[")) {
          const codes = part.slice(2, -1).split(";").map(Number);
          for (let i = 0; i < codes.length; i++) {
            const code = codes[i];
            if (code === 0 || code === 49) active = "";
            else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) active = `\x1b[${code}m`;
            else if (code === 38 || code === 48 || code === 58) {
              const length = codes[i + 1] === 2 ? 5 : 3;
              if (code === 48) active = `\x1b[${codes.slice(i, i + length).join(";")}m`;
              i += length - 1; // RGB/index values are not independent SGR commands.
            }
          }
        } else if (visibleWidth(stripTerminalSequences(part)) > 0) expect(active).toBe(background);
      }
    }
    return plain(lines).join("\n");
  }

  test.each(["ask_planner", "finish_plan"] as const)("%s retains original call/result and one native semantic shell", async (name) => {
    const f = await fixture();
    f.config.mode = "on";
    f.config.excludeRenderers = exclusions;
    const patch = f.installDefaultMode(new Map() as any);
    try {
      for (const state of ["pending", "success", "error"] as const) {
        const component = f.make(name);
        component.markExecutionStarted();
        component.updateResult({ content: [{ type: "text", text: "MODEL_ONLY_RESULT" }], details: details(name, state), isError: state === "error" }, state === "pending");
        for (const expanded of [false, true, false]) {
          component.setExpanded(expanded);
          expect((component as any).getCallRenderer()).toBe(f.tools.get(name).renderCall);
          expect((component as any).getResultRenderer()).toBe(f.tools.get(name).renderResult);
          expect((component as any).getRenderShell()).toBe("default");
          for (const width of [46, 120]) {
            const text = expectNativeShell(component, width, f.nativeTheme, { pending: "toolPendingBg", success: "toolSuccessBg", error: "toolErrorBg" }[state]);
            const call = plain((component as any).callRendererComponent.render(width - 2)).join("\n");
            expect(call).toContain(name === "ask_planner" ? question : "Implementation review");
            expect(call).not.toMatch(/"(?:message|report|verification|concerns)"\s*:/);
            expect(text).not.toContain(JSON.stringify(args[name]));
            expect(text).not.toMatch(/"(?:message|report|verification|concerns)"\s*:/);
            expect(text).not.toContain("MODEL_ONLY_RESULT");
            expect(text).not.toContain("lines returned");
            expect(text).toContain(name === "ask_planner"
              ? { pending: "Planner thinking…", success: "Planner answered", error: "Consultation unavailable" }[state]
              : { pending: "Reviewing", success: expanded ? "Accepted" : "Reviewed", error: "Review did not finish" }[state]);
            if (name === "finish_plan") {
              for (const value of Object.values(args.finish_plan)) expect(text).toContain(value);
              if (state === "error") expect(text).toContain("Ask to retry the review.");
              if (expanded && state !== "pending") {
                expect(text).toContain("Reviewed composed evidence.");
                expect(text).toContain("Planner did not rerun checks.");
                expect(text).toContain("composed-detail.ts");
              }
              if (state === "success") {
                for (const detail of ["Reviewed composed evidence.", "Planner did not rerun checks.", "composed-detail.ts"])
                  if (expanded) expect(text).toContain(detail);
                  else expect(text).not.toContain(detail);
                if (!expanded) expect(text.toLowerCase()).toContain("ctrl+o");
              }
            } else {
              if (expanded || state === "pending") expect(text).toContain("Question");
              if (state === "error") expect(text).toContain("Consultation failed.");
              if (state === "success") expect(text).toContain("Preserve the approved scope.");
            }
          }
        }
      }
    } finally {
      patch.shutdown();
      Object.assign(f.config, f.saved);
    }
  });

  test("negative controls: missing or alias-only exclusions reproduce cc-render takeover and raw completion args", async () => {
    const f = await fixture();
    f.config.mode = "on";
    const patch = f.installDefaultMode(new Map() as any);
    try {
      for (const excluded of [[], ["plan_ask_planner"]]) {
        f.config.excludeRenderers = excluded;
        for (const name of exclusions as Array<keyof typeof args>) {
          const component = f.make(name);
          component.markExecutionStarted();
          component.updateResult({ content: [], details: details(name, "success"), isError: false });
          expect((component as any).getCallRenderer()).not.toBe(f.tools.get(name).renderCall);
          expect((component as any).getResultRenderer()).not.toBe(f.tools.get(name).renderResult);
          expect((component as any).getRenderShell()).toBe("self");
          for (const width of [46, 120]) {
            const lines = component.render(width);
            expect(shells(component)).toBe(0);
            expect(lines.join("\n")).not.toContain(f.nativeTheme.getBgAnsi("toolSuccessBg"));
            const text = plain(lines).join("\n");
            expect(text).toContain(name === "ask_planner" ? "Ask planner" : "Finish plan");
            const call = plain((component as any).callRendererComponent.render(width)).join("\n");
            expect(call).not.toContain(name === "ask_planner" ? "Consultation ·" : "Implementation review");
            if (name === "finish_plan" && width === 120) expect(text).toContain('"report":');
          }
        }
      }
    } finally {
      patch.shutdown();
      Object.assign(f.config, f.saved);
    }
  });

  test("cc-render off and standalone custom completion each retain exactly one native-colored shell", async () => {
    const f = await fixture();
    f.config.mode = "off";
    f.config.excludeRenderers = [];
    const patch = f.installDefaultMode(new Map() as any);
    try {
      for (const state of ["pending", "success", "error"] as const) {
        const color = { pending: "toolPendingBg", success: "toolSuccessBg", error: "toolErrorBg" }[state];
        const completion = new f.CustomMessageComponent({ customType: "plan-mode-finish", content: "", details: details("finish_plan", state) }, f.messages.get("plan-mode-finish"));
        const tools = (["ask_planner", "finish_plan"] as const).map((name) => {
          const component = f.make(name);
          component.updateResult({ content: [], details: details(name, state), isError: state === "error" }, state === "pending");
          return component;
        });
        for (const expanded of [false, true]) {
          for (const component of [...tools, completion]) {
            component.setExpanded(expanded);
            for (const width of [46, 120]) {
              const text = expectNativeShell(component, width, f.nativeTheme, color);
              expect(text).not.toMatch(/"(?:message|report|verification|concerns)"\s*:/);
            }
          }
        }
      }
    } finally {
      patch.shutdown();
      Object.assign(f.config, f.saved);
    }
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
  test("renders estimated occupied sources, category legend and a full-window strip at client widths", async () => {
    const { renderHeaderLines } = await import("../src/feature/shell/startup-header.ts");
    const snapshot = {
      stage: "starting" as const, modelLabel: "provider/model", contextWindow: 200_000,
      usedEstimate: 5_000,
      attribution: { files: true, skills: true },
      sources: [
        { id: "system", category: "system" as const, label: "System", tokens: 3_000 },
        { id: "files", category: "files" as const, label: "Files", tokens: 2_000 },
      ],
      caveats: ["Estimated from loaded content; request hooks and provider framing may add tokens."],
    };
    for (const width of [46, 120, 180]) {
      const lines = renderHeaderLines(width, theme, snapshot);
      const output = plain(lines).join("\n");
      expect(output).toContain("Starting context");
      expect(output).toContain("Sources · occupied context");
      expect(output).toContain("System ~3k");
      expect(output).toContain("Files ~2k");
      expect(output).toContain("Available");
      expect(output).not.toContain("There are many agent harnesses");
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    const retained = renderHeaderLines(120, theme, { ...snapshot, stage: "context" });
    expect(plain(retained)[0]).toMatch(/^Context ·/);
    const loading = renderHeaderLines(46, theme, { ...snapshot, stage: "initializing" });
    expect(plain(loading)).toEqual(["Starting context · loading…"]);
  });
});

describe("tool groups", () => {
  const IMAGE_ROW = "\x1b_Ga=T,f=100,q=2,C=1;AAAA\x1b\\";

  async function groupedTools(populate = true) {
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
    if (populate) {
      root.addChild(tool("bash", ["✓ Bash echo"]));
      root.addChild(tool("read", ["✓ Read a.png", "Read image file [image/png]"], [[IMAGE_ROW, "", ""]]));
    }
    const group = root.children[0] as any;
    return { hooks, group, root, tool };
  }

  test.each([
    { name: "exit_plan_mode", before: ["todo"], after: ["bash"] },
    { name: "exit_plan_mode", before: ["read", "todo"], after: ["bash", "read"] },
    { name: "ask_planner", before: ["todo"], after: ["bash"] },
    { name: "ask_planner", before: ["read", "todo"], after: ["bash", "read"] },
    { name: "finish_plan", before: ["todo"], after: ["bash"] },
    { name: "finish_plan", before: ["read", "todo"], after: ["bash", "read"] },
  ])("$name stays standalone between $before and $after", async ({ name, before, after }) => {
    const { hooks, root, tool } = await groupedTools(false);
    try {
      const preceding = before.map((name) => tool(name, [`✓ ${name}`]));
      const exit = tool(name, ["Plan", "Do it", "Waiting for approval"]);
      exit.isPartial = true;
      const following = after.map((name) => tool(name, [`✓ ${name}`]));
      for (const component of [...preceding, exit, ...following]) root.addChild(component);

      expect(root.children).toHaveLength(3);
      expect(root.children[1]).toBe(exit);
      for (const [index, tools] of [[0, preceding], [2, following]] as const) {
        const sibling = root.children[index] as any;
        if (tools.length === 1) expect(sibling).toBe(tools[0]);
        else {
          expect(sibling.constructor.name).toBe("ToolGroupComponent");
          expect(sibling.children).toEqual(tools);
          expect(sibling.children).not.toContain(exit);
        }
      }
      expect(plain(root.render(80)).join("\n")).toContain("Waiting for approval");
    } finally {
      hooks.shutdown();
    }
  });

  test.each(["ask_planner", "finish_plan"])("%s preserves owned pending/actionable bodies and compact versus expanded final detail beside grouped tools", async (name) => {
    const { createCcstyleTool } = await import("../src/renderer/default-mode.ts");
    const { hooks, root, tool } = await groupedTools(false);
    const { initTheme } = await import("@earendil-works/pi-coding-agent");
    initTheme("dark", false);
    const themeUrl = new URL("./modes/interactive/theme/theme.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { theme: cardTheme } = await import(themeUrl.href);
    // Load actual sibling cards without including its sources in this package's rootDir.
    const cardsPath = new URL("../../pi-plan-mode/src/exec-cards.ts", import.meta.url).href;
    const { renderAsk, renderFinish } = await import(cardsPath);
    const options = { expanded: false, isPartial: true };
    let completion: "accepted" | "no_review" | "user_override" | undefined;
    const current = { executionId: "execution-1", exchangeId: "review-1", unresolvedReviewId: "review-1" };
    const owned = createCcstyleTool({
      name,
      ccstyleOwnResult: true,
      renderResult: (_result: unknown, opts: { expanded: boolean; isPartial: boolean }) => name === "ask_planner"
        ? renderAsk({ question: "Keep the approved scope?", planner: "Planner", number: 1, pending: opts.isPartial, reply: "Preserve the approved scope.", costUsd: 0.01 }, opts, cardTheme)
        : renderFinish({
          ...current,
          report: "Implemented approved scope.",
          verification: "Unit tests passed.",
          concerns: "Manual check not run.",
          planFile: "/tmp/plan.md",
          round: 1,
          pending: opts.isPartial,
          completion,
          changes: { edited: ["owned-result-detail.ts"], outside: [] },
          decision: opts.isPartial ? undefined : {
            outcome: completion ? "accepted" : "changes_requested",
            summary: "Preserve the approved scope.",
            evidence: ["Reviewed owned-result evidence."],
            limitations: ["Planner did not rerun checks."],
            findings: completion ? [] : [{ id: "F1", title: "Scope boundary", detail: "Keep the agreed boundary.", requestedChange: "Remove unrelated changes." }],
          },
        }, opts, cardTheme, () => current),
    }, new Map() as any);
    const exchange = tool(name, []);
    exchange.isPartial = true;
    exchange.render = (width: number) => owned.renderResult({ content: [] }, options, cardTheme, { state: {} }).render(width);
    try {
      for (const component of [tool("read", ["Read a.ts"]), tool("todo", ["Tasks"]), exchange, tool("bash", ["Bash npm test"]), tool("read", ["Read b.ts"])]) root.addChild(component);
      expect(root.children).toHaveLength(3);
      expect(root.children[1]).toBe(exchange);
      for (const sibling of [root.children[0], root.children[2]] as any[]) expect(sibling.constructor.name).toBe("ToolGroupComponent");
      for (const width of [46, 120]) {
        for (const isPartial of [true, false]) {
          options.isPartial = exchange.isPartial = isPartial;
          const lines = root.render(width);
          const text = plain(lines).join("\n");
          expect(text).toContain(isPartial ? (name === "ask_planner" ? "Planner thinking…" : "Reviewing") : "Preserve the approved scope.");
          if (name === "finish_plan") {
            expect(text).toContain("Implemented approved scope.");
            expect(text).toContain("Unit tests passed.");
            expect(text).toContain("Manual check not run.");
            if (!isPartial) {
              expect(text).toContain("Scope boundary");
              expect(text).not.toContain("Keep the agreed boundary.");
              expect(text).not.toContain("Remove unrelated changes.");
              options.expanded = true;
              const expandedText = plain(root.render(width)).join("\n");
              expect(expandedText).toContain("Keep the agreed boundary.");
              expect(expandedText).toContain("Remove unrelated changes.");
              options.expanded = false;
            }
          }
          expect(lines.some((line) => /\x1b\[[\d;]+m/.test(line))).toBe(true);
          expect(text).not.toContain("lines returned");
        }
        if (name === "finish_plan") {
          for (const outcome of ["accepted", "no_review", "user_override"] as const) {
            completion = outcome;
            options.isPartial = exchange.isPartial = false;
            const rendered: string[] = [];
            for (const expanded of [false, true, false]) {
              options.expanded = expanded;
              const lines = root.render(width);
              const text = plain(lines).join("\n");
              rendered.push(text);
              expect(text).toContain({
                accepted: expanded ? "Accepted" : "Reviewed",
                no_review: expanded ? "Completed without review" : "Review skipped",
                user_override: expanded ? "Completed by user override" : "Review overridden",
              }[outcome]);
              for (const value of ["Implemented approved scope.", "Unit tests passed.", "Manual check not run."])
                expect(text).toContain(value);
              for (const detail of ["Reviewed owned-result evidence.", "Planner did not rerun checks.", "owned-result-detail.ts"]) {
                if (expanded) expect(text).toContain(detail);
                else expect(text).not.toContain(detail);
              }
              if (!expanded) expect(text.toLowerCase()).toContain("ctrl+o");
              expect(lines.some((line) => /\x1b\[[\d;]+m/.test(line))).toBe(true);
              expect(text).not.toContain("lines returned");
            }
            expect(rendered[0]).toBe(rendered[2]);
            expect(rendered[1].length).toBeGreaterThan(rendered[0].length);
          }
          completion = undefined;
        }
      }
    } finally {
      hooks.shutdown();
    }
  });

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
