import { describe, expect, it, vi } from "vitest";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { collectStartupContext, readStartupContext, type StartupContextInput } from "../src/feature/shell/startup-context.ts";
import { attachStartupHost, disposeStartupHost, getStartupHost } from "../src/feature/shell/startup-state.ts";

const message = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as any;
const base = (): StartupContextInput => ({ systemPrompt: "", files: [], skills: [], messages: [], model: { provider: "p", id: "m", contextWindow: 200_000 }, declarations: [], hiddenDeclarations: [] });
const total = (snapshot: ReturnType<typeof collectStartupContext>) => {
	expect(snapshot.usedEstimate).toBe(snapshot.sources.reduce((sum, item) => sum + item.tokens, 0));
	for (const source of snapshot.sources) if (source.children) expect(source.tokens).toBe(source.children.reduce((sum, item) => sum + item.tokens, 0));
};

describe("startup context attribution", () => {
	it("partitions repeated and overlapping file spans without duplicating prompt bytes", () => {
		const input = { ...base(), systemPrompt: "12345678\n12345678\nTAIL", files: [
			{ path: "SYSTEM.md", content: "12345678" }, { path: "APPEND_SYSTEM.md", content: "12345678" },
			{ path: "AGENTS.md", content: "3456" }, { path: "duplicate", content: "12345678" },
		] };
		const snapshot = collectStartupContext(input);
		expect(snapshot.usedEstimate).toBe(Math.ceil(input.systemPrompt.length / 4));
		expect(snapshot.sources.find((source) => source.id === "files")?.children).toHaveLength(2);
		expect(snapshot.sources.find((source) => source.id === "system")?.tokens).toBeGreaterThan(0);
		total(snapshot);
	});
	it("charges a duplicated source ID only once even when the same text occurs twice", () => {
		const snapshot = collectStartupContext({ ...base(), systemPrompt: "DUPLICATE DUPLICATE", files: [
			{ path: "/same", content: "DUPLICATE" }, { path: "/same", content: "DUPLICATE" },
		] });
		expect(snapshot.sources.find((source) => source.id === "files")?.children).toEqual([
			{ id: "file:/same", category: "files", label: "/same", tokens: 3 },
		]);
		expect(snapshot.sources.find((source) => source.id === "system")?.tokens).toBeGreaterThan(0);
		total(snapshot);
	});
	it("attributes only escaped advertised skill blocks; disabled skills and missing text cost zero", () => {
		const skill = { name: "foo<&", description: "read > write", filePath: "/tmp/skill", baseDir: "/tmp", sourceInfo: { path: "/tmp/skill", source: "local", scope: "user" as const, origin: "top-level" as const }, disableModelInvocation: false };
		const text = formatSkillsForPrompt([skill]);
		const snapshot = collectStartupContext({ ...base(), systemPrompt: text, skills: [skill, { ...skill, name: "off", filePath: "/off", disableModelInvocation: true }] });
		expect(snapshot.sources.find((source) => source.id === "skills")?.children).toHaveLength(1);
		expect(snapshot.usedEstimate).toBe(Math.ceil(text.length / 4));
		const missing = collectStartupContext({ ...base(), skills: [skill] });
		expect(missing.usedEstimate).toBe(0);
		total(snapshot);
	});
	it("counts prepared visible declarations, never the unused registry or deferred schemas", () => {
		const input = { ...base(), declarations: [
			{ name: "codemode", description: "deferred tool schema once", parameters: { type: "object" } },
			{ name: "mcp__search__query", description: "query", parameters: { type: "object" } },
			{ name: "hidden", description: "no", parameters: {} },
		], hiddenDeclarations: ["hidden"], registry: [
			{ name: "mcp__search__query", namespace: { name: "mcp__search" }, sourceInfo: { path: "mcp:search/lookup" } },
			{ name: "unused", sourceInfo: { path: "builtin:unused" } },
		] };
		const snapshot = collectStartupContext(input);
		expect(snapshot.sources.find((source) => source.id === "tools")?.children?.map((item) => item.label)).toEqual(["codemode"]);
		expect(snapshot.sources.find((source) => source.id === "mcp:search")?.children?.map((item) => item.label)).toEqual(["mcp__search__query"]);
		expect(snapshot.usedEstimate).toBe(input.declarations.slice(0, 2).reduce((sum, item) => sum + Math.ceil(JSON.stringify(item).length / 4), 0));
		total(snapshot);
	});
	it("uses projected model messages, excludes old system and !!, counts images without usage or details", () => {
		const snapshot = collectStartupContext({ ...base(), messages: [
			{ role: "system", content: "historic system", timestamp: 0 },
			{ role: "bashExecution", command: "!! secret", output: "secret", excludeFromContext: true, timestamp: 0 },
			message("hello"),
			{ role: "user", content: [{ type: "image", data: "", mimeType: "image/png" }], timestamp: 0 },
			{ role: "toolResult", toolCallId: "1", toolName: "test", content: [{ type: "text", text: "result" }], details: "x".repeat(10000), timestamp: 0 },
		] as any });
		expect(snapshot.stage).toBe("context");
		expect(snapshot.usedEstimate).toBeGreaterThanOrEqual(1200);
		expect(snapshot.usedEstimate).toBeLessThan(1250);
		total(snapshot);
	});
	it("handles zero, unknown and changed windows, true overages, and partial adapters", () => {
		const zero = collectStartupContext({ ...base(), model: { id: "x", contextWindow: 0 } });
		expect(zero.usedEstimate).toBe(0);
		expect(zero.caveats).toContain("window unknown");
		const over = collectStartupContext({ ...base(), systemPrompt: "x".repeat(100), model: { id: "x", contextWindow: 10 } });
		expect(over.usedEstimate).toBe(25);
		expect(over.caveats).toContain("over by ~15");
		expect(collectStartupContext({ ...base(), declarations: undefined }).caveats).toContain("Tool declarations unavailable.");
		expect(collectStartupContext({}).stage).toBe("unavailable");
		expect(readStartupContext({}).stage).toBe("initializing");
	});
	it("treats a known empty prompt and catalogues as available, but missing prompt or metadata as unavailable", () => {
		const empty = collectStartupContext(base());
		expect(empty.attribution).toEqual({ files: true, skills: true });
		expect(empty.usedEstimate).toBe(0);
		expect(collectStartupContext({ ...base(), files: undefined }).attribution).toEqual({ files: false, skills: true });
		expect(collectStartupContext({ ...base(), skills: undefined }).attribution).toEqual({ files: true, skills: false });
		expect(collectStartupContext({ ...base(), systemPrompt: undefined }).attribution).toEqual({ files: false, skills: false });
	});
	it("keeps valid attribution despite missing projected history or prepared declarations", () => {
		const partial = collectStartupContext({ ...base(), systemPrompt: "abcd", files: [{ path: "SYSTEM.md", content: "abcd" }],
			messages: undefined, declarations: undefined, hiddenDeclarations: undefined });
		expect(partial.stage).toBe("unavailable");
		expect(partial.attribution).toEqual({ files: true, skills: true });
		expect(partial.sources.find((source) => source.id === "files")?.children?.[0]?.tokens).toBe(1);
		expect(partial.caveats).toContain("Tool declarations unavailable.");
		total(partial);
	});
	it("distinguishes absent host loaders from known-empty metadata and retains partial categories", () => {
		const session: any = { systemPrompt: "", model: { id: "x", contextWindow: 1000 }, agent: { state: { tools: [] } },
			_hiddenDeclarations: new Set(), sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
			resourceLoader: { getSystemPromptSource: () => undefined, getSystemPrompt: () => "", getAppendSystemPromptSources: () => [],
				getAppendSystemPrompt: () => [], getAgentsFiles: () => ({ agentsFiles: [] }), getSkills: () => ({ skills: [] }) } };
		const mode = { session };
		expect(readStartupContext(mode).attribution).toEqual({ files: true, skills: true });
		session.extensionRunner = { createCommandContext: () => ({ getSystemPromptOptions: () => ({ contextFiles: [{}], skills: [{}] }) }) };
		expect(readStartupContext(mode).attribution).toEqual({ files: true, skills: true }); // Malformed options use the loader.
		session.extensionRunner = { createCommandContext: () => { throw Error("not ready"); } };
		expect(readStartupContext(mode).attribution).toEqual({ files: true, skills: true });
		delete session.resourceLoader.getAgentsFiles;
		expect(readStartupContext(mode).attribution).toEqual({ files: false, skills: true });
		delete session.resourceLoader.getSkills;
		expect(readStartupContext(mode).attribution).toEqual({ files: false, skills: false });
		session.resourceLoader.getSkills = () => ({ skills: [] });
		delete session.sessionManager.buildSessionProjection;
		delete session.agent.state.tools;
		expect(readStartupContext(mode).attribution).toEqual({ files: false, skills: true });
		session.resourceLoader.getAgentsFiles = () => ({ agentsFiles: [] });
		delete session._hiddenDeclarations;
		const partial = readStartupContext(mode);
		expect(partial.stage).toBe("unavailable");
		expect(partial.attribution).toEqual({ files: true, skills: true });
		expect(partial.caveats).toContain("Tool declarations unavailable.");
	});
	it("uses the prepared hidden set rather than stale base command options", () => {
		const session = {
			systemPrompt: "", model: { id: "x", contextWindow: 200_000 },
			agent: { state: { tools: [{ name: "secret", description: "hidden", parameters: {} }, { name: "visible", description: "shown", parameters: {} }] } },
			_hiddenDeclarations: new Set(["secret"]),
			extensionRunner: { createCommandContext: () => ({ getSystemPromptOptions: () => ({ hiddenTools: [], selectedTools: [] }) }) },
			sessionManager: { buildSessionProjection: () => ({ messages: [] }) },
			getAllTools: () => [],
		};
		const snapshot = readStartupContext({ session });
		expect(snapshot.sources.find((source) => source.id === "tools")?.children?.map((child) => child.label)).toEqual(["visible"]);
	});
	it("reads current projection and memoizes only unchanged snapshots", () => {
		const projection = vi.fn(() => ({ messages: [message("hello")] }));
		const session = { systemPrompt: "1234", model: { id: "x", contextWindow: 1000 }, agent: { state: { tools: [] } }, _hiddenDeclarations: new Set(),
			sessionManager: { buildSessionProjection: projection }, resourceLoader: { getSystemPromptSource: () => undefined, getSystemPrompt: () => "", getAppendSystemPromptSources: () => [], getAppendSystemPrompt: () => [], getAgentsFiles: () => ({ agentsFiles: [] }), getSkills: () => ({ skills: [] }) }, getAllTools: () => [] };
		const mode = { session };
		expect(readStartupContext(mode)).toBe(readStartupContext(mode));
		session.model.contextWindow = 2000;
		expect(readStartupContext(mode).contextWindow).toBe(2000);
		expect(projection).toHaveBeenCalledTimes(3);
	});
	it("replaces session lookup without leaking a previous mode snapshot", () => {
		let id = "first";
		const mode = { sessionManager: { getSessionId: () => id }, session: {} };
		const first = attachStartupHost(mode);
		expect(getStartupHost("first")).toBe(first);
		first.contextSnapshot = collectStartupContext(base());
		id = "second";
		const next = attachStartupHost(mode);
		expect(next).toBe(first);
		expect(next.contextSnapshot).toBeUndefined();
		expect(next.generation).toBe(1);
		expect(getStartupHost("first")).toBeUndefined();
		expect(getStartupHost("second")).toBe(next);
		disposeStartupHost(mode);
		expect(getStartupHost("second")).toBeUndefined();
	});
});
