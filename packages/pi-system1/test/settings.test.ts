import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSystem1Backend, saveSystem1Waterfall } from "../src/settings.js";
import { readSystem1Setting, resolveSystem1Target } from "../src/system1.js";

vi.mock("node:fs", { spy: true });

let directory: string;
let path: string;

beforeEach(() => {
  vi.clearAllMocks();
  directory = mkdtempSync(join(tmpdir(), "pi-system1-settings-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
  path = join(directory, "agent", "system1.json");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function existing(contents: string) {
  mkdirSync(join(directory, "agent"));
  writeFileSync(path, contents);
}

describe("global waterfall save", () => {
  it("atomically creates the ordered waterfall and primary mirror with private permissions", () => {
    const rename = vi.spyOn(fs, "renameSync");
    saveSystem1Waterfall(["openai-decisions", "jev"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      waterfall: ["openai-decisions", "jev"],
      backend: "openai-decisions",
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "agent")).mode & 0o777).toBe(0o700);
    expect(rename).toHaveBeenCalledOnce();
    expect(rename.mock.calls[0][1]).toBe(path);
    expect(rename.mock.calls[0][0]).toMatch(/system1\.json\..+\.tmp$/u);
    expect(readdirSync(join(directory, "agent"))).toEqual(["system1.json"]);
  });
  it("preserves unknown keys and treats a valid waterfall as authoritative over an invalid mirror", () => {
    existing(JSON.stringify({ waterfall: ["jev"], backend: false, future: { nested: [1, true] }, note: "retained" }));
    saveSystem1Waterfall(["jev", "openai-decisions"]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      waterfall: ["jev", "openai-decisions"],
      backend: "jev",
      future: { nested: [1, true] },
      note: "retained",
    });
  });
  it("canonicalizes a legacy singleton without changing the policy or physical target key", () => {
    existing('{"backend":"jev","future":1}');
    const config = { provider: "typesafe", model: "model" };
    const before = readSystem1Setting();
    const targetBefore = resolveSystem1Target(config);
    saveSystem1Waterfall(["jev"]);
    const after = readSystem1Setting();
    expect(before).toMatchObject({ ok: true, waterfall: ["jev"], legacy: true });
    expect(after).toMatchObject({ ok: true, waterfall: ["jev"], legacy: false });
    expect(after.key).toBe(before.key);
    expect(resolveSystem1Target(config).key).toBe(targetBefore.key);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ backend: "jev", waterfall: ["jev"], future: 1 });
  });
  it("keeps the deprecated backend writer as a singleton wrapper", () => {
    saveSystem1Backend("openai-decisions");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      waterfall: ["openai-decisions"],
      backend: "openai-decisions",
    });
  });
  it.each([
    "{broken",
    "null",
    "[]",
    '"jev"',
    "{}",
    '{"backend":"other"}',
    '{"backend":false}',
    '{"backend":"jev","waterfall":null}',
    '{"backend":"jev","waterfall":[]}',
    '{"backend":"jev","waterfall":["jev","jev"]}',
    '{"backend":"jev","waterfall":["other"]}',
  ])("does not repair an existing malformed/invalid file: %s", (contents) => {
    existing(contents);
    expect(() => saveSystem1Waterfall(["jev"])).toThrow(/correct the file before switching/u);
    expect(readFileSync(path, "utf8")).toBe(contents);
    expect(readdirSync(join(directory, "agent"))).toEqual(["system1.json"]);
  });
  it.each([[], ["wrong"], ["jev", "jev"], ["jev", "wrong"], null])(
    "rejects invalid orders before creating a file: %j",
    (waterfall) => {
      expect(() => saveSystem1Waterfall(waterfall as never)).toThrow("Invalid System 1 waterfall");
      expect(readdirSync(directory)).toEqual([]);
    },
  );
  it("does not treat an unreadable file as missing", () => {
    existing('{"backend":"jev"}');
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("private details"), { code: "EACCES" });
    });
    expect(() => saveSystem1Waterfall(["openai-decisions"])).toThrow("Cannot read System 1 setting");
    expect(readFileSync(path, "utf8")).toBe('{"backend":"jev"}');
  });
  it.each(["renameSync", "writeFileSync"] as const)(
    "leaves the old order intact and cleans the temporary file on %s failure",
    (method) => {
      const contents = '{"waterfall":["jev","openai-decisions"],"backend":"jev"}';
      existing(contents);
      vi.spyOn(fs, method).mockImplementationOnce(() => {
        throw new Error("private disk error");
      });
      expect(() => saveSystem1Waterfall(["openai-decisions", "jev"])).toThrow("previous selection was not replaced");
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(readdirSync(join(directory, "agent"))).toEqual(["system1.json"]);
    },
  );
  it("ignores project settings and never writes into the project", () => {
    const project = join(directory, "project", ".pi");
    mkdirSync(project, { recursive: true });
    const projectSetting = join(project, "system1.json");
    writeFileSync(projectSetting, '{"backend":"jev"}');
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(join(directory, "project"));
    saveSystem1Waterfall(["openai-decisions", "jev"]);
    expect(readFileSync(projectSetting, "utf8")).toBe('{"backend":"jev"}');
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      waterfall: ["openai-decisions", "jev"],
      backend: "openai-decisions",
    });
    expect(cwd).not.toHaveBeenCalled();
    expect(readdirSync(project)).toEqual(["system1.json"]);
  });
});
