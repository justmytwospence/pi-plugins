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
      "■ MCP 3 · 1 needs sign-in, 1 failed, /mcp to fix",
      "  project 1              user 2",
      "  ■ ● local  connected   ■ ✕ obsidian         failed",
      "                         ■ ● vercel    needs sign-in",
      "  obsidian: http request failed",
    ]);
    expect(buildMcpSection([], () => undefined)).toBeUndefined();
    expect(renderSection(buildMcpSection([{ name: "a", level: "user" }], () => "connected")!, 80, plainTheme)).toEqual([
      "■ MCP 1",
      "  user 1",
      "  ■ ● a  connected",
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
    expect(group.prefixes![byName("connected")]).toEqual(GLYPHS.live);
    expect(group.prefixes![byName("connecting")]).toEqual(GLYPHS.pending);
    expect(group.prefixes![byName("needs-auth")]).toEqual(GLYPHS.attention);
    expect(group.prefixes![byName("failed")]).toEqual(GLYPHS.failed);
    for (const name of ["disabled", "disconnected", "unknown"]) expect(group.prefixes![byName(name)]).toEqual(GLYPHS.idle);
    expect(group.tones![byName("disabled")]).toBe("dim");
    expect(group.right![byName("disabled")]).toEqual({ text: "disabled", color: "dim" });
    expect(group.right![byName("connected")]).toEqual({ text: "connected · 0 tools", color: "dim" });
    expect(group.right![byName("needs-auth")]).toEqual({ text: "needs sign-in", color: "warning" });
    expect(group.right![byName("failed")]).toEqual({ text: "failed", color: "error" });
    expect(renderSection(section, 80, plainTheme).join("\n")).toContain("disconnected");
    expect(renderSection(section, 80, plainTheme).join("\n")).toContain("unknown");
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
    expect(text).toMatch(/● live\s+connected · 7 tools/);
    expect(text).toMatch(/○ off\s+disabled/);
    expect(text).toMatch(/● resource-only\s+connected · 0 tools/);
    expect(text).toMatch(/○ no-tools\s+unknown/);
    expect(text).toMatch(/○ stale-tools\s+unknown/);
  });

  test("MCP columns split long scopes and preserve right-hand states at narrow widths", async () => {
    const { buildMcpSection } = await import("../src/feature/shell/startup-resources.ts");
    const entries = Array.from({ length: 10 }, (_, i) => ({ name: `server-${i}`, level: "user" as const }));
    const section = buildMcpSection(entries, () => "connected", undefined, () => 1)!;
    const wide = renderSection(section, 100, plainTheme);
    expect(wide.length).toBeLessThan(entries.length + 2);
    expect(wide[2]).toMatch(/server-0.*server-5/);
    const narrow = renderSection(section, 40, plainTheme);
    expect(narrow).toHaveLength(entries.length + 2);
    expect(narrow.slice(2).every((line) => line.endsWith("connected · 1 tool"))).toBe(true);
    const long = buildMcpSection([{ name: "a-very-long-server-name-界界", level: "project" }], () => "needs-auth")!;
    expect(renderSection(long, 28, plainTheme)[2]!.replace(/\x1b\[[0-9;]*m/g, "")).toMatch(/…\s+needs sign-in$/);
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
      expect(shown).toMatch(/live\s+connected · 2 tools/);
      expect(shown).toMatch(/off\s+disabled/);
      expect(shown).not.toContain("project 1");
      await vi.advanceTimersByTimeAsync(65_000);
      status = "live: disconnected, reconnects on next call (codemode)";
      await vi.advanceTimersByTimeAsync(1000);
      expect(shown).toMatch(/○ live\s+disconnected/);
      status = "live: connected, 3 tools (codemode)\noff: connected, 0 tools (codemode)";
      trusted = true;
      await vi.advanceTimersByTimeAsync(1000);
      expect(shown).toMatch(/live\s+connected · 3 tools/);
      expect(shown).toMatch(/off\s+connected · 0 tools/);
      expect(shown).toContain("project 1");
      writeFileSync(join(dir, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { off: { enabled: false } } }));
      status = "live: connected, 3 tools (codemode)\noff: disabled (codemode)";
      await vi.advanceTimersByTimeAsync(1000);
      expect(shown).toMatch(/○ off\s+disabled/);
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
    expect(section.groups[1]!.actions![0]).toEqual({ kind: "model", provider: "openai", id: "gpt-6.1-sol", thinkingLevel: "high" });
    expect(renderSection(section, 80, plainTheme)).toEqual([
      "Models 3",
      "  anthropic 2               openai 1",
      "  ★ claude-opus-5-5 ●  1M   ★ gpt-6.1-sol:high  922K",
      "    claude-haiku-5-5   1M",
    ]);
    // Too narrow for both: providers wrap onto their own bands.
    expect(renderSection(section, 40, plainTheme)).toEqual([
      "Models 3",
      "  anthropic 2",
      "  ★ claude-opus-5-5 ●  1M",
      "    claude-haiku-5-5   1M",
      "  openai 1",
      "  ★ gpt-6.1-sol:high  922K",
    ]);
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
      { provider: "google", id: "antigravity-gemini-4-argon" },
      { provider: "google", id: "antigravity-gemma-3" },
    ], { provider: "google", id: "antigravity-claude-opus-5-5" })!;
    expect(google.groups.map((group) => group.label)).toEqual(["anthropic", "google"]);
    expect(google.groups[1]!.items).toEqual(expect.arrayContaining(["antigravity-gemini-4-argon", "antigravity-gemma-3", "gemini-3.5-pro"]));
    expect(google.groups[1]!.items.every((item) => !item.includes("claude") && !item.includes("gpt"))).toBe(true);
    expect(google.groups[1]!.actions!.every((action) => action?.kind === "model" && action.provider === "google")).toBe(true);
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
    expect(renderSection(collectModelsSection(mode)!, 80, plainTheme)).toEqual(["Models 2", "  p 2", "  alpha ●  128K", "  beta     128K"]);
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

  test("a long column uses quotient/remainder splits under its heading", async () => {
    const items = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const lines = renderSection({ title: "C", count: items.length, layout: "columns", groups: [{ label: "p", items }] }, 80, plainTheme);
    expect(lines).toHaveLength(6);
    expect(lines[2]).toBe("  m0   m4   m7");
    expect(lines[4]).toBe("  m2   m6   m9");
    expect(lines[5]).toBe("  m3");
  });

  test("balanced one-scope MCP columns use available width without stealing metadata", async () => {
    const { buildMcpSection } = await import("../src/feature/shell/startup-resources.ts");
    for (const count of [4, 8, 10, 17]) {
      const section = buildMcpSection(Array.from({ length: count }, (_, n) => ({ name: `s${n}`, level: "user" as const })), () => "connected", undefined, () => 1)!;
      const wide = renderSection(section, 180, plainTheme);
      const columns = Math.max(1, Math.floor(count / 3));
      expect(wide).toHaveLength(2 + Math.ceil(count / columns));
      const firstData = wide[2]!;
      expect(firstData.split("connected · 1 tool").length - 1).toBe(columns);
      expect(wide[2]).toContain("connected · 1 tool");
      if (count === 10) expect(wide.slice(2).map((line) => (line.match(/connected · 1 tool/g) ?? []).length)).toEqual([3, 3, 3, 1]);
      if (count === 17) expect(wide.slice(2).map((line) => (line.match(/connected · 1 tool/g) ?? []).length)).toEqual([5, 5, 5, 2]);
      expect(wide.every((line) => visibleWidth(line) <= 180)).toBe(true);
      for (const width of [46, 120, 180]) {
        const lines = renderSection(section, width, plainTheme);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
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
    for (const theme of [plainTheme, ansi]) for (const width of [12, 28, 46, 120, 180]) {
      const { lines, hits } = layoutSection(section, width, theme);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      expect(hits.map((hit) => hit.action)).toEqual(expect.arrayContaining([
        { kind: "mcp", name: "界界-very-very-long" },
        { kind: "mcp", name: "small" },
        { kind: "mcp", name: "offline" },
      ]));
      for (const hit of hits) {
        expect(hit.startCol).toBeGreaterThanOrEqual(2);
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
    const widths = [...Array.from({ length: 200 }, (_, n) => n + 1), 240];
    for (const width of widths) for (const section of [models, mcp, stacked]) {
      const layout = layoutSection(section, width, plainTheme);
      const { lines, hits } = layout;
      expect(layoutSection(section, width, plainTheme), `${section.title} deterministic at ${width}`).toEqual(layout);
      expect(lines.every((line) => visibleWidth(line) <= width), `${section.title} at ${width}`).toBe(true);
      const actions = new Map<string, typeof hits>();
      for (const hit of hits) {
        expect(hit.row, `${section.title} at ${width}`).toBeGreaterThan(0);
        expect(hit.row).toBeLessThan(lines.length);
        expect(hit.startCol).toBeGreaterThanOrEqual(0);
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
      "Context 2 · ~1.5k tok",
      "  project 2    user 1",
      "  a.md  ~100   ~/big.md  ~1.4k",
      "  b.md   ~20",
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
