import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveProject } from "../src/project.ts";
import { harness } from "./harness.ts";

let cwd: string;
beforeEach(() => {
  cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "gate-harness-")));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const discovery = (dir: string) => ["LC_ALL=C", "git", "-C", dir, "rev-parse", "--path-format=absolute", "--show-toplevel"];
const generic = { code: 1, stdout: "", stderr: "", killed: false };

test("non-Git mode explicitly recognizes only its declared cwd and discovery command", async () => {
  const h = harness({ nonGitCwd: cwd });
  expect(await h.pi.exec("env", discovery(cwd))).toEqual({
    code: 128, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n", killed: false,
  });
  expect(await resolveProject(cwd, h.pi.exec)).toEqual({ cwd, root: cwd, main: cwd, isGit: false });
  for (const [cmd, args] of [
    ["git", discovery(cwd)],
    ["env", discovery(path.join(cwd, "other"))],
    ["env", [...discovery(cwd), "--git-common-dir"]],
    ["env", discovery(cwd).slice(1)],
    ["env", discovery(cwd).map(arg => arg === "LC_ALL=C" ? "LC_ALL=en_US" : arg)],
    ["bash", ["-c", "true"]],
  ] as Array<[string, string[]]>) {
    expect(await h.pi.exec(cmd, args)).toEqual(generic);
  }
});

test("generic harness failures remain failures without explicit selection", async () => {
  const h = harness();
  expect(await h.pi.exec("env", discovery(cwd))).toEqual(generic);
  await expect(resolveProject(cwd, h.pi.exec)).rejects.toThrow("Policy resolution failed");
});

test.each([
  { code: 1, stdout: "", stderr: "", killed: false },
  { code: 128, stdout: "", stderr: "fatal: detected dubious ownership", killed: false },
  { code: 128, stdout: "", stderr: "", killed: true },
])("custom failure is never normalized: %j", async (result) => {
  const exec = vi.fn(() => result);
  const h = harness({ nonGitCwd: cwd, exec });
  expect(await h.pi.exec("env", discovery(cwd))).toBe(result);
  await expect(resolveProject(cwd, h.pi.exec)).rejects.toThrow("Policy resolution failed");
  expect(exec).toHaveBeenCalledWith("env", discovery(cwd));
});

test("custom executor exceptions and successful responses remain untouched", async () => {
  const error = new Error("executor unavailable");
  const h = harness({ nonGitCwd: cwd, exec: () => { throw error; } });
  await expect(h.pi.exec("env", discovery(cwd))).rejects.toBe(error);
  await expect(resolveProject(cwd, h.pi.exec)).rejects.toThrow("Policy resolution failed");
  const result = { code: 0, stdout: "custom output", stderr: "" };
  expect(await harness({ nonGitCwd: cwd, exec: () => result }).pi.exec("env", discovery(cwd))).toBe(result);
});

test("fixture discovery does not bypass ancestor metadata checks", async () => {
  mkdirSync(path.join(cwd, ".git"));
  const nested = path.join(cwd, "nested");
  mkdirSync(nested);
  const h = harness({ nonGitCwd: nested });
  await expect(resolveProject(nested, h.pi.exec)).rejects.toThrow("Policy resolution failed");
});

test("non-Git fixture cwd must actually exist", () => {
  expect(() => harness({ nonGitCwd: path.join(cwd, "missing") })).toThrow();
});
