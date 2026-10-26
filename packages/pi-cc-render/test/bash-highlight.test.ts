import { BashExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import { bashOutputLanguage, installBashHighlight } from "../src/feature/shell/bash-highlight.ts";

describe("bashOutputLanguage", () => {
	test.each([
		["cat src/a.ts", "const a = 1;", "typescript"],
		["head -n 50 scripts/run.py", "import os", "python"],
		["sed -n '1,20p' config.yaml", "a: 1", "yaml"],
		["bat -p Dockerfile", "FROM node", "dockerfile"],
		["cat README.md | head", "# Title", "markdown"],
		["git diff", "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b", "diff"],
		["git -C ~/repo show HEAD", "commit abc", "diff"],
		["git log -p -1", "commit abc", "diff"],
		["diff -u a b", "", "diff"],
		["curl -s https://x/api", '{"a": [1, 2]}', "json"],
		["kubectl get pods -o json", '[\n  {"a": 1}\n]', "json"],
		["some-tool", "diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b", "diff"],
	])("%s", (command, output, language) => {
		expect(bashOutputLanguage(command, output)).toBe(language);
	});

	test.each([
		["ls -la", "total 0"],
		["git status", "On branch main"],
		["echo {hi}", "{hi}"],
		["cat notes", "plain words"],
		["git log --oneline", "abc fix"],
	])("plain: %s", (command, output) => {
		expect(bashOutputLanguage(command, output)).toBeUndefined();
	});
});

describe("! output rendering", () => {
	beforeAll(() => {
		initTheme("dark");
		installBashHighlight();
	});

	const render = (command: string, output: string, expanded = false) => {
		const ui = { requestRender() {} } as any;
		const component = new BashExecutionComponent(command, ui);
		component.appendOutput(output);
		component.setComplete(0, false);
		if (expanded) component.setExpanded(true);
		return component.render(80);
	};

	test("highlights a known language and keeps the text", () => {
		const code = 'const greeting = "hi";\nexport function f() { return 1; }';
		const plain = render("echo", code);
		const highlighted = render("cat src/a.ts", code);
		expect(highlighted.slice(3).map((l) => stripTerminalSequences(l))).toEqual(plain.slice(3).map((l) => stripTerminalSequences(l)));
		expect(highlighted.slice(3)).not.toEqual(plain.slice(3));

	});

	test("keeps Pi's collapsed preview of the last lines", () => {
		const code = Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n");
		const text = render("cat a.ts", code).map((l) => stripTerminalSequences(l));
		expect(text.some((l) => l.includes("const v39 = 39;"))).toBe(true);
		expect(text.some((l) => l.includes("const v0 = 0;"))).toBe(false);
		expect(text.some((l) => l.includes("more lines"))).toBe(true);
		const expanded = render("cat a.ts", code, true).map((l) => stripTerminalSequences(l));
		expect(expanded.some((l) => l.includes("const v0 = 0;"))).toBe(true);
	});
});
