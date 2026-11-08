import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { loadWaterfallConfig, parseWaterfallOrder } from "../src/config.ts";

let root, cwd, agentDir;
const defaults = ["anthropic", "openai", "google"];
const configPath = project => join(project ? join(cwd, ".pi") : agentDir, "model-waterfall.json");
const config = (value, project = false) => writeFileSync(configPath(project), JSON.stringify(value));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "waterfall-config-"));
  cwd = join(root, "project"); agentDir = join(root, "custom-agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true }); mkdirSync(agentDir);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("configured active waterfall policy", () => {
  it("defaults to three and returns fresh arrays", () => {
    const result = loadWaterfallConfig(cwd, agentDir);
    assert.deepEqual(result, { order: defaults });
    result.order.push("muse-code");
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: defaults });
  });
  it("replaces defaults globally using the supplied agent directory", () => {
    config({ order: ["google", "anthropic"] });
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: ["google", "anthropic"] });
    assert.deepEqual(loadWaterfallConfig(cwd, join(root, "missing-agent")), { order: defaults });
  });
  it("replaces global policy with project order, never merging it", () => {
    config({ order: ["muse-code", "anthropic"] });
    config({ order: ["openai"] }, true);
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: ["openai"] });
  });
  it("retains explicit Muse opt-in, and allows deliberate empty policy", () => {
    config({ order: [...defaults, "muse-code"] });
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: [...defaults, "muse-code"] });
    config({ order: [] }, true);
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: [] });
  });
  it("ignores unknown keys and absent order fields", () => {
    config({ unknown: ["muse-code"] }); config({ unrelated: true }, true);
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: defaults });
    config({ order: ["openai"], unrelated: true });
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: ["openai"] });
  });
  it.each([null, {}, "google", 1, ["google", "google"], ["unknown-private-content"], ["muse-sdk"], [1], [null]])("rejects invalid orders %j without including their contents", value => {
    assert.throws(() => parseWaterfallOrder(value), /order/);
    config({ order: value });
    const result = loadWaterfallConfig(cwd, agentDir);
    assert.deepEqual(result.order, []);
    assert.ok(result.error.startsWith(`${configPath(false)}: order`));
    assert.doesNotMatch(result.error, /unknown-private-content/);
  });
  it("fails closed for malformed JSON without leaking its contents", () => {
    writeFileSync(configPath(false), "synthetic-private-content not JSON");
    const result = loadWaterfallConfig(cwd, agentDir);
    assert.deepEqual(result, { order: [], error: `${configPath(false)}: malformed JSON.` });
  });
  it("fails closed for unreadable files other than ENOENT", () => {
    // A directory reliably fails readFile even when tests run with elevated privileges.
    mkdirSync(configPath(true));
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: [], error: `${configPath(true)}: cannot read configuration.` });
  });
  it.each([null, [], 1, "private-root-value"])("rejects a non-object config root %j", value => {
    config(value, true);
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: [], error: `${configPath(true)}: expected a configuration object.` });
  });
  it("only a valid explicit higher-precedence order clears a lower error", () => {
    writeFileSync(configPath(false), "not JSON");
    config({ other: true }, true);
    assert.equal(loadWaterfallConfig(cwd, agentDir).error, `${configPath(false)}: malformed JSON.`);
    config({ order: ["muse-code"] }, true);
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: ["muse-code"] });
    config({ order: [] }, true);
    assert.deepEqual(loadWaterfallConfig(cwd, agentDir), { order: [] });
    config({ order: "invalid" }, true);
    assert.equal(loadWaterfallConfig(cwd, agentDir).error, `${configPath(true)}: order must be an array of supported provider IDs.`);
  });
});
