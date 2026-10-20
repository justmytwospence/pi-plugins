import { describe, expect, test } from "vitest";
import { toolIntent, withIntents } from "../src/intent.ts";

describe("toolIntent", () => {
  test("leaves calls herdr-web-ui already summarizes alone", () => {
    expect(toolIntent("bash", { command: "ls" })).toBeUndefined();
    expect(toolIntent("read", { path: "a.ts" })).toBeUndefined();
    expect(toolIntent("edit", { path: "a.ts", edits: [] })).toBeUndefined();
    expect(toolIntent("todo", { action: "create", subject: "x" })).toBeUndefined();
    expect(toolIntent("bg_run", { command: "npm test", name: "tests" })).toBeUndefined();
    expect(toolIntent("fetch_content", { url: "https://x" })).toBeUndefined();
  });

  test("subagent: label or task, parallel and chain lists, other actions with their id", () => {
    expect(toolIntent("subagent", { task: "Audit the parser\nin detail", label: "Audit parser" })).toBe("Audit parser");
    expect(toolIntent("subagent", { task: "Audit the parser\nin detail" })).toBe("Audit the parser");
    expect(toolIntent("subagent", { tasks: [{ task: "a", label: "A" }, { task: "b\nmore" }] })).toBe("2 parallel: A · b");
    expect(toolIntent("subagent", { chain: [{ task: "find" }, { task: "fix", label: "Fix" }] })).toBe("chain: find → Fix");
    expect(toolIntent("subagent", { action: "status", id: "ab12" })).toBe("status ab12");
  });

  test("codemode: a comment the script opens with, else its first statement", () => {
    expect(toolIntent("codemode", { code: "/* Count lines */\nreturn 1" })).toBe("Count lines");
    expect(toolIntent("codemode", { code: "const a = 1;\n// later note\nreturn a" })).toBe("const a = 1;");
    expect(toolIntent("codemode", { code: '// @options: {"timeout_ms": 1}\n// Batch the reads\nawait tools.read({})' })).toBe("Batch the reads");
    expect(toolIntent("codemode", { code: "\nconst r = await tools.bash({ command: 'ls' });\nreturn r" })).toBe("const r = await tools.bash({ command: 'ls' });");
  });

  test("questions, herdr children, background jobs and searches", () => {
    expect(toolIntent("ask_user_question", { questions: [{ header: "Scope", question: "Which?" }, { question: "And\nthen?" }] })).toBe("Scope · And");
    expect(toolIntent("herdr_child", { action: "spawn", task: "Fix the build\nnow" })).toBe("spawn Fix the build");
    expect(toolIntent("herdr_child", { action: "send", name: "fixer", message: "hi" })).toBe("send fixer");
    expect(toolIntent("bg_wait", {})).toBe("next to finish");
    expect(toolIntent("bg_logs", {})).toBe("all tasks");
    expect(toolIntent("bg_logs", { id: "c4a2b", grep: "error" })).toBe("c4a2b /error/");
    expect(toolIntent("web_search", { queries: ["a b", "c"] })).toBe("a b · c");
    expect(toolIntent("web_search", { query: "pi extensions" })).toBe("pi extensions");
    expect(toolIntent("get_search_content", { responseId: "r1", findText: ["x"] })).toBe("x");
    expect(toolIntent("source_check", { claim: "The sky is blue" })).toBe("The sky is blue");
    expect(toolIntent("get_search_content", { responseId: "r1", urlIndex: 2 })).toBe("r1 url 2");
    expect(toolIntent("bg_kill", { taskId: "b16" })).toBe("b16");
  });

  test("nothing to say: no intent; long text is cut to 120 characters", () => {
    expect(toolIntent("web_enable", {})).toBeUndefined();
    expect(toolIntent("enter_plan_mode", undefined)).toBeUndefined();
    const long = toolIntent("web_search", { query: "x".repeat(300) })!;
    expect(long).toHaveLength(120);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("withIntents", () => {
  test("adds intent to calls without a summary, keeps everything else", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
        { type: "toolCall", id: "2", name: "web_search", arguments: { query: "q" } },
        { type: "toolCall", id: "3", name: "web_search", arguments: { query: "q" }, intent: "own" },
      ],
    };
    const out = withIntents(message)!;
    expect(out.content).toEqual([
      message.content[0],
      message.content[1],
      { type: "toolCall", id: "2", name: "web_search", arguments: { query: "q" }, intent: "q" },
      message.content[3],
    ]);
    expect(out.content[1]).toBe(message.content[1]);
    expect(message.content[2]).not.toHaveProperty("intent");
  });

  test("undefined when nothing changes or the message is not the assistant's", () => {
    expect(withIntents({ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] })).toBeUndefined();
    expect(withIntents({ role: "user", content: [{ type: "toolCall", name: "web_search", arguments: { query: "q" } }] })).toBeUndefined();
    expect(withIntents({ role: "assistant", content: "text" })).toBeUndefined();
  });
});
