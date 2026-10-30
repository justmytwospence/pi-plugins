import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SharedRegisterEntry {
  text: string;
  /** Monotonic-enough stamp (ms) used to tell whether the register changed. */
  ts: number;
}

/** A register shared by every pi session on this machine. */
export interface SharedRegisterStore {
  read(): SharedRegisterEntry | null;
  write(text: string): SharedRegisterEntry | null;
  /** Remove the entry, but only if it is still the one with this stamp. */
  clear(ts: number): void;
}

/** A shared entry is scrubbed this long after it was written, or when pasted. */
export const SHARED_REGISTER_TTL_MS = 5 * 60 * 1000;

export function defaultSharedRegisterPath(): string {
  return (
    process.env.PI_VIM_SHARED_REGISTER ??
    join(homedir(), ".pi", "agent", "pi-vim-register.json")
  );
}

export function createFileSharedRegister(
  path: string = defaultSharedRegisterPath(),
  ttlMs: number = SHARED_REGISTER_TTL_MS,
): SharedRegisterStore {
  let lastTs = 0;
  const remove = (ts: number) => {
    try {
      const v = JSON.parse(readFileSync(path, "utf8"));
      if (v?.ts === ts) rmSync(path, { force: true });
    } catch {
      /* already gone */
    }
  };
  return {
    clear: remove,
    read() {
      try {
        const v = JSON.parse(readFileSync(path, "utf8"));
        if (typeof v?.text === "string" && typeof v?.ts === "number") {
          if (Date.now() - v.ts > ttlMs) {
            remove(v.ts);
            return null;
          }
          return { text: v.text, ts: v.ts };
        }
      } catch {
        /* missing or corrupt: no shared register */
      }
      return null;
    },
    write(text) {
      const ts = Math.max(Date.now(), lastTs + 1);
      lastTs = ts;
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ text, ts }), { mode: 0o600 });
        renameSync(tmp, path);
        // Backup scrub without a poll: one unref'd timer per write.
        setTimeout(() => remove(ts), ttlMs).unref();
        return { text, ts };
      } catch {
        return null;
      }
    },
  };
}
