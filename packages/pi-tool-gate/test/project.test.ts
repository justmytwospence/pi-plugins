import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { projectFiles, projectSaveFile, resolveProject } from "../src/project.ts";

vi.mock("node:fs", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, lstatSync: vi.fn(original.lstatSync) };
});

const run = promisify(execFile);
const exec: ExtensionAPI["exec"] = async (command, args, options) => {
  try {
    const out = await run(command, args, options);
    return { stdout: String(out.stdout), stderr: String(out.stderr), code: 0, killed: false };
  } catch (error) {
    const out = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    return { stdout: out.stdout ?? "", stderr: out.stderr ?? "", code: out.code ?? 1, killed: out.killed ?? false };
  }
};
const fsOriginalLstat = (await vi.importActual<typeof import("node:fs")>("node:fs")).lstatSync;
const dirs: string[] = [];
afterEach(() => {
  vi.mocked(fs.lstatSync).mockReset();
  vi.mocked(fs.lstatSync).mockImplementation(fsOriginalLstat);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "gate-project-")));
  dirs.push(dir);
  return dir;
}
async function git(cwd: string, ...args: string[]) {
  return run("git", ["-C", cwd, ...args]);
}

test("root and subdirectory launches use the same real Git checkout root", async () => {
  const root = setup();
  await git(root, "init");
  const cwd = path.join(root, "src", "nested");
  mkdirSync(cwd, { recursive: true });
  expect(await resolveProject(root, exec)).toEqual({ cwd: root, root, main: root, isGit: true });
  expect(await resolveProject(cwd, exec)).toEqual({ cwd, root, main: root, isGit: true });
  expect(projectFiles(await resolveProject(cwd, exec))).toEqual(projectFiles(await resolveProject(root, exec)));
});

test("linked worktrees use active shared policy and main local policy, including nested launches", async () => {
  const dir = setup();
  const main = path.join(dir, "main");
  const root = path.join(dir, "linked");
  mkdirSync(main);
  await git(main, "init");
  await git(main, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
  await git(main, "worktree", "add", "-b", "linked", root);
  const cwd = path.join(root, "components");
  mkdirSync(cwd);
  const project = await resolveProject(cwd, exec);
  expect(project).toEqual({ cwd, root, main, isGit: true });
  expect(projectFiles(project)).toEqual([
    path.join(root, ".agents/tool-gate.json"),
    path.join(root, ".pi/tool-gate.json"),
    path.join(main, ".pi/tool-gate.local.json"),
  ]);
  expect(projectSaveFile(project)).toBe(path.join(main, ".pi/tool-gate.local.json"));
  expect(projectSaveFile(project, "local")).toBe(projectSaveFile(project));
  expect(projectSaveFile(project, "shared")).toBe(path.join(root, ".pi/tool-gate.json"));
});

test("nested repositories are isolated from their parent repository", async () => {
  const outer = setup();
  await git(outer, "init");
  const root = path.join(outer, "nested");
  const cwd = path.join(root, "components");
  mkdirSync(cwd, { recursive: true });
  await git(root, "init");
  expect(await resolveProject(cwd, exec)).toEqual({ cwd, root, main: root, isGit: true });
});

test("non-Git launches use the launch subdirectory, not an inferred ancestor", async () => {
  const dir = setup();
  const cwd = path.join(dir, "project", "components");
  mkdirSync(cwd, { recursive: true });
  expect(await resolveProject(cwd, exec)).toEqual({ cwd, root: cwd, main: cwd, isGit: false });
});

test("symlink launches resolve cwd, root and main to real paths", async () => {
  const dir = setup();
  const root = path.join(dir, "real");
  const link = path.join(dir, "alias");
  mkdirSync(root);
  symlinkSync(root, link, "dir");
  await git(root, "init");
  expect(await resolveProject(link, exec)).toEqual({ cwd: root, root, main: root, isGit: true });
});

const nonGit = { stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git\n", code: 128, killed: false };

test("only a normal controlled-locale non-Git diagnostic permits fallback", async () => {
  const cwd = setup();
  const failed = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue(nonGit);
  expect(await resolveProject(cwd, failed)).toEqual({ cwd, root: cwd, main: cwd, isGit: false });
  expect(failed).toHaveBeenCalledWith("env", ["LC_ALL=C", "git", "-C", cwd, "rev-parse", "--path-format=absolute", "--show-toplevel"], { timeout: 2_000 });
});

test.each([
  { ...nonGit, killed: true },
  { ...nonGit, code: 1 },
  { ...nonGit, stderr: "" },
  { ...nonGit, stderr: "fatal: detected dubious ownership in repository at '/repo'\n" },
  { ...nonGit, stderr: `${nonGit.stderr}unknown error\n` },
  { ...nonGit, stdout: "unexpected" },
  { ...nonGit, code: 0, killed: true },
])("uncertain initial discovery fails closed: %j", async result => {
  await expect(resolveProject(setup(), vi.fn().mockResolvedValue(result))).rejects.toThrow("Policy resolution failed");
});

test.each(["unavailable", "ETIMEDOUT"])("initial lookup exception (%s) is a resolution error", async message => {
  await expect(resolveProject(setup(), vi.fn().mockRejectedValue(new Error(message)))).rejects.toThrow("Policy resolution failed");
});

test.each(["directory", "gitfile", "broken link"]) ("damaged ancestor .git %s blocks fallback", async kind => {
  const root = setup();
  const cwd = path.join(root, "nested");
  mkdirSync(cwd);
  const metadata = path.join(root, ".git");
  if (kind === "directory") mkdirSync(metadata);
  else if (kind === "gitfile") writeFileSync(metadata, "gitdir: /missing/gate-metadata\n");
  else symlinkSync(path.join(root, "missing"), metadata);
  // Real Git errors must block too, including those indistinguishable from non-Git.
  await expect(resolveProject(cwd, exec)).rejects.toThrow("Policy resolution failed");
  await expect(resolveProject(cwd, vi.fn().mockResolvedValue(nonGit))).rejects.toThrow("Policy resolution failed");
});

test.each(["objects", "refs", "config"])("apparent bare metadata (%s) blocks fallback", async entry => {
  const root = setup();
  const cwd = path.join(root, "nested");
  mkdirSync(cwd);
  writeFileSync(path.join(root, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(root, entry), "damaged metadata");
  await expect(resolveProject(cwd, vi.fn().mockResolvedValue(nonGit))).rejects.toThrow("Policy resolution failed");
});

test.each(["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM"])("explicit %s blocks fallback even when empty", async key => {
  vi.stubEnv(key, "");
  await expect(resolveProject(setup(), vi.fn().mockResolvedValue(nonGit))).rejects.toThrow("Policy resolution failed");
});

test.each(["EACCES", "EPERM", "EIO", "ENOTDIR"])("uncertain ancestor probes (%s) block fallback", async code => {
  const cwd = setup();
  const original = fsOriginalLstat;
  vi.mocked(fs.lstatSync).mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    if (args[0] === path.join(path.dirname(cwd), ".git")) throw Object.assign(new Error("probe failed"), { code });
    return original(...args);
  });
  await expect(resolveProject(cwd, vi.fn().mockResolvedValue(nonGit))).rejects.toThrow("Policy resolution failed");
});

test("negative metadata scan reaches filesystem root and never selects an ancestor", async () => {
  const cwd = setup();
  const spy = vi.mocked(fs.lstatSync);
  expect((await resolveProject(cwd, vi.fn().mockResolvedValue(nonGit))).root).toBe(cwd);
  expect(spy).toHaveBeenCalledWith(path.join(path.parse(cwd).root, ".git"));
});

async function commit(cwd: string) {
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
}

test.each([false, true])("separate-git-dir linked worktrees require a recorded main mapping (%s)", async mapped => {
  const dir = setup();
  const main = path.join(dir, "main");
  const root = path.join(dir, "linked");
  mkdirSync(main);
  await git(main, "init", "--separate-git-dir", path.join(dir, "metadata"));
  await commit(main);
  expect(await resolveProject(main, exec)).toEqual({ cwd: main, root: main, main, isGit: true });
  await git(main, "worktree", "add", "-b", "linked", root);
  if (mapped) {
    await git(main, "config", "--local", "core.worktree", main);
    expect(await resolveProject(root, exec)).toEqual({ cwd: root, root, main, isGit: true });
  } else {
    await expect(resolveProject(root, exec)).rejects.toThrow("Policy resolution failed");
  }
});

test("real submodule linked worktrees resolve main to the submodule checkout", async () => {
  const dir = setup();
  const source = path.join(dir, "source");
  const parent = path.join(dir, "parent");
  mkdirSync(source);
  mkdirSync(parent);
  await git(source, "init");
  await commit(source);
  await git(parent, "init");
  await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", source, "module");
  const main = path.join(parent, "module");
  expect(await resolveProject(main, exec)).toEqual({ cwd: main, root: main, main, isGit: true });
  const root = path.join(dir, "linked-module");
  await git(main, "worktree", "add", "-b", "linked", root);
  expect(await resolveProject(root, exec)).toEqual({ cwd: root, root, main, isGit: true });
});

test("Git paths preserve leading/trailing whitespace and embedded/trailing newlines", async () => {
  const dir = setup();
  const main = path.join(dir, " main\ncheckout \n");
  const root = path.join(dir, " linked\ncheckout \n");
  const cwd = path.join(root, " nested \n");
  mkdirSync(main);
  await git(main, "init");
  await commit(main);
  await git(main, "worktree", "add", "-b", "linked", root);
  mkdirSync(cwd);
  expect(await resolveProject(cwd, exec)).toEqual({ cwd, root, main, isGit: true });
});

test.each([
  ["empty", ""],
  ["unterminated", "worktree /missing\0HEAD abc\0"],
  ["missing path", "HEAD abc\0\0"],
  ["relative path", "worktree relative\0\0"],
  ["bare", "worktree MAIN\0bare\0\0"],
  ["duplicate path", "worktree MAIN\0worktree MAIN\0\0"],
  ["nonexistent checkout", "worktree MAIN/missing\0\0"],
  ["different repository", "worktree OTHER\0\0"],
])("invalid main metadata (%s) throws instead of falling back", async (_name, metadata) => {
  const main = setup();
  const other = setup();
  const linked = path.join(other, "linked");
  await git(main, "init");
  await commit(main);
  await git(main, "worktree", "add", "-b", "linked", linked);
  await git(other, "init");
  const intercepted: ExtensionAPI["exec"] = async (command, args, options) => {
    if (args.includes("--porcelain")) {
      return { stdout: metadata.replaceAll("MAIN", main).replaceAll("OTHER", other), stderr: "", code: 0, killed: false };
    }
    return exec(command, args, options);
  };
  await expect(resolveProject(linked, intercepted)).rejects.toThrow("Policy resolution failed");
});

test.each(["absolute", "common", "list", "verify"])("Git %s lookup failures after identification throw", async stage => {
  const main = setup();
  await git(main, "init");
  await commit(main);
  const linked = path.join(setup(), "linked");
  await git(main, "worktree", "add", "-b", "linked", linked);
  const intercepted: ExtensionAPI["exec"] = async (command, args, options) => {
    if ((stage === "absolute" && args.includes("--absolute-git-dir")) ||
        (stage === "common" && args.includes("--git-common-dir")) ||
        (stage === "list" && args.includes("--porcelain")) ||
        (stage === "verify" && args[1] === main && args.includes("--show-toplevel"))) {
      throw new Error("unavailable");
    }
    return exec(command, args, options);
  };
  await expect(resolveProject(linked, intercepted)).rejects.toThrow("Policy resolution failed");
});

test.each(["relative", "worktree-specific", "worktree-fallback", "mismatched", "global-only", "bare"])("repository main mapping: %s", async kind => {
  const dir = setup();
  const main = path.join(dir, " main\ncheckout \n");
  const root = path.join(dir, "linked\n");
  const common = path.join(dir, "metadata");
  mkdirSync(main);
  await git(main, "init", "--separate-git-dir", common);
  await commit(main);
  await git(main, "worktree", "add", "-b", "linked", root);
  if (kind === "relative") {
    await git(main, "config", "--local", "core.worktree", path.relative(common, main));
  } else if (kind === "worktree-specific") {
    await git(main, "config", "--local", "extensions.worktreeConfig", "true");
    await git(main, "config", "--local", "core.worktree", root);
    await run("git", ["--git-dir", common, "config", "--worktree", "core.worktree", main]);
  } else if (kind === "worktree-fallback") {
    await git(main, "config", "--local", "extensions.worktreeConfig", "true");
    await git(main, "config", "--local", "core.worktree", main);
    await git(root, "config", "--worktree", "core.worktree", root);
  } else if (kind === "mismatched") {
    // A linked checkout shares common-dir but cannot be accepted as main.
    await git(main, "config", "--local", "core.worktree", root);
  } else if (kind === "bare") {
    await git(main, "config", "--local", "core.bare", "true");
  }
  // Inject a real global configuration only for this fixture's Git children.
  const globalFile = path.join(dir, "global-config");
  await run("git", ["config", "--file", globalFile, "core.worktree", main]);
  const isolated: ExtensionAPI["exec"] = async (command, args, options) => {
    try {
      const out = await run(command, args, { ...options, env: { ...process.env, GIT_CONFIG_GLOBAL: globalFile, GIT_CONFIG_NOSYSTEM: "1" } });
      return { stdout: String(out.stdout), stderr: String(out.stderr), code: 0, killed: false };
    } catch (error) {
      const out = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: out.stdout ?? "", stderr: out.stderr ?? "", code: out.code ?? 1, killed: false };
    }
  };
  if (kind === "relative" || kind === "worktree-specific" || kind === "worktree-fallback") {
    expect(await resolveProject(root, isolated)).toEqual({ cwd: root, root, main, isGit: true });
  } else {
    await expect(resolveProject(root, isolated)).rejects.toThrow("Policy resolution failed");
  }
});

test("direct main uses separate canonical metadata queries without listing worktrees", async () => {
  const root = setup();
  await git(root, "init");
  const spy = vi.fn(exec);
  expect((await resolveProject(root, spy)).main).toBe(root);
  expect(spy.mock.calls.map(call => call[1])).toEqual([
    ["LC_ALL=C", "git", "-C", root, "rev-parse", "--path-format=absolute", "--show-toplevel"],
    ["-C", root, "rev-parse", "--absolute-git-dir"],
    ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
  ]);
});

test("successful initial lookup with invalid path metadata is not a non-Git fallback", async () => {
  const cwd = setup();
  const invalid = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ stdout: "", stderr: "", code: 0, killed: false });
  await expect(resolveProject(cwd, invalid)).rejects.toThrow("Policy resolution failed");
});
