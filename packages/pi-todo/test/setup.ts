/** Adapted from rpiv-mono test/setup.ts (MIT). Set HOME before importing
 * production modules; never let tests read or remove the maintainer's config. */
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const originalCwd = process.cwd();
const testHome = realpathSync(mkdtempSync(join(tmpdir(), "pi-todo-test-home-")));
const testProject = join(testHome, "project");
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;
mkdirSync(testProject);
process.chdir(testProject);

beforeEach(async () => {
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.XDG_CONFIG_HOME;
	for (const entry of readdirSync(testHome)) {
		if (entry !== "project") rmSync(join(testHome, entry), { recursive: true, force: true });
	}
	for (const entry of readdirSync(testProject)) {
		rmSync(join(testProject, entry), { recursive: true, force: true });
	}
	// Dynamic on purpose: HOME must already be isolated before module evaluation.
	const { __resetState } = await import("../state/store.js");
	__resetState();
});

afterAll(() => {
	process.chdir(originalCwd);
	rmSync(testHome, { recursive: true, force: true });
});
