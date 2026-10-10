import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

const BG = new Set(["selectedBg", "searchMatchBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"]);

/** A real pi theme built from the bundled dark.json / light.json. */
export function makeTheme(name: "dark" | "light"): Theme {
	const pkg = join(fileURLToPath(new URL("..", import.meta.url)), "node_modules/@earendil-works/pi-coding-agent/dist");
	const json = JSON.parse(readFileSync(join(pkg, "modes/interactive/theme", `${name}.json`), "utf8")) as {
		vars?: Record<string, string>;
		colors: Record<string, string | number>;
		appearance?: "dark" | "light";
	};
	const fg: Record<string, string | number> = {};
	const bg: Record<string, string | number> = {};
	for (const [k, v] of Object.entries(json.colors)) {
		const val = typeof v === "string" && json.vars && v in json.vars ? json.vars[v] : v;
		(BG.has(k) ? bg : fg)[k] = val;
	}
	// biome-ignore lint/suspicious/noExplicitAny: test fixture
	return new Theme(fg as any, bg as any, "truecolor", { name, appearance: json.appearance });
}

export function fakeTui(columns = 120, rows = 40): TUI & { renders: number } {
	const t = {
		renders: 0,
		terminal: { columns, rows },
		requestRender() {
			t.renders++;
		},
	};
	return t as unknown as TUI & { renders: number };
}

export function gitRepo(): { root: string; run: (...args: string[]) => string; write: (path: string, text: string) => void } {
	const root = mkdtempSync(join(tmpdir(), "pdr-test-"));
	const run = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
		});
	run("init", "-q", "-b", "main");
	run("config", "commit.gpgsign", "false");
	const write = (path: string, text: string) => {
		const full = join(root, path);
		execFileSync("mkdir", ["-p", dirname(full)]);
		writeFileSync(full, text);
	};
	return { root, run, write };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
export const strip = (s: string) => s.replace(/\x1b\[[0-9;:?]*[A-Za-z]|\x1b_[^\x07\x1b]*(\x07|\x1b\\)/g, "");
