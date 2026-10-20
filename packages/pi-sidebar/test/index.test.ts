import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import piSidebar from "../src/index.ts";
import { FakePi, fakeCtx } from "./fake.ts";

const KEYS = ["PI_SIDEBAR_HOST", "PI_SIDEBAR_KEYS", "HERDR_ENV", "HERDR_PANE_ID"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("registration", () => {
  it("registers /sidebar and ctrl+' in the main session", () => {
    delete process.env.PI_SIDEBAR_HOST;
    delete process.env.PI_SIDEBAR_KEYS;
    const pi = new FakePi();
    piSidebar(pi as any);
    expect([...pi.commands.keys()]).toEqual(["sidebar"]);
    expect([...pi.shortcuts.keys()]).toEqual(["ctrl+'"]);
    expect(pi.handlers.has("before_provider_request")).toBe(true);
    expect(pi.handlers.has("tool_call")).toBe(false);
  });

  it("takes its keys from PI_SIDEBAR_KEYS", () => {
    process.env.PI_SIDEBAR_KEYS = "ctrl+., alt+s";
    const pi = new FakePi();
    piSidebar(pi as any);
    expect([...pi.shortcuts.keys()]).toEqual(["ctrl+.", "alt+s"]);
  });

  it("runs as Sidebar when started with PI_SIDEBAR_HOST", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-sidebar-index-"));
    try {
      process.env.PI_SIDEBAR_HOST = dir;
      const pi = new FakePi();
      piSidebar(pi as any);
      expect(pi.handlers.has("tool_call")).toBe(true);
      expect(pi.handlers.has("context_with_system")).toBe(true);
      expect([...pi.commands.keys()]).toEqual(["sidebar"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("explains why the model cannot be overridden", async () => {
    delete process.env.PI_SIDEBAR_HOST;
    const pi = new FakePi();
    piSidebar(pi as any);
    const c = fakeCtx();
    await pi.commands.get("sidebar")!.handler("model anthropic/claude-haiku", c.ctx);
    expect(c.notes[0]!.message).toMatch(/always uses main's model/);
  });
});
