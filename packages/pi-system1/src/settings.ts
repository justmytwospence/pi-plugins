import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { system1Path, type System1Backend } from "./system1.js";

/** Save only the global backend selection. Existing malformed settings require a human fix. */
export function saveSystem1Backend(backend: System1Backend): void {
  if (backend !== "jev" && backend !== "openai-decisions") throw new Error("Unsupported System 1 backend");
  const path = system1Path();
  let current: Record<string, unknown> = {};
  let contents: string | undefined;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read System 1 setting at ${path}; correct the file before switching`);
    }
  }
  if (contents !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(contents); } catch {
      throw new Error(`Malformed System 1 setting at ${path}; correct the file before switching`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
        !["jev", "openai-decisions"].includes((parsed as Record<string, unknown>).backend as string)) {
      throw new Error(`Invalid System 1 backend at ${path}; correct the file before switching`);
    }
    current = parsed as Record<string, unknown>;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify({ ...current, backend }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch {
    throw new Error(`Cannot save System 1 setting at ${path}; the previous selection was not replaced`);
  } finally {
    // A failed rename/write must not leave a competing settings file behind.
    try { rmSync(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
  }
}
