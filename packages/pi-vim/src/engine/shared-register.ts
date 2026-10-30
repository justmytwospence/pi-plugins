import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
}

export function defaultSharedRegisterPath(): string {
  return (
    process.env.PI_VIM_SHARED_REGISTER ??
    join(homedir(), ".pi", "agent", "pi-vim-register.json")
  );
}

export function createFileSharedRegister(
  path: string = defaultSharedRegisterPath(),
): SharedRegisterStore {
  let lastTs = 0;
  return {
    read() {
      try {
        const v = JSON.parse(readFileSync(path, "utf8"));
        if (typeof v?.text === "string" && typeof v?.ts === "number") {
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
        return { text, ts };
      } catch {
        return null;
      }
    },
  };
}
