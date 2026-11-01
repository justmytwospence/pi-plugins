// Fake registries and SDK harnesses must never read the developer's live System 1 policy.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The harness is also loaded by RPC fixture subprocesses without Vitest. They inherit this
// marker and keep their parent's explicitly scoped fixture directory (including fake auth).
if (!process.env.PI_SUBAGENTS_TEST_AGENT_DIR) {
  const dir = mkdtempSync(path.join(tmpdir(), "subagents-offline-"));
  process.env.PI_SUBAGENTS_TEST_AGENT_DIR = dir;
  process.env.PI_CODING_AGENT_DIR = dir;
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
}
