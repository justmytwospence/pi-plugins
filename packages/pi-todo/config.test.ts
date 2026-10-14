import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	DEFAULT_MAX_WIDGET_LINES,
	getMaxWidgetLines,
	isValidCollapseKeySpec,
	loadConfig,
	resolveCollapseKey,
	validateGuidanceFields,
} from "./config.js";

const CONFIG_PATH = join(process.env.HOME!, ".pi", "agent", "pi-todo.json");

function writePath(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf-8");
}

function writeConfigFile(contents: string): void {
	writePath(CONFIG_PATH, contents);
}
function removeConfigFile(): void {
	rmSync(CONFIG_PATH, { force: true });
}

beforeEach(removeConfigFile);
afterEach(removeConfigFile);

describe("native config and legacy migration", () => {
	const legacyPath = join(process.env.HOME!, ".config", "rpiv-todo", "config.json");
	const projectPath = join(process.cwd(), ".pi", "pi-todo.json");

	it("isolates all config I/O from the real home and project", () => {
		expect(process.env.HOME).toContain("pi-todo-test-home-");
		expect(process.cwd()).toBe(join(process.env.HOME!, "project"));
	});

	it("keeps old home config, guidance and personal Ctrl+T when native config is absent", () => {
		const config = { maxWidgetLines: 8, collapseKey: "ctrl+t", guidance: { promptSnippet: "Legacy", promptGuidelines: ["Rule"] } };
		writePath(legacyPath, JSON.stringify(config));
		expect(loadConfig()).toEqual(config);
		expect(getMaxWidgetLines()).toBe(8);
		expect(resolveCollapseKey()).toBe("ctrl+t");
	});

	it("uses native config instead of legacy, without backfilling legacy fields", () => {
		writePath(legacyPath, JSON.stringify({ collapseKey: "ctrl+t", maxWidgetLines: 9 }));
		writeConfigFile(JSON.stringify({ maxWidgetLines: 5 }));
		expect(loadConfig()).toEqual({ maxWidgetLines: 5 });
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("honors PI_CODING_AGENT_DIR including a leading tilde", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "ctrl+t" }));
		vi.stubEnv("PI_CODING_AGENT_DIR", "~/custom-agent");
		writePath(join(process.env.HOME!, "custom-agent", "pi-todo.json"), JSON.stringify({ collapseKey: "alt+o" }));
		expect(resolveCollapseKey()).toBe("alt+o");
	});

	it("honors an absolute PI_CODING_AGENT_DIR", () => {
		const agentDir = join(process.env.HOME!, "agent");
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		writePath(join(agentDir, "pi-todo.json"), JSON.stringify({ maxWidgetLines: 6 }));
		expect(getMaxWidgetLines()).toBe(6);
	});

	it("prefers the XDG legacy file and falls back to home only when it is missing", () => {
		const xdg = join(process.env.HOME!, "xdg");
		vi.stubEnv("XDG_CONFIG_HOME", xdg);
		writePath(legacyPath, JSON.stringify({ collapseKey: "ctrl+t" }));
		expect(resolveCollapseKey()).toBe("ctrl+t");
		writePath(join(xdg, "rpiv-todo", "config.json"), JSON.stringify({ collapseKey: "alt+o" }));
		expect(resolveCollapseKey()).toBe("alt+o");
		writeConfigFile(JSON.stringify({ collapseKey: "off" }));
		expect(resolveCollapseKey()).toBe(COLLAPSE_KEY_OFF);
	});

	it.each(["", "   ", "relative/path", "~someone/config"])("uses home for invalid XDG directory %j", (xdg) => {
		vi.stubEnv("XDG_CONFIG_HOME", xdg);
		writePath(legacyPath, JSON.stringify({ maxWidgetLines: 7 }));
		expect(getMaxWidgetLines()).toBe(7);
	});

	it("expands and trims a tilde XDG directory", () => {
		vi.stubEnv("XDG_CONFIG_HOME", "  ~/xdg  ");
		writePath(join(process.env.HOME!, "xdg", "rpiv-todo", "config.json"), JSON.stringify({ collapseKey: "ctrl+t" }));
		expect(resolveCollapseKey()).toBe("ctrl+t");
	});

	it("does not mask malformed native config by falling back to legacy", () => {
		writePath(legacyPath, JSON.stringify({ collapseKey: "ctrl+t" }));
		writeConfigFile("{");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(loadConfig()).toEqual({});
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("pi-todo: invalid JSON"));
	});

	it("does not mask malformed XDG config by falling back to home", () => {
		const xdg = join(process.env.HOME!, "xdg");
		vi.stubEnv("XDG_CONFIG_HOME", xdg);
		writePath(legacyPath, JSON.stringify({ collapseKey: "ctrl+t" }));
		writePath(join(xdg, "rpiv-todo", "config.json"), "{");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(loadConfig()).toEqual({});
	});

	it.each(["null", "[]", "42", '"text"', "true"])("rejects non-object native JSON %s", (json) => {
		writePath(legacyPath, JSON.stringify({ collapseKey: "ctrl+t" }));
		writeConfigFile(json);
		expect(loadConfig()).toEqual({});
	});

	it("overlays project fields and guidance, replacing guideline arrays", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "ctrl+t", maxWidgetLines: 9, guidance: { promptSnippet: "User", promptGuidelines: ["Old"], description: "Desc" } }));
		writePath(projectPath, JSON.stringify({ collapseKey: "off", guidance: { promptGuidelines: ["Project"] } }));
		expect(loadConfig()).toEqual({ collapseKey: "off", maxWidgetLines: 9, guidance: { promptSnippet: "User", promptGuidelines: ["Project"], description: "Desc" } });
		expect(resolveCollapseKey()).toBe(COLLAPSE_KEY_OFF);
	});

	it("applies project overrides over legacy config too", () => {
		writePath(legacyPath, JSON.stringify({ collapseKey: "ctrl+t", maxWidgetLines: 9 }));
		writePath(projectPath, JSON.stringify({ collapseKey: "alt+o" }));
		expect(loadConfig()).toEqual({ collapseKey: "alt+o", maxWidgetLines: 9 });
	});

	it("retains user values when project JSON is invalid", () => {
		writeConfigFile(JSON.stringify({ maxWidgetLines: 8 }));
		writePath(projectPath, "{");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(getMaxWidgetLines()).toBe(8);
	});

	it("preserves guidance validation semantics, including whitespace and whole-array validation", () => {
		expect(validateGuidanceFields({ promptSnippet: " ", promptGuidelines: [" "], description: "D", extra: true })).toEqual({ promptSnippet: " ", promptGuidelines: [" "], description: "D" });
		expect(validateGuidanceFields({ promptSnippet: "", promptGuidelines: ["valid", ""], description: 5 })).toEqual({});
		expect(validateGuidanceFields({ promptGuidelines: [] })).toEqual({});
		expect(validateGuidanceFields(null)).toEqual({});
	});
});

describe("getMaxWidgetLines", () => {
	it("returns the default when no config is present", () => {
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
	});
	it("returns the default when the field is absent", () => {
		writeConfigFile(JSON.stringify({}));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
	});
	it("returns the default for non-number values", () => {
		writeConfigFile(JSON.stringify({ maxWidgetLines: "twelve" }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
	});
	it("returns the default for values below the floor (2, 1, 0, -5)", () => {
		writeConfigFile(JSON.stringify({ maxWidgetLines: 2 }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
		writeConfigFile(JSON.stringify({ maxWidgetLines: 1 }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
		writeConfigFile(JSON.stringify({ maxWidgetLines: 0 }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
		writeConfigFile(JSON.stringify({ maxWidgetLines: -5 }));
		expect(getMaxWidgetLines()).toBe(DEFAULT_MAX_WIDGET_LINES);
	});
	it("returns the configured value at the floor (3) and above — no ceiling", () => {
		writeConfigFile(JSON.stringify({ maxWidgetLines: 3 }));
		expect(getMaxWidgetLines()).toBe(3);
		writeConfigFile(JSON.stringify({ maxWidgetLines: 8 }));
		expect(getMaxWidgetLines()).toBe(8);
		writeConfigFile(JSON.stringify({ maxWidgetLines: 50 }));
		expect(getMaxWidgetLines()).toBe(50);
	});
});

describe("loadConfig — collapseKey", () => {
	it("surfaces a user-set collapseKey unchanged (validation happens in resolveCollapseKey, not at load)", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "alt+o" }));
		expect(loadConfig().collapseKey).toBe("alt+o");
	});

	it("passes invalid specs through verbatim — the resolver, not the loader, decides validity", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "ctr+t" }));
		expect(loadConfig().collapseKey).toBe("ctr+t");
	});
});

describe("resolveCollapseKey", () => {
	it("returns the default (ctrl+shift+t) when no config is present", () => {
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("returns the default when the field is absent", () => {
		writeConfigFile(JSON.stringify({}));
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("returns the default when the field is empty or blank", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "" }));
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
		writeConfigFile(JSON.stringify({ collapseKey: "   " }));
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("returns COLLAPSE_KEY_OFF when set to the sentinel", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "off" }));
		expect(resolveCollapseKey()).toBe(COLLAPSE_KEY_OFF);
	});

	it("returns the lowercased validated spec when valid", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "Alt+O" }));
		expect(resolveCollapseKey()).toBe("alt+o");
	});

	it("returns the default when the spec is invalid", () => {
		writeConfigFile(JSON.stringify({ collapseKey: "ctr+t" }));
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("returns the default for non-string values", () => {
		writeConfigFile(JSON.stringify({ collapseKey: 123 }));
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
		writeConfigFile(JSON.stringify({ collapseKey: true }));
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
		writeConfigFile(JSON.stringify({ collapseKey: ["alt+o"] }));
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
		writeConfigFile(JSON.stringify({ collapseKey: { key: "alt+o" } }));
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("is arg-less and reads config fresh on every call (no caching, parity with getMaxWidgetLines)", () => {
		// First call: no config → default.
		expect(resolveCollapseKey()).toBe(DEFAULT_COLLAPSE_KEY);
		writeConfigFile(JSON.stringify({ collapseKey: "off" }));
		// Second call: reads the just-written value without any re-import.
		expect(resolveCollapseKey()).toBe(COLLAPSE_KEY_OFF);
		writeConfigFile(JSON.stringify({ collapseKey: "alt+o" }));
		expect(resolveCollapseKey()).toBe("alt+o");
	});
});

describe("isValidCollapseKeySpec", () => {
	it("accepts valid specs", () => {
		expect(isValidCollapseKeySpec("ctrl+shift+t")).toBe(true);
		expect(isValidCollapseKeySpec("alt+o")).toBe(true);
		expect(isValidCollapseKeySpec("escape")).toBe(true);
		expect(isValidCollapseKeySpec("f5")).toBe(true);
		expect(isValidCollapseKeySpec("ctrl+]")).toBe(true);
	});

	it("rejects empty spec", () => {
		expect(isValidCollapseKeySpec("")).toBe(false);
	});

	it("rejects leading, trailing, and double '+'", () => {
		expect(isValidCollapseKeySpec("+")).toBe(false);
		expect(isValidCollapseKeySpec("+t")).toBe(false);
		expect(isValidCollapseKeySpec("ctrl+")).toBe(false);
		expect(isValidCollapseKeySpec("ctrl++t")).toBe(false);
	});

	it("rejects unknown modifiers", () => {
		expect(isValidCollapseKeySpec("win+t")).toBe(false);
	});

	it("rejects duplicate modifiers", () => {
		expect(isValidCollapseKeySpec("ctrl+ctrl+t")).toBe(false);
	});

	it("rejects typo bases (multi-char non-special)", () => {
		// 'ctr' is 3 chars and not a named special key → a typo for 'ctrl'.
		expect(isValidCollapseKeySpec("ctr+t")).toBe(false);
	});
});
