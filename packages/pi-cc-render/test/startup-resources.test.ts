import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  collectSections,
  formatTokens,
  HEAVY_SKILL_TOKENS,
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

  test("groups locals by scope, multi-entry packages with counts and single packages together", () => {
    const entries: ResourceEntry[] = [
      { name: "worktree", scope: "user" },
      { name: "eval", scope: "user" },
      { name: "pi-b", source: "me/repo", scope: "user" },
      { name: "pi-a", source: "me/repo", scope: "user" },
      { name: "src", source: "@x/solo", scope: "user" },
      { name: "src", source: "other", scope: "user" },
    ];
    expect(groupEntries(entries, "source")).toEqual([
      { label: "user", items: ["eval", "worktree"] },
      { label: "me/repo", items: ["a", "b"] },
      { label: "packages", items: ["@x/solo", "other"] },
    ]);
  });

  test("a lone local group drops its sub-heading", () => {
    expect(groupEntries([{ name: "b", scope: "user" }, { name: "a", scope: "user" }], "name")).toEqual([
      { items: ["a", "b"] },
    ]);
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
        groups: [{ label: "me/repo", items: ["a", "b"] }, { label: "packages", items: ["solo"] }],
      },
      80,
      plainTheme,
    );
    expect(lines).toEqual(["Extensions 3", "  me/repo 2", "    a   b", "  packages 1", "    solo"]);
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
          getAgentsFiles: () => ({
            agentsFiles: [
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
    expect(sections.Context!.groups[0]!.items).toEqual(["BIG.md", "AGENTS.md"]);
    expect(sections.Context!.groups[0]!.tokens).toEqual([1000, 100]);
    expect(sections.Context!.tokens).toBe(1100);
    expect(sections.Skills!.groups).toEqual([{ items: ["herdr"], tokens: [expect.any(Number)] }]);
    expect(sections.Skills!.tokens).toBeGreaterThan(0);
    expect(sections.Extensions!.count).toBe(3);
    expect(sections.Extensions!.groups.map((group) => group.label)).toEqual(["user", expect.stringContaining("repo")]);
    expect(sections.Extensions!.groups[1]!.items).toEqual(["bg", "todo"]);
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
        groups: [{ items: ["~/big.md", "a.md"], tokens: [1400, 100] }],
      },
      80,
      plainTheme,
    );
    expect(lines).toEqual(["Context 2 · ~1.5k tok", "  ~/big.md  ~1.4k", "  a.md       ~100"]);
  });

  test("skills annotate only the heavy ones and keep alphabetical order", () => {
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
    expect(lines[1]).toBe(`  apple      bee ~${HEAVY_SKILL_TOKENS + 50}   cat`);
  });

  test("groupEntries keeps token estimates aligned with the sorted names", () => {
    const groups = groupEntries(
      [
        { name: "b", scope: "user", tokens: 2 },
        { name: "a", scope: "user", tokens: 1 },
      ],
      "name",
    );
    expect(groups).toEqual([{ items: ["a", "b"], tokens: [1, 2] }]);
  });
});
