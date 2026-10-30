import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, test, vi } from "vitest";
import { planSlug, planTextTitle, planTitle, savePlanSnapshot } from "../src/plan-file.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: vi.fn(fs.openSync),
    closeSync: vi.fn(fs.closeSync),
    writeFileSync: vi.fn(fs.writeFileSync),
  };
});

const directories: string[] = [];
const temporaryDirectory = () => {
  const directory = mkdtempSync(join(tmpdir(), "plan-file-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const plan = (text: string) => {
  const file = join(temporaryDirectory(), "calm-river.md");
  writeFileSync(file, text);
  return file;
};

test("a plan is called by its first heading, never by its file name", () => {
  assert.equal(planTitle(plan("# Toy demo: `greet.mjs` CLI\n\n## Summary\n")), "Toy demo: greet.mjs CLI");
  assert.equal(planTitle(plan("# Plan: Exec mode UX\n")), "Exec mode UX");
  assert.equal(planTitle(plan("\nAdd a flag to the CLI.\n\n## Changes\n")), "Add a flag to the CLI.");
});

test("a long title is cut and a plan with no text is just the plan", () => {
  assert.equal(planTitle(plan(`# ${"word ".repeat(30)}`)).length, 60);
  assert.ok(planTitle(plan(`# ${"word ".repeat(30)}`)).endsWith("…"));
  assert.equal(planTitle(plan("")), "the plan");
  assert.equal(planTitle("/no/such/file.md"), "the plan");
});

test("text titles preserve display cleanup and use the full reviewed title by default", () => {
  for (const text of ["", "\n```md\n---\n# Plan: **Reviewed** `title`\n", "First line\n# Later heading", "# ***"]) {
    assert.equal(planTextTitle(text, 60), planTitle(plan(text)));
    assert.equal(planTextTitle(text, 12), planTitle(plan(text), 12));
  }
  const title = `${"a".repeat(70)} important ending`;
  assert.equal(planTextTitle(`# ${title}`), title);
  assert.equal(planSlug(planTextTitle(`# ${title}`)).length, 80);
});

test("slugs remove Markdown, decompose accents and retain only bounded ASCII words", () => {
  assert.equal(planSlug("# Plan: **Café** `CLI` & [résumé](https://example.com) ~~fix~~"), "cafe-cli-resume-fix");
  assert.equal(planSlug("  Hello... WORLD / version 2!  "), "hello-world-version-2");
  assert.equal(planSlug("Crème brûlée A\u030Angström ﬁ ＡＢＣ"), "creme-brulee-angstrom-fi-abc");
  for (const text of ["", "  ", "日本語", "🚀", "*** !!!"]) assert.equal(planSlug(text), "");
  assert.equal(planSlug("a".repeat(100)), "a".repeat(80));
  assert.equal(planSlug(`${"a".repeat(79)} more`), "a".repeat(79));
});

test("snapshots create private absolute files with exact trimmed text and preserve the draft", () => {
  const directory = temporaryDirectory();
  const draft = join(directory, "draft.md");
  const text = " \n# Reviewed plan\n\nKeep internal spacing.  \n ";
  writeFileSync(draft, text);
  const destination = join(directory, "nested", "plans");
  const file = savePlanSnapshot(destination, text, "  Café CLI.md  ");
  assert.equal(file, resolve(destination, "cafe-cli.md"));
  assert.equal(readFileSync(file, "utf8"), "# Reviewed plan\n\nKeep internal spacing.\n");
  assert.equal(readFileSync(draft, "utf8"), text);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(savePlanSnapshot(destination, "", "Empty.MD"), join(destination, "empty.md"));
  assert.equal(readFileSync(join(destination, "empty.md"), "utf8"), "\n");
  assert.equal(savePlanSnapshot(destination, "x", "one.md.md"), join(destination, "one-md.md"));
});

test("unsafe or unusable stems are refused before creating any directory", () => {
  const directory = join(temporaryDirectory(), "not-created");
  for (const name of [
    "",
    " ",
    ".",
    "..",
    ".md",
    "../escape",
    "/absolute",
    "a/b",
    "a\\b",
    "\0bad",
    "bad\n",
    "\tbad",
    "bad\u007f",
    "bad\u0085",
    "日本語",
    "!!!",
  ]) {
    assert.throws(() => savePlanSnapshot(directory, "plan", name), /Enter a descriptive plan name\./u, name);
  }
  assert.equal(existsSync(directory), false);
});

test("collisions include files, directories and symlinks without changing existing content", () => {
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "title.md"), "original");
  mkdirSync(join(directory, "title-2.md"));
  symlinkSync(join(directory, "title.md"), join(directory, "title-3.md"));
  assert.equal(savePlanSnapshot(directory, "new", "title"), join(directory, "title-4.md"));
  assert.equal(readFileSync(join(directory, "title.md"), "utf8"), "original");
});

test("exclusive open handles a candidate created concurrently", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const directory = temporaryDirectory();
  vi.mocked(openSync).mockImplementationOnce((path, flags, mode) => {
    fs.writeFileSync(path, "racing writer");
    return fs.openSync(path, flags, mode);
  });
  assert.equal(savePlanSnapshot(directory, "ours", "race"), join(directory, "race-2.md"));
  assert.equal(readFileSync(join(directory, "race.md"), "utf8"), "racing writer");
  assert.equal(readFileSync(join(directory, "race-2.md"), "utf8"), "ours\n");
  assert.ok(vi.mocked(openSync).mock.calls.every(([, flags, mode]) => flags === "wx" && mode === 0o600));
});

test("collision attempts stop at candidate 1000, which remains usable", () => {
  const directory = temporaryDirectory();
  for (let i = 1; i < 1000; i++) writeFileSync(join(directory, `full${i === 1 ? "" : `-${i}`}.md`), "old");
  assert.equal(savePlanSnapshot(directory, "last", "full"), join(directory, "full-1000.md"));
  assert.throws(() => savePlanSnapshot(directory, "overflow", "full"), /1000 candidates/u);
  assert.equal(existsSync(join(directory, "full-1001.md")), false);
  assert.equal(readFileSync(join(directory, "full-1000.md"), "utf8"), "last\n");
});

test("non-collision open failures propagate without retrying or touching existing files", () => {
  const directory = temporaryDirectory();
  const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
  writeFileSync(join(directory, "keep.md"), "keep");
  vi.mocked(openSync)
    .mockClear()
    .mockImplementationOnce(() => {
      throw error;
    });
  assert.throws(
    () => savePlanSnapshot(directory, "new", "keep"),
    (actual) => actual === error,
  );
  assert.equal(vi.mocked(openSync).mock.calls.length, 1);
  assert.equal(readFileSync(join(directory, "keep.md"), "utf8"), "keep");
  assert.equal(vi.mocked(closeSync).mock.calls.length, 0);
});

test("a successful write closes its descriptor", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  savePlanSnapshot(temporaryDirectory(), "plan", "closed");
  assert.equal(vi.mocked(closeSync).mock.calls.length, 1);
  const descriptor = vi.mocked(closeSync).mock.calls[0]?.[0];
  assert.throws(() => fs.fstatSync(descriptor as number), { code: "EBADF" });
});

test("directory creation errors propagate without opening a candidate", () => {
  const file = plan("not a directory");
  assert.throws(() => savePlanSnapshot(join(file, "child"), "plan", "name"), { code: "ENOTDIR" });
  assert.equal(vi.mocked(openSync).mock.calls.length, 0);
  assert.equal(readFileSync(file, "utf8"), "not a directory");
});

test("a partial write is closed and removed, leaving collisions and draft untouched", async () => {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const directory = temporaryDirectory();
  writeFileSync(join(directory, "draft.md"), "draft");
  writeFileSync(join(directory, "saved.md"), "existing");
  const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  let descriptor: number | undefined;
  vi.mocked(writeFileSync).mockImplementationOnce((file) => {
    descriptor = file as number;
    fs.writeFileSync(file, "partial");
    throw error;
  });
  assert.throws(
    () => savePlanSnapshot(directory, "full plan", "saved"),
    (actual) => actual === error,
  );
  assert.deepEqual(readdirSync(directory).sort(), ["draft.md", "saved.md"]);
  assert.equal(readFileSync(join(directory, "draft.md"), "utf8"), "draft");
  assert.equal(readFileSync(join(directory, "saved.md"), "utf8"), "existing");
  assert.ok(vi.mocked(closeSync).mock.calls.some(([fd]) => fd === descriptor));
  assert.throws(() => fs.fstatSync(descriptor as number), { code: "EBADF" });
});
