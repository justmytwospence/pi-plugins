// Hermetic theme and agent directory for rendering tests; no Pi settings are read.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-btw-test-"));
initTheme("dark", false);
