import { expect, test } from "vitest";
import { extractSegments, looksLikeCommand, parseBlocks, shellCommands } from "../src/segments.ts";
import { assistantEntry, userEntry } from "./harness.ts";

const reply = `Here's the fix. Run this:

\`\`\`bash
$ npm install zod
npm run build && \\
  npm test
\`\`\`

The config lives in \`src/config/loader.ts\` and docs are at https://zod.dev/api.

| flag | meaning |
|---|---|
| -v | verbose |

- first step
- second step

\`\`\`ts
export const x = 1;
\`\`\`

\`\`\`
feat: add config validation

Validate the config with zod at startup.
\`\`\`

This paragraph explains why the change is safe and does not affect existing users at all.`;

test("parseBlocks and shellCommands", () => {
  const blocks = parseBlocks(reply.split("\n"));
  expect(blocks.flatMap((b) => (b.type === "fence" ? [b.lang] : []))).toEqual(["bash", "ts", ""]);
  expect(blocks.map((b) => b.type)).toEqual(["paragraph", "fence", "paragraph", "table", "list", "fence", "fence", "paragraph"]);
  expect(shellCommands("$ npm install zod\nnpm run build && \\\n  npm test\n# comment")).toEqual(["npm install zod", "npm run build && \\\n  npm test"]);
});

test("extractSegments finds every kind of piece", () => {
  const entries = [
    userEntry("add config validation"),
    assistantEntry(reply),
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "1", name: "bash", arguments: { command: "git status" } }] } },
  ];
  const segments = extractSegments(entries);
  const kinds = (k: string) => segments.filter((s) => s.kind === k).map((s) => s.text);
  expect(kinds("user")).toEqual(["add config validation"]);
  expect(kinds("assistant")).toHaveLength(1);
  expect(kinds("command")).toEqual(["npm install zod", "npm run build && \\\n  npm test", "git status"]);
  expect(kinds("code")).toEqual(["$ npm install zod\nnpm run build && \\\n  npm test", "export const x = 1;"]);
  expect(kinds("commit")).toEqual(["feat: add config validation\n\nValidate the config with zod at startup."]);
  expect(kinds("table")).toHaveLength(1);
  expect(kinds("list")).toEqual(["- first step\n- second step"]);
  expect(kinds("url")).toEqual(["https://zod.dev/api"]);
  expect(kinds("path")).toEqual(["src/config/loader.ts"]);
  expect(kinds("paragraph")).toContain("This paragraph explains why the change is safe and does not affect existing users at all.");
  expect(segments.every((s, i) => s.order === i)).toBe(true);
});

test("only the last maxTurns user turns are covered", () => {
  const entries = Array.from({ length: 5 }, (_, i) => [userEntry(`request ${i}`), assistantEntry(`reply number ${i} with enough words to be a paragraph of text`)]).flat();
  const segments = extractSegments(entries, 2);
  expect(segments.filter((s) => s.kind === "user").map((s) => s.text)).toEqual(["request 3", "request 4"]);
  expect(Math.max(...segments.map((s) => s.turn))).toBe(1);
});

// A reply that hands over a prompt: a ````-fence holding Markdown with its own ``` blocks, sections,
// nested lists, and inline code.
const handoff = `Paste this into the agent on your laptop:

\`\`\`\`
Fix every MCP client on this machine. Read this whole brief before acting.

## What changed
- Each server is reachable only at https://<name>.example.com/mcp
  - The bare hostname no longer works.
- Allowed callbacks:
  - pi: http://127.0.0.1:<port>/callback
  - Claude Code: http://localhost:8766/callback

## 1. Dotfiles
Apply the patch:
\`\`\`
scp nuc:fix.patch /tmp/
cd ~/dotfiles && git apply /tmp/fix.patch
\`\`\`
It touches two files:
- shell/.config/mcp/mcp.json
- \`mcp-install\`: passes the client id, e.g. \`claude mcp add --client-id <id>\`

Check the Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json).
\`\`\`\``;

test("a fenced prompt and its sections, lists, and inline pieces are pieces", () => {
  const segments = extractSegments([userEntry("give me the prompt"), assistantEntry(handoff)]);
  const kinds = (k: string) => segments.filter((s) => s.kind === k).map((s) => s.text);
  const prompt = handoff.split("\n").slice(3, -1).join("\n");
  expect(kinds("code")).toEqual([prompt, "scp nuc:fix.patch /tmp/\ncd ~/dotfiles && git apply /tmp/fix.patch"]);
  expect(kinds("section").map((s) => s.split("\n")[0])).toEqual(["## What changed", "## 1. Dotfiles"]);
  expect(kinds("section")[0]).toBe(prompt.split("\n\n")[1]);
  expect(kinds("list")).toContain("Allowed callbacks:\n- pi: http://127.0.0.1:<port>/callback\n- Claude Code: http://localhost:8766/callback");
  expect(kinds("list")).toContain("It touches two files:\n- shell/.config/mcp/mcp.json\n- `mcp-install`: passes the client id, e.g. `claude mcp add --client-id <id>`");
  expect(kinds("command")).toEqual(["scp nuc:fix.patch /tmp/", "cd ~/dotfiles && git apply /tmp/fix.patch", "claude mcp add --client-id <id>"]);
  expect(kinds("snippet")).toEqual(["mcp-install"]);
  expect(kinds("url")).toEqual(["http://localhost:8766/callback"]);
  expect(kinds("path")).toContain("~/Library/Application Support/Claude/claude_desktop_config.json");
  expect(kinds("path")).not.toContain("~/Library/Application");
  // Lines that only introduce what follows are not pieces of their own.
  expect(kinds("paragraph")).toContain("Fix every MCP client on this machine. Read this whole brief before acting.");
  expect(kinds("paragraph")).not.toContain("Paste this into the agent on your laptop:");
});

test("list items in loose and nested lists keep their code", () => {
  const text = "Steps:\n\n1. Install it:\n   \`\`\`sh\n   npm install zod\n   \`\`\`\n\n2. Build it\n   - run the build\n   - check the output\n\nDone, and everything should be working now as expected.";
  const segments = extractSegments([userEntry("how"), assistantEntry(text)]);
  const kinds = (k: string) => segments.filter((s) => s.kind === k).map((s) => s.text);
  expect(kinds("command")).toEqual(["npm install zod"]);
  expect(kinds("list")).toContain("Build it\n- run the build\n- check the output");
  expect(kinds("paragraph")).toEqual(["Done, and everything should be working now as expected."]);
});

test("looksLikeCommand", () => {
  expect(looksLikeCommand("git status")).toBe(true);
  expect(looksLikeCommand("FOO=1 npm test")).toBe(true);
  expect(looksLikeCommand("mytool --verbose x")).toBe(true);
  expect(looksLikeCommand("feat: add config validation")).toBe(false);
  expect(looksLikeCommand("set the URL")).toBe(false);
});
