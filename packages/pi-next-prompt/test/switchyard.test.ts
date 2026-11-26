import { describe, expect, it } from "vitest";
import adapter from "../src/switchyard/adapter.ts";

describe("next-prompt Switchyard tool views", () => {
  it("an offer is one row with its text and how it landed", () => {
    expect(adapter.toolView({ toolCallId: "1", name: "offer_prompt", args: { text: "/reload" } })).toEqual({
      kind: "other", verb: "Offered prompt", activeVerb: "Offering prompt", target: "/reload", meta: [],
    });
    expect(adapter.toolView({ toolCallId: "1", name: "offer_prompt", args: { text: "/reload" }, result: {}, details: { status: "queued" } })).toMatchObject({
      meta: ["queued behind a draft"],
    });
    expect(adapter.toolView({ toolCallId: "1", name: "offer_terminal", args: { command: "npm test" }, result: {}, isError: true, details: { status: "blocked", reason: "no terminal" } })).toMatchObject({
      verb: "Offered command", target: "npm test", meta: ["blocked", "no terminal"],
    });
  });

  it("a multi-line offer opens to the whole text", () => {
    expect(adapter.toolView({ toolCallId: "1", name: "offer_terminal", args: { command: "make \\\n  all" } })).toMatchObject({
      target: "make \\…", detail: { t: "code", text: "make \\\n  all", lang: "bash" },
    });
    expect(adapter.toolView({ toolCallId: "1", name: "read", args: {} })).toBeUndefined();
  });
});
