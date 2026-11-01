import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { system1Path, type System1Backend } from "./system1.js";

function validWaterfall(value: unknown): value is System1Backend[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    Array.from(value).every((backend) => backend === "jev" || backend === "openai-decisions") &&
    new Set(value).size === value.length
  );
}

/** Save the global order. Existing malformed settings require a human fix. */
export function saveSystem1Waterfall(waterfall: readonly System1Backend[]): void {
  if (!validWaterfall(waterfall)) throw new Error("Invalid System 1 waterfall");
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
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`Malformed System 1 setting at ${path}; correct the file before switching`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid System 1 setting at ${path}; correct the file before switching`);
    }
    current = parsed as Record<string, unknown>;
    if (
      Object.hasOwn(current, "waterfall")
        ? !validWaterfall(current.waterfall)
        : current.backend !== "jev" && current.backend !== "openai-decisions"
    ) {
      throw new Error(`Invalid System 1 setting at ${path}; correct the file before switching`);
    }
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify({ ...current, waterfall, backend: waterfall[0] }, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
  } catch {
    throw new Error(`Cannot save System 1 setting at ${path}; the previous selection was not replaced`);
  } finally {
    // A failed rename/write must not leave a competing settings file behind.
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* Preserve the original write error. */
    }
  }
}

/** @deprecated Use saveSystem1Waterfall to save the complete order. */
export function saveSystem1Backend(backend: System1Backend): void {
  saveSystem1Waterfall([backend]);
}
