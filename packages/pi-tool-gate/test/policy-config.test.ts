import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig, loadConfigReport, policyErrors, policyFiles } from "../src/policy-config.ts";
import type { ProjectContext } from "../src/project.ts";
import { editDirectoryGrant } from "../src/permissions.ts";

const defaults: Record<string, unknown> = { flag: true, denyInsteadOfPrompting: false, nested: { model: "default", timeoutMs: 1500 }, list: ["a"] };

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Fresh temp dirs for the shared user, pi user and project locations, with the env pointed at them. */
function setup() {
  const root = mkdtempSync("/tmp/config-");
  dirs.push(root);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(root, "xdg"));
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "pi"));
  const cwd = path.join(root, "project");
  mkdirSync(cwd);
  return { cwd, root };
}

function write(file: string, content: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

test("active shared policy and main local policy override users without inheriting main shared policy", () => {
  const { cwd: root, root: dir } = setup();
  const main = path.join(dir, "main");
  const project: ProjectContext = { cwd: path.join(root, "components"), root, main, isGit: true };
  write(path.join(dir, "xdg/agents/tool-gate.json"), { source: "user", nested: { model: "user" } });
  write(path.join(main, ".agents/tool-gate.json"), { source: "wrong-main", flag: false });
  write(path.join(main, ".pi/tool-gate.json"), { source: "wrong-main", flag: false });
  write(path.join(project.cwd, ".pi/tool-gate.json"), { source: "wrong-subdirectory", flag: false });
  write(path.join(root, ".agents/tool-gate.json"), { source: "agents", nested: { timeoutMs: 10 } });
  write(path.join(root, ".pi/tool-gate.json"), { source: "active" });
  expect(loadConfig("tool-gate", defaults, project)).toEqual({ ...defaults, source: "active", nested: { model: "user", timeoutMs: 10 } });
  write(path.join(main, ".pi/tool-gate.local.json"), { source: "local", nested: { timeoutMs: 20 } });
  expect(loadConfig("tool-gate", defaults, project)).toEqual({ ...defaults, source: "local", nested: { model: "user", timeoutMs: 20 } });
});

test("prompting defaults to false, user true wins over a project false, and a project may set it true", () => {
  const { cwd, root } = setup();
  expect(loadConfig("tool-gate", defaults, cwd)).toEqual(defaults);
  write(path.join(root, "xdg/agents/tool-gate.json"), { denyInsteadOfPrompting: true, nested: { timeoutMs: 42 } });
  expect(loadConfig("tool-gate", defaults, cwd)).toEqual({ ...defaults, denyInsteadOfPrompting: true, nested: { model: "default", timeoutMs: 42 } });
  // A project may not turn prompting back on.
  write(path.join(cwd, ".pi/tool-gate.json"), { denyInsteadOfPrompting: false });
  expect(loadConfig("tool-gate", defaults, cwd)).toEqual({ ...defaults, denyInsteadOfPrompting: true, nested: { model: "default", timeoutMs: 42 } });
  // It may turn it off (tighten).
  write(path.join(root, "xdg/agents/tool-gate.json"), { denyInsteadOfPrompting: false });
  write(path.join(cwd, ".pi/tool-gate.json"), { denyInsteadOfPrompting: true });
  expect(loadConfig("tool-gate", defaults, cwd)).toEqual({ ...defaults, denyInsteadOfPrompting: true });
});

test.each(["true", "false", 0, 1, null, [], {}])("wrong-typed prompting %j preserves the earlier boolean and unrelated fields", invalid => {
  const { cwd, root } = setup();
  const user = path.join(root, "pi/tool-gate.json");
  write(user, { denyInsteadOfPrompting: invalid });
  expect(loadConfig("tool-gate", defaults, cwd)).toEqual(defaults);
  write(user, { denyInsteadOfPrompting: true });
  write(path.join(cwd, ".pi/tool-gate.json"), { denyInsteadOfPrompting: invalid, flag: false, list: ["project"] });
  expect(loadConfig("tool-gate", defaults, cwd)).toEqual({ ...defaults, denyInsteadOfPrompting: true, flag: false, list: ["project"] });
});

test("directory read/write grants union and deduplicate defaults and every policy scope", () => {
  const { cwd: root, root: dir } = setup();
  const project: ProjectContext = { cwd: path.join(root, "nested"), root, main: path.join(dir, "main"), isGit: true };
  const base = { directories: { read: ["default-read", "default-read"], write: ["default-write", "default-write"] } };
  const expected = { directories: { read: ["default-read"], write: ["default-write"] } };
  expect(loadConfig("tool-gate", base, project)).toEqual(expected);
  for (const [i, file] of policyFiles(project).entries()) {
    const read = `scope-${i}-read`;
    const writeGrant = `scope-${i}-write`;
    write(file, { directories: { read: ["default-read", read, read], write: ["default-write", writeGrant, writeGrant] } });
    expected.directories.read.push(read);
    expected.directories.write.push(writeGrant);
    expect(loadConfig("tool-gate", base, project)).toEqual(expected);
    write(file, { directories: { read: [], write: [] } });
    expect(loadConfig("tool-gate", base, project)).toEqual({ directories: {
      read: expected.directories.read.slice(0, -1), write: expected.directories.write.slice(0, -1),
    } });
    write(file, { directories: { read: [read], write: [writeGrant] } });
  }
  expect(base.directories.read).toEqual(["default-read", "default-read"]);
});

test("directory unions work without defaults and reject non-string lists", () => {
  const { cwd } = setup();
  write(path.join(cwd, ".agents/tool-gate.json"), { directories: { read: ["A", "A"], write: ["B", "B"] } });
  write(path.join(cwd, ".pi/tool-gate.json"), { directories: { read: ["C", 42], write: [false] } });
  expect(loadConfig("tool-gate", {}, cwd)).toEqual({ directories: { read: ["A"], write: ["B"] } });
});

test("arrays other than top-level directory read/write retain replacement precedence", () => {
  const { cwd } = setup();
  const base = { list: ["default"], directories: { exclude: ["default"] }, nested: { directories: { read: ["default"], write: ["default"] } } };
  for (const [i, file] of policyFiles(cwd).entries()) {
    const list = [`scope-${i}`, `scope-${i}`];
    const value = { list, directories: { exclude: list }, nested: { directories: { read: list, write: list } } };
    write(file, value);
    expect(loadConfig("tool-gate", base, cwd)).toEqual(value);
  }
  write(path.join(cwd, ".pi/tool-gate.local.json"), { list: [], directories: { exclude: [] }, nested: { directories: { read: [], write: [] } } });
  expect(loadConfig("tool-gate", base, cwd)).toEqual({ list: [], directories: { exclude: [] }, nested: { directories: { read: [], write: [] } } });
});

test.each(["read", "write"] as const)("saving local directory %s grant B does not hide shared grant A", async access => {
  const { cwd: root, root: dir } = setup();
  const project: ProjectContext = { cwd: path.join(root, "nested"), root, main: path.join(dir, "main"), isGit: true };
  const shared = path.join(root, ".pi/tool-gate.json");
  const local = path.join(project.main, ".pi/tool-gate.local.json");
  write(shared, { directories: { [access]: ["/shared/A"] } });
  await editDirectoryGrant(local, "add", access, "/local/B");
  expect(loadConfig("tool-gate", {}, project)).toEqual({ directories: { [access]: ["/shared/A", "/local/B"] } });
  await editDirectoryGrant(local, "remove", access, "/local/B");
  expect(loadConfig("tool-gate", {}, project)).toEqual({ directories: { [access]: ["/shared/A"] } });
});

test("persistence is user-owned: project files cannot change it, and say so", () => {
  const { cwd, root } = setup();
  const base = { persistence: { project: "local", userWritable: true } };
  write(path.join(root, "xdg/agents/tool-gate.json"), { persistence: { project: "shared", userWritable: false } });
  write(path.join(root, "pi/tool-gate.json"), { persistence: { userWritable: true } });
  write(path.join(cwd, ".agents/tool-gate.json"), { persistence: { userWritable: false } });
  write(path.join(cwd, ".pi/tool-gate.local.json"), { persistence: { project: "local", userWritable: false } });
  const report = loadConfigReport("tool-gate", base, cwd);
  expect(report.config).toEqual({ persistence: { project: "shared", userWritable: true } });
  expect(report.ignored.map(i => [path.basename(i.file), i.key])).toEqual([["tool-gate.json", "persistence"], ["tool-gate.local.json", "persistence"]]);
  write(path.join(root, "pi/tool-gate.json"), { persistence: { userWritable: false } });
  write(path.join(cwd, ".pi/tool-gate.json"), { persistence: { userWritable: true } });
  write(path.join(cwd, ".pi/tool-gate.local.json"), { persistence: { project: "shared", userWritable: true } });
  expect(loadConfig("tool-gate", base, cwd)).toEqual({ persistence: { project: "shared", userWritable: false } });
});

test("project files cannot supply persistence when no user value exists", () => {
  const { cwd } = setup();
  write(path.join(cwd, ".pi/tool-gate.json"), { persistence: { project: "shared", userWritable: false } });
  expect(loadConfig("tool-gate", {}, cwd)).toEqual({});
});

const LOOSENING: Array<[string, unknown, string]> = [
  ["enabled", false, "enabled"],
  ["allowTools", ["bash"], "allowTools"],
  ["readOnlyCommands", ["make"], "readOnlyCommands"],
  ["thresholds", { irreversible: 1 }, "thresholds"],
  ["jev", { enabled: false }, "jev"],
  ["modes", ["auto"], "modes"],
  ["defaultApproval", "yolo", "defaultApproval"],
  ["defaultMode", "bypass", "defaultMode"],
  ["denyInsteadOfPrompting", false, "denyInsteadOfPrompting"],
  ["planShell", "scoped", "planShell"],
];

test.each(LOOSENING)("a project file cannot loosen %s; user files can", (key, value, reported) => {
  const { cwd, root } = setup();
  for (const file of [".agents/tool-gate.json", ".pi/tool-gate.json", ".pi/tool-gate.local.json"]) {
    write(path.join(cwd, file), { [key]: value });
    const report = loadConfigReport("tool-gate", {}, cwd);
    expect(report.config).toEqual({});
    expect(report.ignored.map(i => i.key)).toEqual([reported]);
    rmSync(path.join(cwd, file));
  }
  write(path.join(root, "pi/tool-gate.json"), { [key]: value });
  expect(loadConfigReport("tool-gate", {}, cwd)).toEqual({ config: { [key]: value }, ignored: [] });
});

test("a project file may tighten: manual approvals, prompting off, read-only plan shell", () => {
  const { cwd } = setup();
  write(path.join(cwd, ".pi/tool-gate.json"), { defaultApproval: "manual", denyInsteadOfPrompting: true, planShell: "read-only" });
  expect(loadConfigReport("tool-gate", {}, cwd)).toEqual({ config: { defaultApproval: "manual", denyInsteadOfPrompting: true, planShell: "read-only" }, ignored: [] });
});

test("project directories keep private and derived roots, add to them, and cannot loosen the rest", () => {
  const { cwd, root } = setup();
  write(path.join(root, "pi/tool-gate.json"), { directories: { private: ["~/A"], derived: [{ path: "~/.config" }], alwaysWrite: ["/tmp"], enabled: true } });
  write(path.join(cwd, ".pi/tool-gate.json"), {
    directories: { private: ["~/B", "~/A"], derived: [{ path: "~/.config" }, { path: "~/.x" }], alwaysWrite: ["/"], exemptCommands: ["make"], enabled: false },
  });
  const report = loadConfigReport("tool-gate", { directories: { enabled: true, private: [], derived: [], alwaysWrite: [] } }, cwd);
  expect(report.config).toEqual({ directories: { enabled: true, private: ["~/A", "~/B"], derived: [{ path: "~/.config" }, { path: "~/.x" }], alwaysWrite: ["/tmp"] } });
  expect(report.ignored.map(i => i.key).sort()).toEqual(["directories.alwaysWrite", "directories.enabled", "directories.exemptCommands"]);
});

test.each([false, true, "managed", null, [], 42])("project persistence scalar %j cannot bypass managed globals", persistence => {
  const { cwd, root } = setup();
  const base = { persistence: { project: "local", userWritable: true } };
  write(path.join(root, "pi/tool-gate.json"), { persistence: { project: "shared", userWritable: false } });
  write(path.join(cwd, ".agents/tool-gate.json"), { persistence });
  write(path.join(cwd, ".pi/tool-gate.json"), { persistence });
  write(path.join(cwd, ".pi/tool-gate.local.json"), { persistence });
  expect(loadConfig("tool-gate", base, cwd)).toEqual({ persistence: { project: "shared", userWritable: false } });
  expect(loadConfig("tool-gate", {}, cwd)).toEqual({ persistence: { project: "shared", userWritable: false } });
});

test.each(["invalid", "", false, null, 42, {}])("invalid persistence.project %j retains lower precedence", invalid => {
  const { cwd, root } = setup();
  const base = { persistence: { project: "local", userWritable: true } };
  const user = path.join(root, "pi/tool-gate.json");
  write(user, { persistence: { project: invalid } });
  expect(loadConfig("tool-gate", base, cwd)).toEqual(base);
  write(user, { persistence: { project: "shared", userWritable: false } });
  for (const file of [".agents/tool-gate.json", ".pi/tool-gate.json", ".pi/tool-gate.local.json"])
    write(path.join(cwd, file), { persistence: { project: invalid, userWritable: true } });
  expect(loadConfig("tool-gate", base, cwd)).toEqual({ persistence: { project: "shared", userWritable: false } });
});

test("policy diagnostics cover every scope, distinguish malformed/nonobject/unreadable, and ignore missing files", () => {
  const { cwd: root, root: dir } = setup();
  const project: ProjectContext = { cwd: path.join(root, "nested"), root, main: path.join(dir, "main"), isGit: true };
  const files = policyFiles(project);
  expect(files).toEqual([
    path.join(dir, "xdg/agents/tool-gate.json"),
    path.join(dir, "pi/tool-gate.json"),
    path.join(root, ".agents/tool-gate.json"),
    path.join(root, ".pi/tool-gate.json"),
    path.join(project.main, ".pi/tool-gate.local.json"),
  ]);
  expect(policyErrors(project)).toEqual([]);
  write(files[0]!, "{");
  write(files[1]!, "null");
  write(files[2]!, "[]");
  mkdirSync(files[3]!, { recursive: true });
  write(files[4]!, "true");
  const errors = policyErrors(project);
  expect(errors).toHaveLength(5);
  for (const [i, file] of files.entries()) expect(errors[i]).toContain(file);
  expect(errors[0]).toContain("Invalid policy JSON");
  expect(errors[1]).toContain("must be an object");
  expect(errors[2]).toContain("must be an object");
  expect(errors[3]).toContain("Could not read policy file");
  expect(errors[4]).toContain("must be an object");
  expect(loadConfig("tool-gate", defaults, project)).toEqual(defaults);
  rmSync(files[3]!, { recursive: true });
  for (const file of files) write(file, {});
  expect(policyErrors(project)).toEqual([]);
});
