import { describe, expect, it } from "vitest";
import adapter, { type Claim, type InteractionResponse, type PiUiRequest } from "../src/switchyard/adapter.ts";

export const gateSelect: PiUiRequest = {
  id: "tg-1",
  method: "select",
  title: [
    "Allow this call?",
    "Action: run a shell command",
    "Target: rm -rf build",
    "Held: no rule allows this command",
    "Agent: main",
    "This removes files in the workspace.",
    "Rule: bash rm -rf build",
    "Folder: /work/repo",
  ].join("\n"),
  options: [
    "Allow once",
    "Allow rule for this session",
    "Allow rule in this project",
    "Allow rule everywhere",
    "Edit the rule...",
    "Block",
    "Block with a message",
  ],
};

/** Recorded from pi-tool-gate 0.1.2 for a bash call held by a session ask rule. */
export const recordedGateSelect: PiUiRequest = {
  id: "tg-3",
  method: "select",
  title:
    "Allow this call?\nAction: bash\nTarget: echo hello\nHeld: matches the ask rule Bash(echo:*) (session)\nAgent: (gave no reason)",
  options: ["Allow once", "Block", "Block with a message"],
};

export const gateMessageInput: PiUiRequest = {
  id: "tg-2",
  method: "input",
  title: "Message for the agent",
};

/** The host's claim step: the adapter's claim, or undefined when the dialog is left to generic. */
function claim(req: PiUiRequest): Claim | undefined {
  return adapter.claimInteraction(req);
}
function claimed(req: PiUiRequest): Claim {
  const c = claim(req);
  if (!c) throw new Error("expected claim");
  return c;
}
const respond = (c: Claim, r: InteractionResponse) => c.toPiResponse(r);

describe("tool-gate switchyard adapter", () => {
  it("renders the approval as a table, note and one action per option", () => {
    const c = claimed(gateSelect);
    expect(c.title).toBe("Allow this call? run a shell command");
    expect(c.presentation).toEqual({
      t: "section",
      title: "Allow this call?",
      children: [
        {
          t: "table",
          columns: ["Field", "Value"],
          rows: [
            ["Action", "run a shell command"],
            ["Target", "rm -rf build"],
            ["Held", "no rule allows this command"],
            ["Agent", "main"],
            ["Rule", "bash rm -rf build"],
            ["Folder", "/work/repo"],
          ],
        },
        { t: "markdown", text: "This removes files in the workspace." },
        {
          t: "actions",
          actions: [
            { id: "option:0", label: "Allow once", tone: "primary" },
            { id: "option:1", label: "Allow rule for this session", tone: "default" },
            { id: "option:2", label: "Allow rule in this project", tone: "default" },
            { id: "option:3", label: "Allow rule everywhere", tone: "default" },
            { id: "option:4", label: "Edit the rule...", tone: "default" },
            { id: "option:5", label: "Block", tone: "danger" },
            { id: "option:6", label: "Block with a message", tone: "danger" },
          ],
        },
      ],
    });
  });

  it.each([
    ["option:0", "Allow once"],
    ["option:3", "Allow rule everywhere"],
    ["option:5", "Block"],
  ])("action %s -> {value: %s}", (actionId, value) => {
    expect(respond(claimed(gateSelect), { kind: "action", actionId })).toEqual({ value });
  });

  it("cancel -> {cancelled: true}; unknown or mistyped answers are rejected", () => {
    const c = claimed(gateSelect);
    expect(respond(c, { kind: "cancel" })).toEqual({ cancelled: true });
    expect(() => respond(c, { kind: "action", actionId: "option:99" })).toThrow(/unknown approval action/);
    expect(() => respond(c, { kind: "confirm", confirmed: true })).toThrow(/expected an approval action/);
    try {
      respond(c, { kind: "action", actionId: "nope" });
    } catch (err) {
      // The host recognises this error by name and keeps the interaction open.
      expect((err as Error).name).toBe("InteractionResponseError");
      expect((err as { code?: string }).code).toBe("invalid_request");
    }
  });

  it("leaves the block-message follow-up to the generic renderer", () => {
    expect(claim(gateMessageInput)).toBeUndefined();
  });

  it("parses the payload recorded from pi-tool-gate 0.1.2", () => {
    const c = claimed(recordedGateSelect);
    expect(c.title).toBe("Allow this call? bash");
    expect(c.presentation).toEqual({
      t: "section",
      title: "Allow this call?",
      children: [
        {
          t: "table",
          columns: ["Field", "Value"],
          rows: [
            ["Action", "bash"],
            ["Target", "echo hello"],
            ["Held", "matches the ask rule Bash(echo:*) (session)"],
            ["Agent", "(gave no reason)"],
          ],
        },
        {
          t: "actions",
          actions: [
            { id: "option:0", label: "Allow once", tone: "primary" },
            { id: "option:1", label: "Block", tone: "danger" },
            { id: "option:2", label: "Block with a message", tone: "danger" },
          ],
        },
      ],
    });
    expect(respond(c, { kind: "action", actionId: "option:1" })).toEqual({ value: "Block" });
  });

  it("does not claim other selects", () => {
    expect(claim({ id: "x", method: "select", title: "Pick a fruit", options: ["Apple"] })).toBeUndefined();
  });
});
