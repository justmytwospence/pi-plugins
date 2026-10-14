import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL(".", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function productionFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name.startsWith(".") || ["node_modules", "docs", "test"].includes(entry.name)) return [];
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return productionFiles(path);
		if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts") || entry.name === "vitest.config.ts") return [];
		return [relative(root, path)];
	});
}

describe("component manifest", () => {
	it("covers every production module and retains attribution", () => {
		const declared = pkg.files as string[];
		const missing = productionFiles(root).filter((file) => !declared.some((entry) => entry.endsWith("/") ? file.startsWith(entry) : entry === file));
		expect(missing).toEqual([]);
		expect(declared.filter((entry) => !entry.startsWith("!") && !existsSync(join(root, entry)))).toEqual([]);
		expect(declared).toEqual(expect.arrayContaining(["LICENSE", "UPSTREAM.json"]));
	});

	it("is independently loadable without rpiv-config", () => {
		expect(pkg.name).toBe("@justmytwospence/pi-todo");
		expect(pkg.pi.extensions).toEqual(["./index.ts"]);
		expect(pkg.dependencies?.["@juicesharp/rpiv-config"]).toBeUndefined();
		expect(pkg.peerDependenciesMeta["@juicesharp/rpiv-i18n"].optional).toBe(true);
		expect(pkg.devDependencies["@earendil-works/pi-coding-agent"]).toBe("1.2.0");
	});
});
