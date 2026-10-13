import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { Conversation, type Message } from "../src/conversation.ts";
import subagents from "../src/index.ts";
import type { AutocompleteProvider } from "../src/mentions.ts";
import { compactTranscript, referenceContext, referenceItems, referenceToken, resolveReference, runAutocomplete, type RunRef } from "../src/references.ts";
import { harness } from "./harness.ts";
import { fakeRun, fakeUI } from "./ui-helpers.ts";

const ref = (over: Partial<RunRef> & { id: string }): RunRef => ({
  agent: "scout",
  task: "Find where the config is loaded",
  status: "done",
  model: "m/x",
  run: () => fakeRun({ id: over.id, task: over.task ?? "Find where the config is loaded", ...(over.label ? { label: over.label } : {}), agent: over.agent ?? "scout", state: { status: "done", output: `output of ${over.id}` } }),
  ...over,
});

test("tokens are label slugs, or ids where labels collide; resolution takes ids, unique prefixes and slugs", () => {
  const refs = [ref({ id: "a1b2c3", label: "Audit cache invalidation" }), ref({ id: "d4e5f6", label: "Step" }), ref({ id: "a1zzzz", label: "Step" })];
  expect(referenceToken(refs[0]!, refs)).toBe("audit-cache-invalidation");
  expect(referenceToken(refs[1]!, refs)).toBe("d4e5f6");
  expect(resolveReference("audit-cache-invalidation", refs)).toEqual({ ref: refs[0] });
  expect(resolveReference("Audit-Cache-Invalidation", refs)).toEqual({ ref: refs[0] });
  expect(resolveReference("d4e5", refs)).toEqual({ ref: refs[1] });
  expect(resolveReference("a1", refs)).toEqual({ ambiguous: [refs[0], refs[2]] });
  expect(resolveReference("step", refs)).toEqual({ ambiguous: [refs[1], refs[2]] });
  expect(resolveReference("nothing", refs)).toBeUndefined();
});

test("completion lists runs newest first, filtered by id, label or agent, and inserts the token", async () => {
  const refs = [ref({ id: "newest", label: "Review the diff", agent: "reviewer", status: "running" }), ref({ id: "older1", label: "Find the config" })];
  expect(referenceItems("@run:", refs).map((i) => i.value)).toEqual(["@run:review-the-diff", "@run:find-the-config"]);
  expect(referenceItems("@run:", refs)[0]).toEqual({ value: "@run:review-the-diff", label: "Review the diff · reviewer", description: "running · newest · m/x" });
  expect(referenceItems("@run:old", refs).map((i) => i.value)).toEqual(["@run:find-the-config"]);
  expect(referenceItems("@run:config", refs).map((i) => i.value)).toEqual(["@run:find-the-config"]);
  expect(referenceItems("@run:rev", refs).map((i) => i.value)).toEqual(["@run:review-the-diff"]);
  expect(referenceItems("@run:zzz", refs)).toEqual([]);

  const base: AutocompleteProvider = { triggerCharacters: ["@"], getSuggestions: vi.fn(async () => ({ prefix: "@", items: [{ value: "file.ts", label: "file" }] })), applyCompletion: vi.fn(() => ({ lines: ["file.ts"], cursorLine: 0, cursorCol: 7 })), shouldTriggerFileCompletion: () => true };
  const provider = runAutocomplete(base, () => refs);
  const options = { signal: new AbortController().signal };
  const suggestions = await provider.getSuggestions(["See @run:fi"], 0, 11, options);
  expect(suggestions).toEqual({ prefix: "@run:fi", items: [{ value: "@run:find-the-config", label: "Find the config · scout", description: "done · older1 · m/x" }] });
  expect(provider.applyCompletion(["See @run:fi then"], 0, 11, suggestions!.items[0]!, suggestions!.prefix)).toEqual({ lines: ["See @run:find-the-config  then"], cursorLine: 0, cursorCol: 25 });
  expect(provider.shouldTriggerFileCompletion?.(["@run:"], 0, 5)).toBe(false);
  expect(provider.shouldTriggerFileCompletion?.(["@file"], 0, 5)).toBe(true);
  expect(await provider.getSuggestions(["@file"], 0, 5, options)).toEqual({ prefix: "@", items: [{ value: "file.ts", label: "file" }] });
  expect(await provider.getSuggestions(["@run:zzz"], 0, 8, options)).toBeNull();
  expect(base.getSuggestions).toHaveBeenCalledTimes(1);
  provider.applyCompletion(["@file"], 0, 5, { value: "file.ts", label: "file" }, "@");
  expect(base.applyCompletion).toHaveBeenCalledTimes(1);
});

test("the compact transcript skips the task, thinking and signatures, keeps tool calls and results, and cuts the middle", () => {
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: "Find the config" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Looking." }, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "rg   loadConfig" } }] },
    { role: "toolResult", toolName: "bash", toolCallId: "t1", content: [{ type: "text", text: "src/config.ts:3\nsrc/index.ts:9" }] },
    { role: "assistant", content: [{ type: "text", text: "It is in src/config.ts." }] },
  ];
  expect(compactTranscript(messages, "Find the config")).toBe("assistant: Looking.\ntool: bash: rg loadConfig\ntool result (bash): src/config.ts:3 src/index.ts:9\nassistant: It is in src/config.ts.");
  expect(compactTranscript(messages, "Other task")).toMatch(/^user: Find the config\n/u);

  const long: Message[] = Array.from({ length: 40 }, (_, i) => ({ role: "assistant", content: [{ type: "text", text: `step ${i} ${"x".repeat(50)}` }] }));
  const cut = compactTranscript(long, "task", 1_000);
  expect(cut.length).toBeLessThanOrEqual(1_000);
  expect(cut).toMatch(/^assistant: step 0 /u);
  expect(cut).toContain("[... middle of the transcript left out ...]");
  expect(cut).toMatch(/assistant: step 39 x+$/u);
  expect(cut).not.toContain("step 20 ");
});

test("the hidden context carries each run's task, result and transcript, names unknown or ambiguous tokens, and stays within budget", () => {
  const conversation = Conversation.from([
    { role: "user", content: [{ type: "text", text: "Find the config" }] },
    { role: "assistant", content: [{ type: "text", text: "It is in src/config.ts." }] },
  ]);
  const refs = [
    ref({ id: "abc123", label: "Find the config", task: "Find the config", run: () => fakeRun({ id: "abc123", task: "Find the config", conversation, state: { status: "done", output: "src/config.ts loads it." } }) }),
    ref({ id: "run222", label: "Twin" }),
    ref({ id: "run333", label: "Twin" }),
    ref({ id: "live44", label: "Still going", status: "running", run: () => fakeRun({ id: "live44", task: "Keep going", label: "Still going", state: { status: "running" } }) }),
  ];
  expect(referenceContext("no references", refs)).toBeUndefined();
  const text = referenceContext("Build on @run:find-the-config and @run:abc123, @run:twin, @run:live44 and @run:nope.", refs)!;
  expect(text).toMatch(/^The user's message references earlier subagent runs/u);
  expect(text).toContain("untrusted");
  expect(text).toContain("### @run:find-the-config: Find the config · scout (abc123, done, anthropic/claude-haiku-5, low)\nTask:\nFind the config\nResult:\nsrc/config.ts loads it.\nTranscript (compact):\nassistant: It is in src/config.ts.");
  // The same run twice is included once.
  expect(text.match(/abc123, done/gu)).toHaveLength(1);
  expect(text).toContain("### @run:twin: several runs match; ask the user which, or use an id: run222 (Twin · scout), run333 (Twin · scout).");
  expect(text).toContain("### @run:live44: Still going · scout (live44, running, anthropic/claude-haiku-5, low)\nTask:\nKeep going\nResult: (still running; what it has done so far is in the transcript)");
  expect(text).toContain("### @run:nope: no run of that name or id in this session. Runs: abc123 (Find the config · scout), run222 (Twin · scout), run333 (Twin · scout), live44 (Still going · scout).");

  const big = ref({ id: "big111", label: "Big", run: () => fakeRun({ id: "big111", task: "Big", state: { status: "done", output: "y".repeat(20_000) } }) });
  const capped = referenceContext("@run:big111", [big], { task: 4_000, output: 12_000, transcript: 8_000, line: 400, total: 48_000 })!;
  expect(capped.length).toBeLessThan(13_000);
  expect(capped).toMatch(/y+…$/u);
  const squeezed = referenceContext("@run:big111 and @run:abc123", [big, refs[0]!], { task: 4_000, output: 12_000, transcript: 8_000, line: 400, total: 1_000 })!;
  expect(squeezed.length).toBeLessThanOrEqual(1_100);
  expect(squeezed).toContain("### @run:abc123: left out, the references in this prompt already fill their budget.");
});

test("in a session, @run: completes from recorded and live runs and a prompt that references one gets its record as hidden context", async () => {
  const h = harness();
  let provider!: AutocompleteProvider;
  const base: AutocompleteProvider = { getSuggestions: async () => null, applyCompletion: () => ({ lines: [], cursorLine: 0, cursorCol: 0 }) };
  const ui = Object.assign(fakeUI(), { addAutocompleteProvider: vi.fn((factory: (base: AutocompleteProvider) => AutocompleteProvider) => { provider = factory(base); }) });
  const dir = mkdtempSync(path.join(tmpdir(), "subagent-references-"));
  mkdirSync(path.join(dir, "abc123"));
  writeFileSync(path.join(dir, "abc123/output.md"), "The config is loaded in src/config.ts.");
  writeFileSync(path.join(dir, "abc123/messages.jsonl"), `${JSON.stringify({ role: "user", content: "Find where the config is loaded" })}\n${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "src/config.ts." }] })}\n`);
  const record = { id: "abc123", agent: "scout", task: "Find where the config is loaded", label: "Find the config", model: "m/x", thinking: "low", byJev: { agent: false, model: false, thinking: false }, status: "done", turns: 1, tokens: 10, cost: 0, seconds: 4, outputPath: path.join(dir, "abc123/output.md"), async: false };
  const entries: unknown[] = [{ type: "custom", customType: "subagents:run", data: { ...record, status: "running" } }, { type: "custom", customType: "subagents:run", data: record }];
  subagents(h.pi);
  const ctx = h.ctx({ ui, sessionManager: { getBranch: () => entries, getSessionId: () => "s" } });
  await h.emit("session_start", { type: "session_start" }, ctx);
  const options = { signal: new AbortController().signal };
  expect((await provider.getSuggestions(["@run:"], 0, 5, options))?.items).toEqual([{ value: "@run:find-the-config", label: "Find the config · scout", description: "done · abc123 · m/x" }]);
  // Both prefixes share one provider: the agent mention still completes.
  expect((await provider.getSuggestions(["@subagent:gen"], 0, 14, options))?.items[0]?.value).toBe("@subagent:general");

  const result: any = await h.emit("before_agent_start", { prompt: "Continue from @run:find-the-config" }, ctx);
  expect(result.message.customType).toBe("subagent-run-reference");
  expect(result.message.display).toBe(false);
  expect(result.message.content).toContain("### @run:find-the-config: Find the config · scout (abc123, done, m/x, low)\nTask:\nFind where the config is loaded\nResult:\nThe config is loaded in src/config.ts.\nTranscript (compact):\nassistant: src/config.ts.");
  // A prompt without a reference adds nothing.
  expect(await h.emit("before_agent_start", { prompt: "plain" }, ctx)).toBeUndefined();
  await h.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  expect((await provider.getSuggestions(["@run:"], 0, 5, options))).toBeNull();
});
