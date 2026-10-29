import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let agentDir: string;

async function loadConfigModule() {
  vi.resetModules();
  return import("../src/config/config.ts");
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-cc-render-config-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  rmSync(agentDir, { recursive: true, force: true });
});

describe("config file", () => {
  test("lives at <agent dir>/pi-cc-render.json and honors PI_CODING_AGENT_DIR", async () => {
    const { CONFIG_PATH } = await loadConfigModule();
    expect(CONFIG_PATH).toBe(join(agentDir, "pi-cc-render.json"));
  });

  test("falls back to defaults when the file is missing or invalid", async () => {
    const missing = await loadConfigModule();
    expect(missing.config).toEqual(missing.DEFAULT_CONFIG);
    writeFileSync(join(agentDir, "pi-cc-render.json"), "{ not json");
    const invalid = await loadConfigModule();
    expect(invalid.config).toEqual(invalid.DEFAULT_CONFIG);
  });

  test("reads its own file and ignores the old pi-cc-extensions.json", async () => {
    writeFileSync(join(agentDir, "pi-cc-extensions.json"), JSON.stringify({ mode: "compact" }));
    writeFileSync(join(agentDir, "claude-code-style.json"), JSON.stringify({ mode: "off" }));
    const ignored = await loadConfigModule();
    expect(ignored.config.mode).toBe("on");
    expect(existsSync(join(agentDir, "pi-cc-render.json"))).toBe(false);
    expect(existsSync(join(agentDir, "pi-cc-extensions.json"))).toBe(true);

    writeFileSync(join(agentDir, "pi-cc-render.json"), JSON.stringify({ mode: "compact", previewLines: 5 }));
    const own = await loadConfigModule();
    expect(own.config.mode).toBe("compact");
    expect(own.config.previewLines).toBe(5);
  });

  test("updateConfig normalizes, persists and creates the directory", async () => {
    const nested = join(agentDir, "nested", "agent");
    process.env.PI_CODING_AGENT_DIR = nested;
    const { updateConfig, config, CONFIG_PATH } = await loadConfigModule();
    updateConfig({ diffSplitMinWidth: 9999, excludeRenderers: ["bash", "bash", ""] });
    expect(config.diffSplitMinWidth).toBe(300);
    expect(config.excludeRenderers).toEqual(["bash"]);
    const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    expect(saved.diffSplitMinWidth).toBe(300);
    expect(saved.mode).toBe("on");
  });
});

describe("normalizeConfig", () => {
  test("keeps the remaining keys with upstream defaults", async () => {
    const { DEFAULT_CONFIG } = await loadConfigModule();
    expect(DEFAULT_CONFIG).toEqual({
      mode: "on",
      excludeRenderers: [],
      diffViewMode: "auto",
      diffIndicatorMode: "bars",
      diffSplitMinWidth: 120,
      editDiffCollapsedLines: 24,
      writeDiffCollapsedLines: 0,
      diffWordWrap: true,
      expandedPreviewMaxLines: 40,
      expandedCardBackground: "userMessageBg",
      expandedInputMaxLines: 5,
      expandedOutputMaxLines: 10,
      inputClip: 0,
      useSummaryTitlesAsThinkingTitle: true,
      previewLines: 3,
      animationIntervalMs: 90,
      dimThinkingText: false,
      showStartupHeader: true,
      scrollStepLines: 3,
      enableAgentSummary: true,
      restoreInterruptedPrompt: true,
      highlightBashOutput: true,
      readableBash: true,
      expandedBashInputMaxLines: 20,
    });
  });

  test("drops keys that belong to components ported elsewhere", async () => {
    const { normalizeConfig } = await loadConfigModule();
    const result = normalizeConfig({
      enableSessionReference: false,
      enableSubagentAutocomplete: false,
      enableContextCommand: false,
      enableWorkingMessage: false,
      enableAliases: false,
      enableCustomFooter: false,
      footerNerdIcons: false,
      footerHiddenKeys: ["git"],
      footerLine1Keys: ["model"],
      enableAgentSummary: false,
    }) as Record<string, unknown>;
    for (const key of Object.keys(result)) expect(key).not.toMatch(/^footer|Reference|Autocomplete|ContextCommand|WorkingMessage|Aliases|CustomFooter/);
    expect(result.enableAgentSummary).toBe(false);
  });

  test("clamps and validates values", async () => {
    const { normalizeConfig, DEFAULT_CONFIG } = await loadConfigModule();
    const result = normalizeConfig({
      mode: "bogus",
      diffViewMode: "split",
      diffIndicatorMode: "nope",
      editDiffCollapsedLines: "0",
      writeDiffCollapsedLines: -4,
      expandedCardBackground: "notASlot",
      inputClip: 3,
      previewLines: 0,
      animationIntervalMs: "abc",
      scrollStepLines: 500,
      excludeRenderers: "bash",
    });
    expect(result.mode).toBe(DEFAULT_CONFIG.mode);
    expect(result.diffViewMode).toBe("split");
    expect(result.diffIndicatorMode).toBe("bars");
    expect(result.editDiffCollapsedLines).toBe(1);
    expect(result.writeDiffCollapsedLines).toBe(0);
    expect(result.expandedCardBackground).toBe("userMessageBg");
    expect(result.inputClip).toBe(8);
    expect(result.previewLines).toBe(0);
    expect(result.animationIntervalMs).toBe(90);
    expect(result.scrollStepLines).toBe(50);
    expect(result.excludeRenderers).toEqual([]);
  });

  test("formatConfigStatus only reports surviving keys", async () => {
    const { formatConfigStatus, DEFAULT_CONFIG } = await loadConfigModule();
    const status = formatConfigStatus(DEFAULT_CONFIG);
    expect(status).toContain("mode=on");
    expect(status).toContain("agentSummary=on");
    expect(status).toContain("restorePrompt=on");
    expect(status).not.toMatch(/footer|sessionRef|context=|aliases|workingMsg/);
  });
});
