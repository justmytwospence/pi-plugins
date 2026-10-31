import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
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
  type ResourceEntry,
  type StartupTheme,
} from "../src/feature/shell/startup-resources.ts";

const plainTheme: StartupTheme = { fg: (_name, text) => text, bold: (text) => text };

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
    ).toEqual(["Extensions 3", "  project 1", "    x", "  user 2", "    me/repo 2", "      a   b"]);
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
    expect(lines).toEqual(["Extensions 3", "  user 3", "    me/repo 2", "      a   b", "    packages 1", "      solo"]);
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
          getSkills: () => ({ skills: [{ name: "herdr", sourceInfo: { source: "local", scope: "user" } }] }),
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
    const sections = collectSections(mode);
    expect(sections.Context!.groups.map((group) => group.label)).toEqual(["project", "user"]);
    expect(sections.Context!.groups[0]!.items).toEqual(["BIG.md", "AGENTS.md"]);
    expect(sections.Context!.groups[0]!.tokens).toEqual([1000, 100]);
    expect(sections.Context!.groups[1]!.tokens).toEqual([200]);
    expect(sections.Context!.tokens).toBe(1300);
    expect(sections.Skills!.groups).toEqual([{ label: "user", items: ["herdr"], tokens: [expect.any(Number)] }]);
    expect(sections.Skills!.tokens).toBeGreaterThan(0);
    expect(sections.Extensions!.count).toBe(3);
    expect(sections.Extensions!.groups.map((group) => group.label)).toEqual(["user"]);
    expect(sections.Extensions!.groups[0]!.items).toEqual(["worktree"]);
    expect(sections.Extensions!.groups[0]!.children!.map((group) => group.label)).toEqual([expect.stringContaining("repo")]);
    expect(sections.Extensions!.groups[0]!.children![0]!.items).toEqual(["bg", "todo"]);
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
          dash_name: { enabled: false },
        },
      }),
    );
    expect(loadMcpEntries({ userFile, projectFile, registered: ["a", "ext"] })).toEqual([
      { name: "a", level: "user" },
      { name: "gated", level: "project" },
      { name: "tuned", level: "user" },
      { name: "local", level: "project" },
      { name: "ext", level: "extension" },
    ]);
    expect(loadMcpEntries({ userFile })).toHaveLength(3);
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

  test("server state: problems win, tools appearing later clear them, connecting fades after the grace period", async () => {
    const { McpState, CONNECTING_GRACE_MS, parseAttentionMessage } = await import("../src/feature/shell/mcp-servers.ts");
    const state = new McpState();
    state.mount(1000);
    expect(state.status("a", new Set(), 1000)).toBe("connecting");
    expect(state.status("a", new Set(["a"]), 1000)).toBe("connected");
    expect(state.status("a", new Set(), 1000 + CONNECTING_GRACE_MS)).toBeUndefined();
    state.record(parseAttentionMessage("MCP servers need attention:\n  a: needs sign-in\n  b: failed: boom\nRun /mcp to fix.")!, new Set(["b"]));
    expect(state.status("a", new Set(), 1000)).toBe("needs-auth");
    expect(state.status("c", new Set(), 1000)).toBeUndefined();
    expect(state.status("a", new Set(["a"]), 1000)).toBe("connected");
    expect(state.status("b", new Set(["b"]), 1000)).toBe("failed");
    expect(state.detail("b")).toBe("boom");
    state.outcome("b", "connected", new Set(["b"]));
    expect(state.status("b", new Set(["b"]), 1000)).toBe("connected");
  });

  test("the MCP section groups by level and marks servers that need attention", async () => {
    const { buildMcpSection } = await import("../src/feature/shell/startup-resources.ts");
    const section = buildMcpSection(
      [
        { name: "vercel", level: "user" },
        { name: "obsidian", level: "user" },
        { name: "local", level: "project" },
      ],
      (name) => (name === "vercel" ? "needs-auth" : name === "obsidian" ? "failed" : "connected"),
      (name) => (name === "obsidian" ? "http request failed" : undefined),
    )!;
    expect(renderSection(section, 100, plainTheme)).toEqual([
      "MCP 3 · 1 needs sign-in, 1 failed, /mcp to fix",
      "  project 1",
      "    local",
      "  user 2",
      "    obsidian failed        vercel needs sign-in",
      "  obsidian: http request failed",
    ]);
    expect(buildMcpSection([], () => undefined)).toBeUndefined();
    expect(renderSection(buildMcpSection([{ name: "a", level: "user" }], () => "connected")!, 80, plainTheme)).toEqual([
      "MCP 1",
      "  user 1",
      "    a",
    ]);
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
    expect(mcpState.status("obsidian", new Set())).toBe("failed");
    mode.showExtensionNotify("MCP servers need attention:\n  config: /x: bad\n  obsidian: failed\nRun /mcp to fix.", "warning");
    expect(shown[2]).toBe("MCP configuration needs attention:\n  config: /x: bad\nRun /mcp to fix.");
  });

  test("the models section groups by provider and marks the current model", async () => {
    const { buildModelsSection, collectModelsSection } = await import("../src/feature/shell/startup-resources.ts");
    const section = buildModelsSection(
      [
        { provider: "anthropic", id: "opus", thinkingLevel: "high" },
        { provider: "anthropic", id: "sonnet" },
        { provider: "openai", id: "gpt" },
      ],
      { provider: "anthropic", id: "sonnet" },
      true,
    )!;
    expect(renderSection(section, 100, plainTheme)).toEqual([
      "Models 3",
      "  anthropic 2",
      "    opus:high        sonnet current",
      "  openai 1",
      "    gpt",
    ]);
    expect(buildModelsSection([])).toBeUndefined();
    const mode = {
      session: {
        scopedModels: [],
        model: { provider: "p", id: "b" },
        modelRuntime: { getAvailableSnapshot: () => [{ provider: "p", id: "a" }, { provider: "p", id: "b" }] },
      },
    };
    expect(renderSection(collectModelsSection(mode)!, 80, plainTheme)).toEqual([
      "Models (all available) 2",
      "  p 2",
      "    a           b current",
    ]);
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
        layout: "lines",
        groups: [
          { label: "project", items: ["a.md"], tokens: [100] },
          { label: "user", items: ["~/big.md"], tokens: [1400] },
        ],
      },
      80,
      plainTheme,
    );
    expect(lines).toEqual([
      "Context 2 · ~1.5k tok",
      "  project 1",
      "    a.md       ~100",
      "  user 1",
      "    ~/big.md  ~1.4k",
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
    expect(lines[0]).toBe("Skills 3 · ~400 tok");
    expect(lines[1]).toBe(`  apple ~20   bee ~${HEAVY_SKILL_TOKENS + 50}    cat ~30`);
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

  test("heading total is colored by share of the context window", () => {
    expect(windowShareColor(1000, undefined)).toBe("dim");
    expect(windowShareColor(2000, 200_000)).toBe("dim");
    expect(windowShareColor(6000, 200_000)).toBe("warning");
    expect(windowShareColor(12000, 200_000)).toBe("error");
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
