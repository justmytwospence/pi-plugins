import { describe, expect, it } from "vitest";
import { judgeToolCall } from "../src/read-only.ts";

describe("judgeToolCall", () => {
  it("allows reading tools and codemode (whose nested calls are judged one by one)", () => {
    for (const tool of ["read", "grep", "find", "ls", "web_search", "fetch_content", "codemode"]) {
      expect(judgeToolCall(tool, {}).allowed).toBe(true);
    }
  });

  it("blocks writing and delegating tools", () => {
    for (const tool of ["edit", "write", "subagent", "herdr_child", "bg_run", "todo"]) {
      const verdict = judgeToolCall(tool, {});
      expect(verdict.allowed).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toMatch(/read-only/);
    }
  });

  it("runs read-only shell commands only", () => {
    expect(judgeToolCall("bash", { command: "git status && git log --oneline -5" }, "/repo").allowed).toBe(true);
    expect(judgeToolCall("bash", { command: "rg foo src | head" }, "/repo").allowed).toBe(true);
    for (const command of ["rm -rf build", "echo hi > out.txt", "git commit -m x", "npm install", "sed -i '' s/a/b/ f"]) {
      expect(judgeToolCall("bash", { command }, "/repo").allowed, command).toBe(false);
    }
  });

  it("names the blocked part of a command", () => {
    const verdict = judgeToolCall("bash", { command: "ls && touch x" }, "/repo");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toContain("touch x");
  });
});
