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
    for (const event of ["session_start", "session_shutdown", "session_compact", "session_tree", "message_start", "message_update", "tool_execution_start", "tool_execution_end", "agent_start", "agent_end", "input", "before_agent_start", "agent_settled"]) {
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

  test("early paint uses a loading context map, while disabling the setting leaves the native header", async () => {
    const { config } = await import("../src/config/config.ts");
    const { installEarlyStartupHeader } = await import("../src/feature/shell/startup-header.ts");
    const { disposeStartupHost } = await import("../src/feature/shell/startup-state.ts");
    const { EARLY_STARTUP_HEADER_PATCH, patchRegistry } = await import("../src/utils/patch-keys.ts");
    const prototype = (InteractiveMode as any).prototype;
    const savedInit = prototype.init;
    const savedPatch = patchRegistry.get(EARLY_STARTUP_HEADER_PATCH);
    const enabled = config.showStartupHeader;
    const makeMode = (id: string) => {
      const children: any[] = [];
      const headers: Array<any> = [];
      const mode: any = {
        sessionManager: { getSessionId: () => id },
        builtInHeader: { render: () => ["native"] },
        headerContainer: { children, addChild(child: any) { children.push(child); } },
        setExtensionHeader(factory: any) { headers.push(factory({}, { fg: (_c: string, text: string) => text })); },
        ui: { requestRender() {} },
      };
      return { mode, children, headers };
    };
    try {
      prototype.init = async function (this: any) { this.headerContainer.addChild(this.builtInHeader); };
      patchRegistry.delete(EARLY_STARTUP_HEADER_PATCH);
      installEarlyStartupHeader();
      const first = makeMode("early-1");
      await prototype.init.call(first.mode);
      expect(first.headers).toHaveLength(1);
      expect(first.headers[0].render(46)[0]).toContain("Starting context · loading");
      installEarlyStartupHeader();
      const second = makeMode("early-2");
      await prototype.init.call(second.mode);
      expect(second.headers).toHaveLength(1);
      expect(second.headers[0].render(46)[0]).toContain("Starting context · loading");
      config.showStartupHeader = false;
      const native = makeMode("early-native");
      await prototype.init.call(native.mode);
      expect(native.children).toEqual([native.mode.builtInHeader]);
      expect(native.headers).toHaveLength(0);
      disposeStartupHost(first.mode);
      disposeStartupHost(second.mode);
    } finally {
      config.showStartupHeader = enabled;
      prototype.init = savedInit;
      if (savedPatch) patchRegistry.install(EARLY_STARTUP_HEADER_PATCH, savedPatch);
      else patchRegistry.delete(EARLY_STARTUP_HEADER_PATCH);
    }
  });

  test("session_start reuses its header state and refresh hooks follow session replacement and shutdown", async () => {
    const { default: startupHeader, applyStartupHeader } = await import("../src/feature/shell/startup-header.ts");
    const { attachStartupHost, getStartupHost, disposeStartupHost } = await import("../src/feature/shell/startup-state.ts");
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    startupHeader({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
    const id = { value: "header-session-1" };
    let renders = 0;
    const mode = { sessionManager: { getSessionId: () => id.value }, ui: { requestRender: () => renders++ } };
    const state = attachStartupHost(mode);
    const snapshot = { stage: "starting" as const, modelLabel: "test/model", usedEstimate: 0, sources: [], attribution: { files: true, skills: true }, caveats: [] };
    state.contextSnapshot = snapshot;
    let factory: any;
    const ctx = { hasUI: true, sessionManager: mode.sessionManager, ui: {
      theme: { fg: (_color: string, text: string) => text },
      setHeader: (value: any) => { factory = value; }, requestRender: () => renders++,
    } };
    try {
      // A session_start keeps the same owner and installs the current snapshot's factory.
      handlers.get("session_start")!({}, ctx);
      expect(getStartupHost(id.value)).toBe(state);
      expect(factory({}, ctx.ui.theme).render(120)[0]).toContain("Starting context");
      state.contextSnapshot = snapshot;
      let refreshed = 0;
      state.refresh = () => { refreshed++; state.repaint?.(); };
      for (const name of ["model_select", "session_tree", "session_compact", "agent_end", "agent_settled"]) {
        handlers.get(name)!({}, ctx);
      }
      expect(refreshed).toBe(5);
      expect(renders).toBeGreaterThanOrEqual(5);
      id.value = "header-session-2";
      expect(attachStartupHost(mode)).toBe(state);
      expect(getStartupHost("header-session-1")).toBeUndefined();
      expect(getStartupHost(id.value)).toBe(state);
      handlers.get("session_shutdown")!({}, ctx);
      expect(getStartupHost(id.value)).toBeUndefined();
      expect(factory).toBeUndefined();
      // Explicit reinstall after disposal creates a fresh owner (not a leaked old callback).
      applyStartupHeader(ctx);
      expect(getStartupHost(id.value)).toBeUndefined();
    } finally {
      disposeStartupHost(mode);
    }
  });

  test("session_start recovers an early header before Pi assigns its first session ID", async () => {
    const { applyStartupHeader } = await import("../src/feature/shell/startup-header.ts");
    const { attachStartupHost, disposeStartupHost, getStartupHost } = await import("../src/feature/shell/startup-state.ts");
    let id: string | undefined;
    const manager = { getSessionId: () => id };
    const mode = { sessionManager: manager };
    const state = attachStartupHost(mode);
    expect(state.sessionId).toBe("");
    id = "assigned-later";
    let factory: any;
    try {
      applyStartupHeader({ hasUI: true, sessionManager: manager, ui: {
        setHeader: (value: any) => { factory = value; }, requestRender() {},
      } });
      expect(getStartupHost(id)).toBe(state);
      expect(factory).toBeTypeOf("function");
      expect(factory({}, { fg: (_color: string, text: string) => text }).render(46)[0]).toContain("Starting context");
    } finally { disposeStartupHost(mode); }
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

describe("Pi 1.2.0 resource loader", () => {
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
      "agent_end", "agent_settled", "agent_start", "before_agent_start", "input", "message_start", "message_update", "model_select", "session_compact", "session_shutdown",
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
      expect(manifest.devDependencies[host]).toBe("1.2.0");
      expect(manifest.dependencies?.[host]).toBeUndefined();
    }
    expect(manifest.dependencies).toBeUndefined();
    const license = readFileSync(resolve(root, "LICENSE"), "utf8");
    expect(license).toContain("Copyright (c) 2026 minuque");
    expect(license).toContain("tifandotme");
    expect(license).toContain("MasuRii");
  });
});
