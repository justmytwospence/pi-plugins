import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_ROUTES, type ModelInfo, parentRoute, compareGeneration, confirmFamily, derivePairs, describeTable, familyOf, familyTable,
  ignoreFamily, loadFamilyTable, markSeen, modelFamiliesPath, parseId, readFamiliesFile, routeOf, tierModels, writeFamiliesFile,
} from "../src/model-families.ts";

const m = (provider: string, id: string, input = 0, output = 0): ModelInfo => ({ provider, id, cost: { input, output } });
const google = [
  m("google", "gemini-3.5-flash-lite", 0.1, 0.4), m("google", "gemini-3.8-flash", 0.75, 3.75),
  m("google", "gemini-4-argon", 2, 10), m("google", "gemini-4-carbon", 2, 10), m("google", "gemini-4-hydrogen", 1.5, 7.5),
  m("google", "gemini-flash-latest"), m("google", "gemini-4-argon-preview"),
  m("google", "antigravity-gemini-3.8-flash"), m("google", "antigravity-gemini-4-argon"),
  m("google", "antigravity-gemini-4-carbon"), m("google", "antigravity-gemini-4-hydrogen"),
  m("google", "antigravity-gemini-3.8-flash-lite"), m("google", "antigravity-claude-opus-5-5"), m("google", "antigravity-claude-sonnet-5-5"),
];
const anthropic = [
  m("anthropic", "claude-fable-5-2", 10, 50), m("anthropic", "claude-opus-5-5", 4, 20), m("anthropic", "claude-sonnet-5-5", 2, 10),
  m("anthropic", "claude-haiku-5-5", 0.1, 0.5), m("anthropic", "claude-sonnet-4-5-20250929", 3, 15), m("anthropic", "claude-opus-4-8", 4, 20),
];
const openai = ["gpt-5-mini", "gpt-5.6-cyber", "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6.1-terra"].map((id) => m("openai", id, 1, 5));
const catalog = [...google, ...anthropic, ...openai];
const route = (id: string) => BUILTIN_ROUTES.find((r) => r.id === id)!;
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "families-")); process.env.PI_CODING_AGENT_DIR = dir; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.PI_CODING_AGENT_DIR; });

describe("ids and routes", () => {
  it("parses families and generations, and rejects other shapes and snapshots", () => {
    expect(parseId(route("google/gemini"), "gemini-4-argon")).toEqual({ family: "argon", generation: [4] });
    expect(parseId(route("google/gemini"), "gemini-3.5-flash-lite")).toEqual({ family: "flash-lite", generation: [3, 5] });
    expect(parseId(route("google/antigravity-gemini"), "antigravity-gemini-3.8-flash")).toEqual({ family: "flash", generation: [3, 8] });
    for (const id of ["gemini-4-argon-preview", "gemini-flash-latest", "gemini-4-pro-image-x"]) expect(parseId(route("google/gemini"), id), id).toBeUndefined();
    expect(parseId(route("google/antigravity-gemini"), "antigravity-gemini-3.8-flash-lite")).toBeUndefined();
    expect(parseId(route("anthropic"), "claude-sonnet-4-5-20250929")).toBeUndefined();
    expect(parseId(route("anthropic"), "claude-opus-5-5")).toEqual({ family: "opus", generation: [5, 5] });
    expect(compareGeneration([4], [3, 8])).toBeGreaterThan(0);
  });
  it("sends each google id to its own route", () => {
    expect(routeOf(BUILTIN_ROUTES, "google", "antigravity-claude-opus-5-5")?.id).toBe("google/antigravity-claude");
    expect(routeOf(BUILTIN_ROUTES, "google", "antigravity-gemini-4-argon")?.id).toBe("google/antigravity-gemini");
    expect(routeOf(BUILTIN_ROUTES, "google", "gemini-4-argon")?.id).toBe("google/gemini");
    expect(routeOf(BUILTIN_ROUTES, "google", "other")).toBeUndefined();
    expect(routeOf(BUILTIN_ROUTES, "openai-codex", "gpt-6-sol")?.id).toBe("openai");
    expect(routeOf(BUILTIN_ROUTES, "__proto__", "x")).toBeUndefined();
  });
  it("gives a parent outside the id shapes its provider's only route, never a guessed Google route", () => {
    expect(parentRoute(BUILTIN_ROUTES, "openai", "o3")?.id).toBe("openai");
    expect(parentRoute(BUILTIN_ROUTES, "anthropic", "claude")?.id).toBe("anthropic");
    expect(parentRoute(BUILTIN_ROUTES, "google", "other")).toBeUndefined();
    expect(parentRoute(BUILTIN_ROUTES, "lmstudio", "qwen")).toBeUndefined();
  });
});

describe("discovery", () => {
  it("finds nothing on the shipped catalog", () => {
    expect(familyTable(catalog).discoveries).toEqual([]);
  });
  it("prices Antigravity families through their API twin and places them like the nearest cheaper family", () => {
    expect(familyTable(catalog).routes.find((r) => r.id === "google/antigravity-gemini")!.families.find((f) => f.id === "hydrogen")!.price).toBe(9);
    const ag = route("google/antigravity-gemini");
    const unaware = { ...ag, pairs: undefined, families: ag.families.filter((f) => !["hydrogen", "carbon"].includes(f.id)) };
    const table = familyTable(catalog, { version: 1 }, undefined, [unaware, route("google/gemini")]);
    expect(table.discoveries.map((d) => [d.family, d.tiers, d.basis])).toEqual([
      ["carbon", ["strong"], "priced like Argon"],
      ["hydrogen", ["fast", "balanced"], "priced like Flash"],
    ]);
    const placed = table.routes[0]!.families.map((f) => `${f.id}:${f.source}`);
    expect(placed).toEqual(["carbon:provisional", "argon:builtin", "pro:builtin", "hydrogen:provisional", "flash:builtin"]);
  });
  it("skips families below the route's newest generation and ignored families", () => {
    const withCyber = familyTable([...catalog, m("openai", "gpt-6.1-newname", 3, 9), m("openai", "gpt-5.6-cyber", 1, 5)]);
    expect(withCyber.discoveries.map((d) => d.family)).toEqual(["newname"]);
    const ignored = familyTable([...catalog, m("openai", "gpt-6.1-newname", 3, 9)], { version: 1, routes: { openai: { ignore: ["newname"] } } });
    expect(ignored.discoveries).toEqual([]);
  });
  it("never puts a discovery in premium, even above every ranked price", () => {
    const table = familyTable([...catalog, m("openai", "gpt-6.2-giga", 50, 200)]);
    expect(table.discoveries[0]).toMatchObject({ family: "giga", tiers: ["strong"], basis: "priced like Astra" });
  });
  it("leaves a family without a price unrouted", () => {
    const table = familyTable([...catalog, m("openai", "gpt-6.2-free", 0, 0)]);
    expect(table.discoveries[0]).toMatchObject({ family: "free", tiers: [], basis: "no price" });
  });
  it("applies the user file: add before a family, built-ins win, ignore, invalid file", () => {
    const file = { version: 1 as const, routes: { openai: { add: [{ id: "nova", tiers: ["balanced" as const], before: "terra" }, { id: "sol", tiers: ["fast" as const] }] } } };
    const table = familyTable(catalog, file);
    const ids = table.routes.find((r) => r.id === "openai")!.families.map((f) => f.id);
    expect(ids).toEqual(["astra", "sol", "nova", "terra", "luna"]);
    expect(table.routes.find((r) => r.id === "openai")!.families.find((f) => f.id === "sol")!.source).toBe("builtin");
    writeFileSync(modelFamiliesPath(), "{nope");
    const broken = loadFamilyTable(catalog);
    expect(broken.error).toBeTruthy();
    expect(broken.routes.find((r) => r.id === "openai")!.families).toHaveLength(4);
    writeFileSync(modelFamiliesPath(), JSON.stringify({ version: 1, routes: { openai: { add: [{ id: "x", tiers: ["huge"] }] } } }));
    expect(readFamiliesFile().error).toContain("routes.openai.add");
    expect(describeTable(broken)).toContain("using built-in families");
  });
});

describe("tiers and pairs", () => {
  const table = familyTable(catalog);
  it("orders tier models by family preference then generation", () => {
    expect(tierModels(table, "google/antigravity-gemini-4-argon", google, "balanced")).toEqual([
      "google/antigravity-gemini-4-hydrogen", "google/antigravity-gemini-3.8-flash",
    ]);
    expect(tierModels(table, "google/antigravity-gemini-4-argon", google, "premium")).toEqual(["google/antigravity-gemini-4-carbon"]);
    expect(tierModels(table, "google/gemini-4-argon", google, "fast")).toEqual(["google/gemini-3.5-flash-lite"]);
    expect(tierModels(table, "google/antigravity-claude-opus-5-5", google, "fast")).toEqual(["google/antigravity-claude-sonnet-5-5"]);
    expect(tierModels(table, "anthropic/claude-opus-5-5", anthropic, "balanced")).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(tierModels(table, "lmstudio/qwen", anthropic, "fast")).toEqual([]);
  });
  it("prefers the parent's generation within a family", () => {
    expect(tierModels(table, "openai/gpt-6-sol", openai, "strong")).toEqual(["openai/gpt-6-sol", "openai/gpt-6.1-sol"]);
    expect(tierModels(table, "openai/gpt-6.1-sol", openai, "strong")[0]).toBe("openai/gpt-6.1-sol");
  });
  it("derives today's plan pairs", () => {
    expect(derivePairs(table).map((p) => [`${p.provider}/${p.id}`, p.name, p.routes])).toEqual([
      ["anthropic/fableplan", "Fable plan, Opus build", ["anthropic"]],
      ["anthropic/opusplan", "Opus plan, Sonnet build", ["anthropic"]],
      ["openai-codex/astraplan", "Astra plan, Sol build", ["openai"]],
      ["openai-codex/solplan", "Sol plan, Terra build", ["openai"]],
      ["openai/astraplan", "Astra plan, Sol build", ["openai"]],
      ["openai/solplan", "Sol plan, Terra build", ["openai"]],
      ["google/carbonplan", "Carbon plan, Hydrogen build", ["google/antigravity-gemini", "google/gemini"]],
      ["google/argonplan", "Argon plan, Hydrogen build", ["google/antigravity-gemini", "google/gemini"]],
    ]);
  });
  it("excludes provisional families and honors user pair overrides", () => {
    const withNew = familyTable([...catalog, m("openai", "gpt-6.2-giga", 50, 200)]);
    expect(derivePairs(withNew).map((p) => p.planner)).not.toContain("giga");
    const custom = familyTable(catalog, { version: 1, routes: { anthropic: { pairs: [{ planner: "opus", worker: "haiku" }] } } });
    expect(derivePairs(custom).find((p) => p.id === "opusplan")!.name).toBe("Opus plan, Haiku build");
  });
  it("finds the family of an id", () => {
    expect(familyOf(table, "google", "antigravity-gemini-4-hydrogen")).toMatchObject({ family: { id: "hydrogen" }, generation: [4] });
    expect(familyOf(table, "google", "gemini-flash-latest")).toBeUndefined();
  });
});

describe("file edits", () => {
  it("are pure and idempotent", () => {
    const base = { version: 1 as const };
    const once = confirmFamily(base, "openai", { id: "nova", tiers: ["balanced"] });
    expect(base).toEqual({ version: 1 });
    expect(confirmFamily(once, "openai", { id: "nova", tiers: ["balanced"] })).toEqual(once);
    const ignored = ignoreFamily(once, "openai", "nova");
    expect(ignored.routes!.openai).toEqual({ ignore: ["nova"] });
    expect(ignoreFamily(ignored, "openai", "nova")).toEqual(ignored);
    expect(confirmFamily(ignored, "openai", { id: "nova", tiers: ["fast"] }).routes!.openai!.ignore).toBeUndefined();
    const seen = markSeen(base, [{ route: "openai", family: "b" }, { route: "openai", family: "a" }]);
    expect(seen.seen).toEqual({ openai: ["a", "b"] });
    expect(markSeen(seen, [{ route: "openai", family: "a" }])).toEqual(seen);
  });
  it("round-trips through the user file", () => {
    const file = confirmFamily({ version: 1 }, "openai", { id: "nova", tiers: ["balanced"], before: "terra" });
    writeFamiliesFile(file);
    expect(JSON.parse(readFileSync(modelFamiliesPath(), "utf8"))).toEqual(file);
    expect(readFamiliesFile()).toEqual({ file });
  });
});
