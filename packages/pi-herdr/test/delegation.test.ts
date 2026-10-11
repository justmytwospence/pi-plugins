import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import piHerdr from "../src/index.ts";

// Capture the actual model-facing registration without starting sessions, sockets, or panes.
afterEach(() => vi.unstubAllEnvs());

test("Herdr guidance separates report-back delegation from persistent handoffs and checkout isolation", () => {
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_SOCKET_PATH", "/unused/herdr.sock");
  vi.stubEnv("HERDR_PANE_ID", "w1:p1");
  let registered: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  piHerdr({
    events: { on() {} },
    on() {},
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) { registered = tool; },
  } as unknown as ExtensionAPI);
  expect(registered?.name).toBe("herdr_child");
  expect(registered?.description).toContain("persistent, human-led");
  expect(registered?.description).toContain("use a headless subagent instead");
  expect(registered?.description).toContain("even for long or multi-step tasks");
  const guidelines = registered?.promptGuidelines?.join("\n") ?? "";
  expect(guidelines).toContain("Duration, complexity");
  expect(guidelines).toContain("explicit interactive-session request");
  expect(guidelines).toContain("where=tab in the existing Herdr space");
  expect(guidelines).toContain("Tabs and splits share files");
  expect(guidelines).toContain("where=split only for deliberate side-by-side");
  expect(guidelines).toContain("otherwise ask before creating one");
  expect(guidelines).toContain("already open");
  expect(guidelines).not.toContain("Use herdr_child when the work is long or open-ended");
  const schema = JSON.stringify(registered?.parameters);
  expect(schema).toContain("user-requested independent branch/checkout");
  expect(schema).toContain("do not create a worktree without the user's request");
});
