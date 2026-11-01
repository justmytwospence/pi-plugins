import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import piCopy, { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev, type ClassifierAnswer, type JevOutcome } from "../src/jev.ts";
import type { Picker } from "../src/picker.ts";
import { chronological } from "../src/rank.ts";
import { SYSTEM1_CHANGED, resolveSystem1Target } from "../src/system1.js";
import { assistantEntry, harness } from "./harness.ts";

// Deliberately ignore cancellation and return old successes: consumers must guard UI application too.
vi.mock("../src/jev.ts", async (original) => ({ ...await original<typeof import("../src/jev.ts")>(), askJev: vi.fn() }));

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "copy-system1-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  vi.mocked(askJev).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const backend = (value: string) => writeFileSync(path.join(root, "system1.json"), JSON.stringify({ backend: value }));

function setup() {
  const h = harness();
  piCopy(h.pi);
  const ctx = h.ctx({ cwd: root, sessionManager: { getBranch: () => [assistantEntry("Older paragraph worth copying."), assistantEntry("Newest paragraph worth copying.")] } });
  const views: Array<{ picker: Picker; close: () => void }> = [];
  ctx.ui.custom = (factory: any) => new Promise((resolve) => {
    const picker = factory({ requestRender: () => undefined }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, undefined, resolve);
    views.push({ picker, close: () => resolve(undefined) });
  });
  return { h, ctx, views, open: () => h.commands.get("yank").handler("", ctx) as Promise<void> };
}

function judgments() {
  const calls: Array<{ signal?: AbortSignal; finish: (hideAll?: boolean) => void }> = [];
  vi.mocked(askJev).mockImplementation((_registry, config, _state, questions, signal) => {
    const target = resolveSystem1Target(config);
    if (!target.ok) throw new Error(target.reason);
    return new Promise<JevOutcome>((resolve) => {
      calls.push({ signal, finish: (hideAll = false) => {
        const answers: Record<string, ClassifierAnswer> = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id,
          question.type === "score" ? { type: "score", score: id.includes("0") ? 3 : 0, confidence: 1 }
            : { type: "bool", probability: hideAll ? 0 : 1 },
        ]));
        resolve({ ...target, selectionKey: target.key, answers, latencyMs: 1 });
      } });
    });
  });
  return calls;
}

test("content cache is scoped to the effective backend/provider/model target", async () => {
  const calls = judgments();
  const s = setup();
  let opened = s.open();
  calls[0]!.finish();
  await flush();
  s.views.at(-1)!.close();
  await opened;
  opened = s.open();
  expect(calls).toHaveLength(1);
  s.views.at(-1)!.close();
  await opened;

  // No watcher event: opening must still read the authoritative selection.
  backend("openai-decisions");
  opened = s.open();
  expect(calls).toHaveLength(2);
  calls[1]!.finish();
  await flush();
  s.views.at(-1)!.close();
  await opened;
  // Dormant Jev overrides do not change the effective Decisions target.
  writeFileSync(path.join(root, "copy.json"), JSON.stringify({ jev: { provider: "other", model: "other-model" } }));
  opened = s.open();
  expect(calls).toHaveLength(2);
  s.views.at(-1)!.close();
  await opened;
  backend("jev");
  opened = s.open();
  expect(calls).toHaveLength(3);
  calls[2]!.finish();
  await flush();
  s.views.at(-1)!.close();
  await opened;
  writeFileSync(path.join(root, "copy.json"), JSON.stringify({ jev: { ...DEFAULT_CONFIG.jev, model: "another-jev" } }));
  opened = s.open();
  expect(calls).toHaveLength(4);
  s.views.at(-1)!.close();
  await opened;
});

test.each([false, true])("a backend change aborts ranking and rejects late success (event=%s)", async (event) => {
  const calls = judgments();
  const s = setup();
  const opened = s.open();
  const { picker, close } = s.views[0]!;
  picker.handleInput("\x1b[B");
  const selected = picker.items()[picker.cursor]!.id;
  backend("openai-decisions");
  if (event) s.h.pi.events.emit(SYSTEM1_CHANGED, {});
  else picker.handleInput("\x1b[C"); // Interaction, with no watcher, checks before using the ranking.
  expect(calls[0]!.signal?.aborted).toBe(true);
  expect(picker.items()[picker.cursor]!.id).toBe(selected);
  expect(picker.items().map((p) => p.id)).toEqual(chronological(picker.items()).map((p) => p.id));
  expect(picker.render(120).join("\n")).toContain("recency order");
  calls[0]!.finish(true);
  await flush();
  expect(picker.items()[picker.cursor]!.id).toBe(selected);
  expect(s.h.entries).toEqual([]);
  close();
  await opened;
});

test("completion rereads the backend even without an event or picker interaction", async () => {
  const calls = judgments();
  const s = setup();
  const opened = s.open();
  backend("openai-decisions");
  calls[0]!.finish(true);
  await flush();
  expect(calls[0]!.signal?.aborted).toBe(true);
  const { picker, close } = s.views[0]!;
  expect(picker.items().length).toBeGreaterThan(0);
  expect(picker.render(80).join("\n")).toContain("recency order");
  expect(s.h.entries).toEqual([]);
  close();
  await opened;
});

test("an old picker cannot populate the changed-backend picker's cache or replace its selection", async () => {
  const calls = judgments();
  const s = setup();
  const old = s.open();
  backend("openai-decisions");
  const fresh = s.open();
  expect(calls[0]!.signal?.aborted).toBe(true);
  const current = s.views[1]!;
  current.picker.handleInput("\x1b[B");
  const selected = current.picker.items()[current.picker.cursor]!.id;
  calls[1]!.finish();
  await flush();
  const items = current.picker.items().map((p) => p.id);
  calls[0]!.finish(true);
  await flush();
  expect(current.picker.items().map((p) => p.id)).toEqual(items);
  expect(current.picker.items()[current.picker.cursor]!.id).toBe(selected);
  expect(s.h.entries).toHaveLength(1);
  s.views[0]!.close();
  current.close();
  await Promise.all([old, fresh]);
});

test("closing a picker aborts work and a late success is not cached", async () => {
  const calls = judgments();
  const s = setup();
  const opened = s.open();
  s.views[0]!.close();
  await opened;
  expect(calls[0]!.signal?.aborted).toBe(true);
  calls[0]!.finish();
  await flush();
  const reopened = s.open();
  expect(calls).toHaveLength(2);
  expect(s.h.entries).toEqual([]);
  s.views[1]!.close();
  await reopened;
});

test("unavailable ranking keeps chronological fallback", async () => {
  vi.mocked(askJev).mockResolvedValue({ ok: false, reason: "unavailable" });
  const s = setup();
  const opened = s.open();
  await flush();
  const { picker, close } = s.views[0]!;
  expect(picker.items().map((p) => p.id)).toEqual(chronological(picker.items()).map((p) => p.id));
  expect(picker.render(80).join("\n")).toContain("recency order");
  close();
  await opened;
});
