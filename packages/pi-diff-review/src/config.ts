/** Settings from ~/.pi/agent/diff-review.json (every key optional). */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
	/** "auto" picks split when the terminal is at least `splitMinWidth` columns wide. */
	view: "auto" | "split" | "unified";
	splitMinWidth: number;
	wrap: boolean;
	/** Show the file list beside the diff (on terminals 100 columns or wider). */
	fileList: boolean;
	/** Files with more diff lines start collapsed. */
	maxFileLines: number;
	/** Lines of context around each change. */
	context: number;
	/** Inside herdr, zoom the pane while the review is open. */
	zoom: boolean;
}

export const DEFAULTS: Config = {
	view: "auto",
	splitMinWidth: 160,
	wrap: true,
	fileList: true,
	maxFileLines: 1500,
	context: 3,
	zoom: true,
};

export function configPath(): string {
	const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(dir, "diff-review.json");
}

export function loadConfig(path = configPath()): Config {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
		const c = { ...DEFAULTS };
		if (raw.view === "auto" || raw.view === "split" || raw.view === "unified") c.view = raw.view;
		for (const k of ["splitMinWidth", "maxFileLines", "context"] as const) {
			if (typeof raw[k] === "number" && raw[k] >= 0) c[k] = raw[k];
		}
		for (const k of ["wrap", "fileList", "zoom"] as const) {
			if (typeof raw[k] === "boolean") c[k] = raw[k];
		}
		return c;
	} catch {
		return { ...DEFAULTS };
	}
}
