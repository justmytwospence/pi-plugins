import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { implementersFor, LEGACY_PAIR_ID, latestSpec, legacyPlanner } from "../src/implementers.js";

const catalog = (...ids: string[]) =>
  ids.map((entry) => {
    const slash = entry.indexOf("/");
    return { provider: entry.slice(0, slash), id: entry.slice(slash + 1) };
  });
const ids = (session: string, available: ReturnType<typeof catalog>) => {
  const slash = session.indexOf("/");
  return implementersFor({ provider: session.slice(0, slash), modelId: session.slice(slash + 1) }, available).map(
    (spec) => `${spec.provider}/${spec.modelId}`,
  );
};

const anthropic = catalog(
  "anthropic/claude-fable-5-5",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
);

test("a premium session offers one and two tiers down; a strong session offers the next two", () => {
  assert.deepEqual(ids("anthropic/claude-fable-5-5", anthropic), [
    "anthropic/claude-opus-5-5",
    "anthropic/claude-sonnet-5-5",
  ]);
  assert.deepEqual(ids("anthropic/claude-opus-5-5", anthropic), [
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-haiku-5-5",
  ]);
});

test("balanced and fast sessions, and unknown models, offer nothing", () => {
  assert.deepEqual(ids("anthropic/claude-sonnet-5-5", anthropic), []);
  assert.deepEqual(ids("anthropic/claude-haiku-5-5", anthropic), []);
  assert.deepEqual(ids("anthropic/something-else", anthropic), []);
});

test("Astra and Sol offer their workers on both OpenAI routes", () => {
  for (const provider of ["openai", "openai-codex"]) {
    const models = catalog(
      `${provider}/gpt-6-astra`,
      `${provider}/gpt-6-sol`,
      `${provider}/gpt-6-terra`,
      `${provider}/gpt-6-luna`,
    );
    assert.deepEqual(ids(`${provider}/gpt-6-astra`, models), [`${provider}/gpt-6-sol`, `${provider}/gpt-6-terra`]);
    assert.deepEqual(ids(`${provider}/gpt-6-sol`, models), [`${provider}/gpt-6-terra`, `${provider}/gpt-6-luna`]);
  }
});

test("workers use the newest generation regardless of the session model", () => {
  for (const provider of ["openai", "openai-codex"]) {
    assert.deepEqual(
      ids(
        `${provider}/gpt-6.1-sol`,
        catalog(
          `${provider}/gpt-6.1-terra`,
          `${provider}/gpt-6.2-terra`,
          `${provider}/gpt-6.10-terra`,
          `${provider}/gpt-6.9-terra`,
        ),
      ),
      [`${provider}/gpt-6.10-terra`],
    );
  }
  assert.deepEqual(
    ids(
      "anthropic/claude-opus-5-5",
      catalog(
        "anthropic/claude-sonnet-5-5",
        "anthropic/claude-sonnet-5-6",
        "anthropic/claude-haiku-5-5",
        "anthropic/claude-haiku-6",
      ),
    ),
    ["anthropic/claude-sonnet-5-6", "anthropic/claude-haiku-6"],
  );
});

test("a missing one-tier-down family still offers the tier below it", () => {
  assert.deepEqual(
    ids("anthropic/claude-fable-5-5", catalog("anthropic/claude-fable-5-5", "anthropic/claude-sonnet-5-5")),
    ["anthropic/claude-sonnet-5-5"],
  );
  assert.deepEqual(ids("anthropic/claude-fable-5-5", catalog("anthropic/claude-fable-5-5")), []);
});

test("Carbon stays on its Antigravity lane", () => {
  assert.deepEqual(
    ids(
      "google/antigravity-gemini-4-carbon",
      catalog(
        "google/antigravity-gemini-4-carbon",
        "google/antigravity-gemini-4-neon",
        "google/antigravity-gemini-4-hydrogen",
        "google/gemini-4-hydrogen",
      ),
    ),
    ["google/antigravity-gemini-4-neon", "google/antigravity-gemini-4-hydrogen"],
  );
  assert.deepEqual(
    ids(
      "google/antigravity-gemini-4-carbon",
      catalog("google/antigravity-gemini-4-carbon", "google/gemini-4-neon", "google/gemini-4-hydrogen"),
    ),
    [],
  );
});

test("a route's pairs override picks the one-tier-down worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "implementers-families-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    writeFileSync(
      join(dir, "model-families.json"),
      JSON.stringify({ version: 1, routes: { anthropic: { pairs: [{ planner: "fable", worker: "sonnet" }] } } }),
    );
    // The override replaces the one-tier-down choice; the tier it lands on is not offered twice.
    assert.deepEqual(ids("anthropic/claude-fable-5-5", anthropic), ["anthropic/claude-sonnet-5-5"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a removed plan model's id names its planner family, which resolves to its newest model", () => {
  assert.equal(LEGACY_PAIR_ID.exec("fableplan-sonnet")?.[1], "fable");
  assert.equal(LEGACY_PAIR_ID.exec("opusplan")?.[1], "opus");
  assert.equal(LEGACY_PAIR_ID.test("claude-opus-5-5"), false);
  assert.deepEqual(
    legacyPlanner("anthropic", "fable", catalog("anthropic/claude-fable-5-1", "anthropic/claude-fable-5-2")),
    { provider: "anthropic", modelId: "claude-fable-5-2" },
  );
  assert.deepEqual(
    legacyPlanner("google", "neon", catalog("google/gemini-4-neon", "google/antigravity-gemini-4-neon")),
    { provider: "google", modelId: "antigravity-gemini-4-neon" },
  );
  assert.equal(legacyPlanner("anthropic", "nova", anthropic), undefined);
});

test("a configured model names its family and follows its newest available generation", () => {
  const available = catalog(
    "anthropic/claude-fable-5-1",
    "anthropic/claude-fable-5-2",
    "anthropic/claude-sonnet-5-5",
    "openai/gpt-6.1-sol",
  ).map((model) => ({ provider: model.provider, modelId: model.id }));
  assert.deepEqual(
    latestSpec({ provider: "anthropic", modelId: "claude-fable-5-1", thinkingLevel: "xhigh" }, available),
    { provider: "anthropic", modelId: "claude-fable-5-2", thinkingLevel: "xhigh" },
  );
  assert.deepEqual(latestSpec({ provider: "openai", modelId: "gpt-6-sol" }, available), {
    provider: "openai",
    modelId: "gpt-6.1-sol",
  });
  assert.deepEqual(latestSpec({ provider: "anthropic", modelId: "claude-custom" }, available), {
    provider: "anthropic",
    modelId: "claude-custom",
  });
});
