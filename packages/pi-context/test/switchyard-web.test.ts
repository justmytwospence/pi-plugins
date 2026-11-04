import { type ExtensionAPI, createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, test, vi } from "vitest";
import extension from "../src/index.ts";

function load() {
  const pi = {
    registerCommand: vi.fn(),
    getAllTools: () => [{ name: "read", description: "Read", parameters: { type: "object" } }],
    on: vi.fn(),
    events: createEventBus(),
  };
  extension(pi as unknown as ExtensionAPI);
  return pi;
}

const ctx = {
  hasUI: true,
  mode: "rpc",
  model: { contextWindow: 200_000 },
  getContextUsage: () => ({ tokens: 10_000, percent: 5, contextWindow: 200_000 }),
  getSystemPrompt: () => "x".repeat(4_000),
  getSystemPromptOptions: () => ({ cwd: "/", selectedTools: ["read"] }),
  sessionManager: { getSessionId: () => "session", buildContextEntries: () => [] },
  ui: { notify: vi.fn() },
};

describe("context web view", () => {
  test("claims /context and returns the breakdown", async () => {
    const pi = load();
    const probe: any = { version: 1, name: "context", args: "", probe: true };
    pi.events.emit("switchyard.web-command.v1", probe);
    expect(probe.accept).toBe(true);
    const other: any = { version: 1, name: "other", args: "", probe: true };
    pi.events.emit("switchyard.web-command.v1", other);
    expect(other.accept).toBeUndefined();

    const req: any = { version: 1, name: "context", args: "", probe: false, ctx };
    pi.events.emit("switchyard.web-command.v1", req);
    const view = await req.view;
    expect(view.title).toBe("Context");
    const [summary, parts] = view.body.children;
    expect(summary.text).toContain("tokens");
    expect(parts.t).toBe("table");
    expect(parts.columns).toEqual(["Part", "Tokens", "Share"]);
    expect(parts.rows.length).toBeGreaterThan(0);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });
});
