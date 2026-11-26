import { describe, expect, it } from "vitest";
import adapter from "../src/switchyard/adapter.ts";

const view = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  adapter.toolView({ toolCallId: "1", name: "herdr", args, ...extra });

describe("herdr Switchyard tool views", () => {
  it("each action is one row naming the agent", () => {
    expect(view({ action: "send", name: "reviewer", message: "Please look", delivery: "queue", await_reply: true })).toEqual({
      kind: "other", verb: "Messaged", activeVerb: "Messaging", target: "reviewer", meta: ["queue", "awaiting reply"],
      detail: { t: "markdown", text: "Please look" },
    });
    expect(view({ action: "send", names: ["a", "b"], message: "hi" })).toMatchObject({ target: "a, b" });
    expect(view({ action: "spawn", task: "Fix the login\nmore", where: "worktree", branch: "fix-login", fork: true })).toMatchObject({
      verb: "Spawned", target: "Fix the login", meta: ["worktree", "fix-login", "fork"], detail: { t: "markdown" },
    });
    expect(view({ action: "list", machine: "nuc" })).toMatchObject({ verb: "Listed agents", target: "", meta: ["nuc"] });
    expect(view({ action: "crew" })).toMatchObject({ verb: "Crew", target: "status" });
    expect(view({ action: "wait", name: "x" }, { result: {}, isError: true })).toMatchObject({ verb: "Waited on", target: "x", meta: ["failed"] });
    expect(adapter.toolView({ toolCallId: "1", name: "bash", args: {} })).toBeUndefined();
  });
});
