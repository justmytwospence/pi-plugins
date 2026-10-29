import { readFileSync } from "node:fs";

/**
 * What the startup listing's MCP section knows about each server: the level it is configured at and, as far
 * as pi's public surface tells, whether it is connected, still connecting, needs a sign-in or failed.
 *
 * Pi's built-in MCP extension keeps connection state private and reports problems once, as one warning
 * ("MCP servers need attention: ..."). The warning is parsed here (and kept off the screen, the section shows
 * it), connected servers are read off the tools they registered, and the levels come from the mcp.json files.
 */

export type McpLevel = "project" | "user" | "extension";
export type McpStatus = "connected" | "connecting" | "needs-auth" | "failed";

export type McpEntry = { name: string; level: McpLevel };

export type McpProblem = {
	status: "needs-auth" | "failed";
	/** First line of the failure, when pi gave one. */
	detail?: string;
	/** The server already had tools when the problem was reported, so tools appearing later prove nothing. */
	wasConnected: boolean;
};

/** Servers that stay "connecting" for this long after the listing appeared show no mark: nothing tells us more. */
export const CONNECTING_GRACE_MS = 30_000;

/** `-` and `_` name the same server for pi (its tool namespace swaps them). */
export function normalizeMcpName(name: string): string {
	return name.trim().replace(/-/g, "_");
}

type RawServers = Record<string, unknown>;

function readServers(file: string): RawServers {
	try {
		const servers = (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: unknown })?.mcpServers;
		return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as RawServers) : {};
	} catch {
		return {};
	}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Pi's rule: an entry with no command, url or type only overrides a server defined elsewhere. */
const isOverride = (value: Record<string, unknown>): boolean =>
	value.command === undefined && value.url === undefined && value.type === undefined;

/**
 * Enabled servers and the level each is active at. The user file defines servers; the trusted project file
 * defines its own, or overrides a user server (an override that switches a disabled one on makes it a
 * project server: it runs only because of this project). Extension-registered names fill in the rest.
 */
export function loadMcpEntries(options: { userFile: string; projectFile?: string; registered?: string[] }): McpEntry[] {
	const servers = new Map<string, { name: string; level: McpLevel; enabled: boolean }>();
	const add = (name: string, level: McpLevel, enabled: boolean) => servers.set(normalizeMcpName(name), { name, level, enabled });
	for (const [name, raw] of Object.entries(readServers(options.userFile))) {
		if (isObject(raw)) add(name, "user", raw.enabled !== false);
	}
	if (options.projectFile) {
		for (const [name, raw] of Object.entries(readServers(options.projectFile))) {
			if (!isObject(raw)) continue;
			const key = normalizeMcpName(name);
			const base = servers.get(key);
			if (!isOverride(raw)) add(name, "project", raw.enabled !== false);
			else if (base && typeof raw.enabled === "boolean") {
				servers.set(key, { ...base, enabled: raw.enabled, level: raw.enabled && !base.enabled ? "project" : base.level });
			}
		}
	}
	for (const name of options.registered ?? []) {
		if (!servers.has(normalizeMcpName(name))) add(name, "extension", true);
	}
	return [...servers.values()].filter((server) => server.enabled).map(({ name, level }) => ({ name, level }));
}

const ATTENTION_HEADER = "MCP servers need attention:";
const ATTENTION_FOOTER = "Run /mcp to fix.";

export type McpReport = {
	/** Server problems, by normalized name. */
	problems: Map<string, { status: "needs-auth" | "failed"; detail?: string }>;
	/** Lines about the configuration itself (`config: ...`); they belong to no server and stay a warning. */
	configLines: string[];
};

/** Reads pi's startup/attach warning; undefined for any other message. */
export function parseAttentionMessage(message: string): McpReport | undefined {
	if (!message.startsWith(ATTENTION_HEADER)) return undefined;
	const report: McpReport = { problems: new Map(), configLines: [] };
	for (const raw of message.split("\n").slice(1)) {
		const line = raw.trim();
		if (!line || line === ATTENTION_FOOTER) continue;
		if (line.startsWith("config: ")) {
			report.configLines.push(line);
			continue;
		}
		const colon = line.indexOf(": ");
		if (colon <= 0) continue;
		const name = line.slice(0, colon);
		const state = line.slice(colon + 2);
		if (state === "needs sign-in") report.problems.set(normalizeMcpName(name), { status: "needs-auth" });
		else if (state === "failed" || state.startsWith("failed: ")) {
			const detail = state.startsWith("failed: ") ? state.slice("failed: ".length).trim() : "";
			report.problems.set(normalizeMcpName(name), { status: "failed", ...(detail ? { detail } : {}) });
		}
	}
	return report;
}

/** The warning text for a report's configuration lines alone, so those are still shown. */
export function configWarning(report: McpReport): string {
	return `MCP configuration needs attention:\n${report.configLines.map((line) => `  ${line}`).join("\n")}\n${ATTENTION_FOOTER}`;
}

/** The `/mcp reconnect` and sign-in confirmations; undefined for other messages. */
export function parseOutcomeMessage(message: string): { name: string; state: "connected" | "needs-auth" | "failed" } | undefined {
	const signedIn = /^Signed in to MCP server "(.+)" \(/.exec(message);
	if (signedIn) return { name: signedIn[1]!, state: "connected" };
	const reconnected = /^Reconnected to MCP server "(.+)" \((.*)\)\.$/.exec(message);
	if (!reconnected) return undefined;
	const state = reconnected[2]!;
	return {
		name: reconnected[1]!,
		state: state.startsWith("connected") ? "connected" : state.startsWith("needs sign-in") ? "needs-auth" : "failed",
	};
}

/** Names (normalized) of the servers whose tools are registered, from `session.getAllTools()`. */
export function connectedNames(tools: readonly { namespace?: { name?: string } }[]): Set<string> {
	const connected = new Set<string>();
	for (const tool of tools) {
		const namespace = String(tool?.namespace?.name ?? "");
		if (namespace.startsWith("mcp__") && namespace.length > 5) connected.add(normalizeMcpName(namespace.slice(5)));
	}
	return connected;
}

/** What the listing has learned about the servers of one process. */
export class McpState {
	problems = new Map<string, McpProblem>();
	/** Set once a listing carries the MCP section; only then is pi's warning left to it. */
	mounted = false;
	mountedAt = 0;
	/** A report arrived since the listing appeared: servers it does not name are not "connecting" any more. */
	reported = false;

	mount(now = Date.now()): void {
		this.mounted = true;
		this.mountedAt = now;
		this.reported = false;
	}

	/** Records a warning's problems; servers the warning omits are not touched (a later attach reports only its own). */
	record(report: McpReport, connected: ReadonlySet<string>): void {
		this.reported = true;
		for (const [name, problem] of report.problems) {
			this.problems.set(name, { ...problem, wasConnected: connected.has(name) });
		}
	}

	/** Applies a reconnect or sign-in outcome. */
	outcome(name: string, state: "connected" | "needs-auth" | "failed", connected: ReadonlySet<string>): void {
		const key = normalizeMcpName(name);
		if (state === "connected") this.problems.delete(key);
		else this.problems.set(key, { status: state, wasConnected: connected.has(key) });
	}

	status(name: string, connected: ReadonlySet<string>, now = Date.now()): McpStatus | undefined {
		const key = normalizeMcpName(name);
		const problem = this.problems.get(key);
		const isConnected = connected.has(key);
		if (problem && !(isConnected && !problem.wasConnected)) return problem.status;
		if (isConnected) return "connected";
		if (this.mounted && !this.reported && now - this.mountedAt < CONNECTING_GRACE_MS) return "connecting";
		return undefined;
	}

	detail(name: string): string | undefined {
		return this.problems.get(normalizeMcpName(name))?.detail;
	}
}

/** The one state of this module instance (a reload loads a new one, which starts clean). */
export const mcpState = new McpState();
