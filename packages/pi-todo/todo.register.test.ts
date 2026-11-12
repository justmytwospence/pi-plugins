import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Row } from "./src/transcript-style.ts";
import { createMockCtx, createMockPi, makeTheme } from "./test/fixtures.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetState, registerTodoTool, setActiveRenderSession, type TaskDetails, TOOL_NAME } from "./todo.js";

const theme = makeTheme() as unknown as Theme;

function setup() {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	return { tool, captured };
}

async function call(tool: ReturnType<typeof setup>["tool"], params: Record<string, unknown>) {
	return tool.execute?.("tc", params as never, undefined as never, undefined as never, createMockCtx() as never);
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
});

describe("registerTodoTool — registration shape", () => {
	it("registers under the tool name 'todo' with the expected label and guidelines", () => {
		const { captured } = setup();
		const tool = captured.tools.get("todo")!;
		expect(tool.name).toBe("todo");
		expect(tool.label).toBe("Todo");
		expect(tool.promptSnippet).toContain("task list");
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
		expect((tool.promptGuidelines as string[]).length).toBeGreaterThan(0);
	});

	it("exposes a typebox parameters schema declaring the six actions", () => {
		const { tool } = setup();
		const raw = JSON.stringify(tool.parameters);
		for (const action of ["create", "update", "list", "get", "delete", "clear"]) {
			expect(raw).toContain(action);
		}
	});
});

describe("registerTodoTool — execute mutates module state", () => {
	it("create → list returns the seeded row", async () => {
		const { tool } = setup();
		const r1 = await call(tool, { action: "create", subject: "first" });
		expect((r1!.details as TaskDetails).action).toBe("create");
		const r2 = await call(tool, { action: "list" });
		expect(r2?.content[0]).toMatchObject({ text: expect.stringContaining("first") });
	});

	it("clear resets module state and nextId", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		await call(tool, { action: "create", subject: "b" });
		const r = await call(tool, { action: "clear" });
		const d = r?.details as TaskDetails;
		expect(d.tasks).toEqual([]);
		expect(d.nextId).toBe(1);
	});
});

describe("registerTodoTool — renderCall", () => {
	it("create action emits a Todo row with the create op and the subject", () => {
		const { tool } = setup();
		const node = tool.renderCall?.(
			{ action: "create", subject: "hello" } as never,
			theme,
			undefined as never,
		) as unknown as Row;
		expect(node).toBeInstanceOf(Row);
		const text = node.render(120).join("\n");
		expect(text).toContain("Todo");
		expect(text).toContain("create");
		expect(text).toContain("hello");
	});

	it("update action renders '#id' when the task has not been registered yet", () => {
		const { tool } = setup();
		const node = tool.renderCall?.(
			{ action: "update", id: 42 } as never,
			theme,
			undefined as never,
		) as unknown as Row;
		expect(node.render(120).join("\n")).toContain("#42");
	});

	it("update action renders the task subject when seeded", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "seeded-subject" });
		const node = tool.renderCall?.(
			{ action: "update", id: 1 } as never,
			theme,
			undefined as never,
		) as unknown as Row;
		expect(node.render(120).join("\n")).toContain("seeded-subject");
	});

	it("list action with a status filter renders the humanized status label", () => {
		const { tool } = setup();
		const node = tool.renderCall?.(
			{ action: "list", status: "in_progress" } as never,
			theme,
			undefined as never,
		) as unknown as Row;
		expect(node.render(120).join("\n")).toContain("in progress");
	});

	it("clear action renders only the base prefix + glyph", () => {
		const { tool } = setup();
		const node = tool.renderCall?.({ action: "clear" } as never, theme, undefined as never) as unknown as Row;
		expect(node.render(120).join("\n")).toContain("clear");
	});
});

describe("registerTodoTool — renderResult", () => {
	function collapsed(tool: ReturnType<typeof setup>["tool"], r: unknown): string {
		const node = tool.renderResult?.(r as never, {} as never, theme, { isError: false, isPartial: false } as never) as unknown as Text;
		return node.render(120).join("\n");
	}

	it("create renders a ↳ line with the first line of the result", async () => {
		const { tool } = setup();
		const r = await call(tool, { action: "create", subject: "a" });
		const text = collapsed(tool, r);
		expect(text).toContain("↳ Created #1: a (pending)");
		expect(text).toContain("to expand");
	});

	it("update renders the transition summary", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "update", id: 1, status: "in_progress" });
		expect(collapsed(tool, r)).toContain("↳ Updated #1 (pending → in_progress)");
	});

	it("delete renders the deleted summary without an expand hint", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "delete", id: 1 });
		const text = collapsed(tool, r);
		expect(text).toContain("↳ Deleted #1: a");
	});

	it("list renders the first line of the list", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "list" });
		expect(collapsed(tool, r)).toContain("↳ ");
	});

	it("get renders a ↳ line", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "get", id: 1 });
		expect(collapsed(tool, r)).toContain("↳ ");
	});

	it("clear renders a ↳ line", async () => {
		const { tool } = setup();
		const r = await call(tool, { action: "clear" });
		expect(collapsed(tool, r)).toContain("↳ ");
	});

	it("expanded renders a block with the full text", async () => {
		const { tool } = setup();
		const r = await call(tool, { action: "create", subject: "a" });
		const node = tool.renderResult?.(r as never, { expanded: true } as never, theme, { isError: false, isPartial: false } as never) as unknown as Text;
		const text = node.render(120).join("\n");
		expect(text).toContain("Todo");
		expect(text).toContain("Todo list");
	});

	it("missing content falls back to a plain ↳ done", () => {
		const { tool } = setup();
		expect(collapsed(tool, { content: [], details: undefined })).toContain("↳ done");
	});
});

it("registers renderShell self", () => {
	const { tool } = setup();
	expect(tool.renderShell).toBe("self");
});
