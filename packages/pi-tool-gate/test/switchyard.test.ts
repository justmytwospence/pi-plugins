import { describe, expect, it } from "vitest";
import { approvalRequest } from "../src/approval-entry.ts";
import { MODE_LABELS, modeStatus, workflowStatus } from "../src/modes.ts";
import adapter, { type AdapterContext, type Claim, modesOf } from "../src/switchyard/adapter.ts";
import type { AdapterContribution, InteractionResponse, PiUiRequest } from "../src/switchyard/contract.ts";

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


const request = {
  id: "approval", method: "select" as const,
  title: "Allow this call?\nAction: bash\nRule: npm test",
  options: ["Allow once", "Block", "Block with a message"],
};

describe("gate Switchyard contract", () => {
  it("preserves the real options and maps only an explicit answer or cancellation", () => {
    const claim = adapter.claimInteraction(request)!;
    expect(claim).toBeDefined();
    expect(JSON.stringify(claim.presentation)).toContain("npm test");
    expect(claim.toPiResponse({ kind: "action", actionId: "option:0" })).toEqual({ value: "Allow once" });
    expect(claim.toPiResponse({ kind: "action", actionId: "option:2" })).toEqual({ value: "Block with a message" });
    expect(claim.toPiResponse({ kind: "cancel" })).toEqual({ cancelled: true });
  });

  it("failed/unsupported claims never manufacture permission or an alternate dialog", () => {
    expect(adapter.claimInteraction({ ...request, title: "Unrelated question" })).toBeUndefined();
    expect(adapter.claimInteraction({ id: "input", method: "input", title: request.title })).toBeUndefined();
    const claim = adapter.claimInteraction(request)!;
    expect(() => claim.toPiResponse({ kind: "action", actionId: "option:99" })).toThrow();
    expect(() => claim.toPiResponse({ kind: "form", values: {} })).toThrow();
    expect(claim.toPiResponse({ kind: "action", actionId: "option:1" })).toEqual({ value: "Block" });
  });
});

const V2 = ["tool.views.v1", "ui.nodes.v2", "adapter.trackers.v1", "interaction.kinds.v1"];
function makeCtx(features?: string[]) {
  const store = new Map<string, unknown>();
  const contributions = new Map<string, AdapterContribution>();
  const ctx: AdapterContext = {
    ...(features ? { features } : {}),
    state: {
      get: <T = unknown>(key: string) => store.get(key) as T | undefined,
      set: (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: (key: string) => void store.delete(key),
      keys: () => [...store.keys()],
    },
    setContribution: (id, c) => void (c ? contributions.set(id, c) : contributions.delete(id)),
  };
  return { ctx, contributions };
}

describe("contract v2", () => {
  const bashTitle = "Allow this call?\nAction: bash\nTarget: npm publish\nHeld: matches the ask rule Bash(npm publish:*)\nAgent: release it\nRule: Bash(npm publish:*)\nProject saves: ~/.pi/tool-gate (local)";
  const bash: PiUiRequest = { id: "b1", method: "select", title: bashTitle, options: ["Allow once", "Allow rule for this session", "Block"] };
  const entry = {
    type: "custom",
    customType: "tool-gate:approval-request",
    data: approvalRequest({
      title: bashTitle, tool: "bash", action: "bash", target: "npm publish", cwd: "/work/app",
      command: "npm publish --access public", held: "matches the ask rule Bash(npm publish:*)", agent: "release it",
      offer: { kind: "rules", items: ["Bash(npm publish:*)"], saves: "~/.pi/tool-gate (local)" },
    }),
  };

  it("an approval keeps its row: kind approval on every host (a v1 host ignores it)", () => {
    expect(adapter.claimInteraction(request)?.kind).toBe("approval");
  });

  it("shows the published request as facts plus the command, matched by the exact title", () => {
    const { ctx } = makeCtx(V2);
    adapter.onEntry(entry, ctx);
    const c = adapter.claimInteraction(bash, ctx)!;
    expect(c.title).toBe("Allow this call? bash");
    expect(c.presentation).toEqual({
      t: "section",
      title: "Allow this call?",
      children: [
        {
          t: "facts",
          items: [
            { label: "Tool", value: "bash", mono: true },
            { label: "Action", value: "bash" },
            { label: "Target", value: "npm publish", mono: true },
            { label: "Directory", value: "/work/app", mono: true },
            { label: "Held", value: "matches the ask rule Bash(npm publish:*)" },
            { label: "Agent", value: "release it" },
            { label: "Rule", value: "Bash(npm publish:*)", mono: true },
            { label: "Saves to", value: "~/.pi/tool-gate (local)" },
          ],
        },
        { t: "code", text: "npm publish --access public", lang: "bash" },
        {
          t: "actions",
          actions: [
            { id: "option:0", label: "Allow once", tone: "primary" },
            { id: "option:1", label: "Allow rule for this session", tone: "default" },
            { id: "option:2", label: "Block", tone: "danger" },
          ],
        },
      ],
    });
    expect(c.toPiResponse({ kind: "action", actionId: "option:2" })).toEqual({ value: "Block" });
  });

  it("a short one-line command is the Target fact alone", () => {
    const { ctx } = makeCtx(V2);
    adapter.onEntry({ ...entry, data: { ...entry.data, command: "npm publish" } }, ctx);
    const children = (adapter.claimInteraction(bash, ctx)!.presentation as { children: { t: string }[] }).children;
    expect(children.map((n) => n.t)).toEqual(["facts", "actions"]);
  });

  it("falls back to the title's fields as facts without a matching entry, and ignores malformed entries", () => {
    const { ctx } = makeCtx(V2);
    adapter.onEntry({ ...entry, data: { ...entry.data, version: 2 } }, ctx);
    adapter.onEntry({ ...entry, data: { ...entry.data, title: "Allow this call?\nAction: other" } }, ctx);
    const children = (adapter.claimInteraction(bash, ctx)!.presentation as { children: { t: string; items?: unknown[] }[] }).children;
    expect(children[0]).toMatchObject({ t: "facts", items: expect.arrayContaining([{ label: "Target", value: "npm publish" }]) });
    expect(children.some((n) => n.t === "code")).toBe(false);
  });

  it("before v2 keeps the exact legacy table even when an entry was published", () => {
    const { ctx } = makeCtx();
    adapter.onEntry(entry, ctx);
    const legacy = adapter.claimInteraction(bash)!.presentation;
    expect(adapter.claimInteraction(bash, ctx)!.presentation).toEqual(legacy);
    expect(JSON.stringify(legacy)).toContain('"t":"table"');
  });

  it("reads every mode the gate's own status formatters show", () => {
    for (const mode of Object.keys(MODE_LABELS) as (keyof typeof MODE_LABELS)[]) {
      expect(modesOf({ approvals: modeStatus(mode, "alt+a") }).approvals).toBeDefined();
      expect(modesOf({ approvals: modeStatus(mode, undefined) }).approvals).toBeDefined();
    }
    for (const w of ["work", "chat", "plan"] as const) {
      expect(modesOf({ workflow: workflowStatus(w, "shift+tab") }).workflow).toBe(w);
    }
    expect(modesOf({ approvals: modeStatus("bypassPermissions", undefined) }).approvals).toBe("yolo");
    expect(modesOf({ workflow: "something else" })).toEqual({});
  });

  it("v2: the statuses become a Mode tracker and a badge away from work and auto", () => {
    const { ctx, contributions } = makeCtx(V2);
    expect(adapter.onStatus("workflow-mode", workflowStatus("work", "shift+tab"), ctx)).toBe(true);
    expect(adapter.onStatus("permission-mode", modeStatus("auto", "alt+a"), ctx)).toBe(true);
    expect(adapter.onStatus("permission-prompting", "permission prompts: on", ctx)).toBe(true);
    expect(adapter.onStatus("tool-gate", "gate: 3 auto · 0 pushed back · 1 asked", ctx)).toBe(true);
    expect(adapter.onStatus("other", "x", ctx)).toBe(false);
    expect(contributions.get("mode")).toEqual({
      placement: "composer.tracker",
      title: "Mode",
      node: {
        t: "facts",
        items: [
          { label: "Workflow", value: "work" },
          { label: "Approvals", value: "auto" },
          { label: "Permission prompts", value: "on" },
          { label: "Gate", value: "3 auto · 0 pushed back · 1 asked" },
        ],
      },
      mobileFallback: "Workflow: work\nApprovals: auto\nPermission prompts: on\nGate: 3 auto · 0 pushed back · 1 asked",
      tracker: { count: "work · auto" },
      order: -10,
    });
    expect(contributions.has("mode-badge")).toBe(false);
    adapter.onStatus("workflow-mode", workflowStatus("plan", undefined), ctx);
    adapter.onStatus("permission-mode", modeStatus("bypassPermissions", undefined), ctx);
    adapter.onStatus("permission-prompting", "permission prompts: off", ctx);
    expect(contributions.get("mode")?.tracker).toEqual({ count: "plan · yolo", status: "attention", step: "prompts off" });
    expect(contributions.get("mode-badge")).toMatchObject({ placement: "session.badge", node: { t: "badge", text: "plan · yolo", tone: "warning" } });
    for (const key of ["workflow-mode", "permission-mode", "permission-prompting", "tool-gate"]) adapter.onStatus(key, undefined, ctx);
    expect(contributions.size).toBe(0);
  });

  it("before v2 leaves the statuses to the generic Status panel and publishes nothing", () => {
    const { ctx, contributions } = makeCtx();
    expect(adapter.onStatus("workflow-mode", workflowStatus("work", undefined), ctx)).toBe(false);
    adapter.onRestore(ctx);
    expect(contributions.size).toBe(0);
  });
});

