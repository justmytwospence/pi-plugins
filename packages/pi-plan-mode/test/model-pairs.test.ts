import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { builtinPairs, latestSpec, pairDefinitions, pairKey, resolvePair } from "../src/model-pairs.js";

const catalog = (...ids: string[]) =>
  ids.map((entry) => {
    const slash = entry.indexOf("/");
    return { provider: entry.slice(0, slash), id: entry.slice(slash + 1) };
  });

const def = (key: string) => {
  const found = pairDefinitions(undefined).find((candidate) => pairKey(candidate) === key);
  assert.ok(found, key);
  return found;
};

test("the built-in pairs plan on a stronger family and build on a cheaper one", () => {
  assert.deepEqual(
    builtinPairs().map((pair) => [pairKey(pair), pair.name]),
    [
      ["anthropic/fableplan", "Fable plan, Opus build"],
      ["anthropic/fableplan-sonnet", "Fable plan, Sonnet build"],
      ["anthropic/opusplan", "Opus plan, Sonnet build"],
      ["openai-codex/astraplan", "Astra plan, Sol build"],
      ["openai-codex/astraplan-terra", "Astra plan, Terra build"],
      ["openai-codex/solplan", "Sol plan, Terra build"],
      ["openai/astraplan", "Astra plan, Sol build"],
      ["openai/astraplan-terra", "Astra plan, Terra build"],
      ["openai/solplan", "Sol plan, Terra build"],
      ["google/carbonplan", "Carbon plan, Hydrogen build"],
      ["google/argonplan", "Argon plan, Hydrogen build"],
    ],
  );
});

test("only the premium-planner built-in identities retain their approved worker", () => {
  const persistent = [
    "anthropic/fableplan",
    "anthropic/fableplan-sonnet",
    "openai-codex/astraplan",
    "openai-codex/astraplan-terra",
    "openai/astraplan",
    "openai/astraplan-terra",
  ];
  assert.deepEqual(
    builtinPairs()
      .filter((pair) => pair.handoff === "persistent")
      .map(pairKey),
    persistent,
  );
  for (const pair of builtinPairs()) {
    assert.equal(pair.handoff, persistent.includes(pairKey(pair)) ? "persistent" : undefined, pairKey(pair));
  }
});

test("custom replacements inherit identity policy, but newly named pairs do not", () => {
  const replacement = {
    planner: { provider: "x", modelId: "planner" },
    worker: { provider: "x", modelId: "worker" },
    name: "Replacement",
  };
  const originals = builtinPairs();
  const defs = pairDefinitions(
    Object.fromEntries([...originals.map(pairKey), "x/new"].map((key) => [key, replacement])),
  );
  for (const original of originals) {
    const pair = defs.find((candidate) => pairKey(candidate) === pairKey(original));
    assert.ok(pair);
    assert.equal(pair.handoff, original.handoff, pairKey(original));
    assert.equal(pair.name, "Replacement");
    assert.deepEqual(pair.planner, { spec: replacement.planner });
    assert.deepEqual(pair.worker, { spec: replacement.worker });
  }
  assert.equal(defs.find((pair) => pairKey(pair) === "x/new")?.handoff, undefined);
});

test("opusplan resolves to the highest generation of each family", () => {
  const resolved = resolvePair(
    def("anthropic/opusplan"),
    catalog(
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-opus-4-1",
      "anthropic/claude-sonnet-4",
      "anthropic/claude-sonnet-4-5-20250929",
    ),
  );
  assert.deepEqual(resolved, {
    planner: { provider: "anthropic", modelId: "claude-opus-4-5" },
    worker: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
  });
});

test("the worker prefers the planner's generation", () => {
  const resolved = resolvePair(
    def("anthropic/fableplan"),
    catalog("anthropic/claude-fable-5-1", "anthropic/claude-opus-5-1", "anthropic/claude-opus-5-5"),
  );
  assert.deepEqual(resolved, {
    planner: { provider: "anthropic", modelId: "claude-fable-5-1" },
    worker: { provider: "anthropic", modelId: "claude-opus-5-1" },
  });
});

test("a missing planner family is an error naming it", () => {
  const resolved = resolvePair(def("anthropic/fableplan"), catalog("anthropic/claude-opus-5-5"));
  assert.deepEqual(resolved, { error: "no available Fable model on anthropic" });
});

test("a missing worker family is an error naming it", () => {
  const resolved = resolvePair(def("anthropic/opusplan"), catalog("anthropic/claude-opus-5-5"));
  assert.deepEqual(resolved, { error: "no available Sonnet model on anthropic" });
});

test("the Astra and Sol pairs resolve on openai-codex and openai", () => {
  for (const provider of ["openai-codex", "openai"]) {
    const resolved = resolvePair(
      def(`${provider}/astraplan`),
      catalog(`${provider}/gpt-6-astra`, `${provider}/gpt-6-sol`, `${provider}/gpt-6-terra`),
    );
    assert.deepEqual(resolved, {
      planner: { provider, modelId: "gpt-6-astra" },
      worker: { provider, modelId: "gpt-6-sol" },
    });
  }
});

test("argonplan resolves on one Google lane, preferring Antigravity", () => {
  assert.deepEqual(
    resolvePair(
      def("google/argonplan"),
      catalog(
        "google/antigravity-gemini-4-argon",
        "google/antigravity-gemini-4-hydrogen",
        "google/antigravity-gemini-3.8-flash",
        "google/gemini-4-argon",
        "google/gemini-4.1-hydrogen",
      ),
    ),
    {
      planner: { provider: "google", modelId: "antigravity-gemini-4-argon" },
      worker: { provider: "google", modelId: "antigravity-gemini-4-hydrogen" },
    },
  );
  assert.deepEqual(resolvePair(def("google/argonplan"), catalog("google/gemini-4-argon", "google/gemini-4-hydrogen")), {
    planner: { provider: "google", modelId: "gemini-4-argon" },
    worker: { provider: "google", modelId: "gemini-4-hydrogen" },
  });
  assert.deepEqual(
    resolvePair(def("google/argonplan"), catalog("google/antigravity-gemini-4-argon", "google/gemini-4-hydrogen")),
    { error: "no available Hydrogen model on google" },
  );
  assert.deepEqual(
    resolvePair(
      def("google/argonplan"),
      catalog("google/antigravity-gemini-4-argon", "google/antigravity-gemini-3.8-flash"),
    ),
    { error: "no available Hydrogen model on google" },
  );
});

test("a premium planner also offers a worker two tiers down", () => {
  assert.deepEqual(
    resolvePair(
      def("anthropic/fableplan-sonnet"),
      catalog("anthropic/claude-fable-5-5", "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5"),
    ),
    {
      planner: { provider: "anthropic", modelId: "claude-fable-5-5" },
      worker: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    },
  );
  assert.deepEqual(
    resolvePair(def("openai/astraplan-terra"), catalog("openai/gpt-6-astra", "openai/gpt-6-sol", "openai/gpt-6-terra")),
    {
      planner: { provider: "openai", modelId: "gpt-6-astra" },
      worker: { provider: "openai", modelId: "gpt-6-terra" },
    },
  );
  // carbonplan already builds on Hydrogen, two tiers down, so Google gets no extra pair.
  assert.ok(!builtinPairs().some((pair) => pair.provider === "google" && pair.id.startsWith("carbonplan-")));
});

test("carbonplan plans on Carbon and builds on Hydrogen", () => {
  assert.deepEqual(
    resolvePair(
      def("google/carbonplan"),
      catalog(
        "google/antigravity-gemini-4-carbon",
        "google/antigravity-gemini-4-argon",
        "google/antigravity-gemini-4-hydrogen",
      ),
    ),
    {
      planner: { provider: "google", modelId: "antigravity-gemini-4-carbon" },
      worker: { provider: "google", modelId: "antigravity-gemini-4-hydrogen" },
    },
  );
  assert.deepEqual(resolvePair(def("google/carbonplan"), catalog("google/antigravity-gemini-4-argon")), {
    error: "no available Carbon model on google",
  });
});

test("the worker prefers the planner's generation and a user-confirmed family joins the derived pairs", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-families-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    assert.deepEqual(
      resolvePair(def("openai/solplan"), catalog("openai/gpt-6.1-sol", "openai/gpt-6-terra", "openai/gpt-6.1-terra")),
      {
        planner: { provider: "openai", modelId: "gpt-6.1-sol" },
        worker: { provider: "openai", modelId: "gpt-6.1-terra" },
      },
    );
    writeFileSync(
      join(dir, "model-families.json"),
      JSON.stringify({ version: 1, routes: { anthropic: { add: [{ id: "nova", tiers: ["premium"] }] } } }),
    );
    // A confirmed family is ranked after the built-ins of its tier, so it does not displace Fable.
    assert.equal(
      pairDefinitions(undefined).some((pair) => pair.id === "novaplan"),
      false,
    );
    writeFileSync(
      join(dir, "model-families.json"),
      JSON.stringify({
        version: 1,
        routes: { anthropic: { add: [{ id: "nova", tiers: ["premium"], before: "fable" }] } },
      }),
    );
    const nova = pairDefinitions(undefined).find((pair) => pair.id === "novaplan");
    assert.equal(nova?.name, "Nova plan, Opus build");
    assert.equal(nova?.handoff, undefined, "newly derived premium identities do not acquire handoff policy");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a custom pair replaces a built-in key in place and a new key is appended", () => {
  const defs = pairDefinitions({
    "anthropic/opusplan": {
      planner: { provider: "anthropic", modelId: "claude-opus-5-5" },
      worker: { provider: "anthropic", modelId: "claude-sonnet-5-1" },
      name: "Mine",
    },
    "openai/deep": {
      planner: { provider: "openai", modelId: "gpt-6-astra" },
      worker: { provider: "openai", modelId: "gpt-6-terra" },
    },
  });
  assert.equal(defs.length, builtinPairs().length + 1);
  assert.equal(defs[2] && pairKey(defs[2]), "anthropic/opusplan");
  assert.equal(defs[2]?.name, "Mine");
  const added = defs[defs.length - 1];
  assert.equal(added && pairKey(added), "openai/deep");
  assert.equal(added?.name, "gpt-6-astra plan, gpt-6-terra build");
  assert.deepEqual(resolvePair(defs[2] as never, catalog("anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-1")), {
    planner: { provider: "anthropic", modelId: "claude-opus-5-5" },
    worker: { provider: "anthropic", modelId: "claude-sonnet-5-1" },
  });
  assert.deepEqual(resolvePair(defs[2] as never, catalog("anthropic/claude-opus-5-5")), {
    error: "anthropic/claude-sonnet-5-1 is not available",
  });
});

test("identical planner and worker is an error", () => {
  const defs = pairDefinitions({
    "x/same": {
      planner: { provider: "x", modelId: "m" },
      worker: { provider: "x", modelId: "m" },
    },
  });
  assert.deepEqual(resolvePair(defs[defs.length - 1] as never, catalog("x/m")), {
    error: "planner and worker are the same model",
  });
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
    {
      provider: "anthropic",
      modelId: "claude-fable-5-2",
      thinkingLevel: "xhigh",
    },
  );
  assert.deepEqual(latestSpec({ provider: "openai", modelId: "gpt-6-sol" }, available), {
    provider: "openai",
    modelId: "gpt-6.1-sol",
  });
  assert.deepEqual(latestSpec({ provider: "anthropic", modelId: "claude-custom" }, available), {
    provider: "anthropic",
    modelId: "claude-custom",
  });
  const custom = pairDefinitions({
    "anthropic/mine": {
      planner: { provider: "anthropic", modelId: "claude-fable-5" },
      worker: { provider: "anthropic", modelId: "claude-sonnet-5" },
    },
  }).find((candidate) => pairKey(candidate) === "anthropic/mine");
  assert.ok(custom);
  assert.deepEqual(resolvePair(custom, catalog("anthropic/claude-fable-5-2", "anthropic/claude-sonnet-5-5")), {
    planner: { provider: "anthropic", modelId: "claude-fable-5-2" },
    worker: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
  });
});
