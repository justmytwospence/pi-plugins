import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  collectSections,
  formatTokens,
  HEAVY_SKILL_TOKENS,
  MEDIUM_SKILL_TOKENS,
  VERY_HEAVY_SKILL_TOKENS,
  skillTokenColor,
  skillTokenColors,
  windowShareColor,
  groupEntries,
  layoutGrid,
  packageItemName,
  renderSection,
  layoutSection,
  planSplashSections,
  splashSectionCandidates,
  sectionRows,
  buildMcpSection,
  type ResourceSection,
  type ResourceEntry,
  type StartupTheme,
} from "../src/feature/shell/startup-resources.ts";

const plainTheme: StartupTheme = { fg: (_name, text) => text, bold: (text) => text };
const screenshotModels = [
  ...["claude-3-7-sonnet-20250219", "claude-3-7-haiku-20250219", "claude-3-7-opus-20250219", "claude-3-7-fable-20250219"].map((id) => ({ provider: "anthropic", id, contextWindow: 200_000 })),
  { provider: "lmstudio", id: "qwen3-coder-32b-instruct", contextWindow: 131_072 },
  { provider: "mtplx", id: "muse-wonder-1.0-extended", contextWindow: 200_000 },
  ...["gpt-6.1-sol-preview:high", "gpt-6.1-cyber-preview", "gpt-6.1-astra-preview", "gpt-6.1-pro-preview"].map((id) => ({ provider: "openai", id, contextWindow: 272_000 })),
];

describe("startup resources", () => {
  test("packageItemName reduces package paths to the extension name", () => {
    expect(packageItemName("packages/pi-bg/src")).toBe("pi-bg");
    expect(packageItemName("packages/pi-todo")).toBe("pi-todo");
    expect(packageItemName("extensions/foo/index.ts")).toBe("foo");
    expect(packageItemName("src")).toBe("src");
  });

  test("groups by level first, then locals, multi-entry packages and single packages together", () => {
    const entries: ResourceEntry[] = [
      { name: "worktree", scope: "user" },
      { name: "eval", scope: "user" },
      { name: "pi-b", source: "me/repo", scope: "user" },
      { name: "pi-a", source: "me/repo", scope: "user" },
      { name: "src", source: "@x/solo", scope: "user" },
      { name: "src", source: "other", scope: "user" },
      { name: "local", scope: "project" },
      { name: "src", source: "proj-pkg", scope: "project" },
    ];
    expect(groupEntries(entries, "source")).toEqual([
      { label: "project", items: ["local"], children: [{ label: "packages", items: ["proj-pkg"] }] },
      {
        label: "user",
        items: ["eval", "worktree"],
        children: [
          { label: "me/repo", items: ["a", "b"] },
          { label: "packages", items: ["@x/solo", "other"] },
        ],
      },
    ]);
  });

  test("a lone level keeps its label", () => {
    expect(groupEntries([{ name: "b", scope: "user" }, { name: "a", scope: "user" }], "name")).toEqual([
      { label: "user", items: ["a", "b"] },
    ]);
  });

  test("a level with only packages lists them under it", () => {
    expect(
      renderSection(
        {
          title: "Extensions",
          count: 3,
          layout: "grid",
          groups: groupEntries(
            [
              { name: "pi-a", source: "me/repo", scope: "user" },
              { name: "pi-b", source: "me/repo", scope: "user" },
              { name: "x", scope: "project" },
            ],
            "source",
          ),
        },
        80,
        plainTheme,
      ),
    ).toEqual([" Extensions 3", "   project 1", "     x", "   user 2", "     me/repo 2", "       a   b"]);
  });

  test("context files are placed by level", async () => {
    const { contextScope } = await import("../src/feature/shell/startup-resources.ts");
    expect(contextScope("/h/.pi/agent/AGENTS.md", "/h/.pi/agent", "/work/repo")).toBe("user");
    expect(contextScope("/work/repo/AGENTS.md", "/h/.pi/agent", "/work/repo")).toBe("project");
    expect(contextScope("/work/AGENTS.md", "/h/.pi/agent", "/work/repo")).toBe("project");
    expect(contextScope("/work/repo/.pi/SYSTEM.md", "/h/.pi/agent", "/work/repo")).toBe("project");
    expect(contextScope("/elsewhere/prompt.md", "/h/.pi/agent", "/work/repo")).toBe("path");
  });

  test("grid runs down columns and stays within the width", () => {
    const items = ["aa", "bb", "cc", "dd", "ee"];
    const lines = layoutGrid(items, 14, 2);
    expect(lines.every((line) => line.length <= 14)).toBe(true);
    expect(lines.join("\n")).toContain("aa");
    expect(lines).toEqual(["  aa   cc   ee", "  bb   dd"]);
    expect(layoutGrid(items, 2, 2)).toHaveLength(5);
  });

  test("renders heading with count and nested groups", () => {
    const lines = renderSection(
      {
        title: "Extensions",
        count: 3,
        layout: "grid",
        groups: [{ label: "user", items: [], children: [{ label: "me/repo", items: ["a", "b"] }, { label: "packages", items: ["solo"] }] }],
      },
      80,
      plainTheme,
    );
    expect(lines).toEqual([" Extensions 3", "   user 3", "     me/repo 2", "       a   b", "     packages 1", "       solo"]);
  });

  test("collects sections from a mode built on pi's own path helpers", () => {
    const proto = (InteractiveMode as any).prototype;
    const git = (name: string) => ({
      path: `/h/.pi/agent/git/github.com/me/repo/packages/pi-${name}/src`,
      sourceInfo: { source: "git:github.com/me/repo", scope: "user", baseDir: "/h/.pi/agent/git/github.com/me/repo" },
    });
    const mode = Object.create(proto, Object.fromEntries(Object.entries({
      sessionManager: { getCwd: () => "/work" },
      session: {
        promptTemplates: [],
        resourceLoader: {
          getSystemPromptSource: () => undefined,
          getAppendSystemPromptSources: () => [],
          agentDir: "/h/.pi/agent",
          getAgentsFiles: () => ({
            agentsFiles: [
              { path: "/h/.pi/agent/AGENTS.md", content: "x".repeat(800) },
              { path: "/work/AGENTS.md", content: "x".repeat(400) },
              { path: "/work/BIG.md", content: "x".repeat(4000) },
            ],
          }),
          getSkills: () => ({ skills: [{ name: "herdr", filePath: "/skill/herdr", sourceInfo: { source: "local", scope: "user" } }] }),
          getExtensions: () => ({
            extensions: [
              git("bg"),
              git("todo"),
              { path: "/h/.pi/agent/extensions/worktree.ts", sourceInfo: { source: "local", scope: "user" } },
            ],
          }),
        },
      },
    }).map(([key, value]) => [key, { value }])));
    const snapshot = {
      stage: "starting" as const, modelLabel: "p/m", contextWindow: 200_000, usedEstimate: 1400,
      toolDeclarationsKnown: false, mcpOriginsKnown: false,
      attribution: { files: true, skills: true }, caveats: [], sources: [
        { id: "files", category: "files" as const, label: "Files", tokens: 1300, children: [
          { id: "file:/work/BIG.md", category: "files" as const, label: "BIG.md", tokens: 1000 },
          { id: "file:/work/AGENTS.md", category: "files" as const, label: "AGENTS.md", tokens: 100 },
          { id: "file:/h/.pi/agent/AGENTS.md", category: "files" as const, label: "AGENTS.md", tokens: 200 },
        ] },
        { id: "skills", category: "skills" as const, label: "Skills", tokens: 100, children: [
          { id: "skill:/skill/herdr", category: "skills" as const, label: "herdr", tokens: 100 },
        ] },
      ],
    };
    const sections = collectSections(mode, undefined, snapshot);
    expect(sections.Context!.groups.map((group) => group.label)).toEqual(["project", "user"]);
    expect(sections.Context!.groups[0]!.items).toEqual(["BIG.md", "AGENTS.md"]);
    expect(sections.Context!.groups[0]!.tokens).toEqual([1000, 100]);
    expect(sections.Context!.groups[1]!.tokens).toEqual([200]);
    expect(sections.Context!.tokens).toBe(1300);
    expect(sections.Skills!.groups).toEqual([{ label: "user", items: ["herdr"], tokens: [expect.any(Number)] }]);
    expect(sections.Skills!.tokens).toBe(100);
    expect(sections.Extensions!.count).toBe(3);
    expect(sections.Extensions!.groups.map((group) => group.label)).toEqual(["user"]);
    expect(sections.Extensions!.groups[0]!.items).toEqual(["worktree"]);
    expect(sections.Extensions!.groups[0]!.children!.map((group) => group.label)).toEqual([expect.stringContaining("repo")]);
    expect(sections.Extensions!.groups[0]!.children![0]!.items).toEqual(["bg", "todo"]);
  });

  test("matched costs deduplicate source IDs, and missing attribution suppresses costs without hiding inventory", () => {
    const file = "/work/AGENTS.md";
    const mode = {
      sessionManager: { getCwd: () => "/work" },
      session: { model: { contextWindow: 200_000 }, promptTemplates: [], resourceLoader: {
        agentDir: "/home/agent", getSystemPromptSource: () => undefined, getAppendSystemPromptSources: () => [],
        getAgentsFiles: () => ({ agentsFiles: [{ path: file, content: "AAA" }, { path: file, content: "AAA" }, { path: "/work/unused.md", content: "NOT IN PROMPT" }] }),
        getSkills: () => ({ skills: [
          { name: "one", filePath: "/work/one/SKILL.md", sourceInfo: {} },
          { name: "one-copy", filePath: "/work/one/SKILL.md", sourceInfo: {} },
          { name: "unused", filePath: "/work/unused/SKILL.md", sourceInfo: {} },
        ] }),
        getExtensions: () => ({ extensions: [] }),
      } },
      getScopeGroup: () => "project", isPackageSource: () => false,
      formatContextPath: (value: string) => value.split("/").at(-1),
    };
    const attributed = {
      stage: "unavailable" as const, modelLabel: "m", contextWindow: 200_000, usedEstimate: 12,
      toolDeclarationsKnown: false, mcpOriginsKnown: false,
      attribution: { files: true, skills: true }, caveats: ["Tool declarations unavailable."], sources: [
        { id: "files", category: "files" as const, label: "Files", tokens: 9, children: [{ id: `file:${file}`, category: "files" as const, label: "AGENTS.md", tokens: 9 }] },
        { id: "skills", category: "skills" as const, label: "Skills", tokens: 3, children: [{ id: "skill:/work/one/SKILL.md", category: "skills" as const, label: "one", tokens: 3 }] },
      ],
    };
    const sections = collectSections(mode, undefined, attributed);
    expect(sections.Context!.tokens).toBe(9);
    expect(sections.Context!.groups[0]!.tokens).toEqual([9, 0, 0]);
    expect(sections.Skills!.tokens).toBe(3);
    expect(sections.Skills!.groups[0]!.tokens).toEqual([3, 0, 0]);
    expect(sections.Context!.notes).toBeUndefined();
    const empty = collectSections(mode, undefined, { ...attributed, usedEstimate: 0, sources: [] });
    expect(empty.Context!.tokens).toBe(0);
    expect(empty.Context!.groups[0]!.tokens).toEqual([0, 0, 0]);
    expect(renderSection(empty.Context!, 80, plainTheme)[0]).toContain("~0 tok");
    const missing = collectSections(mode, undefined, { ...attributed, attribution: { files: false, skills: false } });
    for (const key of ["Context", "Skills"]) {
      expect(missing[key]!.tokens).toBeUndefined();
      expect(missing[key]!.notes).toEqual([{ text: "prompt attribution unavailable", color: "dim" }]);
      expect(renderSection(missing[key]!, 80, plainTheme).join("\n")).not.toMatch(/~\d+ tok/);
    }
    expect(missing.Context!.count).toBe(3);
    expect(missing.Skills!.count).toBe(3);
  });

  test("MCP servers are listed by the level they are configured at", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { loadMcpEntries } = await import("../src/feature/shell/mcp-servers.ts");
    const dir = mkdtempSync(join(tmpdir(), "mcp-"));
    const userFile = join(dir, "user.json");
    const projectFile = join(dir, "project.json");
    writeFileSync(
      userFile,
      JSON.stringify({
        mcpServers: {
          a: { command: "x" },
          off: { command: "x", enabled: false },
          gated: { url: "https://x", enabled: false },
          tuned: { command: "x" },
          "dash-name": { command: "x" },
        },
      }),
    );
    writeFileSync(
      projectFile,
      JSON.stringify({
        mcpServers: {
          local: { command: "y" },
          gated: { enabled: true },
          tuned: { exposure: "direct" },
          "dash-name": { enabled: false },
        },
      }),
    );
    expect(loadMcpEntries({ userFile, projectFile, registered: ["a", "ext"] })).toEqual([
      { name: "a", level: "user" },
      { name: "off", level: "user", enabled: false },
      { name: "gated", level: "project" },
      { name: "tuned", level: "user" },
      { name: "dash-name", level: "user", enabled: false },
      { name: "local", level: "project" },
      { name: "ext", level: "extension" },
    ]);
    expect(loadMcpEntries({ userFile })).toHaveLength(5);
    expect(loadMcpEntries({ userFile: join(dir, "missing.json") })).toEqual([]);
  });

  test("pi's attention warning is read per server and its configuration lines kept apart", async () => {
    const { parseAttentionMessage, parseOutcomeMessage, configWarning } = await import("../src/feature/shell/mcp-servers.ts");
    const report = parseAttentionMessage(
      "MCP servers need attention:\n  config: /x/mcp.json: bad\n  obsidian: failed: http request failed: body error\n  my-vercel: needs sign-in\nRun /mcp to fix.",
    )!;
    expect(report.problems.get("obsidian")).toEqual({ status: "failed", detail: "http request failed: body error" });
    expect(report.problems.get("my_vercel")).toEqual({ status: "needs-auth" });
    expect(report.configLines).toEqual(["config: /x/mcp.json: bad"]);
    expect(configWarning(report)).toBe("MCP configuration needs attention:\n  config: /x/mcp.json: bad\nRun /mcp to fix.");
    expect(parseAttentionMessage("Something else")).toBeUndefined();
    expect(parseOutcomeMessage('Signed in to MCP server "v" (3 tools).')).toEqual({ name: "v", state: "connected" });
    expect(parseOutcomeMessage('Reconnected to MCP server "v" (failed: no).')).toEqual({ name: "v", state: "failed" });
  });

  test("notification fallback records explicit outcomes, never guesses a connection from tools or time", async () => {
    const { McpState, parseAttentionMessage } = await import("../src/feature/shell/mcp-servers.ts");
    const state = new McpState();
    state.mount();
    expect(state.status("a")).toBeUndefined();
    state.record(parseAttentionMessage("MCP servers need attention:\n  a: needs sign-in\n  b: failed: boom\nRun /mcp to fix.")!);
    expect(state.status("a")).toBe("needs-auth");
    expect(state.status("c")).toBeUndefined();
    expect(state.status("b")).toBe("failed");
    expect(state.detail("b")).toBe("boom");
    state.outcome("b", "connected");
    expect(state.status("b")).toBe("connected");
    expect(state.detail("b")).toBeUndefined();
    state.mount();
    expect(state.status("b")).toBeUndefined();
  });

  test("the MCP section uses compact attention counts and leaves failure details to /mcp", async () => {
    const { buildMcpSection } = await import("../src/feature/shell/startup-resources.ts");
    const detail = "http request failed: a very long diagnostic that belongs in /mcp";
    const section = buildMcpSection(
      [
        { name: "vercel", level: "user" },
        { name: "obsidian", level: "user" },
        { name: "local", level: "project" },
      ],
      (name) => (name === "vercel" ? "needs-auth" : name === "obsidian" ? "failed" : "connected"),
      (name) => (name === "obsidian" ? detail : undefined),
      () => 30,
    )!;
    expect(section.legend).toEqual([{ text: "□ 1", color: "warning" }, { text: "□ 1", color: "error" }]);
    expect(section.notes).toBeUndefined();
    for (const width of [46, 120, 180]) {
      const lines = renderSection(section, width, plainTheme);
      expect(lines[0]).toBe(" ■ MCP 3 · □ 1 · □ 1");
      expect(lines.join("\n")).not.toContain(detail);
      expect(lines.join("\n")).not.toMatch(/connected ·|needs sign-in|\/mcp to fix/);
      expect(lines.some((line) => /■ local\s+30 · \? tok(?:\s|$)/.test(line))).toBe(true);
      expect(lines.some((line) => /□ obsidian/.test(line))).toBe(true);
      expect(lines.some((line) => /□ vercel/.test(line))).toBe(true);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
    const colored: StartupTheme = { fg: (name, text) => `<${name}>${text}</${name}>`, bold: (text) => text };
    const heading = renderSection(section, 180, colored)[0]!;
    expect(heading).toContain("<warning>□ 1</warning>");
    expect(heading).toContain("<error>□ 1</error>");
    expect(buildMcpSection([], () => undefined)).toBeUndefined();
    expect(renderSection(buildMcpSection([{ name: "a", level: "user" }], () => "connected")!, 80, plainTheme)).toEqual([
      " ■ MCP 1",
      "   user 1",
      "   ■ a  ? · ? tok",
    ]);
  });

  test("MCP uses the splash glyphs, explicit states and disabled tones in scope columns", async () => {
    const { buildMcpSection, GLYPHS } = await import("../src/feature/shell/startup-resources.ts");
    const states = ["connected", "connecting", "disabled", "disconnected", "needs-auth", "failed", "unknown"] as const;
    const section = buildMcpSection(
      states.map((name) => ({ name, level: "user", ...(name === "disabled" ? { enabled: false } : {}) })),
      (name) => name === "disabled" ? "connected" : states.find((state) => state === name),
      () => undefined,
      () => 0,
    )!;
    expect(section.layout).toBe("columns");
    const group = section.groups[0]!;
    const byName = (name: string) => group.items.indexOf(name);
    expect(group.prefixes![byName("connected")]).toEqual({ text: "■", color: "success" });
    expect(group.prefixes![byName("connecting")]).toEqual({ text: "□", color: "dim" });
    expect(group.prefixes![byName("needs-auth")]).toEqual({ text: "□", color: "warning" });
    expect(GLYPHS.attention).toEqual({ text: "◆", color: "warning" });
    expect(GLYPHS.attention.text).not.toBe(GLYPHS.live.text);
    expect(group.prefixes![byName("failed")]).toEqual({ text: "□", color: "error" });
    for (const name of ["disabled", "disconnected", "unknown"]) expect(group.prefixes![byName(name)]).toEqual({ text: "□", color: "dim" });
    expect(group.tones![byName("disabled")]).toBe("dim");
    expect(group.right![byName("connected")]).toBe("0 · ? tok");
    for (const name of states.filter((state) => state !== "connected")) expect(group.right![byName(name)]).toBeUndefined();
    const lines = renderSection(section, 80, plainTheme).join("\n");
    expect(lines).toMatch(/□ disabled/);
    expect(lines).toMatch(/□ disconnected/);
    expect(lines).toMatch(/□ unknown/);
    const ansi: StartupTheme = {
      fg: (name, text) => `\x1b[${{ success: 32, warning: 33, error: 31, dim: 2 }[name] ?? 37}m${text}\x1b[0m`,
      bold: (text) => text,
    };
    const colored = renderSection(section, 180, ansi).join("\n");
    expect(colored).toContain("\x1b[32m■\x1b[0m connected");
    expect(colored).toContain("\x1b[33m□\x1b[0m needs-auth");
    expect(colored).toContain("\x1b[31m□\x1b[0m failed");
    expect(colored).toContain("\x1b[2m□\x1b[0m \x1b[2mdisabled\x1b[0m");
  });

  test("MCP metrics reuse visible prepared schemas and distinguish missing, unattributed, and real unknown origins", async () => {
    const { collectStartupContext } = await import("../src/feature/shell/startup-context.ts");
    const visible = { name: "mcp__dash_name__lookup", description: "visible", parameters: {} };
    const hidden = { name: "mcp__dash_name__secret", description: "hidden".repeat(100), parameters: {} };
    const unknown = { name: "mcp__unknown__lookup", description: "real server", parameters: {} };
    const unattributed = { name: "anonymous", description: "unattributed", parameters: {} };
    const snapshot = collectStartupContext({ declarations: [visible, hidden, unknown], hiddenDeclarations: [hidden.name], model: { id: "m", contextWindow: 200_000 } });
    const unassigned = collectStartupContext({ declarations: [unattributed], hiddenDeclarations: [], registry: [{ name: unattributed.name, sourceInfo: { source: "mcp" } }] });
    snapshot.sources.push(...unassigned.sources);
    snapshot.usedEstimate += unassigned.usedEstimate;
    const estimate = (declaration: object) => Math.ceil(JSON.stringify(declaration).length / 4);
    const entries = ["dash-name", "unknown", "empty"].map((name) => ({ name, level: "user" as const }));
    const section = buildMcpSection(entries, () => "connected", undefined, (name) => name === "empty" ? 0 : undefined, snapshot)!;
    const right = Object.fromEntries(section.groups[0]!.items.map((name, i) => [name, section.groups[0]!.right![i]]));
    expect(right).toEqual({ "dash-name": `? · ~${estimate(visible)} tok`, unknown: `? · ~${estimate(unknown)} tok`, empty: "0 · ? tok" });
    expect(section.tokens).toBe(estimate(visible) + estimate(unknown) + estimate(unattributed));
    expect(renderSection(section, 180, plainTheme)[0]).toContain(`~${formatTokens(section.tokens!)} tok`);
    const clean = collectStartupContext({ declarations: [visible], hiddenDeclarations: [], model: { id: "m", contextWindow: 200_000 } });
    const complete = buildMcpSection(entries, () => "connected", undefined, () => 0, clean)!;
    expect(complete.groups[0]!.right![complete.groups[0]!.items.indexOf("empty")]).toBe("0 · ~0 tok");
    const incomplete = buildMcpSection(entries, () => "connected", undefined, () => 0, { ...clean, mcpOriginsKnown: false })!;
    expect(incomplete.tokens).toBeUndefined();
    expect(incomplete.groups[0]!.right![incomplete.groups[0]!.items.indexOf("dash-name")]).toBe(`0 · ~${estimate(visible)} tok`);
    expect(incomplete.groups[0]!.right![incomplete.groups[0]!.items.indexOf("empty")]).toBe("0 · ? tok");
    const absent = buildMcpSection(entries, () => "connected")!;
    expect(absent.tokens).toBeUndefined();
    expect(absent.groups[0]!.right).toEqual(["? · ? tok", "? · ? tok", "? · ? tok"]);
    // Both origins can occur together in one prepared session, regardless of declaration order.
    for (const declarations of [[unknown, unattributed], [unattributed, unknown]]) {
      const combined = collectStartupContext({ declarations, hiddenDeclarations: [], registry: [{ name: unattributed.name, sourceInfo: { source: "mcp" } }] });
      const result = buildMcpSection(entries, () => "connected", undefined, () => 0, combined)!;
      const metrics = Object.fromEntries(result.groups[0]!.items.map((name, i) => [name, result.groups[0]!.right![i]]));
      expect(metrics.unknown).toBe(`0 · ~${estimate(unknown)} tok`);
      expect(metrics.empty).toBe("0 · ? tok");
      expect(result.tokens).toBe(estimate(unknown) + estimate(unattributed));
    }
  });

  test("MCP runtime state wins over disk and tool registrations, including zero-tool servers", async () => {
    const { collectMcpSection } = await import("../src/feature/shell/startup-resources.ts");
    const { mcpState } = await import("../src/feature/shell/mcp-servers.ts");
    mcpState.mount();
    const entries = [
      { name: "live", level: "user", enabled: false },
      { name: "off", level: "user" },
      { name: "resource-only", level: "project" },
      { name: "no-tools", level: "user" },
      { name: "stale-tools", level: "user" },
    ] as const;
    const mode = { session: { getAllTools: () => [
      { namespace: { name: "mcp__live" } },
      { namespace: { name: "mcp__off" } },
      { namespace: { name: "mcp__stale_tools" } },
    ] } };
    const section = collectMcpSection(mode, [...entries], new Map([
      ["live", { status: "connected", tools: 7 }],
      ["off", { status: "disabled" }],
      ["resource_only", { status: "connected", tools: 0 }],
    ]))!;
    const text = renderSection(section, 100, plainTheme).join("\n");
    expect(text).toMatch(/■ live\s+7 · \? tok(?:\s|$)/);
    expect(text).toMatch(/□ off(?:\s|$)/);
    expect(text).toMatch(/■ resource-only\s+0 · \? tok(?:\s|$)/);
    expect(text).toMatch(/□ no-tools(?:\s|$)/);
    expect(text).toMatch(/□ stale-tools(?:\s|$)/);
    expect(text).not.toMatch(/connected ·|disabled(?:\s|$)|unknown(?:\s|$)/);
  });

  test("MCP columns split long scopes and preserve numeric counts at narrow widths", async () => {
    const { buildMcpSection } = await import("../src/feature/shell/startup-resources.ts");
    const entries = Array.from({ length: 10 }, (_, i) => ({ name: `server-${i}`, level: "user" as const }));
    const section = buildMcpSection(entries, () => "connected", undefined, () => 1)!;
    const wide = renderSection(section, 100, plainTheme);
    expect(wide.length).toBeLessThan(entries.length + 2);
    expect(wide).toHaveLength(5); // Longer metrics require wider columns.
    const narrow = renderSection(section, 40, plainTheme);
    expect(narrow.length).toBeGreaterThan(wide.length);
    expect((narrow.slice(2).join(" ").match(/■ server-\d\s+1 · \? tok(?:\s|$)/g) ?? [])).toHaveLength(entries.length);
    const long = buildMcpSection([{ name: "a-very-long-server-name-界界", level: "project" }], () => "needs-auth")!;
    expect(renderSection(long, 28, plainTheme)[2]!.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/□ a-very-long-server-nam…$/);
    const ansi: StartupTheme = { fg: (_name, text) => `\x1b[32m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m` };
    for (const width of [0, 1, 2, 5, 15, 28, 40, 80, 140]) {
      for (const current of [section, long]) {
        expect(renderSection(current, width, ansi).every((line) => visibleWidth(line) <= width), `width ${width}`).toBe(true);
      }
    }
  });

  test("MCP polling follows late status/count/config updates without a startup deadline and stops on removal", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { watchMcpState, collectMcpSection, stopStartupResources } = await import("../src/feature/shell/startup-resources.ts");
    const dir = mkdtempSync(join(tmpdir(), "mcp-watch-"));
    mkdirSync(join(dir, ".pi"));
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    vi.useFakeTimers();
    let status = "live: connected, 2 tools (codemode)";
    let trusted = false;
    const handler = vi.fn(async (_args, ctx) => ctx.ui.notify(status));
    const runner = {
      getCommand: () => ({ sourceInfo: { path: "builtin:mcp" }, handler }),
      createCommandContext: () => ({ mode: "tui", ui: {} }),
      runtime: { mcpServers: { list: () => [] } },
    };
    const component = {};
    const mode = {
      sessionManager: { getCwd: () => dir },
      settingsManager: { isProjectTrusted: () => trusted },
      session: { extensionRunner: runner, getAllTools: () => [] },
      loadedResourcesContainer: { children: [component] },
    };
    let shown = "";
    try {
      writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { live: { command: "x" }, off: { command: "x", enabled: false } } }));
      writeFileSync(join(dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { off: { enabled: true } } }));
      watchMcpState(mode, component, (entries, states) => {
        shown = renderSection(collectMcpSection(mode, entries, states)!, 100, plainTheme).join("\n");
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(shown).toMatch(/■ live\s+2 · \? tok(?:\s|$)/);
      expect(shown).toMatch(/□ off(?:\s|$)/);
      expect(shown).not.toContain("project 1");
      await vi.advanceTimersByTimeAsync(65_000);
      status = "live: disconnected, reconnects on next call (codemode)";
      await vi.advanceTimersByTimeAsync(1000);
      expect(shown).toMatch(/□ live(?:\s|$)/);
      status = "live: connected, 3 tools (codemode)\noff: connected, 0 tools (codemode)";
      trusted = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(shown).toMatch(/■ live\s+3 · \? tok(?:\s|$)/);
      expect(shown).toMatch(/■ off\s+0 · \? tok(?:\s|$)/);
      expect(shown).toContain("project 1");
      writeFileSync(join(dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { off: { enabled: false } } }));
      status = "live: connected, 3 tools (codemode)\noff: disabled (codemode)";
      await vi.advanceTimersByTimeAsync(1000);
      expect(shown).toMatch(/□ off(?:\s|$)/);
      expect(shown).not.toContain("project 1");
      mode.loadedResourcesContainer.children.length = 0;
      const calls = handler.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(handler).toHaveBeenCalledTimes(calls);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stopStartupResources();
      vi.useRealTimers();
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("quiet startup leaves native diagnostics alone and starts no map watcher", async () => {
    const { replaceSections, stopStartupResources } = await import("../src/feature/shell/startup-resources.ts");
    const { mcpState } = await import("../src/feature/shell/mcp-servers.ts");
    vi.useFakeTimers();
    const warning = { render: () => ["[Extension issues] failed"], invalidate() {} };
    const mode = { shouldShowStartupDetails: () => false, loadedResourcesContainer: { children: [warning] } };
    try {
      replaceSections(mode, { showDiagnosticsWhenQuiet: true });
      expect(mode.loadedResourcesContainer.children).toEqual([warning]);
      expect(mcpState.mounted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      stopStartupResources();
      vi.useRealTimers();
    }
  });

  test("the attention warning is taken in once the MCP section is mounted, other messages pass through", async () => {
    const { installMcpNotify } = await import("../src/feature/shell/startup-resources.ts");
    const { mcpState } = await import("../src/feature/shell/mcp-servers.ts");
    const shown: string[] = [];
    const proto: any = { showExtensionNotify: (message: string) => void shown.push(message) };
    installMcpNotify(proto);
    const mode = Object.create(proto, { ui: { value: { requestRender: () => {} } }, session: { value: { getAllTools: () => [] } } });
    const warning = "MCP servers need attention:\n  obsidian: failed: boom\nRun /mcp to fix.";
    mcpState.mounted = false;
    mode.showExtensionNotify(warning, "warning");
    expect(shown).toEqual([warning]);
    mcpState.mount();
    mode.showExtensionNotify(warning, "warning");
    mode.showExtensionNotify("hello", "info");
    expect(shown).toEqual([warning, "hello"]);
    expect(mcpState.status("obsidian")).toBe("failed");
    mode.showExtensionNotify("MCP servers need attention:\n  config: /x: bad\n  obsidian: failed\nRun /mcp to fix.", "warning");
    expect(shown[2]).toBe("MCP configuration needs attention:\n  config: /x: bad\nRun /mcp to fix.");
  });

  test("the models section lists each provider's current generation, one per line, favorites starred", async () => {
    const { buildModelsSection, collectModelsSection, GLYPHS } = await import("../src/feature/shell/startup-resources.ts");
    const available = [
      { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_048_576 },
      { provider: "anthropic", id: "claude-opus-4-8", contextWindow: 1_048_576 },
      { provider: "anthropic", id: "claude-haiku-5-5", contextWindow: 1_048_576 },
      { provider: "anthropic", id: "claude-haiku-4-5-20251001", contextWindow: 200_000 },
      { provider: "openai", id: "gpt-6.1-sol", contextWindow: 922_000 },
      { provider: "openai", id: "gpt-6-sol", contextWindow: 272_000 },
      { provider: "openai", id: "gpt-5.5-pro", contextWindow: 1_050_000 },
      { provider: "openai", id: "o4-mini", contextWindow: 200_000 },
      { provider: "openai", id: "chat-latest", contextWindow: 400_000 },
    ];
    const section = buildModelsSection(
      available,
      [{ provider: "openai", id: "gpt-6.1-sol", thinkingLevel: "high" }, { provider: "anthropic", id: "claude-opus-5-5" }],
      { provider: "anthropic", id: "claude-opus-5-5" },
    )!;
    expect(section.groups.map((group) => group.label)).toEqual(["anthropic", "openai"]);
    expect(section.groups[0]!.marks![0]).toEqual({ ...GLYPHS.live, highlight: true });
    expect(section.groups[0]!.prefixes![0]).toEqual(GLYPHS.favorite);
    expect(GLYPHS.favorite).toEqual({ text: "★", color: "muted" });
    expect(section.groups[1]!.actions![0]).toEqual({ kind: "model", provider: "openai", id: "gpt-6.1-sol", thinkingLevel: "high" });
    expect(renderSection(section, 80, plainTheme)).toEqual([
      " Models 3",
      "   anthropic 2               openai 1",
      "   ★ claude-opus-5-5 ●  1M   ★ gpt-6.1-sol:high  922K",
      "     claude-haiku-5-5   1M",
    ]);
    // Too narrow for both: providers wrap onto their own bands.
    expect(renderSection(section, 40, plainTheme)).toEqual([
      " Models 3",
      "   anthropic 2",
      "   ★ claude-opus-5-5 ●  1M",
      "     claude-haiku-5-5   1M",
      "   openai 1",
      "   ★ gpt-6.1-sol:high  922K",
    ]);
    const colored: StartupTheme = { fg: (name, text) => `\x1b[${name === "muted" ? 90 : name === "success" ? 32 : 33}m${text}\x1b[0m`, bold: (text) => text };
    const coloredModels = renderSection(section, 80, colored).join("\n");
    expect(coloredModels).toContain("\x1b[90m★\x1b[0m");
    expect(coloredModels).toContain("\x1b[32mclaude-opus-5-5\x1b[0m \x1b[32m●\x1b[0m");
    expect(coloredModels).not.toContain("\x1b[33m★\x1b[0m");
    expect(buildModelsSection([])).toBeUndefined();
    const google = buildModelsSection([
      { provider: "google", id: "antigravity-gemini-4-argon" },
      { provider: "google", id: "antigravity-gemma-3" },
      { provider: "google", id: "antigravity-claude-opus-5-5" },
      { provider: "google", id: "antigravity-gpt-oss-120b-medium" },
      { provider: "google", id: "gemini-3.5-pro" },
      { provider: "anthropic", id: "claude-opus-5-5" },
    ], [
      { provider: "google", id: "antigravity-claude-opus-5-5" },
      { provider: "google", id: "antigravity-gpt-oss-120b-medium" },
      { provider: "google", id: "antigravity-gemini-4-argon", thinkingLevel: "high" },
      { provider: "google", id: "antigravity-gemma-3" },
      { provider: "google", id: "antigravity-gemini-4-argon-old" }, // stale favorite must not create a ghost action
    ], { provider: "google", id: "antigravity-gemini-4-argon" })!;
    expect(google.groups.map((group) => group.label)).toEqual(["anthropic", "google"]);
    expect(google.groups[1]!.items).toEqual(["gemini-4-argon:high", "gemma-3"]);
    expect(google.groups[1]!.prefixes![0]).toEqual(GLYPHS.favorite);
    expect(google.groups[1]!.marks![0]).toEqual({ ...GLYPHS.live, highlight: true });
    expect(google.groups[1]!.actions![0]).toEqual({ kind: "model", provider: "google", id: "antigravity-gemini-4-argon", thinkingLevel: "high" });
    expect(google.groups[1]!.actions![1]).toEqual({ kind: "model", provider: "google", id: "antigravity-gemma-3" });
    const nativeOnly = buildModelsSection([
      { provider: "google", id: "gemini-4-argon" }, { provider: "google", id: "gemma-4-31b-it" },
      { provider: "anthropic", id: "claude-opus-5-5" },
    ], [{ provider: "google", id: "antigravity-gemini-4-argon" }])!;
    expect(nativeOnly.groups.map((group) => group.label)).toEqual(["anthropic"]);
    expect(buildModelsSection([{ provider: "google", id: "gemini-4-argon" }])).toBeUndefined();
    let live = [{ provider: "anthropic", id: "claude-opus-5-5" }];
    const lateMode = { session: { scopedModels: [], modelRuntime: { getAvailableSnapshot: () => live } } };
    expect(collectModelsSection(lateMode)!.groups.map((group) => group.label)).toEqual(["anthropic"]);
    live = [...live, { provider: "google", id: "antigravity-gemini-4-argon" }];
    expect(collectModelsSection(lateMode)!.groups.map((group) => group.label)).toEqual(["anthropic", "google"]);
    const mode = {
      session: {
        scopedModels: [],
        model: { provider: "p", id: "alpha" },
        modelRuntime: {
          getAvailableSnapshot: () => [
            { provider: "p", id: "alpha", contextWindow: 131_072 },
            { provider: "p", id: "beta", contextWindow: 131_072 },
          ],
        },
      },
    };
    expect(renderSection(collectModelsSection(mode)!, 80, plainTheme)).toEqual([" Models 2", "   p 2", "   alpha ●  128K", "   beta     128K"]);
  });

  test("the current generation keeps the newest of each family and drops a generation behind", async () => {
    const { currentGeneration, parseModelId } = await import("../src/feature/shell/startup-resources.ts");
    const sorted = (ids: string[]) => [...currentGeneration(ids)].sort();
    expect(
      sorted(["claude-opus-4-5-20251101", "claude-opus-4-8", "claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5-5", "claude-fable-5-1"]),
    ).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(
      sorted(["gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-cyber", "gpt-4o", "gpt-4o-2024-05-13", "o3", "o4-mini", "gpt-daybreak-blue-latest", "chat-latest"]),
    ).toEqual(["gpt-6-astra", "gpt-6.1-sol"]);
    // A family new in a later major does not retire a still-current one.
    expect(sorted(["antigravity-gemini-3.5-flash", "antigravity-gemini-3.8-flash", "antigravity-gemini-4-argon", "antigravity-gpt-oss-120b-medium"])).toEqual([
      "antigravity-gemini-3.8-flash",
      "antigravity-gemini-4-argon",
      "antigravity-gpt-oss-120b-medium",
    ]);
    expect(parseModelId("claude-opus-4-5-20251101")).toEqual({ family: "claude-opus", vendor: "claude", version: [4, 5], alias: true });
    expect(sorted(["muse-wonder-1.0", "muse-wonder-1.0-contributor", "muse-spark-1.2", "muse-spark-1.3", "muse-image-1.0"])).toEqual([
      "muse-spark-1.3",
      "muse-wonder-1.0",
    ]);
    expect(parseModelId("o4-mini")).toEqual({ family: "o-mini", version: [4, 0], alias: false });
    expect(parseModelId("qwen3.8-27b")).toEqual({ family: "qwen-27b", version: [3, 8], alias: false });
  });

  test("context windows use the units vendors quote", async () => {
    const { formatContextWindow } = await import("../src/feature/shell/startup-resources.ts");
    expect([1_048_576, 131_072, 65_536, 922_000, 272_000, 1_050_000, 200_000, 1_000_000].map(formatContextWindow)).toEqual([
      "1M", "128K", "64K", "922K", "272K", "1.05M", "200K", "1M",
    ]);
    expect(formatContextWindow(undefined)).toBe("");
  });

  test("screenshot-sized Models pack ordered providers into independently placed vertical stacks", async () => {
    const { buildModelsSection } = await import("../src/feature/shell/startup-resources.ts");
    // Favorites keep every inventory entry, including IDs that happen to resemble aliases or versions.
    const section = buildModelsSection(screenshotModels, screenshotModels)!;
    expect(section.groups.map((group) => [group.label, group.items.length])).toEqual([
      ["anthropic", 4], ["lmstudio", 1], ["mtplx", 1], ["openai", 4],
    ]);
    const { lines, hits } = layoutSection(section, 100, plainTheme);
    expect(lines).toHaveLength(8); // Section heading + two seven-row stacks, not two five-row horizontal bands.
    expect(lines[1]).toContain("anthropic 4");
    expect(lines[1]).toContain("mtplx 1");
    expect(lines[6]).toContain("lmstudio 1");
    expect(lines[3]).toContain("openai 4"); // The right stack starts openai beneath mtplx.
    expect(lines[2]).toContain("muse-wonder-1.0-extended");
    expect(lines[7]).toContain("gpt-6.1-pro-preview");
    expect(new Set(hits.map((hit) => JSON.stringify(hit.action))).size).toBe(10);
    for (const [provider, rows] of [["anthropic", [2, 3, 4, 5]], ["lmstudio", [7]], ["mtplx", [2]], ["openai", [4, 5, 6, 7]]] as const) {
      expect([...new Set(hits.filter((hit) => hit.action.kind === "model" && hit.action.provider === provider).map((hit) => hit.row))].sort((a, b) => a - b)).toEqual(rows);
    }
    const firstColumn = hits.filter((hit) => hit.action.kind === "model" && ["anthropic", "lmstudio"].includes(hit.action.provider));
    const secondColumn = hits.filter((hit) => hit.action.kind === "model" && ["mtplx", "openai"].includes(hit.action.provider));
    const leftEdge = Math.max(...firstColumn.map((hit) => hit.endCol));
    const rightEdge = Math.min(...secondColumn.map((hit) => hit.startCol));
    expect(leftEdge + 3).toBeLessThanOrEqual(rightEdge);
    expect(sliceByColumn(lines[2]!, leftEdge, rightEdge - leftEdge).trim()).toBe("");
  });

  test("ten differently sized MCP server names reflow at screenshot width", () => {
    const tools = new Map(Object.entries({ "chrome-live": 30, context7: 2, garmin: 163, inoreader: 33,
      obsidian: 18, paperless: 22, strava: 33, tabpfn: 6, telebrowser: 0, vercel: 0 }));
    const entries = [...tools.keys()].map((name) => ({ name, level: "user" as const }));
    const section = buildMcpSection(entries, (name) => tools.get(name) ? "connected" : "disconnected",
      undefined, (name) => tools.get(name))!;
    const lines = renderSection(section, 100, plainTheme);
    expect(lines).toHaveLength(5);
    for (const name of tools.keys()) expect(lines.join("\n")).toContain(name);
    expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
  });

  test("a long column uses quotient/remainder splits under its heading", async () => {
    const items = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const lines = renderSection({ title: "C", count: items.length, layout: "columns", groups: [{ label: "p", items }] }, 80, plainTheme);
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe("   m0   m2   m4   m6   m8");
    expect(lines[3]).toBe("   m1   m3   m5   m7   m9");
  });

  test("balanced one-scope MCP columns use available width without stealing metadata", async () => {
    const { buildMcpSection } = await import("../src/feature/shell/startup-resources.ts");
    for (const count of [4, 8, 10, 17]) {
      const section = buildMcpSection(Array.from({ length: count }, (_, n) => ({ name: `s${n}`, level: "user" as const })), () => "connected", undefined, () => 1)!;
      const wide = renderSection(section, 180, plainTheme);
      const columns = count === 17 ? 6 : Math.max(1, Math.floor(count / 2));
      expect(wide).toHaveLength(2 + Math.ceil(count / columns));
      const firstData = wide[2]!;
      const cells = (line: string) => line.match(/■ s\d+\s+1 · \? tok(?:\s|$)/g) ?? [];
      expect(cells(firstData)).toHaveLength(columns);
      if (count === 10) expect(wide.slice(2).map((line) => cells(line).length)).toEqual([5, 5]);
      if (count === 17) expect(wide.slice(2).map((line) => cells(line).length)).toEqual([6, 6, 5]);
      expect(wide.every((line) => visibleWidth(line) <= 180)).toBe(true);
      for (const width of [46, 120, 180]) {
        const { lines, hits } = layoutSection(section, width, plainTheme);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.slice(2).flatMap(cells)).toHaveLength(count);
        expect(new Set(hits.map((hit) => JSON.stringify(hit.action))).size).toBe(count);
        for (const hit of hits) {
          expect(hit.endCol).toBeLessThanOrEqual(width);
          expect(sliceByColumn(lines[hit.row]!, hit.startCol, hit.endCol - hit.startCol).trim()).not.toBe("");
        }
      }
    }
  });

  test("hit geometry matches emitted cells after bands, Unicode and truncation", async () => {
    const { buildMcpSection } = await import("../src/feature/shell/startup-resources.ts");
    const section = buildMcpSection([
      { name: "界界-very-very-long", level: "project" },
      { name: "small", level: "user" },
      { name: "offline", level: "user", enabled: false },
    ], (name) => name === "small" ? "connected" : "unknown")!;
    const ansi: StartupTheme = { fg: (_name, text) => `\x1b[32m${text}\x1b[39m`, bold: (text) => `\x1b[1m${text}\x1b[22m` };
    for (const theme of [plainTheme, ansi]) for (const width of [28, 46, 100, 120, 180]) {
      const { lines, hits } = layoutSection(section, width, theme);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(hits.map((hit) => hit.action)).toEqual(expect.arrayContaining([
        { kind: "mcp", name: "界界-very-very-long" },
        { kind: "mcp", name: "small" },
        { kind: "mcp", name: "offline" },
      ]));
      for (const hit of hits) {
        expect(hit.startCol).toBeGreaterThanOrEqual(3);
        expect(hit.endCol).toBeLessThanOrEqual(width);
        expect(hit.endCol).toBeGreaterThan(hit.startCol);
        expect(hit.row).toBeGreaterThan(0);
        expect(lines[hit.row]).toBeDefined();
        expect(visibleWidth(sliceByColumn(lines[hit.row]!, hit.startCol, hit.endCol - hit.startCol))).toBeGreaterThan(0);
      }
    }
  });

  test("all widths keep balanced sections and hit rectangles inside the viewport", async () => {
    const { buildModelsSection, buildMcpSection } = await import("../src/feature/shell/startup-resources.ts");
    const models = buildModelsSection([
      ...Array.from({ length: 17 }, (_, n) => ({ provider: "google", id: `antigravity-gemini-${n}-flash`, contextWindow: 200_000 })),
      { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_048_576 },
      { provider: "openai", id: "gpt-6.1-sol", contextWindow: 922_000 },
    ], Array.from({ length: 17 }, (_, n) => ({ provider: "google", id: `antigravity-gemini-${n}-flash` })))!;
    const mcp = buildMcpSection(Array.from({ length: 17 }, (_, n) => ({ name: `s${n}`, level: "user" as const })), () => "connected", undefined, () => 1)!;
    const stacked = buildModelsSection(screenshotModels, screenshotModels)!;
    const widths = [...Array.from({ length: 201 }, (_, n) => n), 240];
    for (const width of widths) for (const section of [models, mcp, stacked]) {
      const layout = layoutSection(section, width, plainTheme);
      const { lines, hits } = layout;
      expect(layoutSection(section, width, plainTheme), `${section.title} deterministic at ${width}`).toEqual(layout);
      expect(lines.every((line) => visibleWidth(line) <= width && (!line.trim() || line.startsWith(" "))), `${section.title} at ${width}`).toBe(true);
      const actions = new Map<string, typeof hits>();
      for (const hit of hits) {
        expect(hit.row, `${section.title} at ${width}`).toBeGreaterThan(0);
        expect(hit.row).toBeLessThan(lines.length);
        expect(hit.startCol).toBeGreaterThanOrEqual(1);
        expect(hit.endCol).toBeLessThanOrEqual(width);
        expect(hit.endCol).toBeGreaterThan(hit.startCol);
        expect(sliceByColumn(lines[hit.row]!, hit.startCol, hit.endCol - hit.startCol).trim()).not.toBe("");
        const key = JSON.stringify(hit.action);
        actions.set(key, [...(actions.get(key) ?? []), hit]);
      }
      for (const cells of actions.values()) {
        expect(new Set(cells.map((hit) => hit.row)).size, `${section.title} duplicate row at ${width}`).toBe(1);
        expect(cells.length, `${section.title} duplicate cell at ${width}`).toBeLessThanOrEqual(2);
      }
      for (let row = 0; row < lines.length; row++) {
        const rectangles = hits.filter((hit) => hit.row === row).sort((a, b) => a.startCol - b.startCol);
        for (let i = 1; i < rectangles.length; i++) {
          const previous = rectangles[i - 1]!;
          const current = rectangles[i]!;
          expect(current.startCol, `${section.title} overlapping hits at ${width}`).toBeGreaterThanOrEqual(previous.endCol);
          // The name/status gap is inactive; a different stack may have a heading between actions.
          if (JSON.stringify(previous.action) === JSON.stringify(current.action)) {
            expect(sliceByColumn(lines[row]!, previous.endCol, current.startCol - previous.endCol).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim(), `${section.title} active gap at ${width}`).toBe("");
          }
        }
      }
      if (width >= 120) {
        const expected = section.groups.flatMap((group) => group.actions ?? []).map((action) => JSON.stringify(action));
        expect([...actions.keys()].sort(), `${section.title} missing/repeated action at ${width}`).toEqual(expected.sort());
        expect(lines[0]).toContain(`${section.title} ${section.count}`);
      }
    }
  });

  test("inset shifts the model name and count hit rectangles and leaves the gutter inert", () => {
    const section: ResourceSection = { title: "Models", count: 1, layout: "columns", groups: [{
      label: "p", items: ["alpha"], right: ["128K"], actions: [{ kind: "model", provider: "p", id: "alpha" }],
    }] };
    for (const width of [0, 1, 24, 46, 120]) {
      const { lines, hits } = layoutSection(section, width, plainTheme);
      expect(lines.every((line) => visibleWidth(line) <= width && (!line.trim() || line.startsWith(" ")))).toBe(true);
      expect(hits.every((hit) => hit.startCol > 0 && hit.endCol <= width)).toBe(true);
      if (width <= 1) expect({ lines, hits }).toEqual({ lines: [], hits: [] });
      else {
        expect(lines).toEqual([" Models 1", "   p 1", "   alpha  128K"]);
        expect(hits.map(({ row, startCol, endCol }) => ({ row, startCol, endCol }))).toEqual([
          { row: 2, startCol: 3, endCol: 8 }, { row: 2, startCol: 10, endCol: 14 },
        ]);
        expect(hits.some((hit) => hit.startCol <= 0 && hit.endCol > 0)).toBe(false);
      }
    }
  });

  test("responsive candidates fold whole groups and preserve protected sources at the actual width", () => {
    const extensions: ResourceSection = { title: "Extensions", count: 44, layout: "grid", category: "tools", groups: [
      { label: "user", items: ["local-00", "local-01", "local-02", "local-03"], children: Array.from({ length: 4 }, (_, child) => ({
        label: `package-${child}`, items: Array.from({ length: 10 }, (_, i) => `extension-${child}-${String(i).padStart(2, "0")}`),
      })) },
    ] };
    const models: ResourceSection = { title: "Models", count: 14, layout: "columns", groups: [
      { label: "provider", items: Array.from({ length: 14 }, (_, i) => `model-${String(i).padStart(2, "0")}`),
        actions: Array.from({ length: 14 }, (_, i) => ({ kind: "model" as const, provider: "provider", id: `model-${String(i).padStart(2, "0")}` })),
        marks: [{ text: "●", color: "success", highlight: true }, ...Array(13).fill(undefined)],
        prefixes: [undefined, { text: "★", color: "muted" }, ...Array(12).fill(undefined)],
        right: Array(14).fill("200K") },
    ] };
    const mcp = buildMcpSection(Array.from({ length: 10 }, (_, i) => ({ name: `server-${i}`, level: "user" as const })),
      (name) => name === "server-0" ? "needs-auth" : "connected", undefined, () => 2)!;
    const context: ResourceSection = { title: "Context", count: 2, tokens: 300, layout: "columns", groups: [
      { label: "project", items: ["AGENTS.md", "SYSTEM.md"], tokens: [200, 100] },
    ], notes: [{ text: "diagnostic retained", color: "warning" }] };
    const skills: ResourceSection = { title: "Skills", count: 2, layout: "grid", groups: [{ label: "user", items: ["skill-a", "skill-b"], tokens: [10, 20] }] };
    const prompts: ResourceSection = { title: "Prompts", count: 2, layout: "grid", groups: [{ label: "project", items: ["/a", "/b"] }] };
    const sections = { Context: context, Skills: skills, Prompts: prompts, Extensions: extensions, MCP: mcp, Models: models };
    const names = Object.keys(sections) as Array<keyof typeof sections>;
    const score = (choices: ReturnType<typeof splashSectionCandidates>) => ({
      protected: choices.reduce((sum, choice) => sum + choice.losses[0] + choice.losses[1], 0),
      hidden: choices.reduce((sum, choice) => sum + choice.hidden, 0),
      favorites: choices.reduce((sum, choice) => sum + choice.losses[2], 0),
      folds: choices.reduce((sum, choice) => sum + choice.folds, 0),
      order: choices.map((choice) => choice.order).join("/"),
    });
    const compare = (a: ReturnType<typeof score>, b: ReturnType<typeof score>) =>
      a.protected - b.protected || a.hidden - b.hidden || a.favorites - b.favorites || a.folds - b.folds || a.order.localeCompare(b.order);
    const checkAtomic = (source: ResourceSection, candidate: ResourceSection) => {
      expect(candidate.count).toBe(source.count);
      expect(candidate.tokens).toBe(source.tokens);
      expect(candidate.notes).toEqual(source.notes);
      const check = (originalGroups: ResourceSection["groups"], chosenGroups: ResourceSection["groups"]) => {
        expect(chosenGroups.map((group) => group.label)).toEqual(originalGroups.map((group) => group.label));
        for (const [index, group] of chosenGroups.entries()) {
          const original = originalGroups[index]!;
          if (group.foldedCount) {
            expect(group.items).toEqual([]);
            expect(group.children ?? []).toEqual([]);
            expect(group.foldedCount).toBe(group.count);
          } else {
            expect(group.items).toEqual(original.items);
            for (const property of ["tokens", "marks", "prefixes", "right", "tones", "actions"] as const) {
              expect(group[property]).toEqual(original[property]);
            }
            check(original.children ?? [], group.children ?? []);
          }
        }
      };
      if (candidate.foldedCount) {
        expect(candidate.groups).toEqual([]);
        expect(candidate.foldedCount).toBe(source.count);
      } else check(source.groups, candidate.groups);
    };
    for (const width of [46, 80, 120, 180]) {
      const fullRows = names.reduce((sum, name) => sum + renderSection(sections[name], width, plainTheme).length, 0);
      for (const name of names) expect(planSplashSections(sections, width, plainTheme, fullRows)[name]).toBe(sections[name]);
      const options = names.map((name) => splashSectionCandidates(name, sections[name], width, plainTheme));
      for (const [index, variants] of options.entries()) for (const candidate of variants) {
        checkAtomic(sections[names[index]!]!, candidate.section);
        expect(candidate.rows).toBe(renderSection(candidate.section, width, plainTheme).length);
        if (candidate.hidden) expect(renderSection(candidate.section, width, plainTheme).join("\n")).toMatch(/\+\d+ hidden/);
      }
      for (const budget of [fullRows - 4, fullRows - 9]) {
        const planned = planSplashSections(sections, width, plainTheme, budget);
        const used = names.reduce((sum, name) => sum + renderSection(planned[name]!, width, plainTheme).length, 0);
        expect(used).toBeLessThanOrEqual(budget);
        const selected = names.map((name, index) => options[index]!.find((choice) => JSON.stringify(choice.section) === JSON.stringify(planned[name]))!);
        expect(selected.every(Boolean)).toBe(true);
        let minimum: ReturnType<typeof score> | undefined;
        const exhaustive = (index: number, rows: number, picked: typeof selected) => {
          if (rows > budget) return;
          if (index === names.length) {
            const current = score(picked);
            if (!minimum || compare(current, minimum) < 0) minimum = current;
            return;
          }
          for (const choice of options[index]!) exhaustive(index + 1, rows + choice.rows, [...picked, choice]);
        };
        exhaustive(0, 0, []);
        expect(compare(score(selected), minimum!)).toBe(0);
        for (const name of names) {
          const original = sections[name];
          const chosen = planned[name]!;
          checkAtomic(original, chosen);
          const layout = layoutSection(chosen, width, plainTheme);
          expect(layout.lines[0]).toContain(`${name} ${original.count}`);
          expect(layout.lines.every((line) => visibleWidth(line) <= width)).toBe(true);
          for (const hit of layout.hits) expect(sliceByColumn(layout.lines[hit.row]!, hit.startCol, hit.endCol - hit.startCol).trim()).not.toBe("");
        }
        expect(planned.Context!.notes).toContainEqual({ text: "diagnostic retained", color: "warning" });
        if (planned.Models!.groups.length && !planned.Models!.groups[0]!.foldedCount) expect(planned.Models!.groups[0]!.items).toContain("model-00");
        if (planned.MCP!.groups.length && !planned.MCP!.groups[0]!.foldedCount) expect(planned.MCP!.groups[0]!.items).toContain("server-0");
      }
      const impossible = planSplashSections(sections, width, plainTheme, 0);
      expect(impossible.Context!.notes).toContainEqual({ text: "diagnostic retained", color: "warning" });
      expect(renderSection(impossible.Models!, width, plainTheme)[0]).toContain("Models 14");
    }
  });

  test("grid charges each natural column separately, preserves column-major order and ANSI/Unicode bounds", () => {
    const values = ["a", "b", "c", "d", "界界界界界界", "f", "g", "h"];
    const ansi = values.map((value) => `\x1b[32m${value}\x1b[39m`);
    const lines = layoutGrid(ansi, 26, 2);
    expect(lines).toHaveLength(2); // Per-column widths 1 + 1 + 12 + 1 plus three gaps fit.
    expect(lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""))).toEqual([
      "  a   c   界界界界界界   g", "  b   d   f              h",
    ]);
    expect(lines.every((line) => visibleWidth(line) <= 26)).toBe(true);
    expect(layoutGrid(["界界界界界界"], 7, 2)[0] && visibleWidth(layoutGrid(["界界界界界界"], 7, 2)[0]!)).toBeLessThanOrEqual(7);
  });

  test("scope-local lists stay whole while child packages fold; large subgroup beams stay bounded and scroll safely", () => {
    const scope: ResourceSection = { title: "Extensions", count: 29, layout: "grid", groups: [{ label: "user", items: ["local-a", "local-b", "local-c"],
      children: Array.from({ length: 13 }, (_, i) => ({ label: `package-${i}`, items: [`item-${i}-a`, `item-${i}-b`] })) }] };
    const wide = splashSectionCandidates("Extensions", scope, 120, plainTheme);
    expect(wide).toHaveLength(256);
    expect(splashSectionCandidates("Extensions", scope, 120, plainTheme)).toEqual(wide);
    expect(wide.some((choice) => choice.section.foldedCount === 29 && choice.section.groups.length === 0)).toBe(true);
    for (const choice of wide) {
      const group = choice.section.groups[0];
      if (group && !group.foldedCount) {
        expect(group.items).toEqual(["local-a", "local-b", "local-c"]);
        for (const child of group.children ?? []) {
          expect(child.items.length).toBe(child.foldedCount ? 0 : 2);
          if (child.foldedCount) expect(renderSection(choice.section, 120, plainTheme).join("\n")).toContain(`${child.label} 2 · +2 hidden`);
        }
      }
    }
    const longName: ResourceSection = { title: "Extensions", count: 2, layout: "grid", groups: [
      { label: "a-very-long-package-name-that-needs-truncation-at-narrow-widths", items: ["alpha", "beta"] },
    ] };
    const folded = splashSectionCandidates("Extensions", longName, 46, plainTheme).find((choice) => choice.section.groups[0]?.foldedCount)!;
    expect(renderSection(folded.section, 46, plainTheme)[1]).toContain("· +2 hidden");
    const impossible = planSplashSections({ Extensions: scope }, 46, plainTheme, 0).Extensions!;
    expect(impossible.foldedCount).toBe(29);
    expect(renderSection(impossible, 46, plainTheme)).toEqual([" Extensions 29 · +29 hidden"]);
  });

  test("column row counts match the rendered layout, and many model providers plan quickly", () => {
    const sizes = [3, 40, 12, 25, 8, 30, 5, 18, 22, 9, 14, 6, 9];
    const models: ResourceSection = { title: "Models", count: sizes.reduce((sum, size) => sum + size, 0), layout: "columns",
      notes: [{ text: "note", color: "dim" }],
      groups: sizes.map((size, group) => ({ label: `provider-${group}`, items: Array.from({ length: size }, (_, index) => `model-${group}-${index}${"x".repeat(index % 7)}`) })) };
    const started = performance.now();
    const candidates = splashSectionCandidates("Models", models, 158, plainTheme);
    planSplashSections({ Models: models }, 158, plainTheme, 20);
    expect(performance.now() - started).toBeLessThan(2000);
    for (const width of [1, 2, 6, 30, 46, 80, 158, 220]) {
      expect(sectionRows(models, width, plainTheme)).toBe(renderSection(models, width, plainTheme).length);
      for (const candidate of width === 158 ? candidates : splashSectionCandidates("Models", models, width, plainTheme).slice(0, 40)) {
        expect(candidate.rows).toBe(renderSection(candidate.section, width, plainTheme).length);
      }
    }
  });

  test("protected current-model and MCP problem scopes win over a smaller hidden count", () => {
    const models: ResourceSection = { title: "Models", count: 4, layout: "columns", groups: [
      { label: "current-provider", items: ["current", "favorite"], marks: [{ text: "●", color: "success", highlight: true }, undefined],
        prefixes: [undefined, { text: "★", color: "muted" }] },
      { label: "other-provider", items: ["other-1", "other-2"] },
    ] };
    const mcp = buildMcpSection([
      { name: "problem", level: "project" }, { name: "healthy-1", level: "user" }, { name: "healthy-2", level: "user" },
    ], (name) => name === "problem" ? "needs-auth" : "connected")!;
    for (const status of ["needs-auth", "failed"] as const) {
      const problems = buildMcpSection([{ name: "problem", level: "project" }, { name: "healthy", level: "user" }],
        (name) => name === "problem" ? status : "connected")!;
      const candidates = splashSectionCandidates("MCP", problems, 100, plainTheme);
      const foldedProblem = candidates.find((candidate) => candidate.section.groups.find((group) => group.label === "project")?.foldedCount)!;
      const foldedHealthy = candidates.find((candidate) => candidate.section.groups.find((group) => group.label === "user")?.foldedCount && !candidate.section.groups.find((group) => group.label === "project")?.foldedCount)!;
      expect(foldedProblem.losses[1]).toBeGreaterThan(foldedHealthy.losses[1]);
    }
    for (const width of [46, 80, 120, 180]) {
      const full = renderSection(models, width, plainTheme).length + renderSection(mcp, width, plainTheme).length;
      const options = [splashSectionCandidates("Models", models, width, plainTheme), splashSectionCandidates("MCP", mcp, width, plainTheme)];
      const fit = options[0]!.flatMap((a) => options[1]!.map((b) => [a, b] as const)).filter(([a, b]) => a.rows + b.rows <= full - 2 && a.losses[0] + b.losses[1] === 0);
      if (!fit.length) continue;
      const planned = planSplashSections({ Models: models, MCP: mcp }, width, plainTheme, full - 2);
      expect(planned.Models!.groups.find((group) => group.label === "current-provider")?.items).toContain("current");
      expect(planned.MCP!.groups.find((group) => group.label === "project")?.items).toContain("problem");
      expect(planned.MCP!.legend).toEqual(mcp.legend);
    }
  });

  test("formats token counts compactly", () => {
    expect(formatTokens(210)).toBe("210");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(1440)).toBe("1.4k");
    expect(formatTokens(12600)).toBe("13k");
  });

  test("context files show a total and right-aligned counts", () => {
    const lines = renderSection(
      {
        title: "Context",
        count: 2,
        tokens: 1500,
        layout: "columns",
        groups: [
          { label: "project", items: ["a.md", "b.md"], tokens: [100, 20] },
          { label: "user", items: ["~/big.md"], tokens: [1400] },
        ],
      },
      80,
      plainTheme,
    );
    expect(lines).toEqual([
      " Context 2 · ~1.5k tok",
      "   project 2    user 1",
      "   a.md  ~100   ~/big.md  ~1.4k",
      "   b.md   ~20",
    ]);
  });

  test("skills all show counts, colored by weight, and keep alphabetical order", () => {
    const lines = renderSection(
      {
        title: "Skills",
        count: 3,
        tokens: 400,
        layout: "grid",
        groups: [{ items: ["apple", "bee", "cat"], tokens: [20, HEAVY_SKILL_TOKENS + 50, 30] }],
      },
      80,
      plainTheme,
    );
    expect(lines[0]).toBe(" Skills 3 · ~400 tok");
    expect(lines[1]).toBe(`   apple ~20   bee ~${HEAVY_SKILL_TOKENS + 50}   cat ~30`);
    expect(skillTokenColor(20)).toBe("dim");
    expect(skillTokenColor(MEDIUM_SKILL_TOKENS)).toBe("muted");
    expect(skillTokenColor(HEAVY_SKILL_TOKENS)).toBe("warning");
    expect(skillTokenColor(VERY_HEAVY_SKILL_TOKENS)).toBe("error");
  });

  test("outliers against the list median move up a tier", () => {
    expect(skillTokenColors([60, 60, 60, 150])).toEqual(["dim", "dim", "dim", "warning"]);
    expect(skillTokenColors([150, 150, 150])).toEqual(["muted", "muted", "muted"]);
    expect(skillTokenColors([])).toEqual([]);
  });

  test("long nested headings remain within the viewport in grid and lines modes", () => {
    const heading = "a-very-long-package-name-界界界界";
    for (const layout of ["grid", "lines"] as const) {
      for (const width of [1, 12, 24, 25, 46]) {
        const lines = renderSection({ title: "Skills", count: 1, layout, groups: [
          { label: heading, items: ["child"] },
        ] }, width, plainTheme);
        expect(lines.every((line) => visibleWidth(line) <= width), `${layout} ${width}`).toBe(true);
      }
    }
  });

  test("heading total is colored by share of the context window", () => {
    expect(windowShareColor(1000, undefined)).toBe("dim");
    expect(windowShareColor(2000, 200_000)).toBe("dim");
    expect(windowShareColor(6000, 200_000)).toBe("warning");
    expect(windowShareColor(12000, 200_000)).toBe("error");
  });

  test("context share colors recalculate against the selected model without changing category colors", () => {
    const colored: StartupTheme = { fg: (name, text) => `<${name}>${text}</${name}>`, bold: (text) => text };
    const section = {
      title: "Context", count: 1, tokens: 10_000, contextWindow: 200_000,
      category: "files" as const, layout: "columns" as const,
      groups: [{ label: "user", items: ["SYSTEM.md"], tokens: [10_000] }],
    };
    const small = renderSection(section, 500, colored).join("\n");
    const large = renderSection({ ...section, contextWindow: 1_000_000 }, 500, colored).join("\n");
    expect(small).toContain("<warning>· ~10k tok</warning>");
    expect(large).toContain("<dim>· ~10k tok</dim>");
    expect(small).toContain("<mdLink>■</mdLink>");
    expect(large).toContain("<mdLink>■</mdLink>");
  });

  test("groupEntries sorts measured entries by tokens, heaviest first, keeping estimates aligned", () => {
    const groups = groupEntries(
      [
        { name: "b", scope: "user", tokens: 2 },
        { name: "a", scope: "user", tokens: 1 },
      ],
      "name",
    );
    expect(groups).toEqual([{ label: "user", items: ["b", "a"], tokens: [2, 1] }]);
  });
});

describe("splash planning", () => {
  async function setup(rows: number, chatLines: number) {
    const { replaceSections, setStartupResourcesTheme, stopStartupResources } = await import("../src/feature/shell/startup-resources.ts");
    let styled = 0;
    setStartupResourcesTheme(() => ({ fg: (_name, text) => { styled++; return text; }, bold: (text) => text }));
    const git = (name: string) => ({
      path: `/h/.pi/agent/git/github.com/me/repo/packages/pi-${name}/src`,
      sourceInfo: { source: "git:github.com/me/repo", scope: "user", baseDir: "/h/.pi/agent/git/github.com/me/repo" },
    });
    let chat = Array.from({ length: chatLines }, (_, i) => `chat ${i}`);
    const chatContainer = { render: vi.fn(() => chat), invalidate() {} };
    const ui = { requestRender: vi.fn(), terminal: { rows } };
    const mode = Object.create((InteractiveMode as any).prototype, Object.fromEntries(Object.entries({
      sessionManager: { getCwd: () => "/work" },
      session: { promptTemplates: [], resourceLoader: {
        getSystemPromptSource: () => undefined, getAppendSystemPromptSources: () => [], agentDir: "/h/.pi/agent",
        getAgentsFiles: () => ({ agentsFiles: [] }), getSkills: () => ({ skills: [] }),
        getExtensions: () => ({ extensions: Array.from({ length: 40 }, (_, i) => git(`ext${i}`)) }),
      } },
      ui,
      chatContainer,
      loadedResourcesContainer: { children: [] as any[] },
      getStartupExpansionState: () => false,
    }).map(([key, value]) => [key, { value, writable: true }])));
    // Pi builds fresh children on every show.
    const show = () => {
      const extensions = { state: { expanded: false }, setExpanded() {}, invalidate() {}, render: (_width: number) => ["[Extensions]", "  many"] };
      mode.loadedResourcesContainer.children = [extensions];
      replaceSections(mode, { force: true });
      return extensions;
    };
    const frame = async (extensions: { render(width: number): string[] }) => {
      await Promise.resolve();
      chatContainer.render.mockClear();
      styled = 0;
      const first = extensions.render(80);
      expect(extensions.render(80)).toEqual(first);
      return { lines: first, chatRenders: chatContainer.render.mock.calls.length, styled };
    };
    return { show, frame, ui, setChat: (lines: string[]) => { chat = lines; }, getChat: () => chat, stopStartupResources };
  }

  test("measures Pi's containers once per show, never as the chat grows", async () => {
    const t = await setup(12, 4);
    try {
      const ext = t.show();
      const a = await t.frame(ext);
      expect(a.chatRenders).toBe(1);
      expect(a.lines[0]).toContain("Extensions");
      t.setChat(Array.from({ length: 40 }, (_, i) => `chat ${i}`));
      const b = await t.frame(ext);
      expect(b.chatRenders).toBe(0);
      expect(b.lines).toEqual(a.lines);
      t.setChat([...t.getChat(), "one more line"]);
      const c = await t.frame(ext);
      expect(c.chatRenders).toBe(0);
      expect(c.lines).toEqual(b.lines);
      expect(c.styled).toBe(b.styled);
    } finally {
      t.stopStartupResources();
    }
  });

  test("refits to a resized pane without measuring again", async () => {
    const t = await setup(200, 4);
    try {
      const ext = t.show();
      const tall = await t.frame(ext);
      expect(tall.chatRenders).toBe(1);
      expect(tall.lines.join("\n")).not.toContain("hidden");
      t.ui.terminal.rows = 6;
      const short = await t.frame(ext);
      expect(short.chatRenders).toBe(0);
      expect(short.lines.length).toBeLessThan(tall.lines.length);
      expect(short.lines.join("\n")).toContain("hidden");
      t.ui.terminal.rows = 200;
      const back = await t.frame(ext);
      expect(back.chatRenders).toBe(0);
      expect(back.lines).toEqual(tall.lines);
    } finally {
      t.stopStartupResources();
    }
  });

  test("measures again when the splash is shown again", async () => {
    const t = await setup(12, 4);
    try {
      expect((await t.frame(t.show())).chatRenders).toBe(1);
      const ext2 = t.show();
      expect((await t.frame(ext2)).chatRenders).toBe(1);
      expect((await t.frame(ext2)).chatRenders).toBe(0);
    } finally {
      t.stopStartupResources();
    }
  });
});

describe("waterfall-ordered models", () => {
	test("routers are a line above providers, which follow the waterfall with skipped rungs dimmed and labeled", async () => {
		const { buildModelsSection } = await import("../src/feature/shell/startup-resources.ts");
		const now = 1_000_000;
		const section = buildModelsSection([
			{ provider: "waterfall", id: "auto", virtual: true },
			{ provider: "lmstudio", id: "qwen3.8-27b" },
			{ provider: "muse-code", id: "muse-wonder-1.0" },
			{ provider: "google", id: "antigravity-gemini-4-argon" },
			{ provider: "openai", id: "gpt-6.1-sol" },
			{ provider: "anthropic", id: "claude-opus-5-5" },
		], [{ provider: "waterfall", id: "auto" }], { provider: "waterfall", id: "auto" }, { now, rungs: [
			{ provider: "anthropic", model: "claude-opus-5-5", state: "exhausted", resetAt: now + 3 * 3_600_000 },
			{ provider: "openai", model: "gpt-6.1-sol", state: "disabled" },
			{ provider: "google", model: "antigravity-gemini-4-argon", state: "available" },
			{ provider: "muse-sdk", model: "muse-wonder-1.0", state: "unknown" },
		] })!;
		expect(section.groups.map((group) => group.label)).toEqual([
			"auto", "1 anthropic · resets 3h", "2 openai · off", "3 google", "4 muse-code · unverified", "lmstudio",
		]);
		expect(section.groups[0]).toMatchObject({ uncounted: true, items: ["waterfall"], actions: [{ kind: "model", provider: "waterfall", id: "auto" }],
			right: ["anthropic → openai → google → muse"] });
		expect(section.groups[0]!.marks![0]).toBeTruthy();
		expect(section.groups[1]!.tones).toEqual(["dim"]);
		expect(section.groups[3]!.tones).toBeUndefined();
		expect(section.count).toBe(6);
		// Without a waterfall, providers stay alphabetical and the router is still not a provider group.
		const plain = buildModelsSection([{ provider: "waterfall", id: "auto", virtual: true }, { provider: "openai", id: "gpt-6.1-sol" }, { provider: "anthropic", id: "claude-opus-5-5" }])!;
		expect(plain.groups.map((group) => group.label)).toEqual(["auto", "anthropic", "openai"]);
	});
});

describe("/splash", () => {
	test("freezes the live session once and renders every section, the map and models without polling", async () => {
		const { freezeSplash, renderFrozenSplash } = await import("../src/feature/shell/splash-command.ts");
		const mode = {
			ui: { terminal: { rows: 60 } },
			session: {
				scopedModels: [], model: { provider: "p", id: "alpha" },
				modelRuntime: { getAvailableSnapshot: () => [{ provider: "p", id: "alpha", contextWindow: 131_072 }] },
			},
		};
		const frozen = freezeSplash(mode)!;
		expect(frozen.sections.Models).toBeTruthy();
		const lines = renderFrozenSplash(frozen, 80, plainTheme);
		expect(lines[0]).toBe("");
		expect(lines.at(-1)).toBe("");
		expect(lines.join("\n")).toContain(" Models 1");
		expect(freezeSplash({})).toBeUndefined();
	});
});
