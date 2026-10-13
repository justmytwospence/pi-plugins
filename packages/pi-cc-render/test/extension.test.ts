import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, InteractiveMode, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let temp: string;
const env = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
beforeAll(() => {
  temp = mkdtempSync(resolve(tmpdir(), "pi-cc-render-ext-"));
  process.env.HOME = temp;
  process.env.PI_CODING_AGENT_DIR = temp;
  process.env.XDG_CONFIG_HOME = resolve(temp, "xdg");
});
afterAll(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
});

function stubApi() {
  const handlers = new Map<string, number>();
  const commands = new Map<string, any>();
  const tools: string[] = [];
  const pi = {
    on: (event: string) => {
      handlers.set(event, (handlers.get(event) ?? 0) + 1);
      return () => undefined;
    },
    registerCommand: (name: string, options: any) => commands.set(name, options),
    registerTool: (definition: any) => tools.push(definition.name),
    registerShortcut: () => undefined,
    registerFlag: () => undefined,
    registerMessageRenderer: () => undefined,
    registerEntryRenderer: () => undefined,
    getAllTools: () => [],
    events: { on: () => () => undefined, emit: () => undefined },
  };
  return { pi, handlers, commands, tools };
}

describe("extension factory", () => {
  test("registers /ccstyle and the lifecycle handlers without touching tools at load", async () => {
    const extension = (await import("../src/index.ts")).default;
    const { pi, handlers, commands, tools } = stubApi();
    const markdownRender = Markdown.prototype.render;
    const markdownRenderToken = (Markdown.prototype as any).renderToken;
    extension(pi as any);
    expect([...commands.keys()]).toEqual(["ccstyle"]);
    expect(tools).toEqual([]);
    for (const event of ["session_start", "session_shutdown", "session_compact", "session_tree", "message_start", "message_update", "tool_execution_start", "tool_execution_end", "agent_start", "agent_end"]) {
      expect(handlers.get(event), event).toBeGreaterThan(0);
    }
    // The write override is deferred to session_start so sibling extensions can claim write first.
    expect(handlers.get("session_start")).toBeGreaterThanOrEqual(2);
    // Coexistence with pi-prose-width: pi-tui's Markdown is left alone.
    expect(Markdown.prototype.render).toBe(markdownRender);
    expect((Markdown.prototype as any).renderToken).toBe(markdownRenderToken);
  });

  test("the early startup header patch wraps InteractiveMode.init once and survives a second load", async () => {
    const { installEarlyStartupHeader } = await import("../src/feature/shell/startup-header.ts");
    const { EARLY_STARTUP_HEADER_PATCH, patchRegistry } = await import("../src/utils/patch-keys.ts");
    installEarlyStartupHeader();
    const first = patchRegistry.get<{ active: boolean; installed: unknown; original: unknown }>(EARLY_STARTUP_HEADER_PATCH)!;
    expect((InteractiveMode as any).prototype.init).toBe(first.installed);
    installEarlyStartupHeader();
    const second = patchRegistry.get<{ active: boolean; installed: unknown; original: unknown }>(EARLY_STARTUP_HEADER_PATCH)!;
    expect(first.active).toBe(false);
    expect(second.active).toBe(true);
    expect(second.original).toBe(first.original);
    expect((InteractiveMode as any).prototype.init).toBe(second.installed);
  });

  test("/ccstyle status reports the configuration and other arguments require the TUI", async () => {
    const extension = (await import("../src/index.ts")).default;
    const { pi, commands } = stubApi();
    extension(pi as any);
    const command = commands.get("ccstyle");
    expect(command.getArgumentCompletions("").map((item: any) => item.value)).toEqual(["on", "compact", "off", "status", "panel"]);
    const notices: Array<[string, string]> = [];
    const ctx = { mode: "rpc", hasUI: false, ui: { notify: (message: string, level: string) => notices.push([message, level]) } };
    await command.handler("status", ctx);
    expect(notices[0]![0]).toContain("mode=on");
    await command.handler("panel", ctx);
    expect(notices[1]![0]).toContain("requires TUI");
    await command.handler("wat", ctx);
    expect(notices[2]![1]).toBe("warning");
  });
});

describe("Pi 1.1.0 resource loader", () => {
  test("loads the standalone package from an isolated copy", async () => {
    const isolated = resolve(temp, "isolated", "pi-cc-render");
    cpSync(root, isolated, {
      recursive: true,
      filter: (path) => !path.split("/").some((part) => ["node_modules", ".git"].includes(part)),
    });
    symlinkSync(resolve(root, "node_modules"), resolve(isolated, "node_modules"), "dir");
    const loader = new DefaultResourceLoader({
      cwd: temp,
      agentDir: temp,
      settingsManager: SettingsManager.inMemory({ packages: [isolated] }),
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    expect(result.extensions.map((entry) => entry.path)).toEqual([resolve(isolated, "src/index.ts")]);
    const extension = result.extensions[0]!;
    expect([...extension.commands.keys()]).toEqual(["ccstyle"]);
    expect(extension.tools.size).toBe(0);
    expect(extension.shortcuts.size).toBe(0);
    expect([...extension.handlers.keys()].sort()).toEqual([
      "agent_end", "agent_start", "message_start", "message_update", "session_compact", "session_shutdown",
      "session_start", "session_tree", "tool_execution_end", "tool_execution_start",
    ]);
    const themes = loader.getThemes().themes.map((theme) => theme.name).sort();
    expect(themes).toEqual(expect.arrayContaining(["cc-dark", "cc-light"]));
  });

  test("manifest declares the entry, both themes and pins host packages as peers", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(manifest.name).toBe("@justmytwospence/pi-cc-render");
    expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
    expect(manifest.pi.themes).toEqual(["./themes/cc-dark.json", "./themes/cc-light.json"]);
    for (const host of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@earendil-works/pi-ai"]) {
      expect(manifest.peerDependencies[host]).toBe("*");
      expect(manifest.devDependencies[host]).toBe("1.1.0");
      expect(manifest.dependencies?.[host]).toBeUndefined();
    }
    expect(manifest.dependencies).toBeUndefined();
    const license = readFileSync(resolve(root, "LICENSE"), "utf8");
    expect(license).toContain("Copyright (c) 2026 minuque");
    expect(license).toContain("tifandotme");
    expect(license).toContain("MasuRii");
  });
});
