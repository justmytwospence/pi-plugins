import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, test } from "vitest";
import { OwnServers, findNotebookFiles, serverCommand } from "../src/servers.js";

const fake = fileURLToPath(new URL("./fixtures/fake-marimo.mjs", import.meta.url));
const servers = new OwnServers();
afterAll(() => servers.stopAll());

test("the marimo command: as configured, else uv in a uv project, else marimo", () => {
  expect(serverCommand(["uvx", "marimo", 3], "/p", () => true)).toEqual(["uvx", "marimo"]);
  expect(serverCommand([], "/p", (p) => p === "/p/uv.lock")).toEqual(["uv", "run", "marimo"]);
  expect(serverCommand([], "/p", () => false)).toEqual(["marimo"]);
});

test("a server Pi starts answers on its port, and stops when asked", async () => {
  const server = await servers.start({ command: [process.execPath, fake], file: "/w/nb.py", cwd: tmpdir(), timeoutMs: 10_000 });
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
  expect((await fetch(`${server.url}/health`)).ok).toBe(true);
  expect(servers.find(server.url.replace("127.0.0.1", "localhost"))).toBe(server);
  expect(servers.byFile("/w/nb.py")).toBe(server);
  expect(servers.stop(server.url)).toBe(true);
  expect(servers.list()).toEqual([]);
  for (let i = 0; i < 40; i++) {
    try { await fetch(`${server.url}/health`, { signal: AbortSignal.timeout(200) }); } catch { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the server is still up");
});

test("a server that exits says why", async () => {
  await expect(servers.start({ command: [process.execPath, fake, "--fail"], file: "/w/nb.py", cwd: tmpdir(), timeoutMs: 10_000 })).rejects.toThrow(/marimo exited \(exit 3\): boom: no notebook/u);
  await expect(servers.start({ command: ["/no/such/marimo"], file: "/w/nb.py", cwd: tmpdir(), timeoutMs: 10_000 })).rejects.toThrow(/could not run \/no\/such\/marimo/u);
});

test("the notebooks under a directory, outside environments and hidden directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-marimo-find-"));
  const nb = "import marimo\n\napp = marimo.App()\n";
  mkdirSync(join(dir, "notebooks"));
  mkdirSync(join(dir, ".venv", "lib"), { recursive: true });
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "notebooks", "fit.py"), nb);
  writeFileSync(join(dir, "prep.py"), nb);
  writeFileSync(join(dir, "util.py"), "x = 1\n");
  writeFileSync(join(dir, ".venv", "lib", "nb.py"), nb);
  writeFileSync(join(dir, "node_modules", "nb.py"), nb);
  expect(await findNotebookFiles(dir)).toEqual(["notebooks/fit.py", "prep.py"]);
});
