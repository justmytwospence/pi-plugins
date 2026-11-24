import { describe, expect, it } from "vitest";
import { branchFromBody, slugify, suggestBranch } from "../src/branch.ts";
import type { Issue } from "../src/github.ts";

const issue = (o: Partial<Issue>): Issue => ({ id: "I", number: 1, title: "T", url: "u", body: "", open: true, linkedBranches: [], ...o });

describe("branchFromBody", () => {
  it("finds a branch the first lines name", () => {
    expect(branchFromBody("The plan gets a When.\n\nBranch `trip-day`, its own plan.")).toBe("trip-day");
    expect(branchFromBody("**Branch:** `watch-table` (with #52). **Milestone:** Watch.")).toBe("watch-table");
  });

  it("looks only at the first three non-empty lines", () => {
    expect(branchFromBody("one\ntwo\nthree\nfour\nBranch `late`")).toBeUndefined();
    expect(branchFromBody("No branch here, just `code`.")).toBeUndefined();
  });
});

describe("slugify", () => {
  it("keeps at most three words and 24 characters, without stopwords", () => {
    expect(slugify("Library panel: saved routes and activities with an overview", 76)).toBe("library-panel-saved");
    expect(slugify("Sign-in: a seamless emailed-code flow", 79)).toBe("sign-in-seamless");
  });

  it("falls back to issue-<n>", () => {
    expect(slugify("!!!", 5)).toBe("issue-5");
  });
});

describe("suggestBranch", () => {
  it("prefers a linked branch, then the body, then the title", () => {
    expect(suggestBranch(issue({ linkedBranches: ["linked"], body: "Branch `named`" }))).toBe("linked");
    expect(suggestBranch(issue({ body: "Branch `named`", title: "Some title" }))).toBe("named");
    expect(suggestBranch(issue({ title: "Some title" }))).toBe("some-title");
  });
});
