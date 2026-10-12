import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "vitest";

const modules = fileURLToPath(new URL("../node_modules/@earendil-works/", import.meta.url));
const { createJiti } = await import(pathToFileURL(path.join(modules, "pi-coding-agent/dist/core/extensions/jiti-loader.js")));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-tui": path.join(modules, "pi-tui/dist/index.js"),
} });
const mod = await jiti.import(fileURLToPath(new URL("../src/index.ts", import.meta.url)));
const theme = { fg: (_color, text) => text, bold: (text) => text };
const row = (git) => mod.renderFooter({
  cwd: "/tmp/project", git, model: "test", provider: "test", oauth: false,
  queued: false, context: { tokens: null, contextWindow: 1000, percent: null },
  totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, compactions: 0, started: Date.now() },
  quotas: [], statuses: [], now: Date.now(),
}, 240, theme)[0];

async function repo(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-footer-status-"));
  // Isolate user/system Git settings, signing, hooks and environment overrides.
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key];
  const gitRaw = (...args) => execFileSync("git", ["--no-optional-locks", ...args], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  const git = (...args) => gitRaw(...args).toString("utf8");
  const rawStatus = () => gitRaw("status", "--porcelain=v2", "--branch", "--ahead-behind", "--untracked-files=all", "-z");
  const status = () => mod.parseGitStatus(rawStatus());
  const file = (name, content = name) => writeFile(path.join(dir, name), content);
  const commit = (message) => { git("add", "--all"); git("commit", "-m", message); };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Footer test");
    git("config", "user.email", "footer@example.invalid");
    git("config", "core.hooksPath", os.devNull);
    git("config", "commit.gpgSign", "false");
    await run({ dir, git, gitRaw, rawStatus, status, file, commit });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function assertCounts(git, expected) {
  assert.equal(git.unavailable, undefined);
  for (const [key, value] of Object.entries(expected)) assert.equal(git[key], value, key);
}

test("real paused rebase with no changed filenames marks only the actual worktree operation", async () => {
  await repo(async ({ dir, git, file, commit }) => {
    await file("base", "base\n"); commit("base");
    const linked = path.join(dir, "linked");
    git("worktree", "add", "-b", "topic", linked);
    const run = (...args) => execFileSync("git", args, { cwd: linked, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
    // A real interactive edit stop keeps HEAD/index/worktree identical.
    run("-c", "user.name=Footer test", "-c", "user.email=footer@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "pause");
    execFileSync("git", ["rebase", "-i", "HEAD~1"], { cwd: linked,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull,
        GIT_SEQUENCE_EDITOR: "perl -pi -e 's/^pick /edit /'" } });
    const actual = run("rev-parse", "--absolute-git-dir").toString().trim();
    const common = path.resolve(linked, run("rev-parse", "--git-common-dir").toString().trim());
    assert.notEqual(actual, common);
    assert.equal(await mod.detectGitOperation(actual), true);
    assert.equal(await mod.detectGitOperation(common), false);
    const result = mod.parseGitStatus(run("status", "--porcelain=v2", "--branch", "-z"));
    assertCounts(result, { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
    const text = row({ ...result, operation: await mod.detectGitOperation(actual) });
    assert.ok(text.includes(`${result.branch} !`), text);
    assert.doesNotMatch(text, /\*/);
    run("rebase", "--abort");
    assert.equal(await mod.detectGitOperation(actual), false);
  });
});

test("operation metadata markers are detected without adding dirty paths", async () => {
  await repo(async ({ git }) => {
    const admin = git("rev-parse", "--absolute-git-dir").trim();
    for (const marker of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "BISECT_LOG"]) {
      const target = path.join(admin, marker);
      if (["rebase-merge", "rebase-apply", "sequencer"].includes(marker)) await mkdir(target);
      else await writeFile(target, "operation\n");
      assert.equal(await mod.detectGitOperation(admin), true, marker);
      await rm(target, { recursive: true });
      assert.equal(await mod.detectGitOperation(admin), false, marker);
    }
  });
});

test("real clean, unborn, no-upstream and detached states have minimal suffixes", async () => {
  await repo(async ({ git, status, file, commit }) => {
    assertCounts(status(), { branch: "main", changed: 0 });
    assert.match(row(status()), /main$/);
    await file("first\nfile", "base\n");
    assertCounts(status(), { changed: 1, untracked: 1 });
    assert.match(row(status()), /main \*/);
    commit("base");
    assert.match(row(status()), /main$/);
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    // The remote is deliberately inaccessible: measurements only use cached refs.
    git("config", "remote.origin.url", "/nonexistent/footer-test-remote");
    git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git("branch", "--set-upstream-to=origin/main", "main");
    assertCounts(status(), { upstream: "origin/main", changed: 0, ahead: 0, behind: 0 });
    assert.match(row(status()), /^ project · ⎇ main$/);
    assert.doesNotMatch(row(status()), /changed|conflicts|no upstream|[●✖↑↓]/);
    git("checkout", "--detach");
    const detached = `detached:${git("rev-parse", "--short=7", "HEAD").trim()}`;
    assertCounts(status(), { branch: detached, changed: 0 });
    assert.ok(row(status()).includes(detached));
    assert.doesNotMatch(row(status()), /no upstream/);
    await file("dirty-detached");
    assert.match(row(status()), /detached:[0-9a-f]{7} \*/);
    assert.doesNotMatch(row(status()), /no upstream/);
  });
});

test("real staged/unstaged overlap, newline paths, rename and individual untracked files count once", async () => {
  await repo(async ({ dir, git, status, file, commit }) => {
    await file("both\nphases", "base\n");
    await file("? rename\nsource", "rename me\n");
    await file(".gitignore", "ignored/\n");
    commit("base");
    await file("both\nphases", "staged\n");
    git("add", "--", "both\nphases");
    await file("both\nphases", "unstaged\n");
    git("mv", "--", "? rename\nsource", "renamed\nfile");
    await mkdir(path.join(dir, "nested/deep"), { recursive: true });
    await file("nested/one");
    await file("nested/deep/two\nfile");
    await mkdir(path.join(dir, "ignored"));
    await file("ignored/not-counted");
    assertCounts(status(), { changed: 4, staged: 2, unstaged: 1, untracked: 2, conflicts: 0 });
    assert.match(row(status()), /main \*/);
    assert.doesNotMatch(row(status()), /[●✖]|staged|untracked|conflicts/);
  });
});

test("real conflicts and renames contribute one path each to the changed count", async () => {
  await repo(async ({ git, status, file, commit }) => {
    await file("conflict\nfile", "base\n");
    await file("rename-source", "rename me\n");
    commit("base");
    git("checkout", "-b", "other");
    await file("conflict\nfile", "other\n");
    commit("other");
    git("checkout", "main");
    await file("conflict\nfile", "main\n");
    commit("main");
    assert.throws(() => git("merge", "other"));
    git("mv", "rename-source", "rename-destination");
    assertCounts(status(), { changed: 2, conflicts: 1, staged: 1, unstaged: 0, untracked: 0 });
    assert.match(row({ ...status(), worktree: true }), /main \* !/);
    assert.doesNotMatch(row(status()), /[●✖]/);
  });
});

test("real diverged history reports ahead/behind relative to cached upstream without fetching", async () => {
  await repo(async ({ git, status, file, commit }) => {
    await file("base"); commit("base");
    git("checkout", "-b", "upstream");
    await file("remote"); commit("remote");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("checkout", "main");
    await file("local"); commit("local");
    git("config", "remote.origin.url", "/nonexistent/footer-test-remote");
    git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git("branch", "--set-upstream-to=origin/main", "main");
    git("config", "status.aheadBehind", "false");
    assertCounts(status(), { changed: 0, ahead: 1, behind: 1 });
    assert.match(row(status()), /main ↑1 ↓1/);
    assert.doesNotMatch(row(status()), /changed|conflicts|no upstream/);
  });
});

// Encode headers as UTF-8, but never round-trip raw filename bytes through it.
const porcelain = (...records) => Buffer.concat(records.flatMap((record) => [
  Buffer.isBuffer(record) ? record : Buffer.from(record, "utf8"), Buffer.from("\0"),
]));
const pathRecord = (prefix, name) => Buffer.concat([Buffer.from(prefix, "ascii"), name]);
const invalidNames = [0xff, 0xfe].map((byte) => Buffer.concat([Buffer.from("invalid-"), Buffer.from([byte])]));

for (const kind of ["untracked", "tracked", "renamed"]) {
  test(`Buffer porcelain keeps FF and FE ${kind} filename identities distinct`, () => {
    const [ff, fe] = invalidNames;
    const records = kind === "untracked" ? [pathRecord("? ", ff), pathRecord("? ", fe)]
      : kind === "tracked" ? [
        pathRecord("1 MM N... 100644 100644 100644 aabbccd aabbccd ", ff),
        pathRecord("1 .M N... 100644 100644 100644 aabbccd aabbccd ", fe),
      ] : [
        pathRecord("2 RM N... 100644 100644 100644 aabbccd aabbccd R100 ", ff),
        pathRecord("? rename-source-", fe),
        pathRecord("2 R. N... 100644 100644 100644 aabbccd aabbccd R100 ", fe),
        pathRecord("? rename-source-", ff),
      ];
    // A lossy UTF-8 decode collapses these two names to the same replacement character.
    assert.equal(ff.toString("utf8"), fe.toString("utf8"));
    const result = mod.parseGitStatus(porcelain("# branch.oid aabbccddeeff", "# branch.head main", ...records));
    assertCounts(result, {
      branch: "main", changed: 2, conflicts: 0,
      staged: kind === "untracked" ? 0 : kind === "tracked" ? 1 : 2,
      unstaged: kind === "untracked" ? 0 : kind === "tracked" ? 2 : 1,
      untracked: kind === "untracked" ? 2 : 0,
      upstreamMissing: undefined,
    });
    assert.match(row(result), /main \*/);
  });
}

test("string and Buffer porcelain retain UTF-8 non-ASCII branch and upstream display names", () => {
  const branch = "feature/café-日本語";
  const upstream = `origin/${branch}`;
  const output = porcelain("# branch.oid aabbccddeeff", `# branch.head ${branch}`,
    `# branch.upstream ${upstream}`, "# branch.ab +2 -3", "? résumé-日本語");
  const results = [output.toString("utf8"), output].map((input) => mod.parseGitStatus(input));
  assert.deepEqual(results[1], results[0]);
  for (const result of results) {
    assertCounts(result, { branch, upstream, changed: 1, untracked: 1, ahead: 2, behind: 3, upstreamMissing: undefined });
    const text = row(result);
    assert.ok(text.includes(`${branch} * ↑2 ↓3`), text);
    assert.doesNotMatch(text, /no upstream|upstream missing|\uFFFD/);
  }
});

test("configured valid and unborn branches do not imply missing upstreams; detached states omit tracking labels", () => {
  const cases = [
    { oid: "aabbccddeeff", head: "main", upstream: "origin/main", ab: "+0 -0", branch: "main" },
    { oid: "(initial)", head: "main", upstream: "origin/main", branch: "main" },
    { oid: "aabbccddeeff", head: "(detached)", upstream: "origin/main", branch: "detached:aabbccd" },
    { oid: "aabbccddeeff", head: "(detached)", branch: "detached:aabbccd" },
  ];
  for (const fixture of cases) {
    const output = porcelain(`# branch.oid ${fixture.oid}`, `# branch.head ${fixture.head}`,
      ...(fixture.upstream ? [`# branch.upstream ${fixture.upstream}`] : []),
      ...(fixture.ab ? [`# branch.ab ${fixture.ab}`] : []));
    for (const input of [output.toString("utf8"), output]) {
      const result = mod.parseGitStatus(input);
      assertCounts(result, { branch: fixture.branch, changed: 0, ahead: 0, behind: 0, upstreamMissing: undefined });
      assert.ok(row(result).includes(fixture.branch));
      assert.doesNotMatch(row(result), /no upstream|upstream missing/);
      if (fixture.head === "(detached)") {
        // Detached display must ignore even an explicitly supplied missing-tracking flag.
        const text = row({ ...result, upstreamMissing: true });
        assert.ok(text.includes(fixture.branch));
        assert.doesNotMatch(text, /no upstream|upstream missing/);
      }
    }
  }
});

test("real configured unborn branch is not treated as a pruned upstream", async () => {
  await repo(async ({ git, rawStatus, file }) => {
    git("config", "remote.origin.url", "/nonexistent/footer-test-remote");
    git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git("config", "branch.main.remote", "origin");
    git("config", "branch.main.merge", "refs/heads/main");
    await file("unborn-file");
    const output = rawStatus();
    const records = output.toString("utf8").split("\0");
    assert.ok(records.includes("# branch.oid (initial)"));
    assert.ok(records.includes("# branch.upstream origin/main"));
    assert.ok(!records.some((record) => record.startsWith("# branch.ab ")));
    const result = mod.parseGitStatus(output);
    assertCounts(result, { branch: "main", upstream: "origin/main", changed: 1, untracked: 1, upstreamMissing: undefined });
    assert.match(row(result), /main \*/);
    assert.doesNotMatch(row(result), /no upstream|upstream missing|git unavailable/);
  });
});

test("real pruned tracking ref retains branch and counts and hides upstream missing in the compact suffix", async () => {
  await repo(async ({ git, rawStatus, status, file, commit }) => {
    await file("tracked", "base\n");
    commit("base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("config", "remote.origin.url", "/nonexistent/footer-test-remote");
    git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    git("branch", "--set-upstream-to=origin/main", "main");
    await file("tracked", "staged\n");
    git("add", "--", "tracked");
    await file("tracked", "unstaged\n");
    await file("untracked\nfile");
    const before = status();
    assertCounts(before, { branch: "main", upstream: "origin/main", changed: 2, staged: 1, unstaged: 1,
      untracked: 1, conflicts: 0, ahead: 0, behind: 0, upstreamMissing: undefined });
    assert.doesNotMatch(row(before), /no upstream|upstream missing/);
    // Simulate pruning the cached ref without contacting the inaccessible remote.
    git("update-ref", "-d", "refs/remotes/origin/main");
    const output = rawStatus();
    const records = output.toString("utf8").split("\0");
    assert.ok(records.includes("# branch.upstream origin/main"));
    assert.ok(!records.some((record) => record.startsWith("# branch.ab ")));
    assert.ok(records.some((record) => /^# branch\.oid [0-9a-f]{40,64}$/.test(record)));
    assert.ok(!records.includes("# branch.oid (initial)"));
    for (const input of [output, output.toString("utf8")]) {
      const result = mod.parseGitStatus(input);
      assert.deepEqual(result, { ...before, upstreamMissing: true });
      assert.match(row(result), /main \*/);
      assert.doesNotMatch(row(result), /no upstream|git unavailable/);
    }
  });
});

test.skipIf(process.platform !== "linux")("real Linux raw-byte filenames survive Buffer filesystem paths and Git output", async () => {
  await repo(async ({ dir, git, rawStatus, commit }) => {
    const rawPath = (prefix, byte) => Buffer.concat([Buffer.from(path.join(dir, prefix)), Buffer.from([byte])]);
    const files = [0xff, 0xfe].map((byte) => ({ byte,
      source: rawPath("source-", byte), destination: rawPath("renamed-", byte), untracked: rawPath("new-", byte),
    }));
    for (const entry of files) await writeFile(entry.source, `unique content ${entry.byte}\n`);
    const initial = rawStatus();
    assert.ok(Buffer.isBuffer(initial));
    assertCounts(mod.parseGitStatus(initial), { branch: "main", changed: 2, untracked: 2 });
    commit("raw filename base");
    for (const entry of files) await rename(entry.source, entry.destination);
    git("add", "--all");
    await writeFile(files[0].destination, "unstaged rename edit\n");
    for (const entry of files) await writeFile(entry.untracked, "untracked\n");
    const output = rawStatus();
    assert.ok(Buffer.isBuffer(output));
    for (const entry of files) {
      assert.ok(output.includes(Buffer.concat([Buffer.from("? new-"), Buffer.from([entry.byte]), Buffer.from("\0")])));
    }
    assert.equal(output.toString("latin1").split("\0").filter((record) => record.startsWith("2 ")).length, 2);
    const result = mod.parseGitStatus(output);
    assertCounts(result, { branch: "main", changed: 4, staged: 2, unstaged: 1, untracked: 2, conflicts: 0 });
    assert.match(row(result), /main \*/);
  });
});

test("missing, malformed or truncated porcelain is unavailable, never falsely clean", () => {
  for (const output of ["", "garbage\0", "# branch.head main\0", "# branch.oid (initial)\0",
    "# branch.oid aabbccd\0# branch.head main", "# branch.oid aabbccd\0# branch.head main\0unexpected\0",
    "# branch.oid aabbccd\0# branch.head main\0# branch.ab +1 -0\0",
    "# branch.oid aabbccd\0# branch.head main\0# branch.ab unknown\0",
    "# branch.oid aabbccd\0# branch.head main\0? \0",
    "# branch.oid aabbccd\0# branch.head main\0" + "2 R. N... 100644 100644 100644 aabbccd aabbccd R100 dest\0",
  ]) {
    assert.equal(mod.parseGitStatus(output).unavailable, true, JSON.stringify(output));
    const text = row({ ...mod.parseGitStatus(output), branch: "fallback", notRepository: true, changed: 3, conflicts: 1 });
    assert.match(text, /fallback \* !/);
    assert.doesNotMatch(text, /no upstream|changed|conflict/);
  }
  assert.match(row({}), /^ project · !$/);
});
