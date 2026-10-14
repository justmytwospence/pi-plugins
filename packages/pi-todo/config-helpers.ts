/**
 * Config-reading and guidance helpers adapted from juicesharp/rpiv-mono,
 * packages/rpiv-config/config.ts at 7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f.
 * Copyright (c) 2026 juicesharp, MIT (see LICENSE and UPSTREAM.json).
 * Only the read/validation surface needed by pi-todo is retained.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function expandTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** Invalid relative XDG paths fall back to ~/.config, as in upstream. */
function legacyConfigDir(): string {
	const xdg = process.env.XDG_CONFIG_HOME?.trim();
	const expanded = xdg ? expandTilde(xdg) : "";
	return isAbsolute(expanded) ? expanded : join(homedir(), ".config");
}

/** Missing, malformed, and non-object JSON fail soft; malformed JSON warns. */
export function loadJsonConfig<T>(path: string): T {
	if (!existsSync(path)) return {} as T;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch (error) {
		console.warn(`pi-todo: invalid JSON at ${path}, using default ({}) — ${(error as Error).message}`);
		return {} as T;
	}
}

/** A present XDG file wins even when invalid; only absence enables fallback. */
export function loadLegacyConfig<T>(): T {
	const xdgPath = join(legacyConfigDir(), "rpiv-todo", "config.json");
	return loadJsonConfig<T>(
		existsSync(xdgPath) ? xdgPath : join(homedir(), ".config", "rpiv-todo", "config.json"),
	);
}

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
	description?: string;
}

/** Upstream semantics: valid fields override individually; arrays replace. */
export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
		result.promptSnippet = g.promptSnippet;
	}
	if (
		Array.isArray(g.promptGuidelines) &&
		g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = g.promptGuidelines;
	}
	if (typeof g.description === "string" && g.description.length > 0) {
		result.description = g.description;
	}
	return result;
}
