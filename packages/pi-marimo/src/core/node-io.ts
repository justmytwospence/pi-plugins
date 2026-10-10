// The Io of a Node or Bun host (pi, opencode).

import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cancellable, Io, StreamEnd } from "./io.js";

export function registryDir(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") return join(homedir(), ".marimo", "servers");
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "marimo", "servers");
}

function alive(pid: unknown): boolean {
  if (typeof pid !== "number") return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function nodeIo(options: { registryDir?: string; fetch?: typeof fetch } = {}): Io {
  const doFetch = options.fetch ?? fetch;
  return {
    async registryEntries() {
      const dir = options.registryDir ?? registryDir();
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        return [];
      }
      const entries: unknown[] = [];
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        try {
          const entry = JSON.parse(await readFile(join(dir, name), "utf8")) as { pid?: unknown };
          if (alive(entry.pid)) entries.push(entry);
        } catch {
          // A file being written or removed; skip it this round.
        }
      }
      return entries;
    },

    async getJson(url, headers, timeoutMs) {
      try {
        const response = await doFetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        return response.ok ? await response.json() : undefined;
      } catch {
        return undefined;
      }
    },

    stream(url, headers, onText): Cancellable<StreamEnd> {
      const controller = new AbortController();
      const done = (async (): Promise<StreamEnd> => {
        try {
          const response = await doFetch(url, { headers, signal: controller.signal });
          if (!response.ok || !response.body) return { ok: false, status: response.status };
          const decoder = new TextDecoder();
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { value, done: end } = await reader.read();
              if (end) break;
              onText(decoder.decode(value, { stream: true }));
            }
          } finally {
            reader.releaseLock();
          }
          return { ok: true };
        } catch {
          return { ok: controller.signal.aborted };
        }
      })();
      return { done, cancel: () => controller.abort() };
    },

    async realpath(path) {
      try {
        return await realpath(path);
      } catch {
        return path;
      }
    },

    sleep(ms): Cancellable<void> {
      let cancel = (): void => {};
      const done = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        cancel = () => { clearTimeout(timer); resolve(); };
      });
      return { done, cancel };
    },
  };
}
