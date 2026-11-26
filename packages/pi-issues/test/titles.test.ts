import { describe, expect, it } from "vitest";
import piIssues from "../src/index.ts";
import { annotate, findRefs, ghTitles, type Ref, titledMessage, titleQuery } from "../src/titles.ts";
import { fakeExec } from "./fake.ts";

const TITLES: Record<string, string> = {
  "me/app#76": "Library panel",
  "me/app#81": "Retry login on 401",
  "other/lib#5": "Fix *bold* [link]",
};

/** gh repo view says me/app; GraphQL answers from TITLES (null for unknown numbers). */
function ghFake() {
  return fakeExec((line) => {
    if (line.startsWith("gh repo view")) return JSON.stringify({ nameWithOwner: "me/app" });
    if (!line.startsWith("gh api graphql")) return undefined;
    const data: Record<string, Record<string, { title: string } | null>> = {};
    for (const part of line.split(/(?=r\d+: repository\()/).slice(1)) {
      const r = /^(r\d+): repository\(owner:"([^"]+)",name:"([^"]+)"\)/.exec(part)!;
      const items: Record<string, { title: string } | null> = {};
      for (const n of part.matchAll(/n(\d+): issueOrPullRequest/g)) {
        const title = TITLES[`${r[2]}/${r[3]}#${n[1]}`];
        items[`n${n[1]}`] = title ? { title } : null;
      }
      data[r[1]!] = items;
    }
    const missing = Object.values(data).some((items) => Object.values(items).includes(null));
    return { stdout: JSON.stringify({ data }), code: missing ? 1 : 0 };
  });
}

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const textOf = (m: any) => m?.content?.[0]?.text;

async function titled(text: string, exec = ghFake()) {
  return textOf(await titledMessage(assistant(text), "/repo", ghTitles(exec)));
}

describe("findRefs", () => {
  it("finds bare, qualified and URL references", () => {
    const text = "See #76, other/lib#5 and https://github.com/me/app/pull/81.";
    expect(findRefs(text).map((r) => [r.repo, r.number, text.slice(r.start, r.end)])).toEqual([
      [undefined, 76, "#76"],
      ["other/lib", 5, "other/lib#5"],
      ["me/app", 81, "https://github.com/me/app/pull/81"],
    ]);
  });

  it("skips code, next tags, entities, fragments, link targets and words", () => {
    const text = [
      "`#1` &#38; page#2 a#3 #4x [x](https://github.com/me/app/issues/5)",
      "```",
      "#6",
      "```",
      "<next>start #7</next>",
    ].join("\n");
    expect(findRefs(text)).toEqual([]);
  });
});

describe("annotate", () => {
  const repoOf = (r: Ref) => r.repo ?? "me/app";
  const title = (k: string) => TITLES[k];

  it("titles the first mention only and escapes Markdown", () => {
    const text = "#76 then #76 and other/lib#5";
    expect(annotate(text, findRefs(text), repoOf, title)).toBe("#76 (Library panel) then #76 and other/lib#5 (Fix \\*bold\\* \\[link\\])");
  });

  it("leaves mentions whose title is already nearby", () => {
    for (const text of ["Library panel (#76)", "#76: Library panel", "#76 (library panel)"]) {
      expect(annotate(text, findRefs(text), repoOf, title)).toBe(text);
    }
  });
});

describe("titledMessage", () => {
  it("adds titles from one GraphQL query", async () => {
    const exec = ghFake();
    expect(await titled("Fixed #76 and #81; see other/lib#5.", exec)).toBe(
      "Fixed #76 (Library panel) and #81 (Retry login on 401); see other/lib#5 (Fix \\*bold\\* \\[link\\]).",
    );
    expect(exec.calls.filter((c) => c.startsWith("gh api graphql"))).toHaveLength(1);
  });

  it("leaves unknown numbers alone even when gh exits non-zero", async () => {
    expect(await titled("#76 and #999")).toBe("#76 (Library panel) and #999");
  });

  it("caches titles and misses for the session", async () => {
    const exec = ghFake();
    const source = ghTitles(exec);
    await titledMessage(assistant("#76 #999"), "/repo", source);
    await titledMessage(assistant("#76 #999"), "/repo", source);
    expect(exec.calls.filter((c) => c.startsWith("gh api graphql"))).toHaveLength(1);
    expect(exec.calls.filter((c) => c.startsWith("gh repo view"))).toHaveLength(1);
  });

  it("returns nothing without references, outside a GitHub repo, or when gh fails", async () => {
    const exec = ghFake();
    expect(await titledMessage(assistant("No refs here."), "/repo", ghTitles(exec))).toBeUndefined();
    expect(exec.calls).toEqual([]);
    expect(await titled("#76", fakeExec())).toBeUndefined();
    const failing = fakeExec((line) => (line.startsWith("gh repo view") ? JSON.stringify({ nameWithOwner: "me/app" }) : { code: 1, stdout: "" }));
    expect(await titled("#76", failing)).toBeUndefined();
  });

  it("touches only assistant text blocks", async () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "#76" },
        { type: "text", text: "#76" },
        { type: "toolCall", id: "t", name: "bash", arguments: { command: "gh issue view 76" } },
      ],
    };
    const out = (await titledMessage(message, "/repo", ghTitles(ghFake()))) as any;
    expect(out.content[0]).toBe(message.content[0]);
    expect(out.content[1].text).toBe("#76 (Library panel)");
    expect(out.content[2]).toBe(message.content[2]);
    expect(await titledMessage({ role: "user", content: [{ type: "text", text: "#76" }] }, "/repo", ghTitles(ghFake()))).toBeUndefined();
  });

  it("builds a query with quoted repository names", () => {
    expect(titleQuery(new Map([["me/app", [1, 2]]]))).toBe(
      'query{r0: repository(owner:"me",name:"app"){n1: issueOrPullRequest(number:1){... on Issue{title} ... on PullRequest{title}} n2: issueOrPullRequest(number:2){... on Issue{title} ... on PullRequest{title}}}}',
    );
  });
});

describe("message_end", () => {
  it("replaces the finished message with a titled one", async () => {
    const handlers = new Map<string, any>();
    const pi = { on: (name: string, h: any) => handlers.set(name, h), registerTool() {}, registerCommand() {} };
    piIssues(pi as any, { exec: ghFake() });
    const result = await handlers.get("message_end")({ message: assistant("Done: #81.") }, { cwd: "/repo" });
    expect(textOf(result.message)).toBe("Done: #81 (Retry login on 401).");
    expect(await handlers.get("message_end")({ message: assistant("Nothing.") }, { cwd: "/repo" })).toBeUndefined();
  });
});
