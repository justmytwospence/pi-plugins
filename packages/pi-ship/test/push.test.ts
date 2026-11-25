import { describe, expect, it } from "vitest";
import { githubRepo, isPushCommand, parsePushOutput } from "../src/push.ts";

const ff = (to: string) => `Enumerating objects: 5, done.\nTo ${to}\n   1111111..2222222  main -> main\n`;

describe("parsePushOutput", () => {
  it("reads a fast-forward", () => {
    expect(parsePushOutput(ff("git@github.com:o/r.git"))).toEqual([{ repo: "o/r", oldSha: "1111111", newSha: "2222222", branch: "main", forced: false }]);
  });
  it("reads a forced update, by + or by three dots", () => {
    expect(parsePushOutput("To git@github.com:o/r.git\n + 1111111...2222222 dev -> dev (forced update)\n")).toEqual([{ repo: "o/r", oldSha: "1111111", newSha: "2222222", branch: "dev", forced: true }]);
    expect(parsePushOutput("To git@github.com:o/r.git\n   1111111...2222222 dev -> dev\n")[0]?.forced).toBe(true);
  });
  it("reads a new branch, naming the local ref to resolve", () => {
    expect(parsePushOutput("To https://github.com/o/r\n * [new branch]      HEAD -> slug\n")).toEqual([{ repo: "o/r", newSha: "HEAD", branch: "slug", forced: false }]);
    expect(parsePushOutput("To https://github.com/o/r\n * [new branch]      a -> refs/heads/b\n")[0]?.branch).toBe("b");
  });
  it("ignores tags, deletions, rejections and up-to-date pushes", () => {
    const text = "To git@github.com:o/r.git\n * [new tag]         v1 -> v1\n - [deleted]         old\n ! [rejected]        main -> main (non-fast-forward)\nEverything up-to-date\n";
    expect(parsePushOutput(text)).toEqual([]);
  });
  it("accepts https and ssh URL forms and refuses other hosts", () => {
    for (const to of ["https://github.com/o/r.git", "https://user@github.com/o/r", "ssh://git@github.com/o/r.git", "git@github.com:o/r"]) expect(parsePushOutput(ff(to))[0]?.repo).toBe("o/r");
    expect(parsePushOutput(ff("git@gitlab.com:o/r.git"))).toEqual([]);
    expect(githubRepo("https://example.com/o/r")).toBeUndefined();
  });
  it("reads several refs of one push", () => {
    const text = "To git@github.com:o/r.git\n   1111111..2222222  a -> a\n   3333333..4444444  b -> b\n";
    expect(parsePushOutput(text).map((r) => r.branch)).toEqual(["a", "b"]);
  });
});

describe("isPushCommand", () => {
  it.each(["git push", "cd x && git -C y push origin main", "git -c core.x=1 push", "(git push)", "echo hi; git push --force-with-lease"])("%s", (c) => expect(isPushCommand(c)).toBe(true));
  it.each(["git pushd", "echo git push", "git status", "git log --grep push"])("not %s", (c) => expect(isPushCommand(c)).toBe(false));
});
