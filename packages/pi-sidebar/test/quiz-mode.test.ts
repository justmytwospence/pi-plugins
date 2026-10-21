import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { QUIZ_ENTRY, QuizMode, quizFromBranch } from "../src/quiz/mode.ts";

function repo() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "quiz-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return { root, git };
}

function touch(file: string, text: string, at: number) {
  writeFileSync(file, text);
  utimesSync(file, at / 1000, at / 1000);
}

const knowledge = () => mkdtempSync(path.join(tmpdir(), "quiz-knowledge-"));

describe("quiz mode", () => {
  it("measures changes from the commit it started at, and what is new since the last question", async () => {
    const { root, git } = repo();
    const mode = new QuizMode(knowledge());
    const entry = await mode.start(root);
    expect(entry).toMatchObject({ version: 1, on: true, base: git("rev-parse", "HEAD") });

    touch(path.join(root, "a.ts"), "export const a = 2;\n", 1_000_000);
    writeFileSync(path.join(root, "b.ts"), "new\n");
    await mode.prepare(root);
    expect(mode.status()).toContain("Changed since quiz mode started");
    expect(mode.status()).toMatch(/a\.ts, b\.ts/);
    expect(mode.status()).toContain("New since the last question: a.ts, b.ts");
    mode.sent();

    git("add", ".");
    git("commit", "-qm", "main's work");
    touch(path.join(root, "a.ts"), "export const a = 3;\n", 2_000_000);
    await mode.prepare(root);
    expect(mode.status()).toContain("New since the last question: a.ts");
    expect(mode.status()).not.toContain("New since the last question: a.ts, b.ts");
  });

  it("nudges once per change, and not about what a question already covered", async () => {
    const { root } = repo();
    const mode = new QuizMode(knowledge());
    await mode.start(root);
    touch(path.join(root, "a.ts"), "x\n", 1_000_000);
    expect(await mode.freshChanges(root)).toEqual(["a.ts"]);
    expect(await mode.freshChanges(root)).toEqual([]);
    touch(path.join(root, "a.ts"), "y\n", 2_000_000);
    await mode.prepare(root);
    mode.sent();
    expect(await mode.freshChanges(root)).toEqual([]);
  });

  it("records grades into the repository's profile", async () => {
    const { root } = repo();
    const mode = new QuizMode(knowledge(), undefined, () => 5_000);
    await mode.start(root);
    const reply = { role: "assistant", content: [{ type: "text", text: 'Right.\n<quiz-update>{"concept":"a-const","title":"a","result":"correct","difficulty":3}</quiz-update>' }] };
    expect(mode.record([{ role: "user", content: "it is 2" }, reply]).updates).toHaveLength(1);
    expect(mode.counts()).toMatchObject({ learning: 1 });
    expect((await mode.progress(root))[0]).toBe("1 concepts: 0 proven, 1 learning, 0 shaky, 0 due for review");
    expect(mode.record([{ role: "assistant", content: [{ type: "text", text: "<quiz-update>oops</quiz-update>" }] }])).toEqual({ updates: [], invalid: 1 });
  });

  it("adds nothing to requests while off", async () => {
    const mode = new QuizMode(knowledge());
    await mode.prepare("/nowhere");
    expect(mode.status()).toBe("");
    const { root } = repo();
    await mode.start(root);
    await mode.prepare(root);
    mode.stop();
    expect(mode.status()).toBe("");
  });

  it("follows the last setting on main's branch", async () => {
    const { root } = repo();
    const branch = [
      { type: "custom", customType: QUIZ_ENTRY, data: { version: 1, on: true, base: "abc", at: 1 } },
      { type: "custom", customType: "other", data: {} },
      { type: "custom", customType: QUIZ_ENTRY, data: { version: 1, on: false, at: 2 } },
    ];
    expect(quizFromBranch(branch)).toEqual({ version: 1, on: false, at: 2 });
    expect(quizFromBranch(branch.slice(0, 2))).toEqual({ version: 1, on: true, base: "abc", at: 1 });
    expect(quizFromBranch([])).toBeUndefined();
    const mode = new QuizMode(knowledge());
    await mode.restore(quizFromBranch(branch.slice(0, 1)), root);
    expect(mode.on).toBe(true);
    expect(mode.base).toBe("abc");
    await mode.restore(undefined, root);
    expect(mode.on).toBe(false);
  });
});
