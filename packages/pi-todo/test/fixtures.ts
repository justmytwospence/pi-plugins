/** Minimal fixtures adapted from juicesharp/rpiv-mono packages/test-utils
 * at 7c9bc924c5bfd148f36d7ebc9f7bd0a9469d633f. Copyright (c) 2026 juicesharp,
 * MIT (see ../LICENSE). No workflow or other sibling package is needed. */
import type { Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext, SessionEntry, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

export interface MockTheme {
	fg: (color: string, text: string) => string;
	bg: (color: string, text: string) => string;
	bold: (text: string) => string;
	strikethrough: (text: string) => string;
}

export function makeTheme(overrides: Partial<MockTheme> = {}): MockTheme {
	return {
		fg: (_color, text) => text,
		bg: (_color, text) => text,
		bold: (text) => text,
		strikethrough: (text) => text,
		...overrides,
	};
}

type Shortcut = { description?: string; handler: (ctx: unknown) => Promise<void> | void };
type Command = { description?: string; handler: (args: string, ctx: unknown) => Promise<void> | void };

export function createMockPi(overrides: Partial<ExtensionAPI> = {}) {
	const captured = {
		tools: new Map<string, ToolDefinition>(),
		commands: new Map<string, Command>(),
		shortcuts: new Map<string, Shortcut>(),
		events: new Map<string, Array<(...args: unknown[]) => unknown>>(),
		activeTools: [] as string[],
	};
	const pi = {
		registerTool: vi.fn((tool: ToolDefinition) => {
			captured.tools.set(tool.name, tool);
			captured.activeTools.push(tool.name);
		}),
		registerCommand: vi.fn((name: string, command: Command) => captured.commands.set(name, command)),
		registerShortcut: vi.fn((key: string, shortcut: Shortcut) => captured.shortcuts.set(key, shortcut)),
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			const handlers = captured.events.get(event) ?? [];
			handlers.push(handler);
			captured.events.set(event, handlers);
		}),
		sendMessage: vi.fn(),
		getActiveTools: vi.fn(() => [...captured.activeTools]),
		setActiveTools: vi.fn((names: string[]) => { captured.activeTools = [...names]; }),
		...overrides,
	} as unknown as ExtensionAPI;
	return { pi, captured };
}

export function createMockUI(
	overrides: Partial<Omit<ExtensionUIContext, "theme">> & { theme?: Theme | MockTheme } = {},
) {
	return {
		notify: vi.fn(),
		confirm: vi.fn(async () => true),
		input: vi.fn(async () => ""),
		select: vi.fn(async () => undefined),
		setWidget: vi.fn(),
		setStatus: vi.fn(),
		setWorkingMessage: vi.fn(),
		onTerminalInput: vi.fn(() => () => {}),
		...overrides,
	};
}

export function createMockCtx(opts: {
	hasUI?: boolean;
	cwd?: string;
	branch?: SessionEntry[];
	sessionId?: string;
	ui?: Partial<ExtensionUIContext>;
} = {}): ExtensionContext {
	const branch = opts.branch ?? [];
	return {
		hasUI: opts.hasUI ?? false,
		cwd: opts.cwd ?? process.cwd(),
		ui: createMockUI(opts.ui),
		sessionManager: {
			getBranch: vi.fn(() => branch),
			getEntries: vi.fn(() => branch),
			getLeafId: vi.fn(() => branch.length ? branch[branch.length - 1].id : null),
			getSessionFile: vi.fn(() => "/tmp/test-session.jsonl"),
			getSessionId: vi.fn(() => opts.sessionId ?? "test-session"),
		},
		isIdle: vi.fn(() => true),
	} as unknown as ExtensionContext;
}

export function makeUserMessage(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

export function buildSessionEntries(messages: Message[]): SessionEntry[] {
	return messages.map((message) => ({ type: "message", message }) as SessionEntry);
}

export function makeTodoToolResult(details: unknown, text = "ok"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-todo-${Date.now()}`,
		toolName: "todo",
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: Date.now(),
	} as unknown as ToolResultMessage;
}
