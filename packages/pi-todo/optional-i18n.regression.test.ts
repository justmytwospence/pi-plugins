import { describe, expect, it, vi } from "vitest";
import registerTodo from "./index.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { createMockPi } from "./test/fixtures.js";

vi.mock("@juicesharp/rpiv-i18n", () => { throw new Error("optional SDK absent"); });
vi.mock("@juicesharp/rpiv-i18n/loader", () => { throw new Error("optional loader absent"); });

describe("standalone without localization", () => {
	it("registers the tool, command and shortcut without any sibling", () => {
		const { pi, captured } = createMockPi();
		expect(() => registerTodo(pi)).not.toThrow();
		expect(captured.tools.has("todo")).toBe(true);
		expect(captured.commands.has("todos")).toBe(true);
		expect(captured.shortcuts.has("ctrl+shift+t")).toBe(true);
	});

	it("uses English status and chrome fallbacks", () => {
		expect(formatStatusLabel("pending")).toBe("pending");
		expect(formatStatusLabel("in_progress")).toBe("in progress");
		expect(formatStatusLabel("completed")).toBe("completed");
		expect(formatStatusLabel("deleted")).toBe("deleted");
		expect(t("overlay.heading", "Todos")).toBe("Todos");
	});
});
