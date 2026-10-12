import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { createBtwResourceLoader } from "../src/session.ts";
import { BTW_TOOLS_BY_MODE, buildBtwSeedState } from "../src/thread.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
afterEach(() => vi.unstubAllGlobals());
function offline() { vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network access is forbidden in this test"); })); }

test("package metadata is independent, SDK dev versions are exact, and local attribution matches the recorded upstream", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  expect(pkg.pi).toEqual({ extensions: ["./src/index.ts"], skills: ["./skills"] });
  expect(pkg.dependencies).toBeUndefined();
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    expect(pkg.peerDependencies[name]).toBe("*"); expect(pkg.devDependencies[name]).toBe("1.1.0");
    expect(lock.packages[""].devDependencies[name]).toBe("1.1.0");
  }
  const hostPeers = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"]);
  for (const [name, range] of Object.entries(pkg.peerDependencies)) {
    expect(hostPeers.has(name), name).toBe(true); expect(range, name).toBe("*");
  }
  for (const [name, range] of Object.entries(lock.packages[""].peerDependencies)) {
    expect(hostPeers.has(name), name).toBe(true); expect(range, name).toBe("*");
  }
  for (const path of pkg.files) expect(existsSync(join(root, path))).toBe(true);
  const origin = JSON.parse(readFileSync(join(root, "UPSTREAM.json"), "utf8"));
  expect(origin).toMatchObject({ package: "pi-btw", version: "0.6.1", source: "npm:pi-btw@0.6.1", license: "MIT" });
  expect(createHash("sha256").update(readFileSync(join(root, "LICENSE"))).digest("hex")).toBe(origin.sha256.LICENSE);
  // Optional maintainer verification; portable package checks do not require an installed upstream copy.
  if (existsSync(origin.installedSource)) {
    for (const [path, hash] of Object.entries(origin.sha256)) {
      expect(createHash("sha256").update(readFileSync(join(origin.installedSource, path))).digest("hex"), path).toBe(hash);
    }
  }
  const skill = readFileSync(join(root, "skills/btw/SKILL.md"), "utf8");
  expect(skill).toContain("name: btw");
  for (const command of ["/btw", "/side", "/btw:new", "/btw:tangent", "/btw:ask", "/btw:clear", "/btw:model", "/btw:thinking", "/btw:inject", "/btw:summarize"]) expect(skill).toContain(command);
  expect(skill).not.toMatch(/enforced read-only|must not be able to change|cannot modify/i);
});

test("real SDK 1.1 DefaultResourceLoader discovers only BTW commands and its skill from the standalone manifest", async () => {
  offline();
  const cwd = mkdtempSync(join(tmpdir(), "btw-loader-")); const agentDir = join(cwd, "agent");
  try {
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [root], additionalSkillPaths: [join(root, "skills")] });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]); expect(result.extensions).toHaveLength(1);
    expect([...result.extensions[0]!.commands.keys()].sort()).toEqual(["btw", "side", "btw:ask", "btw:tangent", "btw:new", "btw:clear", "btw:model", "btw:thinking", "btw:inject", "btw:summarize"].sort());
    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["btw"]);
    expect(loader.getSkills().diagnostics).toEqual([]);
    expect(result.extensions[0]!.tools.size).toBe(0);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("real SDK child registry and replay state do not inherit parent tools from SDK 1.1 system messages", async () => {
  offline();
  const cwd = mkdtempSync(join(tmpdir(), "btw-sdk-"));
  const parent = SessionManager.inMemory(cwd);
  const system = { role: "system" as const, content: "parent prompt", toolsAdded: [{ name: "dangerous-parent-tool", description: "not inherited", parameters: { type: "object" } }], timestamp: 1 };
  parent.appendMessage(system);
  parent.appendMessage({ role: "user", content: "parent context", timestamp: 1 });
  const model = getModel("anthropic", "claude-sonnet-4-5")!;
  const ctx = { cwd, model, sessionManager: parent, getSystemPrompt: () => "Parent instructions" } as unknown as ExtensionCommandContext;
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), allowModelNetwork: false });
  try {
    for (const mode of ["contextual", "readonly", "tangent"] as const) {
      const seed = buildBtwSeedState(ctx, [], mode, model);
      expect(seed.messages.some((message) => message.role === "system")).toBe(false);
      expect(seed.messages).toHaveLength(mode === "tangent" ? 0 : 1);
      const manager = SessionManager.inMemory(cwd);
      for (const message of seed.messages) manager.appendMessage(message);
      const { session } = await createAgentSession({ cwd, sessionManager: manager, settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }), model, modelRuntime: runtime, tools: [...BTW_TOOLS_BY_MODE[mode]], resourceLoader: createBtwResourceLoader(ctx), thinkingLevel: "off" });
      try {
        expect(session.getActiveToolNames().sort()).toEqual([...BTW_TOOLS_BY_MODE[mode]].sort());
        expect(session.getAllTools().map((tool) => tool.name).sort()).toEqual([...BTW_TOOLS_BY_MODE[mode]].sort());
        expect(session.messages.some((message) => message.role === "system")).toBe(false);
        expect(session.systemPrompt).toContain("Parent instructions");
      } finally { session.dispose(); }
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
