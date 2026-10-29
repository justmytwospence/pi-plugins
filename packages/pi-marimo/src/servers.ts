// Notebook servers Pi starts itself (`/marimo edit`, `/marimo new`), so no browser is needed even to
// begin: `marimo edit <file> --headless --no-token` on a free port. They belong to the Pi process,
// not to a session, so a /reload or a session switch keeps them; they stop when Pi exits, or with
// `/marimo stop` (or `S` twice in the notebook view). `--no-token` makes them register in marimo's
// server registry, where the watcher finds them like any other.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { sameServer } from "./core/touch.js";

/** A new notebook, as marimo writes an empty one. */
export const NOTEBOOK_TEMPLATE = `import marimo

app = marimo.App()


@app.cell
def _():
    import marimo as mo
    return (mo,)


if __name__ == "__main__":
    app.run()
`;

/** How to run marimo: as configured, else through uv in a uv project, else marimo on the PATH. */
export function serverCommand(configured: readonly unknown[], cwd: string, exists: (path: string) => boolean = existsSync): string[] {
  const given = configured.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (given.length) return given;
  return exists(join(cwd, "uv.lock")) ? ["uv", "run", "marimo"] : ["marimo"];
}

/** A port nothing listens on now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

export interface OwnServer {
  url: string;
  /** The notebook it serves (absolute). */
  file: string;
  port: number;
  pid: number;
  startedAt: number;
  /** Its latest output lines. */
  log: string[];
  /** How it ended, once it did. */
  exited?: string;
}

const LOG_LINES = 60;
const tail = (s: OwnServer, n = 5) => s.log.slice(-n).join(" · ") || "no output";

export class OwnServers {
  private readonly servers = new Map<string, { server: OwnServer; child: ChildProcess }>();

  list(): OwnServer[] {
    return [...this.servers.values()].map((s) => s.server);
  }

  find(url: string): OwnServer | undefined {
    return this.list().find((s) => sameServer(s.url, url));
  }

  byFile(file: string): OwnServer | undefined {
    return this.list().find((s) => s.file === file);
  }

  /** Starts marimo on the file and resolves once it answers /health. */
  async start(o: { command: string[]; file: string; cwd: string; timeoutMs?: number }): Promise<OwnServer> {
    const [bin, ...pre] = o.command;
    if (!bin) throw new Error("no marimo command");
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const child = spawn(bin, [...pre, "edit", o.file, "--headless", "--no-token", "--skip-update-check", "--port", String(port)], { cwd: o.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.unref();
    const server: OwnServer = { url, file: o.file, port, pid: child.pid ?? 0, startedAt: Date.now(), log: [] };
    let failed: Error | undefined;
    const take = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/u)) if (line.trim()) server.log.push(line.trim());
      if (server.log.length > LOG_LINES) server.log.splice(0, server.log.length - LOG_LINES);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", (e) => { failed = new Error(`could not run ${bin}: ${e.message}`); });
    child.on("exit", (code, signal) => {
      server.exited = signal ? `signal ${signal}` : `exit ${code}`;
      if (this.servers.get(url)?.child === child) this.servers.delete(url);
    });
    this.servers.set(url, { server, child });
    const end = Date.now() + (o.timeoutMs ?? 45_000);
    for (;;) {
      if (failed) { this.servers.delete(url); throw failed; }
      if (server.exited) { this.servers.delete(url); throw new Error(`marimo exited (${server.exited}): ${tail(server)}`); }
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return server;
      } catch {
        // Not up yet.
      }
      if (Date.now() > end) {
        this.stop(url);
        throw new Error(`marimo did not start in ${Math.round((o.timeoutMs ?? 45_000) / 1000)}s: ${tail(server)}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Stops a server Pi started (its whole process group: `uv run` passes no signal on). */
  stop(url: string): boolean {
    const known = [...this.servers].find(([u]) => sameServer(u, url));
    if (!known) return false;
    const [key, { child }] = known;
    this.servers.delete(key);
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    return true;
  }

  stopAll(): void {
    for (const url of [...this.servers.keys()]) this.stop(url);
  }
}

const KEY = Symbol.for("pi-marimo.own-servers.v1");

/** The Pi process's servers: one registry for every session and reload, stopped when Pi exits. */
export function ownServers(): OwnServers {
  const g = globalThis as Record<symbol, OwnServers | undefined>;
  let s = g[KEY];
  if (!s) {
    s = new OwnServers();
    g[KEY] = s;
    const servers = s;
    process.once("exit", () => servers.stopAll());
  }
  return s;
}

const SKIP = new Set(["node_modules", "__pycache__", "venv", "site-packages"]);

/** The marimo notebooks under a directory (three levels down, outside hidden and environment directories), relative and sorted. */
export async function findNotebookFiles(cwd: string, max = 200): Promise<string[]> {
  const found: string[] = [];
  let level: string[] = [""];
  for (let depth = 0; depth <= 3 && level.length && found.length < max; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      let entries;
      try {
        entries = await readdir(join(cwd, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!e.name.startsWith(".") && !SKIP.has(e.name)) next.push(path);
        } else if (e.isFile() && e.name.endsWith(".py") && found.length < max) {
          try {
            const handle = await open(join(cwd, path), "r");
            try {
              const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
              if (buffer.toString("utf8", 0, bytesRead).includes("marimo.App(")) found.push(path);
            } finally {
              await handle.close();
            }
          } catch {
            // Unreadable: not a notebook we can open.
          }
        }
      }
    }
    level = next;
  }
  return found.sort();
}
