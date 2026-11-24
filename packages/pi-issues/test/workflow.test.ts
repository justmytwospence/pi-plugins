import { describe, expect, it } from "vitest";
import { parseConfig, resolveWorkflow } from "../src/workflow.ts";
import { fakeExec, repo, ROOT } from "./fake.ts";

const none = () => undefined;
const config = (text: string) => (path: string) => (path === `${ROOT}/.pi/issues.json` ? text : undefined);

describe("resolveWorkflow", () => {
  it("starts from GitHub's default branch and merges with rebase when allowed", async () => {
    const wf = await resolveWorkflow(fakeExec(repo({ defaultBranch: "main" })), "/repo/src", none);
    expect(wf).toEqual({ repo: "me/app", root: ROOT, defaultBranch: "main", base: "main", land: { kind: "merge", method: "rebase" } });
  });

  it("takes base, land and task from .pi/issues.json", async () => {
    const wf = await resolveWorkflow(fakeExec(repo()), ROOT, config('{"base":"next","land":"push","task":"Run e2e alone."}'));
    expect(wf.base).toBe("next");
    expect(wf.defaultBranch).toBe("dev");
    expect(wf.land).toEqual({ kind: "push" });
    expect(wf.task).toBe("Run e2e alone.");
  });

  it("picks the first allowed merge method: rebase, merge, squash", async () => {
    const only = (o: { rebase?: boolean; merge?: boolean; squash?: boolean }) =>
      resolveWorkflow(fakeExec(repo({ rebase: false, merge: false, squash: false, ...o })), ROOT, none);
    expect((await only({ merge: true, squash: true })).land).toEqual({ kind: "merge", method: "merge" });
    expect((await only({ squash: true })).land).toEqual({ kind: "merge", method: "squash" });
    await expect(only({})).rejects.toThrow("me/app allows no merge method; set land in .pi/issues.json");
  });

  it("reads the config of a worktree from its own checkout, and the root from the common dir", async () => {
    const exec = fakeExec(
      (line) => (line === "git rev-parse --show-toplevel" ? "/repo/.worktrees/x\n" : undefined),
      repo(),
    );
    const seen: string[] = [];
    const wf = await resolveWorkflow(exec, "/repo/.worktrees/x", (path) => (seen.push(path), undefined));
    expect(seen).toEqual(["/repo/.worktrees/x/.pi/issues.json"]);
    expect(wf.root).toBe(ROOT);
  });
});

describe("parseConfig", () => {
  it("accepts an empty object and ignores unknown keys", () => {
    expect(parseConfig('{"other": 1}', "f")).toEqual({});
  });

  it("names the file and field it rejects", () => {
    expect(() => parseConfig('{"land":"ff"}', "/r/.pi/issues.json")).toThrow('Invalid /r/.pi/issues.json: land must be "push" or "merge"');
    expect(() => parseConfig('{"base":""}', "/r/.pi/issues.json")).toThrow("Invalid /r/.pi/issues.json: base must be a non-empty string");
    expect(() => parseConfig("{", "/r/.pi/issues.json")).toThrow(/^Invalid \/r\/\.pi\/issues\.json: /);
    expect(() => parseConfig("[]", "/r/.pi/issues.json")).toThrow("must be a JSON object");
  });
});
