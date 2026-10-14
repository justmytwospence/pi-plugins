import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatStatusLabel, I18N_NAMESPACE, t } from "./i18n-bridge.js";

// Model the optional SDK's scope contract without installing any sibling.
const sdk = vi.hoisted(() => ({
	locale: "en",
	strings: {} as Record<string, Record<string, string>>,
	scope: vi.fn(),
}));
vi.mock("@juicesharp/rpiv-i18n", () => ({
	scope: sdk.scope.mockImplementation((_namespace: string) => (key: string, fallback: string) => sdk.strings[sdk.locale]?.[key] ?? fallback),
}));

describe("i18n-bridge — optional SDK contract", () => {
	beforeEach(() => {
		sdk.locale = "en";
		sdk.strings = {
			en: { "status.pending": "pending", "status.in_progress": "in progress", "status.completed": "completed", "status.deleted": "deleted" },
			de: { "status.in_progress": "in Bearbeitung", "status.completed": "erledigt" },
		};
	});

	it("returns English when no locale is active", () => {
		expect(formatStatusLabel("in_progress")).toBe("in progress");
		expect(formatStatusLabel("completed")).toBe("completed");
	});

	it("uses live localized values without reimporting", () => {
		sdk.locale = "de";
		expect(formatStatusLabel("in_progress")).toBe("in Bearbeitung");
		expect(formatStatusLabel("completed")).toBe("erledigt");
	});

	it("falls back to English when the active locale omits a key", () => {
		sdk.locale = "de";
		expect(formatStatusLabel("pending")).toBe("pending");
	});

	it("falls back to the inline literal for unknown keys", () => {
		expect(t("nonexistent.key", "fallback literal")).toBe("fallback literal");
	});

	it("preserves the upstream localization namespace", () => {
		expect(I18N_NAMESPACE).toBe("@juicesharp/rpiv-todo");
	});
});
