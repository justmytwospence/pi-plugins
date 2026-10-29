import { describe, expect, test } from "vitest";
import { bashLabel, commentDescription, scanShell } from "../src/renderer/tool/bash-label.ts";

const label = (command: string) => bashLabel(command).text;

describe("scanShell", () => {
	test("splits steps and drops redirects", () => {
		const steps = scanShell('cd /x && rg -n "a b" src 2>&1 | head -5; echo done > /dev/null');
		expect(steps.map((s) => s.words)).toEqual([
			["cd", "/x"],
			["rg", "-n", "a b", "src"],
			["head", "-5"],
			["echo", "done"],
		]);
		expect(steps[1]!.piped).toBe(true);
	});

	test("counts heredoc lines and keeps the body out of the words", () => {
		const steps = scanShell("python3 - <<'EOF'\nprint(1)\nprint(2)\nEOF\nls");
		expect(steps[0]!.words).toEqual(["python3", "-"]);
		expect(steps[0]!.heredocLines).toBe(2);
		expect(steps[1]!.words).toEqual(["ls"]);
	});

	test("captures a file redirect target", () => {
		expect(scanShell("cat > a.txt <<EOF\nx\nEOF")[0]).toMatchObject({ redirOut: "a.txt", heredocLines: 1 });
	});

	test("ignores operators inside quotes and substitutions", () => {
		expect(scanShell('echo "a && b" $(ls | wc -l)').map((s) => s.words)).toEqual([["echo", "a && b", "$(ls | wc -l)"]]);
	});
});

describe("commentDescription", () => {
	test("uses a leading comment, not a shebang or a trailing comment", () => {
		expect(commentDescription("# Run the unit tests\nnpm test")).toBe("Run the unit tests");
		expect(commentDescription("#!/bin/bash\nls")).toBeUndefined();
		expect(commentDescription("ls # list")).toBeUndefined();
	});
});

describe("bashLabel", () => {
	test.each([
		["rg -n \"renderToken\" src", 'Search "renderToken" in src'],
		["cd ~/Projects/pi-plugins/packages/pi-cc-render && npm run check 2>&1 | tail -20", "Run check (npm) in pi-cc-render"],
		["git log --oneline -5", "git log (5 commits)"],
		["git -C ~/repo status --short", "git status"],
		['git commit -m "fix: thing"', "git commit: fix: thing"],
		["sed -n '1,40p' src/a.ts", "Read src/a.ts (lines 1-40)"],
		["head -n 20 README.md", "Read README.md (first 20 lines)"],
		["curl -s https://example.com/api/x", "Fetch example.com/api/x"],
		["python3 - <<EOF\nprint(1)\nEOF", "Run python script (1 line)"],
		["cat > /tmp/a.txt <<EOF\na\nb\nEOF", "Write /tmp/a.txt (2 lines)"],
		["ls -la ~/.pi/agent", "List ~/.pi/agent"],
		["ssh spencer@nuc 'which shfmt'", "On nuc: which shfmt"],
		["docker ps --format '{{.Names}}' --filter status=running", "docker ps"],
		["npx vitest run", "Run vitest (npx)"],
		["uv run pytest -q", "Run pytest (uv)"],
		["FOO=1 sudo docker compose logs foo", "docker compose logs foo"],
		["mkdir -p a/b && cp x a/b", "Create a/b, then Copy x → a/b"],
		["for f in a b; do rm $f; done", "For each a b: Delete $f"],
		["cd /tmp", "cd /tmp"],
		["a1 && b1 && c1", "a1 (+2 more steps)"],
		["ps aux | grep vite | head", "ps aux"],
		["echo start; npm test", "Run test (npm)"],
		["# Check the build\nnpm run build", "Check the build"],
	])("%s", (command, expected) => {
		expect(label(command)).toBe(expected);
	});

	test("falls back to the flattened raw command when nothing is describable", () => {
		expect(bashLabel("set -e\nexport A=1")).toEqual({ text: "set -e export A=1", source: "raw" });
		expect(bashLabel("")).toEqual({ text: "", source: "raw" });
	});

	test("never throws on odd input", () => {
		for (const text of ["'unterminated", '"x $(', "a <<", "| |", "&&", "\\", "$(((", "<<EOF"]) {
			expect(() => bashLabel(text)).not.toThrow();
		}
	});
});
