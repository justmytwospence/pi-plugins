import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { config } from "../src/config/config.ts";
import { installStartupResources, isStartupSplashSettled, stopStartupResources, type StartupTheme } from "../src/feature/shell/startup-resources.ts";
import { createStartupSkeleton, installStartupSkeleton } from "../src/feature/shell/startup-skeleton.ts";
import { WATERFALL_CHANNEL } from "../src/waterfall-contract.ts";

const theme: StartupTheme = { fg: (_name, text) => text, bold: (text) => text };
const git = (name: string) => ({
  path: `/h/.pi/agent/git/github.com/me/repo/packages/pi-${name}/src`,
  sourceInfo: { source: "git:github.com/me/repo", scope: "user", baseDir: "/h/.pi/agent/git/github.com/me/repo" },
});

function makeMode(opts: { extensions?: number; skills?: number; rows?: number; details?: boolean; chat?: any[]; models?: any[] } = {}) {
  const ui = { requestRender: vi.fn(), terminal: { rows: opts.rows ?? 100 } };
  const chatContainer = { children: opts.chat ?? [], render: () => [] as string[], invalidate() {} };
  const mode: any = Object.create((InteractiveMode as any).prototype, Object.fromEntries(Object.entries({
    sessionManager: { getCwd: () => "/work", getSessionId: () => "skeleton-test" },
    session: {
      promptTemplates: [],
      resourceLoader: {
        getSystemPromptSource: () => undefined, getAppendSystemPromptSources: () => [], agentDir: "/h/.pi/agent",
        getAgentsFiles: () => ({ agentsFiles: [] }),
        getSkills: () => ({ skills: Array.from({ length: opts.skills ?? 0 }, (_, i) => ({ name: `skill${i}`, filePath: `/s/${i}`, sourceInfo: { source: "local", scope: "user" } })) }),
        getExtensions: () => ({ extensions: Array.from({ length: opts.extensions ?? 0 }, (_, i) => git(`ext${i}`)) }),
      },
      modelRuntime: { getAvailableSnapshot: () => opts.models ?? [] },
    },
    ui,
    chatContainer,
    loadedResourcesContainer: { children: [] as any[] },
    shouldShowStartupDetails: (): boolean => opts.details ?? true,
    getStartupExpansionState: (): boolean => false,
  }).map(([key, value]) => [key, { value, writable: true }])));
  return { mode, ui, chatContainer };
}

let enabled: boolean;
beforeEach(() => {
  enabled = config.showStartupHeader;
  config.showStartupHeader = true;
  vi.stubEnv("PI_CODING_AGENT_DIR", mkdtempSync(join(tmpdir(), "skeleton-")));
  vi.useFakeTimers();
});
afterEach(() => {
  config.showStartupHeader = enabled;
  stopStartupResources();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("startup skeleton", () => {
  test("renders nothing without a mode", () => {
    expect(createStartupSkeleton(undefined, theme).render(80)).toEqual([]);
  });

  test("shows known sections and placeholders for the map and Models", () => {
    const { mode } = makeMode({ extensions: 3, skills: 1 });
    const skeleton = createStartupSkeleton(mode, theme);
    const text = skeleton.render(80).join("\n");
    expect(text).toContain("Extensions");
    expect(text).toContain("Skills");
    expect(text).toContain("Starting context · loading…");
    expect(text).toContain("Models");
    expect(text).toContain("━");
    skeleton.dispose();
  });

  test("yields to the real listing and stops its timer", () => {
    const { mode } = makeMode({ extensions: 2 });
    const baseline = vi.getTimerCount();
    const prototype = (InteractiveMode as any).prototype;
    const savedShow = prototype.showLoadedResources;
    // Pi's own listing needs a real container; the wrapper under test only needs it to return.
    prototype.showLoadedResources = function () {};
    installStartupResources();
    const wrapper = prototype.showLoadedResources;
    const skeleton = createStartupSkeleton(mode, theme);
    expect(skeleton.render(80).length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(baseline + 1);
    const extensions = { state: { expanded: false }, setExpanded() {}, invalidate() {}, render: () => ["[Extensions]", "  x"] };
    mode.loadedResourcesContainer.children = [extensions];
    expect(isStartupSplashSettled(mode)).toBe(false);
    try {
      wrapper.call(mode, { force: true });
      expect(isStartupSplashSettled(mode)).toBe(true);
      expect(skeleton.render(80)).toEqual([]);
      stopStartupResources(); // the real listing's own MCP poll
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      prototype.showLoadedResources = savedShow;
    }
  });

  test("is hidden when startup details are hidden", () => {
    const { mode } = makeMode({ extensions: 2, details: false });
    expect(createStartupSkeleton(mode, theme).render(80)).toEqual([]);
  });

  test("shimmers on a timer only while the chat is empty", () => {
    const empty = makeMode({ extensions: 1 });
    const skeleton = createStartupSkeleton(empty.mode, theme);
    skeleton.render(80);
    vi.advanceTimersByTime(130);
    expect(empty.ui.requestRender).toHaveBeenCalled();
    skeleton.dispose();

    const busy = makeMode({ extensions: 1, chat: [{}] });
    const baseline = vi.getTimerCount();
    const still = createStartupSkeleton(busy.mode, theme);
    expect(still.render(80).length).toBeGreaterThan(0);
    expect(vi.getTimerCount()).toBe(baseline);
  });

  test("folds to the terminal height", () => {
    const { mode } = makeMode({ extensions: 40, rows: 12 });
    const skeleton = createStartupSkeleton(mode, theme);
    expect(skeleton.render(80).length).toBeLessThanOrEqual(12);
    skeleton.dispose();
  });

  test("lists real Models once the waterfall answers", () => {
    installStartupSkeleton({
      events: { emit: (channel: string, request: any) => { if (channel === WATERFALL_CHANNEL) request.snapshot = { skipped: [], observedAt: 0, order: [] }; } },
    } as any);
    const { mode } = makeMode({ extensions: 1, models: [{ provider: "anthropic", id: "claude-x" }] });
    const skeleton = createStartupSkeleton(mode, theme);
    const text = skeleton.render(80).join("\n");
    expect(text).toContain("Models");
    expect(text).not.toMatch(/Models\n\s*━/);
    skeleton.dispose();
    installStartupSkeleton({ events: { emit() {} } } as any);
  });
});
