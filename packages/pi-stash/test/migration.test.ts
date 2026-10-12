import { afterEach, beforeEach, expect, test, vi } from "vitest";
import promptStash, { LEASE, STASH_KEY, STASH_OWNER, WRAPPER, adoptStash } from "../src/index.ts";
import { CTRL_S, flush, harness } from "./harness.ts";
import { legacyPromptStash } from "./legacy.ts";

const globals = globalThis as Record<symbol, unknown>;

beforeEach(() => {
  delete globals[LEASE];
  delete globals[STASH_KEY];
});
afterEach(() => {
  delete globals[LEASE];
  delete globals[STASH_KEY];
});

function expectUnknownWarning(notes: Array<{ message: string; type?: string }>) {
  const warnings = notes.filter((note) => note.type === "warning");
  expect(warnings).toHaveLength(1);
  const message = warnings[0]!.message;
  expect(message).toMatch(/unrecognized process-global stash/);
  expect(message).toMatch(/possibly retained from @saadjs\/pi-stash/);
  expect(message).toMatch(/Cannot tell whether the legacy copy is still active/);
  expect(message).toMatch(/stays inactive and leaves the stash untouched/);
  expect(message).toMatch(/Save any current\/stashed drafts/);
  expect(message).toMatch(/disable other stash copies/);
  expect(message).toMatch(/fully quit and restart Pi \(not \/reload\)/);
  expect(message).not.toMatch(/already owns Ctrl\+S|another .* is active/);
}

test.each([
  { draft: undefined, started: false },
  { draft: "retained draft", started: false },
  { draft: undefined, started: true },
  { draft: "retained draft", started: true },
])("retired legacy factory (started=$started, draft=$draft) is unknown, not a live owner", async ({ draft, started }) => {
  const old = harness();
  const legacy = legacyPromptStash(old.pi);
  // The factory publishes the global even before any session_start.
  expect(globals[STASH_KEY]).toBe(legacy.stash);
  expect(Object.getOwnPropertySymbols(legacy.stash)).toEqual([]);
  if (draft !== undefined) legacy.stash.stash(draft);
  const retired = old.session();
  retired.state.main.setText("old current draft");
  if (started) await old.emit("session_start", {}, retired.ctx);
  await old.emit("session_shutdown", {}, retired.ctx);
  expect(globals[STASH_KEY]).toBe(legacy.stash);

  // A replacement runtime loads ONLY the suite, with no legacy handlers.
  const next = harness();
  promptStash(next.pi);
  const s = next.session();
  s.state.main.setText("current draft");
  const before = s.factory();
  const take = vi.spyOn(legacy.stash, "take");
  expect(adoptStash()).toEqual({ status: "unknown" });
  await next.emit("session_start", {}, s.ctx);
  expectUnknownWarning(s.notes);
  expect(s.factory()).toBe(before);
  expect(s.state.main.getText()).toBe("current draft");
  expect(s.status.size).toBe(0);
  expect(globals[LEASE]).toBeUndefined();

  s.state.main.handleInput(CTRL_S);
  expect(s.state.main.getText()).toBe("current draft");
  expect(s.state.main.keys).toEqual([CTRL_S]);
  s.state.main.setText("");
  await next.emit("model_select", {}, s.ctx);
  await next.emit("thinking_level_select", {}, s.ctx);
  await next.emit("session_shutdown", {}, s.ctx);
  await flush();
  expect(s.state.main.getText()).toBe("");
  expect(globals[STASH_KEY]).toBe(legacy.stash);
  expect(legacy.stash.value).toBe(draft);
  expect(take).not.toHaveBeenCalled();
  expect(Object.getOwnPropertySymbols(legacy.stash)).toEqual([]);
  expect(legacy.counts).toEqual({ toggles: 0, restores: 0 });

  // Another session/reload in the same process cannot resolve this uncertainty.
  const replacement = next.session();
  await next.emit("session_start", {}, replacement.ctx);
  expectUnknownWarning(replacement.notes);
  expect(replacement.factory()).toBe(replacement.baseFactory);
  expect(globals[STASH_KEY]).toBe(legacy.stash);
  expect(legacy.stash.value).toBe(draft);
  await next.emit("session_shutdown", {}, replacement.ctx);
});

test.each(["legacy-first", "suite-first"])("live legacy duplicate stays the only key/event handler (%s)", async (order) => {
  const h = harness();
  if (order === "suite-first") promptStash(h.pi);
  const legacy = legacyPromptStash(h.pi);
  if (order === "legacy-first") promptStash(h.pi);
  const s = h.session();
  s.state.main.setText("live draft");
  // Legacy factory state already exists, regardless of session handler order.
  expect(adoptStash()).toEqual({ status: "unknown" });
  await h.emit("session_start", {}, s.ctx);
  expectUnknownWarning(s.notes);
  expect((s.factory() as unknown as Record<symbol, unknown>)[WRAPPER]).toBeUndefined();
  expect(globals[LEASE]).toBeUndefined();
  expect((legacy.stash as unknown as Record<symbol, unknown>)[STASH_OWNER]).toBeUndefined();

  s.state.main.handleInput(CTRL_S);
  expect(legacy.counts.toggles).toBe(1);
  expect(legacy.stash.value).toBe("live draft"); // Still the legacy string API, not a suite entry.
  expect(s.state.main.getText()).toBe("");
  await h.emit("model_select", {}, s.ctx);
  expect(legacy.counts.restores).toBe(1);
  expect(s.state.main.getText()).toBe("live draft");
  expect(legacy.stash.value).toBeUndefined();
  expect(s.notes).toHaveLength(1); // No suite stash/restore notifications.

  s.state.main.handleInput(CTRL_S);
  expect(legacy.counts.toggles).toBe(2);
  await h.emit("thinking_level_select", {}, s.ctx);
  expect(legacy.counts.restores).toBe(2);
  expect(s.state.main.getText()).toBe("live draft");

  // Legacy manual restore and swap must retain their string-only semantics too.
  s.state.main.handleInput(CTRL_S);
  s.state.main.handleInput(CTRL_S);
  expect(legacy.counts.toggles).toBe(4);
  expect(s.state.main.getText()).toBe("live draft");
  expect(legacy.stash.value).toBeUndefined();
  s.state.main.handleInput(CTRL_S);
  s.state.main.setText("new live draft");
  s.state.main.handleInput(CTRL_S);
  expect(legacy.counts.toggles).toBe(6);
  expect(s.state.main.getText()).toBe("live draft");
  expect(legacy.stash.value).toBe("new live draft");
  await h.emit("model_select", {}, s.ctx);
  expect(legacy.counts.restores).toBe(2); // Nonempty editor is still protected.
  expect(legacy.stash.value).toBe("new live draft");
  expect(s.notes).toHaveLength(1);
  expect(globals[STASH_KEY]).toBe(legacy.stash);
  const factory = s.factory();
  await h.emit("session_shutdown", {}, s.ctx);
  expect(s.factory()).toBe(factory); // Inactive suite must not tear down legacy's editor.
  expect(globals[STASH_KEY]).toBe(legacy.stash);
});

test("unknown legacy state never acquires or releases another suite instance's lease", async () => {
  const legacyRuntime = harness();
  const legacy = legacyPromptStash(legacyRuntime.pi);
  legacy.stash.stash("retained draft");
  const otherLease = {};
  globals[LEASE] = otherLease;
  const h = harness();
  promptStash(h.pi);
  const s = h.session();
  await h.emit("session_start", {}, s.ctx);
  expectUnknownWarning(s.notes);
  expect(s.factory()).toBe(s.baseFactory);
  expect(globals[LEASE]).toBe(otherLease);
  await h.emit("session_shutdown", {}, s.ctx);
  expect(globals[LEASE]).toBe(otherLease);
  expect(globals[STASH_KEY]).toBe(legacy.stash);
  expect(legacy.stash.value).toBe("retained draft");
});
