import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.ts";
import { MODEL_FAMILIES_CHANGED, modelFamiliesPath } from "../src/model-families.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "families-ext-")); process.env.PI_CODING_AGENT_DIR = dir; delete process.env.PI_SUBAGENT; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PI_CODING_AGENT_DIR; delete process.env.PI_SUBAGENT; });

const catalog = [
  { provider: "openai", id: "gpt-6-sol", cost: { input: 5, output: 25 } },
  { provider: "openai", id: "gpt-6-terra", cost: { input: 2, output: 10 } },
  { provider: "openai", id: "gpt-6-luna", cost: { input: 1, output: 5 } },
  { provider: "openai", id: "gpt-6.2-nova", cost: { input: 3, output: 15 } },
];
function harness(selects: (string | undefined)[] = []) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
  const emit = vi.fn();
  extension({ on: (n: string, h: never) => handlers.set(n, h), registerCommand: (n: string, o: never) => commands.set(n, o), events: { emit } } as never);
  const notify = vi.fn();
  const select = vi.fn(async () => selects.shift());
  const ctx = { hasUI: true, modelRegistry: { getAll: () => catalog }, ui: { notify, select } };
  return { handlers, commands, emit, notify, select, ctx };
}

describe("pi-model-families", () => {
  it("announces a new family once and records it as seen", () => {
    const h = harness();
    h.handlers.get("session_start")!({}, h.ctx);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toContain("Nova (openai, provisionally balanced");
    expect(JSON.parse(readFileSync(modelFamiliesPath(), "utf8")).seen).toEqual({ openai: ["nova"] });
    h.notify.mockClear();
    h.handlers.get("session_start")!({}, h.ctx);
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("is silent in a subagent", () => {
    process.env.PI_SUBAGENT = "1";
    const h = harness();
    h.handlers.get("session_start")!({}, h.ctx);
    expect(h.notify).not.toHaveBeenCalled();
  });
  it("lists the table", async () => {
    const h = harness();
    await h.commands.get("families")!.handler("list", h.ctx);
    expect(h.notify.mock.calls[0]![0]).toContain("google/antigravity-gemini");
  });
  it("confirms a discovery and announces the change", async () => {
    const h = harness(["Nova · openai · balanced (priced like Terra)", "strong"]);
    await h.commands.get("families")!.handler("", h.ctx);
    const file = JSON.parse(readFileSync(modelFamiliesPath(), "utf8"));
    expect(file.routes.openai.add).toEqual([{ id: "nova", name: "Nova", tiers: ["strong"], before: "terra" }]);
    expect(h.emit).toHaveBeenCalledWith(MODEL_FAMILIES_CHANGED, {});
  });
  it("ignores a discovery", async () => {
    const h = harness(["Nova · openai · balanced (priced like Terra)", "Ignore"]);
    await h.commands.get("families")!.handler("", h.ctx);
    expect(JSON.parse(readFileSync(modelFamiliesPath(), "utf8")).routes.openai.ignore).toEqual(["nova"]);
    expect(h.emit).toHaveBeenCalled();
  });
  it("does nothing when the picker is cancelled", async () => {
    const h = harness([undefined]);
    await h.commands.get("families")!.handler("", h.ctx);
    expect(h.emit).not.toHaveBeenCalled();
  });
});
