import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("SDK 1.1.0 loads the standalone manifest with no sibling packages", async () => {
  const temp = mkdtempSync(resolve(tmpdir(), "pi-stash-loader-"));
  try {
    const isolated = resolve(temp, "isolated-stash");
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
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    const result = loader.getExtensions();
    expect(result.errors).toEqual([]);
    expect(result.extensions.map((entry) => entry.path)).toEqual([resolve(isolated, "src/index.ts")]);
    expect([...result.extensions[0]!.handlers.keys()].sort()).toEqual([
      "model_select", "session_shutdown", "session_start", "thinking_level_select",
    ]);
    expect(result.extensions[0]!.tools.size).toBe(0);
    expect(result.extensions[0]!.commands.size).toBe(0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("manifest keeps host runtime dependencies unbundled and records exact upstream", () => {
  const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  expect(manifest.pi.extensions).toEqual(["./src/index.ts"]);
  for (const host of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
    expect(manifest.peerDependencies[host]).toBe("*");
    expect(manifest.devDependencies[host]).toBe("1.1.0");
    expect(manifest.dependencies?.[host]).toBeUndefined();
  }
  const upstream = JSON.parse(readFileSync(resolve(root, "UPSTREAM.json"), "utf8"));
  expect(upstream.source).toBe("npm:@saadjs/pi-stash@0.0.3");
  expect(Object.keys(upstream.sha256).sort()).toEqual(["LICENSE", "README.md", "core.ts", "index.ts", "package.json"]);
  expect(readFileSync(resolve(root, "LICENSE"), "utf8")).toContain("Copyright (c) 2026 Saad Bash");
});
