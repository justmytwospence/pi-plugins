import { describe, expect, it } from "vitest";
import adapter from "../src/switchyard/adapter.ts";

describe("issues Switchyard tool views", () => {
  it("start and status calls are one row naming the issues", () => {
    expect(adapter.toolView({ toolCallId: "1", name: "issue", args: { action: "start", issues: [12], branch: "login-retry" } })).toEqual({
      kind: "other", verb: "Started issue", activeVerb: "Starting issue", target: "#12", meta: ["login-retry"],
    });
    expect(adapter.toolView({ toolCallId: "1", name: "issue", args: { action: "status", issues: [12, 13], status: "Done", repo: "o/r" }, result: {}, isError: true })).toEqual({
      kind: "other", verb: "Set issues status", activeVerb: "Setting issues status", target: "#12 #13", meta: ["Done", "o/r", "failed"],
    });
    expect(adapter.toolView({ toolCallId: "1", name: "bash", args: {} })).toBeUndefined();
  });
});
