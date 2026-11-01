import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveSystem1Backend } from "../src/settings.js";

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

describe("global backend save", () => {
  it("atomically creates only the global backend with private permissions", () => {
    const rename = vi.spyOn(fs, "renameSync");
    saveSystem1Backend("openai-decisions");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ backend: "openai-decisions" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(directory, "agent")).mode & 0o777).toBe(0o700);
    expect(rename).toHaveBeenCalledOnce();
    expect(rename.mock.calls[0][1]).toBe(path);
    expect(rename.mock.calls[0][0]).toMatch(/system1\.json\..+\.tmp$/u);
    expect(readdirSync(join(directory, "agent"))).toEqual(["system1.json"]);
  });
  it("preserves unrelated future JSON keys without adding any new controls", () => {
    existing(JSON.stringify({ backend: "jev", future: { nested: [1, true] }, note: "retained" }));
    saveSystem1Backend("openai-decisions");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ backend: "openai-decisions", future: { nested: [1, true] }, note: "retained" });
    saveSystem1Backend("jev");
    expect(JSON.parse(readFileSync(path, "utf8")).backend).toBe("jev");
  });
  it.each(["{broken", "null", "[]", '"jev"', "{}", '{"backend":"other"}', '{"backend":false}'])
    ("does not repair an existing malformed/invalid file: %s", (contents) => {
      existing(contents);
      expect(() => saveSystem1Backend("jev")).toThrow(/correct the file before switching/u);
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(readdirSync(join(directory, "agent"))).toEqual(["system1.json"]);
    });
  it("rejects invalid backend values before creating a file", () => {
    expect(() => saveSystem1Backend("wrong" as never)).toThrow("Unsupported System 1 backend");
    expect(readdirSync(directory)).toEqual([]);
  });
  it("does not treat an unreadable file as missing", () => {
    existing('{"backend":"jev"}');
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => { throw Object.assign(new Error("private details"), { code: "EACCES" }); });
    expect(() => saveSystem1Backend("openai-decisions")).toThrow("Cannot read System 1 setting");
    expect(readFileSync(path, "utf8")).toBe('{"backend":"jev"}');
  });
  it("leaves the old setting intact and cleans its temporary file on rename failure", () => {
    existing('{"backend":"jev"}');
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("private disk error"); });
    expect(() => saveSystem1Backend("openai-decisions")).toThrow("previous selection was not replaced");
    expect(readFileSync(path, "utf8")).toBe('{"backend":"jev"}');
    expect(readdirSync(join(directory, "agent"))).toEqual(["system1.json"]);
  });
  it("leaves the old selection intact on a write failure", () => {
    existing('{"backend":"jev"}');
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => { throw new Error("private disk error"); });
    expect(() => saveSystem1Backend("openai-decisions")).toThrow("Cannot save System 1 setting");
    expect(readFileSync(path, "utf8")).toBe('{"backend":"jev"}');
    expect(readdirSync(join(directory, "agent"))).toEqual(["system1.json"]);
  });
  it("ignores project settings and never writes into the project", () => {
    const project = join(directory, "project", ".pi");
    mkdirSync(project, { recursive: true });
    const projectSetting = join(project, "system1.json");
    writeFileSync(projectSetting, '{"backend":"jev"}');
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(join(directory, "project"));
    saveSystem1Backend("openai-decisions");
    expect(readFileSync(projectSetting, "utf8")).toBe('{"backend":"jev"}');
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ backend: "openai-decisions" });
    expect(cwd).not.toHaveBeenCalled();
    expect(readdirSync(project)).toEqual(["system1.json"]);
  });
});
