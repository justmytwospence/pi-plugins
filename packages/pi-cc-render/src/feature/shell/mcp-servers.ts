import { readFileSync, statSync } from "node:fs";

/**
 * What the startup listing's MCP section knows about each server: the level it is configured at and, as far
 * as pi's public surface tells, whether it is connected, still connecting, needs a sign-in or failed.
 *
 * Pi keeps connections in the built-in MCP extension's closure. Its command completions and non-TUI status
 * command project that live state without connecting or changing anything. We read those projections only
 * for `builtin:mcp`; tools alone prove neither connection nor disconnection. Files supply configuration scope.
 */

export type McpLevel = "project" | "user" | "extension";
export type McpStatus = "connected" | "connecting" | "needs-auth" | "failed" | "disabled" | "disconnected" | "unknown";
export type McpObservation = { status: McpStatus; tools?: number; detail?: string };

/** `enabled: false` is a configured server switched off (`"enabled": false`); pi lists it but never connects it. */
export type McpEntry = { name: string; level: McpLevel; enabled?: boolean };

/** `-` and `_` name the same server for pi (its tool namespace swaps them). */
export function normalizeMcpName(name: string): string {
	return name.trim().replace(/-/g, "_");
}

type RawServers = Record<string, unknown>;

function readServers(file: string): RawServers {
	try {
		const servers = (JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { mcpServers?: unknown })?.mcpServers;
		return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as RawServers) : {};
	} catch {
		return {};
	}
}

/** Stat only on polling ticks; parse changed files once, never during rendering. */
export class McpConfigCache {
	private files = new Map<string, { signature: string; servers: RawServers }>();

	read(file: string): RawServers {
		let signature = "missing";
		try {
			const stat = statSync(file);
			signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		} catch { /* Missing or unreadable configuration is reported by pi. */ }
		const previous = this.files.get(file);
		if (previous?.signature === signature) return previous.servers;
		const servers = readServers(file);
		this.files.set(file, { signature, servers });
		return servers;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);

/** Pi's rule: an entry with no command, url or type only overrides a server defined elsewhere. */
const isOverride = (value: Record<string, unknown>): boolean =>
	value.command === undefined && value.url === undefined && value.type === undefined;

/**
 * Every configured server and the level it belongs to, switched-off ones included (`enabled: false`). The user file defines servers; the trusted project file
 * defines its own, or overrides a user server (an override that switches a disabled one on makes it a
 * project server: it runs only because of this project). Extension-registered names fill in the rest.
 */
export function loadMcpEntries(options: {
	userFile: string;
	projectFile?: string;
	registered?: Array<string | { name: string; config?: { enabled?: boolean } }>;
	cache?: McpConfigCache;
}): McpEntry[] {
	const read = (file: string) => options.cache ? options.cache.read(file) : readServers(file);
	const servers = new Map<string, { name: string; level: McpLevel; enabled: boolean }>();
	const hasNamespace = (name: string) => [...servers.keys()].some((key) => normalizeMcpName(key) === normalizeMcpName(name));
	const add = (name: string, level: McpLevel, enabled: boolean) => {
		// Pi rejects namespace collisions, rather than treating dash/underscore aliases as config overrides.
		if (servers.has(name) || !hasNamespace(name)) servers.set(name, { name, level, enabled });
	};
	for (const [name, raw] of Object.entries(read(options.userFile))) {
		if (isObject(raw)) add(name, "user", raw.enabled !== false);
	}
	if (options.projectFile) {
		for (const [name, raw] of Object.entries(read(options.projectFile))) {
			if (!isObject(raw)) continue;
			const base = servers.get(name);
			if (!isOverride(raw)) add(name, "project", raw.enabled !== false);
			else if (base && typeof raw.enabled === "boolean") {
				servers.set(name, { ...base, enabled: raw.enabled, level: raw.enabled && !base.enabled ? "project" : base.level });
			}
		}
	}
	for (const registration of options.registered ?? []) {
		const name = typeof registration === "string" ? registration : registration.name;
		const enabled = typeof registration === "string" || registration.config?.enabled !== false;
		if (!hasNamespace(name)) add(name, "extension", enabled);
	}
	return [...servers.values()].map(({ name, level, enabled }) => (enabled ? { name, level } : { name, level, enabled: false }));
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
export function parseOutcomeMessage(message: string): { name: string; state: McpStatus } | undefined {
	const signedIn = /^Signed in to MCP server "(.+)" \(/.exec(message);
	if (signedIn) return { name: signedIn[1]!, state: "connected" };
	const signedOut = /^Signed out of MCP server "(.+)"\.$/.exec(message);
	if (signedOut) return { name: signedOut[1]!, state: "needs-auth" };
	const reconnected = /^Reconnected to MCP server "(.+)" \((.*)\)\.$/.exec(message);
	if (!reconnected) return undefined;
	const state = reconnected[2]!;
	return {
		name: reconnected[1]!,
		state: parseMcpDescription(state)?.status ?? "unknown",
	};
}

/** Registered tools, not a connection/health signal (withdrawn tools can remain registered as hidden). */
export function toolCounts(tools: readonly { namespace?: { name?: string } }[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const tool of tools) {
		const namespace = String(tool?.namespace?.name ?? "");
		if (!namespace.startsWith("mcp__") || namespace.length <= 5) continue;
		const name = normalizeMcpName(namespace.slice(5));
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return counts;
}

/** Pi 1.2–1.4's describeState() (completion) and formatStatus() (non-TUI command) vocabulary. */
export function parseMcpDescription(text: string): McpObservation | undefined {
	if (/^connected(?:$|[ ,·])/.test(text)) {
		const count = /(?:·|,) (\d+) tools?\b/.exec(text);
		return { status: "connected", ...(count ? { tools: Number(count[1]) } : {}) };
	}
	if (/^(starting|connecting)(?:$|[ …(])/.test(text)) return { status: "connecting" };
	if (/^needs sign-in\b/.test(text)) return { status: "needs-auth" };
	if (/^disabled(?:$| )/.test(text)) return { status: "disabled" };
	if (/^(disconnected|closed)(?:$|[ ,(])/.test(text)) return { status: "disconnected" };
	if (/^failed(?:$|[: (])/.test(text)) {
		const detail = /^failed: (.+)/.exec(text)?.[1];
		return { status: "failed", ...(detail ? { detail } : {}) };
	}
	return undefined;
}

/** Only top-level server lines count; errors/configuration notices cannot masquerade as another server. */
export function parseMcpStatus(message: string): Map<string, McpObservation> | undefined {
	if (message.startsWith("No MCP servers configured.")) return new Map();
	const statuses = new Map<string, McpObservation>();
	let last: McpObservation | undefined;
	for (const line of message.split("\n")) {
		if (/^    \S/.test(line) && last?.status === "failed" && !last.detail) last.detail = line.trim();
		if (/^\s/.test(line)) continue;
		last = undefined;
		const match = /^([\w-]+): (.+) \((?:direct|codemode|deferred|hidden)\)$/.exec(line);
		if (!match) continue;
		last = parseMcpDescription(match[2]!) ?? { status: "unknown" };
		statuses.set(normalizeMcpName(match[1]!), last);
	}
	return statuses.size > 0 ? statuses : undefined;
}

/**
 * Compatibility adapter, not a connection manager. The built-in MCP command owns the only live status
 * projection available in Pi 1.2–1.4. Completions return immediately, including connecting/resource-only
 * servers; its read-only print handler also lists disabled entries, but waits for startup to settle.
 * Never invoke a replacement extension's command, open a manager, reconnect, or await this in render().
 */
export class McpStatusReader {
	private runner: any;
	private handler: unknown;
	private generation = 0;
	private full = new Map<string, McpObservation>();
	private completions = new Map<string, McpObservation>();
	private fullPending = false;
	private completionsPending = false;

	get statuses(): ReadonlyMap<string, McpObservation> {
		return new Map([...this.full, ...this.completions]);
	}

	dispose(): void {
		this.generation++;
		this.runner = undefined;
		this.handler = undefined;
		this.full.clear();
		this.completions.clear();
		this.fullPending = this.completionsPending = false;
	}

	refresh(runner: any, changed: () => void): void {
		let command: any;
		try {
			command = runner?.getCommand?.("mcp");
		} catch { /* An old runner can be invalid during reload. */ }
		if (command?.sourceInfo?.path !== "builtin:mcp" || typeof command.handler !== "function") command = undefined;
		if (runner !== this.runner || command?.handler !== this.handler) {
			this.dispose();
			this.runner = runner;
			this.handler = command?.handler;
			changed();
		}
		if (!command) return;
		const generation = this.generation;
		if (!this.completionsPending && typeof command.getArgumentCompletions === "function") {
			this.completionsPending = true;
			void Promise.resolve().then(() => generation === this.generation ? command.getArgumentCompletions("reconnect ") : null).then((items) => {
				if (generation !== this.generation) return;
				this.completions = new Map();
				for (const item of Array.isArray(items) ? items : []) {
					if (typeof item?.label !== "string" || typeof item?.description !== "string") continue;
					this.completions.set(normalizeMcpName(item.label), parseMcpDescription(item.description) ?? { status: "unknown" });
				}
			}).catch(() => {
				if (generation === this.generation) this.completions.clear();
			}).finally(() => {
				if (generation !== this.generation) return;
				this.completionsPending = false;
				changed();
			});
		}
		if (!this.fullPending) {
			this.fullPending = true;
			void Promise.resolve().then(async () => {
				if (generation !== this.generation) return;
				// A fresh supplied context only: never mutate the live UI or runner mode.
				const ctx = runner.createCommandContext();
				let snapshot: Map<string, McpObservation> | undefined;
				await command.handler("", {
					...ctx, mode: "print",
					ui: { ...ctx.ui, notify: (text: string) => { snapshot = parseMcpStatus(text); } },
				});
				if (generation === this.generation) this.full = snapshot ?? new Map();
			}).catch(() => {
				if (generation === this.generation) this.full.clear();
			}).finally(() => {
				if (generation !== this.generation) return;
				this.fullPending = false;
				changed();
			});
		}
	}
}

/** Notification fallback only. Live command projections take precedence over historical notifications. */
export class McpState {
	observations = new Map<string, McpObservation>();
	mounted = false;

	mount(): void {
		this.mounted = true;
		this.observations.clear();
	}

	record(report: McpReport): void {
		for (const [name, problem] of report.problems) this.observations.set(name, problem);
	}

	outcome(name: string, state: McpStatus): void {
		this.observations.set(normalizeMcpName(name), { status: state });
	}

	status(name: string): McpStatus | undefined {
		return this.observations.get(normalizeMcpName(name))?.status;
	}

	detail(name: string): string | undefined {
		return this.observations.get(normalizeMcpName(name))?.detail;
	}
}

/** The one state of this module instance (a reload loads a new one, which starts clean). */
export const mcpState = new McpState();
