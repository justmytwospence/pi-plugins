import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

export const FORK_BOUNDARY = "pi-herdr:fork-boundary";

/** Extract an inclusive ancestry without changing the source session or its live manager. */
export function createTreeFork(sourceFile: string, sessionDir: string, cwd: string, entryId: string): string {
  // Opening a missing or empty path initializes it in Pi. Never let a fork write the source.
  if (!existsSync(sourceFile) || statSync(sourceFile).size === 0) {
    throw new Error(`Cannot fork: source session is not persisted: ${sourceFile}`);
  }
  const manager = SessionManager.open(sourceFile, sessionDir, cwd);
  if (!manager.getEntry(entryId)) {
    throw new Error(`Cannot fork: selected entry ${entryId} was not persisted yet in ${sourceFile}`);
  }
  const sourceSessionId = manager.getSessionId();
  const file = manager.createBranchedSession(entryId);
  if (!file) throw new Error("Cannot fork: Pi did not create a persisted session path");
  manager.appendCustomEntry(FORK_BOUNDARY, { sourceSessionId, entryId });
  // Pi defers persistence for metadata-only branches. Materialize its serialized entries,
  // not a raw slice of the original file (labels and compactions need Pi's re-chaining).
  if (!existsSync(file)) {
    const entries = [manager.getHeader(), ...manager.getEntries()];
    writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
  } else {
    chmodSync(file, 0o600);
  }
  return file;
}
