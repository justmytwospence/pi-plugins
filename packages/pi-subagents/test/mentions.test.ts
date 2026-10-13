import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { discoverAgents } from "../src/agents.ts";
import subagents from "../src/index.ts";
import { mentionGuidance, subagentAutocomplete, type AutocompleteProvider } from "../src/mentions.ts";
import { harness } from "./harness.ts";
import { fakeUI } from "./ui-helpers.ts";

afterEach(() => vi.unstubAllEnvs());
test("config is byte-identical to the actual pi-copy sibling", () => {
  expect(readFileSync(new URL("../src/config.ts", import.meta.url), "utf8")).toBe(readFileSync(new URL("../../pi-copy/src/config.ts", import.meta.url), "utf8"));
});

test("custom starts do not expand user mentions or run references", async () => {
  const h = harness();
  await subagents(h.pi);
  const ctx = h.ctx();
  expect(await h.emit("before_agent_start", { messageType: "custom", message: { content: "@subagent:audit @run:previous" } }, ctx)).toBeUndefined();
  await h.emit("session_shutdown", {}, ctx);
});

test("native mentions complete actual discovery, project overrides, delegate to subagent and retain file completion", async () => {
  const user = mkdtempSync(path.join(tmpdir(), "subagent-mentions-user-"));
  const cwd = mkdtempSync(path.join(tmpdir(), "subagent-mentions-project-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", user);
  mkdirSync(path.join(user, "agents"));
  mkdirSync(path.join(cwd, ".pi/agents"), { recursive: true });
  writeFileSync(path.join(user, "agents/audit.md"), "---\nname: audit\ndescription: user auditor\n---\nUser instructions");
  writeFileSync(path.join(cwd, ".pi/agents/audit.md"), "---\nname: audit\ndescription: project auditor\ntools: read, bash\n---\nProject instructions");
  const base: AutocompleteProvider = { triggerCharacters: ["@", "/"], getSuggestions: vi.fn(async () => ({ prefix: "@", items: [{ value: "file.ts", label: "file" }] })), applyCompletion: vi.fn(() => ({ lines: ["file.ts"], cursorLine: 0, cursorCol: 7 })), shouldTriggerFileCompletion: () => true };
  const h = harness();
  const ui = Object.assign(fakeUI(), { addAutocompleteProvider: vi.fn((factory: (base: AutocompleteProvider) => AutocompleteProvider) => { provider = factory(base); }) });
  let provider!: AutocompleteProvider;
  await subagents(h.pi);
  const ctx = h.ctx({ cwd, ui });
  await h.emit("session_start", {}, ctx);
  await h.emit("session_start", {}, ctx);
  expect(ui.addAutocompleteProvider).toHaveBeenCalledTimes(1);
  const options = { signal: new AbortController().signal };
  const suggestions = await provider.getSuggestions(["Ask @subagent:au"], 0, 16, options);
  expect(suggestions?.items).toEqual([{ value: "@subagent:audit", label: "audit", description: "project auditor (project)" }]);
  expect(provider.applyCompletion(["Ask @subagent:au next"], 0, 16, suggestions!.items[0]!, suggestions!.prefix)).toEqual({ lines: ["Ask @subagent:audit  next"], cursorLine: 0, cursorCol: 20 });
  expect(provider.shouldTriggerFileCompletion?.(["@subagent:"], 0, 10)).toBe(false);
  expect(await provider.getSuggestions(["@file"], 0, 5, options)).toEqual({ prefix: "@", items: [{ value: "file.ts", label: "file" }] });
  expect(base.getSuggestions).toHaveBeenCalledTimes(1);
  const guidance: any = await h.emit("before_agent_start", { prompt: "Use @subagent:audit and @subagent:missing" }, ctx);
  expect(guidance.message.display).toBe(false);
  expect(guidance.message.content).toContain('subagent(agent: "audit")');
  expect(guidance.message.content).toContain("project auditor");
  expect(guidance.message.content).toContain("no agent of that name");
  expect(guidance.message.content).not.toMatch(/Claude|CC|@agent-/);
  expect(mentionGuidance("no mentions", discoverAgents(cwd))).toBeUndefined();
  // New definitions are discovered at suggestion time, not cached at startup.
  writeFileSync(path.join(cwd, ".pi/agents/added.md"), "---\nname: added\ndescription: added later\n---\nInstructions");
  expect((await provider.getSuggestions(["@subagent:add"], 0, 13, options))?.items[0]?.label).toBe("added");
  await h.emit("session_shutdown", {}, ctx);
});

test("without a native hook the wrapper remains optional and the underlying provider keeps its receiver", async () => {
  const current: AutocompleteProvider = { getSuggestions: async function () { expect(this).toBe(current); return null; }, applyCompletion: function () { expect(this).toBe(current); return { lines: [], cursorLine: 0, cursorCol: 0 }; } };
  const wrapped = subagentAutocomplete(current, () => []);
  await wrapped.getSuggestions(["hello"], 0, 5, { signal: new AbortController().signal });
  wrapped.applyCompletion([], 0, 0, { value: "file", label: "file" }, "@");
});
