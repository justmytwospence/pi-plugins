import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import piCopy from "../src/index.ts";
import type { ClassifierQuestion } from "../src/jev.ts";
import type { Picker } from "../src/picker.ts";
import { SYSTEM1_CHANGED } from "../src/system1.js";
import { assistantEntry, harness } from "./harness.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "copy-waterfall-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const waterfall = (order: string[]) => writeFileSync(path.join(root, "system1.json"), JSON.stringify({ waterfall: order }));
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

async function setup() {
  const h = harness();
  piCopy(h.pi);
  type Finish = { error?: string; malformed?: boolean; version?: string };
  const calls: Array<{ provider: string; signal?: AbortSignal; finish: (result?: Finish) => void }> = [];
  // Local registry only: fake native metadata and requests, never credentials or network.
  const registry = {
    findOfType: (_type: string, provider: string, id: string) => ({ provider, id, api: "openai-decisions", baseUrl: "https://api.openai.com/v1" }),
    classify: (model: { provider: string; id: string }, context: { questions: Record<string, ClassifierQuestion> }, options: { signal?: AbortSignal }) => new Promise(resolve => {
      calls.push({ provider: model.provider, signal: options.signal, finish: (result = {}) => resolve({
        model: result.version ?? model.id,
        stopReason: result.error ? "error" : "stop",
        ...(result.error ? { errorMessage: result.error } : {}),
        answers: Object.fromEntries(Object.entries(context.questions).map(([id, question]) => [id,
          question.type === "score" ? { type: "score", score: 3, confidence: 1 }
            : { type: "bool", probability: result.malformed ? 2 : 1 },
        ])),
      }) });
    }),
  };
  const branch = [assistantEntry("Older paragraph worth copying."), assistantEntry("Newest paragraph worth copying.")];
  const ctx = h.ctx({ cwd: root, modelRegistry: registry, sessionManager: { getBranch: () => branch, getSessionId: () => "copy-waterfall" } });
  const views: Array<{ picker: Picker; close: () => void }> = [];
  ctx.ui.custom = (factory: any) => new Promise(resolve => {
    const picker = factory({ requestRender: () => undefined }, { fg: (_c: string, text: string) => text, bold: (text: string) => text }, undefined, resolve);
    views.push({ picker, close: () => resolve(undefined) });
  });
  await h.emit("session_start", {}, ctx);
  const open = async () => {
    const opened = h.commands.get("yank").handler("", ctx) as Promise<void>;
    await flush();
    const view = views.at(-1)!;
    return { ...view, close: async () => { view.close(); await opened; } };
  };
  return { h, ctx, calls, open, decisions: () => h.entries.filter(entry => entry.customType === "copy:decision") };
}

test.each([
  ["jev", "openai-decisions", "typesafe", "system1-openai"],
  ["openai-decisions", "jev", "system1-openai", "typesafe"],
])("winner cache follows cooldown and primary recovery (%s → %s)", async (first, second, preferred, fallback) => {
  waterfall([first, second]);
  const s = await setup();
  let view = await s.open();
  view.picker.handleInput("\x1b[B");
  const selected = view.picker.items()[view.picker.cursor]!.id;
  s.calls[0]!.finish({ error: "quota or credits exhausted" });
  await flush();
  expect(s.calls[1]!.provider).toBe(fallback);
  s.calls[1]!.finish({ version: "reported-version-not-the-configured-model" });
  await flush();
  expect(view.picker.items()[view.picker.cursor]!.id).toBe(selected);
  expect(s.calls[0]!.signal?.aborted).toBe(false);
  expect(s.decisions()).toHaveLength(1);
  expect(s.decisions()[0]!.data).toMatchObject({ backend: second, fallback: true, waterfall: [first, second] });
  await view.close();

  view = await s.open();
  expect(s.calls).toHaveLength(2); // Reuse the winner's configured target, not its reported version.
  await view.close();
  vi.setSystemTime(Date.now() + 300_001);
  view = await s.open();
  expect(s.calls).toHaveLength(3); // Expiry restores primary eligibility, not fallback scores.
  expect(s.calls[2]!.provider).toBe(preferred);
  s.calls[2]!.finish();
  await flush();
  await view.close();
  view = await s.open();
  expect(s.calls).toHaveLength(3);
  await view.close();
  await s.h.emit("session_shutdown", {}, s.ctx);
});

test("a request-specific fallback answer never populates the still-eligible primary cache", async () => {
  waterfall(["jev", "openai-decisions"]);
  const s = await setup();
  let view = await s.open();
  s.calls[0]!.finish({ malformed: true });
  await flush();
  expect(s.calls).toHaveLength(2);
  s.calls[1]!.finish();
  await flush();
  expect(s.decisions()[0]!.data).toMatchObject({ backend: "openai-decisions", fallback: true });
  await view.close();
  view = await s.open();
  expect(s.calls).toHaveLength(3);
  expect(s.calls[2]!.provider).toBe("typesafe");
  await view.close();
  await s.h.emit("session_shutdown", {}, s.ctx);
});

test("replacing a chain while its fallback is pending preserves manual selection and discards late output", async () => {
  waterfall(["jev", "openai-decisions"]);
  const s = await setup();
  let view = await s.open();
  s.calls[0]!.finish({ error: "quota or credits exhausted" });
  await flush();
  expect(s.calls).toHaveLength(2);
  view.picker.handleInput("\x1b[B");
  const selected = view.picker.items()[view.picker.cursor]!.id;
  waterfall(["jev"]); // Same primary, different ownership identity.
  s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  expect(s.calls[1]!.signal?.aborted).toBe(true);
  s.calls[1]!.finish();
  await flush();
  expect(view.picker.items()[view.picker.cursor]!.id).toBe(selected);
  expect(view.picker.render(120).join("\n")).toContain("recency order");
  expect(s.decisions()).toEqual([]);
  await view.close();
  view = await s.open();
  expect(s.calls).toHaveLength(3);
  expect(s.calls[2]!.provider).toBe("typesafe");
  await view.close();
  await s.h.emit("session_shutdown", {}, s.ctx);
});
