import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, InteractiveMode, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

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

  test("early paint hides only native header spacers, restores them on disable/shutdown, and reclaims the wrapper on reload", async () => {
    const { config } = await import("../src/config/config.ts");
    const { applyStartupHeader, clearStartupHeader, default: startupHeader, installEarlyStartupHeader } = await import("../src/feature/shell/startup-header.ts");
    const { EARLY_STARTUP_HEADER_PATCH, EARLY_STARTUP_HEADER_SWAP_KEY, patchRegistry } = await import("../src/utils/patch-keys.ts");
    const prototype = (InteractiveMode as any).prototype;
    const savedInit = prototype.init;
    const savedPatch = patchRegistry.get(EARLY_STARTUP_HEADER_PATCH);
    const enabled = config.showStartupHeader;
    const makeMode = (id: string) => {
      const children: any[] = [];
      const headers: any[] = [];
      let additions = 0;
      const mode: any = {
        sessionManager: { getSessionId: () => id },
        builtInHeader: { render: () => ["native"] },
        headerContainer: { children, addChild(child: any) { additions++; children.push(child); } },
        setExtensionHeader(factory: any) {
          const current = this.customHeader ?? this.builtInHeader;
          const index = children.indexOf(current);
          this.customHeader = factory?.({}, { fg: (_c: string, text: string) => text });
          headers.push(this.customHeader);
          if (index >= 0) children[index] = this.customHeader ?? this.builtInHeader;
        },
      };
      const ctx = { hasUI: true, sessionManager: mode.sessionManager, ui: { setHeader: (factory: any) => mode.setExtensionHeader(factory) } };
      const headerRows = () => children.slice(0, 3).flatMap((child: any) => child.render(46));
      return { mode, children, headers, ctx, headerRows, additions: () => additions };
    };
    try {
      prototype.init = async function (this: any) {
        this.headerContainer.addChild(new Spacer(1));
        this.headerContainer.addChild(this.builtInHeader);
        this.headerContainer.addChild(new Spacer(1));
      };
      patchRegistry.delete(EARLY_STARTUP_HEADER_PATCH);
      config.showStartupHeader = true;
      installEarlyStartupHeader();
      const first = makeMode("early-1");
      await prototype.init.call(first.mode);
      // This is before session_start: neither of Pi's adjacent spacer rows may paint.
      expect(first.headers).toHaveLength(1);
      expect(first.headers[0].render(46)).toEqual([]);
      expect(first.headerRows()).toEqual([]);
      const unrelated = new Spacer(1);
      first.mode.headerContainer.addChild(unrelated);
      expect(unrelated.render(46)).toEqual([""]);
      const firstSwap = first.mode.headerContainer[EARLY_STARTUP_HEADER_SWAP_KEY];
      installEarlyStartupHeader();
      const secondSwap = first.mode.headerContainer[EARLY_STARTUP_HEADER_SWAP_KEY];
      expect(secondSwap.installed).not.toBe(firstSwap.installed);
      expect(secondSwap.original).toBe(firstSwap.original);
      expect(secondSwap.spacing).toBe(firstSwap.spacing);
      expect(first.headerRows()).toEqual([]);
      first.mode.headerContainer.addChild(new Spacer(1));
      expect(first.additions()).toBe(5); // no stacked addChild calls or additional header rows
      expect(first.headers).toHaveLength(1);
      expect(first.headerRows()).toEqual([]);
      expect(first.children[4].render(46)).toEqual([""]);

      config.showStartupHeader = false;
      installEarlyStartupHeader(); // reload with the splash disabled restores the original counts
      expect(first.children[0].render(46)).toEqual([""]);
      expect(first.children[2].render(46)).toEqual([""]);
      expect(first.mode.headerContainer[EARLY_STARTUP_HEADER_SWAP_KEY].original).toBe(firstSwap.original);
      clearStartupHeader(first.ctx);
      expect(first.headerRows()).toEqual(["", "native", ""]);
      expect(unrelated.render(46)).toEqual([""]);
      const native = makeMode("early-native");
      await prototype.init.call(native.mode);
      expect(native.headerRows()).toEqual(["", "native", ""]);
      expect(native.headers).toHaveLength(0);
      config.showStartupHeader = true;
      applyStartupHeader(native.ctx);
      expect(native.headerRows()).toEqual([]);
      expect(first.headerRows()).toEqual(["", "native", ""]);

      const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
      startupHeader({ on: (name: string, handler: any) => handlers.set(name, handler) } as any);
      await handlers.get("session_shutdown")!({}, native.ctx);
      expect(native.headerRows()).toEqual(["", "native", ""]);
      expect(first.headerRows()).toEqual(["", "native", ""]);
    } finally {
      // Leave no mutated spacer or wrapper ownership behind for other tests.
      clearStartupHeader({});
      config.showStartupHeader = enabled;
      prototype.init = savedInit;
      if (savedPatch) patchRegistry.install(EARLY_STARTUP_HEADER_PATCH, savedPatch);
      else patchRegistry.delete(EARLY_STARTUP_HEADER_PATCH);
    }
  });

  test("session_start leaves the header empty while the resource owner retains session state", async () => {
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
      // session_start must not capture or rebind the resource owner's snapshot.
      handlers.get("session_start")!({}, ctx);
      expect(getStartupHost(id.value)).toBe(state);
      expect(factory({}, ctx.ui.theme).render(120)).toEqual([]);
      expect(state.contextSnapshot).toBe(snapshot);
      expect(renders).toBe(0);
      id.value = "header-session-2";
      expect(attachStartupHost(mode)).toBe(state);
      expect(getStartupHost("header-session-1")).toBeUndefined();
      expect(getStartupHost(id.value)).toBe(state);
      handlers.get("session_shutdown")!({}, ctx);
      expect(getStartupHost(id.value)).toBe(state);
      expect(factory).toBeUndefined();
      // Header installation never creates or replaces the resource owner.
      applyStartupHeader(ctx);
      expect(getStartupHost(id.value)).toBe(state);
    } finally {
      disposeStartupHost(mode);
    }
  });

  test("session_start does not bind to a missing session ID before resources exist", async () => {
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
      expect(getStartupHost(id)).toBeUndefined();
      expect(factory).toBeTypeOf("function");
      expect(factory({}, { fg: (_color: string, text: string) => text }).render(46)).toEqual([]);
      expect(attachStartupHost(mode)).toBe(state);
      expect(getStartupHost(id)).toBe(state);
    } finally { disposeStartupHost(mode); }
  });

  test("a session_start before resource installation still mounts a live map after Models", async () => {
    const { applyStartupHeader } = await import("../src/feature/shell/startup-header.ts");
    const { replaceSections, stopStartupResources } = await import("../src/feature/shell/startup-resources.ts");
    const { attachStartupHost, disposeStartupHost } = await import("../src/feature/shell/startup-state.ts");
    vi.useFakeTimers();
    let id: string | undefined;
    const content = "Known AGENTS content for the occupied context map.";
    const file = { path: resolve(temp, "AGENTS.md"), content };
    const manager = {
      getSessionId: () => id, getLeafId: () => undefined, getCwd: () => temp,
      buildSessionProjection: () => ({ messages: [] }),
    };
    const models = [
      { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 200_000 },
      { provider: "openai", id: "gpt-6.1-sol", contextWindow: 1_048_576 },
    ];
    const loader = {
      agentDir: temp,
      getSystemPromptSource: () => undefined, getSystemPrompt: () => "",
      getAppendSystemPromptSources: () => [], getAppendSystemPrompt: () => [],
      getAgentsFiles: () => ({ agentsFiles: [file] }), getSkills: () => ({ skills: [] }),
    };
    const runner = {
      createCommandContext: () => ({ getSystemPromptOptions: () => ({ contextFiles: [file], skills: [], selectedTools: ["read"], hiddenTools: [] }) }),
      runtime: { mcpServers: { list: () => [] } }, getCommand: () => undefined,
    };
    const session: any = {
      sessionManager: manager, resourceLoader: loader, extensionRunner: runner,
      systemPrompt: `Introduction.\n${content}\nEnd.`, agent: { state: { tools: [] } },
      _hiddenDeclarations: new Set<string>(), model: models[0], scopedModels: [],
      modelRuntime: { getAvailableSnapshot: () => models }, getAllTools: () => [],
      promptTemplates: [],
    };
    const mode: any = {
      session, sessionManager: manager, loadedResourcesContainer: { children: [] as any[] },
      settingsManager: { isProjectTrusted: () => false }, shouldShowStartupDetails: () => true,
      formatContextPath: (path: string) => path.split("/").at(-1),
      ui: { requestRender: () => undefined },
    };
    let header: any;
    const native = () => ({ setExpanded() {}, state: { expanded: false }, render: () => ["[Context] native"] });
    const lines = () => mode.loadedResourcesContainer.children.flatMap((child: any) => child.render(120)).join("\n");
    try {
      // This is the failing real-world ordering: the header event fires before a resource owner exists.
      applyStartupHeader({ hasUI: true, sessionManager: manager, ui: { setHeader: (factory: any) => { header = factory; }, requestRender() {} } });
      expect(header({}, { fg: (_color: string, text: string) => text, bold: (text: string) => text }).render(120)).toEqual([]);
      mode.loadedResourcesContainer.children = [new Spacer(1), native()];
      replaceSections(mode, { force: true, extensions: [] });
      expect(mode.loadedResourcesContainer.children[0].render(120)[0]).toContain("Models 2");
      const first = lines();
      expect(first.indexOf("Models 2")).toBeLessThan(first.indexOf("Starting context"));
      expect(first.indexOf("Starting context")).toBeLessThan(first.indexOf("Context 1"));
      expect(first).toContain("Starting context ·");
      expect(first).not.toContain("Sources · occupied context");
      expect(first).not.toContain("loading");
      expect(attachStartupHost(mode).contextSnapshot?.attribution.files).toBe(true);
      expect(attachStartupHost(mode).resourceSections?.Context?.tokens).toBeGreaterThan(0);
      // An OAuth provider can be registered after Pi's initial available snapshot was taken.
      // A read-only, provider-scoped availability check must populate the live Google group.
      const google = { provider: "google", id: "antigravity-gemini-4-argon", contextWindow: 1_048_576 };
      session.modelRuntime.getModels = () => [google];
      session.modelRuntime.getAvailable = vi.fn(async () => [google]);
      attachStartupHost(mode).refresh?.();
      await vi.waitFor(() => expect(lines()).toContain("google 1"));
      expect(session.modelRuntime.getAvailable).toHaveBeenCalledWith("google");
      expect(lines()).toContain("gemini-4-argon");
      expect(lines()).not.toContain("antigravity-gemini-4-argon");
      session.modelRuntime.getAvailable.mockResolvedValueOnce([]); // OAuth access disappears
      await vi.advanceTimersByTimeAsync(16_000);
      expect(lines()).not.toContain("google 1");
      session.model = models[1];
      attachStartupHost(mode).refresh?.();
      expect(lines()).toContain("of 1M");
      expect(lines()).toContain("gpt-6.1-sol ●");
      id = "saved-session";
      attachStartupHost(mode).refresh?.();
      expect(lines()).not.toContain("loading");
      // Pi clears and reconstructs the native sections on reload/resume; our insertion stays singular.
      mode.loadedResourcesContainer.children = [new Spacer(1), native()];
      replaceSections(mode, { force: true, extensions: [] });
      expect(lines().match(/Starting context/g)).toHaveLength(1);
      expect(lines().indexOf("Models 2")).toBeLessThan(lines().indexOf("Starting context"));
    } finally {
      stopStartupResources();
      disposeStartupHost(mode);
      vi.useRealTimers();
    }
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
