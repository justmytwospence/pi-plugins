import { test, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPressurePolicy } from "../src/pressure-config.ts";
import { DEFAULT_LIMITS } from "../src/quota-pressure.ts";

const roots = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock("node:os");
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "pressure-config-"));
  roots.push(root);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "config"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
  const cwd = path.join(root, "project");
  const dirs = [path.join(root, "config", "agents"), path.join(root, "agent"), path.join(cwd, ".agents"), path.join(cwd, ".pi")];
  dirs.forEach(dir => mkdirSync(dir, { recursive: true }));
  return { root, cwd, dirs };
}
const save = (dir, name, value) => writeFileSync(path.join(dir, name), JSON.stringify(value));

test("all four scopes overlay legacy then current, with typed nested lower-layer fallback", () => {
  const { cwd, dirs } = fixture();
  const expected = structuredClone(DEFAULT_LIMITS);
  let layer = 0;
  for (const dir of dirs) for (const file of ["auto-effort.json", "quota-pressure.json"]) {
    const used = (61 + layer++) / 100;
    save(dir, file, { limits: { caution: { used }, warmup: { spanMinutes: 60 + layer } } });
    expected.caution.used = used;
    expected.warmup.spanMinutes = 60 + layer;
    expect(loadPressurePolicy(cwd)).toEqual(expected);
  }
  save(dirs[3], "quota-pressure.json", { limits: { enabled: false, caution: { used: "bad", projected: 0.95 },
    warmup: { readings: -1, spanMinutes: null }, recent: { halfLifeMinutes: 0 } } });
  const result = loadPressurePolicy(cwd);
  expect(result.enabled).toBe(false);
  expect(result.caution).toEqual({ used: 0.67, projected: 0.95 });
  expect(result.warmup).toEqual({ ...DEFAULT_LIMITS.warmup, spanMinutes: 67 });
  expect(result.recent).toEqual({ ...DEFAULT_LIMITS.recent, halfLifeMinutes: 0 });
});

test("missing, unreadable, malformed and mistyped layers preserve lower policy", () => {
  const { cwd, dirs } = fixture();
  save(dirs[0], "auto-effort.json", { limits: { caution: { used: 0.7 }, critical: { projected: 1.4 } } });
  const expected = loadPressurePolicy(cwd);
  // A directory is an unreadable config on all platforms, even for root.
  mkdirSync(path.join(dirs[1], "quota-pressure.json"));
  writeFileSync(path.join(dirs[2], "auto-effort.json"), "{bad JSON");
  for (const value of [null, [], true, "settings", {}, { limits: [] }, { limits: false },
    { limits: { enabled: "false", caution: null, critical: { projected: "2" }, warmup: { readings: -1 } } }]) {
    save(dirs[3], "quota-pressure.json", value);
    expect(loadPressurePolicy(cwd)).toEqual(expected);
  }
});

test("legacy non-limits controls and unknown pressure fields have no effect", () => {
  const { cwd, dirs } = fixture();
  const ignored = { enabled: false, classifier: { model: "other" }, prefilter: { enabled: true },
    midrun: { enabled: true }, bounds: { min: "high" }, limits: { steps: { critical: 5 }, surprise: 99 } };
  for (const dir of dirs) for (const file of ["auto-effort.json", "quota-pressure.json"]) save(dir, file, ignored);
  expect(loadPressurePolicy(cwd)).toEqual(DEFAULT_LIMITS);
  save(dirs[0], "quota-pressure.json", { limits: { enabled: false } });
  expect(loadPressurePolicy(cwd).enabled).toBe(false);
  save(dirs[3], "quota-pressure.json", { limits: { enabled: true } });
  expect(loadPressurePolicy(cwd).enabled).toBe(true);
});

test("unset XDG and agent directories use the documented home defaults", async () => {
  const { root, cwd } = fixture();
  vi.stubEnv("XDG_CONFIG_HOME", "");
  vi.stubEnv("PI_CODING_AGENT_DIR", "");
  const global = path.join(root, ".config", "agents"), agent = path.join(root, ".pi", "agent");
  mkdirSync(global, { recursive: true }); mkdirSync(agent, { recursive: true });
  save(global, "quota-pressure.json", { limits: { caution: { used: 0.72 }, critical: { used: 0.92 } } });
  save(agent, "auto-effort.json", { limits: { caution: { used: 0.73 } } });
  vi.doMock("node:os", () => ({ homedir: () => root }));
  vi.resetModules();
  const { loadPressurePolicy: read } = await import("../src/pressure-config.ts");
  expect(read(cwd).caution.used).toBe(0.73);
  expect(read(cwd).critical.used).toBe(0.92);
});
