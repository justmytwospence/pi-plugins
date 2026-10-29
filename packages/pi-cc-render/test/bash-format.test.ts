import { describe, expect, test } from "vitest";
import { formatBashCommand } from "../src/renderer/tool/bash-format.ts";
import { layoutBash } from "../src/renderer/tool/bash-layout.ts";

describe("layoutBash", () => {
	test("leaves short lines alone", () => {
		expect(layoutBash("cd x && ls")).toBe("cd x && ls");
	});

	test("puts each step of a long chain on its own line", () => {
		const command = `cd ~/Projects/pi-plugins/packages/pi-cc-render && npm run check 2>&1 | grep -E "Tests|FAIL" | tail -20`;
		expect(layoutBash(command)).toBe(
			[
				"cd ~/Projects/pi-plugins/packages/pi-cc-render &&",
				'  npm run check 2>&1 |',
				'  grep -E "Tests|FAIL" |',
				"  tail -20",
			].join("\n"),
		);
	});

	test("does not break inside quotes, substitutions or comments", () => {
		const line = `echo "${"a && b ".repeat(20)}" $(ls | wc -l) # x && y`;
		expect(layoutBash(line)).toBe(line);
	});

	test("keeps heredoc bodies verbatim", () => {
		const text = `cat > f <<'EOF'\n${"x && y | z ".repeat(12)}\nEOF\nls`;
		expect(layoutBash(text)).toBe(text);
	});

	test("does not split compound headers on semicolons", () => {
		const line = `for file in ${"packages/a ".repeat(10)}; do echo $file; done`;
		expect(layoutBash(line)).toBe(line);
	});
});

describe("formatBashCommand", () => {
	test("returns a usable result at once and the shfmt result when ready", async () => {
		const command = "if true;then   echo   hi;fi";
		let ready!: () => void;
		const done = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const first = formatBashCommand(command, ready);
		expect(first).toBeTypeOf("string");
		await done;
		expect(formatBashCommand(command)).toBe("if true; then echo hi; fi");
	});

	test("falls back on a command that does not parse", async () => {
		const command = "echo 'unterminated";
		formatBashCommand(command);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(formatBashCommand(command)).toBe(command);
	});
});

describe("expanded Input of a shell call", () => {
	test("is the formatted command as a standalone bash block", async () => {
		const { formatToolInputBody } = await import("../src/renderer/tool/result.ts");
		const body = formatToolInputBody({ command: "cd /x && npm run check 2>&1 | tail -20", timeout: 60 });
		expect(body.codeBlock).toMatchObject({ language: "bash", standalone: true, startLine: 0 });
		expect(body.text).toContain("cd /x && npm run check 2>&1 | tail -20");
		expect(body.text).toContain("# timeout: 60s");
	});

	test("other tools keep the key: value layout", async () => {
		const { formatToolInputBody } = await import("../src/renderer/tool/result.ts");
		expect(formatToolInputBody({ command: "ls", other: 1 }).text).toBe("command: ls\nother: 1");
	});
});

describe("heredoc bodies", () => {
	test("take the language of the program or the file they write", async () => {
		const { splitBashSegments, heredocLanguage } = await import("../src/renderer/tool/bash-heredoc.ts");
		expect(heredocLanguage("python3 - <<'EOF'")).toBe("python");
		expect(heredocLanguage("cd x && .venv/bin/python - <<EOF")).toBe("python");
		expect(heredocLanguage("node - <<EOF")).toBe("javascript");
		expect(heredocLanguage("cat > /tmp/a.json <<EOF")).toBe("json");
		expect(heredocLanguage("cat <<EOF")).toBeUndefined();
		expect(splitBashSegments("python3 - <<'EOF'\nimport os\nprint(os.name)\nEOF\nls")).toEqual([
			{ language: "bash", lines: ["python3 - <<'EOF'"] },
			{ language: "python", lines: ["import os", "print(os.name)"] },
			{ language: "bash", lines: ["EOF", "ls"] },
		]);
	});
});
