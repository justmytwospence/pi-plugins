import { describe, expect, test } from "vitest";
import restoreInterruptedPrompt from "../src/feature/restore-interrupted-prompt.ts";

function harness(editor = "") {
  const handlers = new Map<string, (event: any, ctx: any) => unknown>();
  const pi = { on: (name: string, handler: any) => handlers.set(name, handler) };
  restoreInterruptedPrompt(pi as any);
  const state = { editor };
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { getEditorText: () => state.editor, setEditorText: (text: string) => { state.editor = text; } },
  };
  const fire = (name: string, event: any = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
  const start = (text: string, input: any = {}) => {
    fire("input", { text, source: "interactive", ...input });
    fire("before_agent_start", { messageType: "user", prompt: text });
  };
  return { state, ctx, fire, start };
}

describe("restore interrupted prompt", () => {
  test("restores the prompt when aborted before any assistant output", () => {
    const h = harness();
    h.start("fix the bug");
    h.fire("message_update", { message: { role: "user" } });
    h.fire("agent_settled", { aborted: true });
    expect(h.state.editor).toBe("fix the bug");
  });

  test("leaves the editor alone once the model has responded", () => {
    const h = harness();
    h.start("fix the bug");
    h.fire("message_update", { message: { role: "assistant" } });
    h.fire("agent_settled", { aborted: true });
    expect(h.state.editor).toBe("");
  });

  test("does nothing for completed runs", () => {
    const h = harness();
    h.start("fix the bug");
    h.fire("agent_settled", { aborted: false });
    expect(h.state.editor).toBe("");
  });

  test("puts the prompt before text already in the editor", () => {
    const h = harness();
    h.start("first");
    h.state.editor = "queued";
    h.fire("agent_settled", { aborted: true });
    expect(h.state.editor).toBe("first\n\nqueued");
  });

  test("ignores steering input and extension-sent prompts", () => {
    const h = harness();
    h.fire("input", { text: "from extension", source: "extension" });
    h.fire("before_agent_start", { messageType: "user", prompt: "from extension" });
    h.fire("input", { text: "steer", source: "interactive", streamingBehavior: "steer" });
    h.fire("agent_settled", { aborted: true });
    expect(h.state.editor).toBe("");
  });

  test("restores only once and not outside the terminal UI", () => {
    const h = harness();
    h.start("again");
    h.fire("agent_settled", { aborted: true });
    h.state.editor = "";
    h.fire("agent_settled", { aborted: true });
    expect(h.state.editor).toBe("");
    h.ctx.mode = "rpc";
    h.start("rpc prompt");
    h.fire("agent_settled", { aborted: true });
    expect(h.state.editor).toBe("");
  });
});
