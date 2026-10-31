import { convertToLlm, estimateTokens as estimateMessageTokens, formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import type { ContextCategory } from "./startup-style.ts";

export type ContextSource = { id: string; category: ContextCategory; label: string; tokens: number; children?: ContextSource[] };
export type StartupContextSnapshot = {
	stage: "initializing" | "starting" | "context" | "unavailable";
	modelLabel: string;
	contextWindow?: number;
	usedEstimate: number;
	sources: ContextSource[];
	/** True only when the effective prompt and that category's source metadata are known. */
	attribution: { files: boolean; skills: boolean };
	caveats: string[];
};
export type LoadedContextFile = { path: string; content: string };
export type StartupSkill = { name: string; description: string; filePath: string; disableModelInvocation?: boolean };
export type PreparedDeclaration = { name: string; description: string; parameters: unknown };
export type StartupContextInput = {
	systemPrompt?: string;
	files?: LoadedContextFile[];
	skills?: StartupSkill[];
	skillReader?: "read" | "bash" | "indirect";
	/** Undefined means attribution is unavailable, not that all registered tools are exposed. */
	declarations?: PreparedDeclaration[];
	hiddenDeclarations?: ReadonlySet<string> | readonly string[];
	registry?: Array<{ name: string; sourceInfo?: { path?: string; source?: string }; namespace?: { name?: string } | string }>;
	/** The canonical session projection, before convertToLlm. */
	messages?: Parameters<typeof convertToLlm>[0];
	model?: { provider?: string; id?: string; contextWindow?: number };
};
const CAVEAT = "Estimated from loaded content; request hooks and provider framing may add tokens.";
const charsToTokens = (text: string) => Math.ceil(text.length / 4);
const labelOf = (model?: StartupContextInput["model"]) => model?.id ? `${model.provider ? `${model.provider}/` : ""}${model.id}` : "Model unknown";

/** Allocate exact, non-overlapping spans of the effective prompt; all unmatched text stays System. */
export function collectStartupContext(input: StartupContextInput): StartupContextSnapshot {
	const window = input.model?.contextWindow;
	const contextWindow = typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
	const caveats = [CAVEAT];
	if (!contextWindow) caveats.push("window unknown");
	const sources: ContextSource[] = [];
	const attribution = {
		files: typeof input.systemPrompt === "string" && Array.isArray(input.files),
		skills: typeof input.systemPrompt === "string" && Array.isArray(input.skills),
	};
	let stage: StartupContextSnapshot["stage"] = "starting";
	if (typeof input.systemPrompt !== "string" || input.messages === undefined) {
		stage = "unavailable";
		caveats.push("Prompt or projected history unavailable.");
	}
	const prompt = input.systemPrompt ?? "";
	type Candidate = { id: string; category: ContextCategory; label: string; text: string };
	const candidates: Candidate[] = (input.files ?? []).filter((file) => file.content).map((file) => ({
		id: `file:${file.path}`, category: "files", label: file.path, text: file.content,
	}));
	const skills = (input.skills ?? []).filter((skill) => !skill.disableModelInvocation);
	if (skills.length) {
		const formatted = formatSkillsForPrompt(skills as Parameters<typeof formatSkillsForPrompt>[0], input.skillReader ?? "read");
		// Extract the exact escaped catalogue blocks, not the contents of SKILL.md.
		const blocks = [...formatted.matchAll(/  <skill>\n[\s\S]*?\n  <\/skill>/g)];
		for (let i = 0; i < skills.length; i++) {
			if (blocks[i]) candidates.push({ id: `skill:${skills[i]!.filePath}`, category: "skills", label: skills[i]!.name, text: blocks[i]![0] });
		}
	}
	const occupied = new Uint8Array(prompt.length);
	const spans: Array<{ start: number; end: number; candidate: Candidate }> = [];
	const assignedIds = new Set<string>();
	for (const candidate of candidates.sort((a, b) => b.text.length - a.text.length || a.id.localeCompare(b.id))) {
		if (assignedIds.has(candidate.id)) continue;
		let offset = 0;
		while (candidate.text.length && offset <= prompt.length - candidate.text.length) {
			const start = prompt.indexOf(candidate.text, offset);
			if (start < 0) break;
			const end = start + candidate.text.length;
			if (!occupied.subarray(start, end).some(Boolean)) {
				occupied.fill(1, start, end);
				spans.push({ start, end, candidate });
				assignedIds.add(candidate.id);
				break; // Each source ID contributes at most once even when metadata repeats.
			}
			offset = end;
		}
	}
	const allocated = new Map<string, ContextSource>();
	const intervals: Array<{ start: number; end: number; candidate?: Candidate }> = [];
	let cursor = 0;
	for (const span of spans.sort((a, b) => a.start - b.start)) {
		if (span.start > cursor) intervals.push({ start: cursor, end: span.start });
		intervals.push(span);
		cursor = span.end;
	}
	if (cursor < prompt.length) intervals.push({ start: cursor, end: prompt.length });
	let systemTokens = 0;
	for (const interval of intervals) {
		const tokens = Math.ceil(interval.end / 4) - Math.ceil(interval.start / 4);
		if (!interval.candidate) { systemTokens += tokens; continue; }
		const { id, category, label } = interval.candidate;
		const source = allocated.get(id) ?? { id, category, label, tokens: 0 };
		source.tokens += tokens;
		allocated.set(id, source);
	}
	if (systemTokens) sources.push({ id: "system", category: "system", label: "System prompt", tokens: systemTokens });
	for (const category of ["files", "skills"] as const) {
		const children = [...allocated.values()].filter((item) => item.category === category && item.tokens > 0);
		if (children.length) sources.push({ id: category, category, label: category === "files" ? "Files" : "Skills", tokens: children.reduce((n, item) => n + item.tokens, 0), children });
	}
	if (!input.declarations || !input.hiddenDeclarations) caveats.push("Tool declarations unavailable.");
	else {
		const hidden = new Set(input.hiddenDeclarations);
		const registry = new Map(input.registry?.map((item) => [item.name, item]) ?? []);
		const groups = new Map<string, ContextSource>();
		for (const tool of input.declarations) {
			if (hidden.has(tool.name)) continue;
			const tokens = charsToTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
			const metadata = registry.get(tool.name);
			const mcpName = tool.name.match(/^mcp__(.+?)__(?:.+)$/)?.[1];
			const namespace = typeof metadata?.namespace === "string" ? metadata.namespace : metadata?.namespace?.name;
			const mcp = !!mcpName || namespace?.startsWith("mcp__") || metadata?.sourceInfo?.source === "mcp" || metadata?.sourceInfo?.path?.startsWith("mcp:");
			const category = mcp ? "mcp" : "tools";
			const server = namespace?.match(/^mcp__(.+)$/)?.[1] || metadata?.sourceInfo?.path?.match(/^mcp:(.+?)(?:\/|$)/)?.[1] || mcpName;
			const key = mcp ? `mcp:${server || "unknown"}` : "tools";
			const group = groups.get(key) ?? { id: key, category, label: mcp ? server || "MCP" : "Tools", tokens: 0, children: [] };
			group.tokens += tokens;
			group.children!.push({ id: `tool:${tool.name}`, category, label: tool.name, tokens });
			groups.set(key, group);
		}
		sources.push(...groups.values());
	}
	if (input.messages) {
		const retained = convertToLlm(input.messages).filter((message) => message.role !== "system");
		if (retained.length && stage !== "unavailable") stage = "context";
		const children = retained.map((message, index): ContextSource => ({
			id: `history:${index}`, category: "history", label: message.role, tokens: estimateMessageTokens(message),
		})).filter((child) => child.tokens > 0);
		if (children.length) sources.push({ id: "history", category: "history", label: "History", tokens: children.reduce((n, child) => n + child.tokens, 0), children });
	}
	const usedEstimate = sources.reduce((sum, source) => sum + source.tokens, 0);
	if (contextWindow && usedEstimate > contextWindow) caveats.push(`over by ~${usedEstimate - contextWindow}`);
	return { stage, modelLabel: labelOf(input.model), contextWindow, usedEstimate, sources, attribution, caveats };
}

const cache = new WeakMap<object, { digest: string; snapshot: StartupContextSnapshot }>();
/** Forget estimates on reload/shutdown even if the host reuses its session object. */
export function resetStartupContext(mode: any): void {
	if (mode?.session) cache.delete(mode.session);
}
/** Read-only host adapter; never runs request hooks or walks the filesystem. */
export function readStartupContext(mode: any): StartupContextSnapshot {
	const session = mode?.session;
	if (!session) return { stage: "initializing", modelLabel: "Model unknown", usedEstimate: 0, sources: [], attribution: { files: false, skills: false }, caveats: [CAVEAT] };
	try {
		const loader = session.resourceLoader;
		let options: any;
		try { options = session.extensionRunner?.createCommandContext?.()?.getSystemPromptOptions?.(); } catch { /* Loader fallback. */ }
		// An absent loader/getter is not an empty catalogue. Read each category independently:
		// missing tool declarations or projection must not discard valid prompt attribution.
		let files: LoadedContextFile[] | undefined;
		try {
			if (typeof loader?.getSystemPromptSource === "function" && typeof loader.getSystemPrompt === "function" &&
				typeof loader.getAppendSystemPromptSources === "function" && typeof loader.getAppendSystemPrompt === "function") {
				const systemSource = loader.getSystemPromptSource();
				const systemText = loader.getSystemPrompt();
				const appendSources = loader.getAppendSystemPromptSources();
				const appendText = loader.getAppendSystemPrompt();
				const validFiles = (value: unknown): value is LoadedContextFile[] => Array.isArray(value) &&
					value.every((file) => typeof file?.path === "string" && typeof file.content === "string");
				const agents = validFiles(options?.contextFiles) ? options.contextFiles : loader.getAgentsFiles?.()?.agentsFiles;
				if (Array.isArray(appendSources) && Array.isArray(appendText) && Array.isArray(agents) &&
					(!systemSource || (typeof systemSource.path === "string" && typeof systemText === "string")) &&
					appendSources.length === appendText.length &&
					appendSources.every((source: any) => typeof source?.path === "string") &&
					appendText.every((text: unknown) => typeof text === "string") && validFiles(agents)) {
					files = [
						...(systemSource ? [{ path: systemSource.path, content: systemText }] : []),
						...appendSources.map((source: { path: string }, index: number) => ({ path: source.path, content: appendText[index] })),
						...agents.map((file: LoadedContextFile) => ({ path: file.path, content: file.content })),
					];
				}
			}
		} catch { /* File metadata unavailable. */ }
		let skills: StartupSkill[] | undefined;
		try {
			const validSkills = (value: unknown): value is StartupSkill[] => Array.isArray(value) && value.every((skill) =>
				typeof skill?.name === "string" && typeof skill.description === "string" && typeof skill.filePath === "string");
			const catalogue = validSkills(options?.skills) ? options.skills : loader?.getSkills?.()?.skills;
			if (validSkills(catalogue)) skills = catalogue;
		} catch { /* Skill metadata unavailable. */ }
		const declarations = session.agent?.state?.tools;
		// The base command-context options can lag behind prepareLoadout's current hidden set.
		const hidden = session._hiddenDeclarations instanceof Set ? session._hiddenDeclarations : options?.hiddenTools;
		let registry: StartupContextInput["registry"];
		let messages: StartupContextInput["messages"];
		try { registry = session.getAllTools?.(); } catch { /* Unknown origin: keep visible declarations as Tools. */ }
		try { messages = session.sessionManager?.buildSessionProjection?.()?.messages; } catch { /* Mark history unavailable. */ }
		const model = session.model;
		const input: StartupContextInput = {
			systemPrompt: session.systemPrompt,
			files, skills,
			skillReader: options?.selectedTools?.includes("read") ? "read" : options?.selectedTools?.includes("bash") ? "bash" : "indirect",
			declarations: Array.isArray(declarations) ? declarations : undefined,
			hiddenDeclarations: Array.isArray(hidden) || hidden instanceof Set ? hidden : undefined,
			registry,
			messages,
			model,
		};
		const leaf = session.sessionManager?.getLeafId?.();
		const id = session.sessionManager?.getSessionId?.();
		const digest = JSON.stringify({ id, leaf, input }, (_key, value: unknown) => value instanceof Set ? [...value].sort() : value);
		const previous = cache.get(session);
		if (previous?.digest === digest) return previous.snapshot;
		const snapshot = collectStartupContext(input);
		cache.set(session, { digest, snapshot });
		return snapshot;
	} catch {
		return collectStartupContext({ model: session.model });
	}
}
