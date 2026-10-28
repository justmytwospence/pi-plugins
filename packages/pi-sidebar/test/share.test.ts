import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MainState } from "../src/main-state.ts";
import { HeadsUp, type HeadsUpHost } from "../src/headsup/headsup.ts";
import { NoteState } from "../src/headsup/note.ts";
import { HEADSUP_ROLE, headsUpRole } from "../src/headsup/prompt.ts";
import { fitPost, graphemes, MAX_POST_GRAPHEMES, parseHeadsUp, type HeadsUpNote } from "../src/headsup/protocol.ts";
import { noteMessages } from "../src/headsup/thread.ts";
import { ProfileStore } from "../src/quiz/profile.ts";
import { facetsOf, postToBluesky, type FetchFn } from "../src/share/bluesky.ts";
import { shareConfig, shareEnabled, shareSummary, STYLE_MAX_CHARS, TASTE_MAX_CHARS, type ShareConfig } from "../src/share/config.ts";
import { draftInstructions, draftMarkdown, notReady, parseDraft, saveDraft, slugify } from "../src/share/draft.ts";
import { FakePi, fakeCtx } from "./fake.ts";

const SHARE = '<headsup topic="Cache Splice" kind="share" format="both">Splicing a side request onto the main prompt cache.</headsup><headsup-detail>A neat trick: reuse the cached prefix.</headsup-detail><headsup-post>TIL you can splice a side request onto your agent\'s cached prompt and pay almost nothing for it.</headsup-post>';
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as never;

describe("share notes in the reply protocol", () => {
  it("reads a share note with its format and post", () => {
    expect(parseHeadsUp({ text: SHARE })).toEqual({
      topic: "cache-splice",
      kind: "share",
      format: "both",
      text: "Splicing a side request onto the main prompt cache.",
      detail: "A neat trick: reuse the cached prefix.",
      post: "TIL you can splice a side request onto your agent's cached prompt and pay almost nothing for it.",
    });
  });

  it("keeps line breaks in the post and fits it to Bluesky's limit", () => {
    expect(fitPost("one  \n\n\n\ntwo")).toBe("one\n\ntwo");
    const long = fitPost("é".repeat(400));
    expect(graphemes(long)).toHaveLength(MAX_POST_GRAPHEMES);
    expect(long.endsWith("…")).toBe(true);
    expect(graphemes("👍🏽ok")).toHaveLength(3);
  });

  it("defaults the format from whether there is a post", () => {
    expect(parseHeadsUp({ text: '<headsup kind="share">Idea</headsup>' })).toMatchObject({ format: "blog" });
    expect(parseHeadsUp({ text: '<headsup kind="share">Idea</headsup><headsup-post>Post</headsup-post>' })).toMatchObject({ format: "both", post: "Post" });
    expect(parseHeadsUp({ text: '<headsup kind="risk">Risk</headsup><headsup-post>ignored</headsup-post>' })).not.toHaveProperty("post");
  });

  it("only asks for share ideas when sharing is on", () => {
    expect(headsUpRole(false)).toBe(HEADSUP_ROLE);
    expect(headsUpRole(true)).toContain('kind="share"');
    expect(headsUpRole(true).startsWith(HEADSUP_ROLE)).toBe(true);
  });

  it("raises the default bar for share ideas and keeps the output contract", () => {
    const role = headsUpRole(true);
    expect(role).toContain("Default to not raising");
    expect(role).toContain("plumbing");
    expect(role).toContain("Never suggest sharing anything confidential");
    expect(role).toContain('format="post|blog|both"');
    expect(role).toContain("<headsup-post>");
    expect(role).toContain("at most 280 characters");
  });

  it("replaces the default bar with the taste guide, keeping confidentiality and the contract", () => {
    const role = headsUpRole(true, "Only counterintuitive numbers.");
    expect(role.startsWith(HEADSUP_ROLE)).toBe(true);
    expect(role).toContain("<share-taste>\nOnly counterintuitive numbers.\n</share-taste>");
    expect(role).toContain("strictly");
    expect(role).toContain('kind="share"');
    expect(role).toContain("<headsup-post>");
    expect(role).toContain("Never suggest sharing anything confidential");
    expect(role).not.toContain("Default to not raising");
    expect(headsUpRole(false, "ignored")).toBe(HEADSUP_ROLE);
  });

  it("carries the post into Sidebar's thread", () => {
    const note = parseHeadsUp({ text: SHARE })!;
    const body = (noteMessages(note, { api: "a", provider: "p", model: "m" }, 0)[1] as any).content[0].text;
    expect(body).toContain("**Heads up: something worth sharing.**");
    expect(body).toContain("> TIL you can splice");
  });
});

const BSKY_ENV = { PI_SIDEBAR_BLUESKY_HANDLE: "me.bsky.social", PI_SIDEBAR_BLUESKY_APP_PASSWORD: "pw" };

describe("share configuration", () => {
  it("is off until a destination is set", () => {
    expect(shareEnabled(shareConfig({}))).toBe(false);
    expect(shareSummary(shareConfig({}))).toMatch(/off/);
    expect(shareConfig({ PI_SIDEBAR_BLUESKY_HANDLE: "me.bsky.social" })).toEqual({});
  });

  it("reads Bluesky and drafts, a command winning over a directory", () => {
    const config = shareConfig({
      HOME: "/home/u",
      PI_SIDEBAR_BLUESKY_HANDLE: "@me.bsky.social",
      PI_SIDEBAR_BLUESKY_APP_PASSWORD: "app-pass",
      PI_SIDEBAR_BLUESKY_SERVICE: "https://pds.example/",
      PI_SIDEBAR_DRAFTS_DIR: "~/drafts",
    });
    expect(config).toEqual({ bluesky: { handle: "me.bsky.social", password: "app-pass", service: "https://pds.example", web: "https://bsky.app", plc: "https://plc.directory" }, drafts: { dir: "/home/u/drafts" } });
    expect(shareConfig({ PI_SIDEBAR_BLUESKY_HANDLE: "me.example", PI_SIDEBAR_BLUESKY_APP_PASSWORD: "p", PI_SIDEBAR_BLUESKY_WEB: "none" }).bluesky).toEqual({ handle: "me.example", password: "p", plc: "https://plc.directory" });
    expect(shareSummary(config)).not.toContain("app-pass");
    expect(shareConfig({ PI_SIDEBAR_DRAFTS_DIR: "/d", PI_SIDEBAR_DRAFTS_COMMAND: "save" }).drafts).toEqual({ command: "save" });
    expect(shareConfig({ PI_SIDEBAR_SHARE: "0", PI_SIDEBAR_DRAFTS_DIR: "/d" })).toEqual({});
  });

  it("reads the examples tool, trimmed, and names it in the summary only for drafts", () => {
    expect(shareConfig({ PI_SIDEBAR_SHARE_EXAMPLES_TOOL: "  mcp__server__similar  " })).toEqual({ examplesTool: "mcp__server__similar" });
    expect(shareConfig({ PI_SIDEBAR_SHARE_EXAMPLES_TOOL: "  " })).toEqual({});
    expect(shareConfig({ PI_SIDEBAR_SHARE: "0", PI_SIDEBAR_SHARE_EXAMPLES_TOOL: "t", PI_SIDEBAR_DRAFTS_DIR: "/d" })).toEqual({});
    const config = shareConfig({ PI_SIDEBAR_DRAFTS_DIR: "/d", PI_SIDEBAR_SHARE_EXAMPLES_TOOL: "mcp__server__similar" });
    expect(config).toEqual({ drafts: { dir: "/d" }, examplesTool: "mcp__server__similar" });
    expect(shareSummary(config)).toBe("Share notes are on: blog drafts in /d; drafts look up examples with mcp__server__similar.");
    expect(shareSummary(shareConfig({ PI_SIDEBAR_DRAFTS_DIR: "/d" }))).not.toContain("examples");
    expect(shareSummary({ ...shareConfig(BSKY_ENV), examplesTool: "t" })).not.toContain("examples"); // no drafts, no lookups
    expect(shareEnabled(shareConfig({ PI_SIDEBAR_SHARE_EXAMPLES_TOOL: "t" }))).toBe(false); // not a destination
  });

  const reader = (files: Record<string, string>) => (file: string) => {
    if (file in files) return files[file]!;
    throw Object.assign(new Error(`ENOENT: no such file, open '${file}'`), { code: "ENOENT" });
  };

  it("reads the taste and style guides, trimmed, with ~ expanded", () => {
    const seen: string[] = [];
    const read = (file: string) => { seen.push(file); return reader({ "/home/u/guides/taste.md": "  Numbers first.\n\n", "/abs/style.md": "Short sentences.\n" })(file); };
    const config = shareConfig({ HOME: "/home/u", PI_SIDEBAR_SHARE_TASTE: "~/guides/taste.md", PI_SIDEBAR_SHARE_STYLE: "/abs/style.md" }, read);
    expect(config).toEqual({ taste: "Numbers first.", style: "Short sentences." });
    expect(seen).toEqual(["/home/u/guides/taste.md", "/abs/style.md"]);
    expect(shareEnabled(config)).toBe(false); // guides alone do not turn sharing on
    expect(shareConfig({}, () => { throw new Error("not read"); })).toEqual({});
  });

  it("reports a missing or empty guide as a problem and uses none", () => {
    const config = shareConfig({ PI_SIDEBAR_SHARE_TASTE: "/x", PI_SIDEBAR_SHARE_STYLE: "/empty.md", PI_SIDEBAR_DRAFTS_DIR: "/d" }, reader({ "/empty.md": " \n" }));
    expect(config.taste).toBeUndefined();
    expect(config.style).toBeUndefined();
    expect(config.guideProblems).toEqual(["PI_SIDEBAR_SHARE_TASTE: cannot read /x: ENOENT", "PI_SIDEBAR_SHARE_STYLE: /empty.md is empty"]);
    expect(config.drafts).toEqual({ dir: "/d" });
  });

  it("cuts an over-long guide and says so", () => {
    const config = shareConfig(
      { PI_SIDEBAR_SHARE_TASTE: "/t", PI_SIDEBAR_SHARE_STYLE: "/s" },
      reader({ "/t": "t".repeat(TASTE_MAX_CHARS + 50), "/s": "s".repeat(STYLE_MAX_CHARS + 1) }),
    );
    expect(config.taste).toHaveLength(TASTE_MAX_CHARS);
    expect(config.style).toHaveLength(STYLE_MAX_CHARS);
    expect(config.guideProblems).toHaveLength(2);
    expect(config.guideProblems![0]).toMatch(/PI_SIDEBAR_SHARE_TASTE: \/t is 4050 characters; cut to the first 4000/);
    expect(config.guideProblems![1]).toMatch(/PI_SIDEBAR_SHARE_STYLE: .* cut to the first 12000/);
    expect(TASTE_MAX_CHARS).toBe(4000);
    expect(STYLE_MAX_CHARS).toBe(12000);
  });

  it("says which guides are in use and what is wrong with the others", () => {
    const config = shareConfig({ PI_SIDEBAR_DRAFTS_DIR: "/d", PI_SIDEBAR_SHARE_TASTE: "/t", PI_SIDEBAR_SHARE_STYLE: "/missing" }, reader({ "/t": "Taste." }));
    const summary = shareSummary(config);
    expect(summary).toContain("Share notes are on");
    expect(summary).toContain("Guides in use: your taste guide.");
    expect(summary).toContain("Guide problem: PI_SIDEBAR_SHARE_STYLE: cannot read /missing: ENOENT");
    expect(shareSummary(shareConfig({ PI_SIDEBAR_SHARE_STYLE: "/s" }, reader({ "/s": "Plain." })))).toMatch(/^Share notes are off.*your style guide/);
  });
});

describe("Bluesky", () => {
  it("makes link and tag facets with UTF-8 byte offsets", () => {
    const text = "Café 👍 see https://example.com/a. #pi #2024";
    const facets = facetsOf(text);
    const bytes = new TextEncoder().encode(text);
    const slice = (f: { index: { byteStart: number; byteEnd: number } }) => new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd));
    expect(facets.map(slice)).toEqual(["https://example.com/a", "#pi"]);
    expect(facets[0]!.features[0]).toEqual({ $type: "app.bsky.richtext.facet#link", uri: "https://example.com/a" });
    expect(facets[1]!.features[0]).toEqual({ $type: "app.bsky.richtext.facet#tag", tag: "pi" });
  });

  function fakeFetch(fail?: { at: number; status: number; body: unknown }) {
    const calls: Array<{ url: string; init: any }> = [];
    const fetch: FetchFn = async (url, init) => {
      calls.push({ url, init });
      const n = calls.length;
      if (fail && fail.at === n) return { ok: false, status: fail.status, json: async () => fail.body, text: async () => "" };
      const body = n === 1 ? { did: "did:plc:abc", accessJwt: "jwt", handle: "me.bsky.social" } : { uri: "at://did:plc:abc/app.bsky.feed.post/3kxyz", cid: "c" };
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };
    return { fetch, calls };
  }
  const config = { handle: "me.bsky.social", password: "secret-pass", service: "https://bsky.social", web: "https://bsky.app", plc: "https://plc.directory" };

  it("signs in, then creates a post record", async () => {
    const { fetch, calls } = fakeFetch();
    const posted = await postToBluesky("Hello https://x.dev", config, { fetch, now: 0 });
    expect(posted).toEqual({ uri: "at://did:plc:abc/app.bsky.feed.post/3kxyz", url: "https://bsky.app/profile/me.bsky.social/post/3kxyz" });
    expect(calls[0]!.url).toBe("https://bsky.social/xrpc/com.atproto.server.createSession");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ identifier: "me.bsky.social", password: "secret-pass" });
    expect(calls[1]!.url).toBe("https://bsky.social/xrpc/com.atproto.repo.createRecord");
    expect(calls[1]!.init.headers.authorization).toBe("Bearer jwt");
    const body = JSON.parse(calls[1]!.init.body);
    expect(body).toMatchObject({ repo: "did:plc:abc", collection: "app.bsky.feed.post", record: { $type: "app.bsky.feed.post", text: "Hello https://x.dev", createdAt: "1970-01-01T00:00:00.000Z" } });
    expect(body.record.facets).toHaveLength(1);
  });

  function pdsFetch(docs: Record<string, unknown>, wellKnown?: string) {
    const calls: string[] = [];
    const fetch: FetchFn = async (url) => {
      calls.push(url);
      if (url.endsWith("/.well-known/atproto-did")) return { ok: !!wellKnown, status: wellKnown ? 200 : 404, json: async () => ({}), text: async () => wellKnown ?? "" };
      if (url in docs) return { ok: true, status: 200, json: async () => docs[url], text: async () => "" };
      if (url.endsWith("createSession")) return { ok: true, status: 200, json: async () => ({ did: "did:plc:me", accessJwt: "j", handle: "bsky.me.example" }), text: async () => "" };
      if (url.endsWith("createRecord")) return { ok: true, status: 200, json: async () => ({ uri: "at://did:plc:me/app.bsky.feed.post/rk" }), text: async () => "" };
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    };
    return { fetch, calls };
  }
  const doc = (pds: string) => ({ id: "did:plc:me", service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }] });

  it("posts straight to a self-hosted PDS resolved from the handle's DNS record", async () => {
    const { fetch, calls } = pdsFetch({ "https://plc.directory/did:plc:me": doc("https://pds.me.example/") });
    const resolveTxt = async (name: string) => (name === "_atproto.bsky.me.example" ? [["did=did:plc:me"]] : []);
    const posted = await postToBluesky("hi", { handle: "bsky.me.example", password: "p", plc: "https://plc.directory" }, { fetch, resolveTxt });
    expect(calls).toEqual(["https://plc.directory/did:plc:me", "https://pds.me.example/xrpc/com.atproto.server.createSession", "https://pds.me.example/xrpc/com.atproto.repo.createRecord"]);
    expect(posted).toEqual({ uri: "at://did:plc:me/app.bsky.feed.post/rk", url: "at://did:plc:me/app.bsky.feed.post/rk" });
  });

  it("falls back to the handle's well-known DID, reads did:web documents, and refuses non-https PDSes", async () => {
    const noDns = async () => { throw new Error("ENOTFOUND"); };
    const web = pdsFetch({ "https://me.example/.well-known/did.json": doc("https://pds.me.example") }, "did:web:me.example\n");
    const posted = await postToBluesky("hi", { handle: "me.example", password: "p", plc: "https://plc.directory", web: "https://deck.example" }, { fetch: web.fetch, resolveTxt: noDns });
    expect(web.calls.slice(0, 3)).toEqual(["https://me.example/.well-known/atproto-did", "https://me.example/.well-known/did.json", "https://pds.me.example/xrpc/com.atproto.server.createSession"]);
    expect(posted.url).toBe("https://deck.example/profile/bsky.me.example/post/rk");
    const insecure = pdsFetch({ "https://plc.directory/did:plc:me": doc("http://pds.me.example") });
    await expect(postToBluesky("hi", { handle: "did:plc:me", password: "p", plc: "https://plc.directory" }, { fetch: insecure.fetch })).rejects.toThrow(/no https PDS.*PI_SIDEBAR_BLUESKY_SERVICE/);
    expect(insecure.calls.some((u) => u.includes("createSession"))).toBe(false);
    const unknown = pdsFetch({});
    await expect(postToBluesky("hi", { handle: "nobody.example", password: "p", plc: "https://plc.directory" }, { fetch: unknown.fetch, resolveTxt: noDns })).rejects.toThrow(/could not resolve the handle/);
  });

  it("reports failures without the password, and refuses empty or long posts", async () => {
    const { fetch } = fakeFetch({ at: 1, status: 401, body: { error: "AuthenticationRequired", message: "Invalid identifier or password" } });
    const error = await postToBluesky("hi", config, { fetch }).catch((e: Error) => e);
    expect(String(error)).toMatch(/sign-in as @me.bsky.social failed: AuthenticationRequired: Invalid identifier or password/);
    expect(String(error)).not.toContain("secret-pass");
    await expect(postToBluesky("  ", config, { fetch })).rejects.toThrow(/empty/);
    await expect(postToBluesky("x".repeat(301), config, { fetch })).rejects.toThrow(/301 characters/);
  });
});

describe("blog drafts", () => {
  const note = parseHeadsUp({ text: SHARE })!;
  const meta = { date: "2026-10-22", repo: "pi-plugins", topic: note.topic };

  it("writes the full draft as an argument and the outline as beats", () => {
    const full = draftInstructions("full");
    expect(full).toContain("700 to 1500 words");
    expect(full).toContain("first two sentences");
    expect(full).toContain("Concede the strongest objection");
    expect(full).toContain("Start with a single '# Title' line");
    expect(full).toContain("never include secrets");
    expect(full).toContain("<draft-not-ready>");
    expect(full).not.toContain("<share-style>");
    const outline = draftInstructions("outline");
    expect(outline).toContain("three to five beats");
    expect(outline).toContain("the claim in one sentence");
    expect(outline).toContain("No section-per-topic headings");
  });

  it("appends the style guide, which overrides the defaults", () => {
    for (const kind of ["full", "outline"] as const) {
      const text = draftInstructions(kind, "Never use semicolons.");
      expect(text).toContain("<share-style>\nNever use semicolons.\n</share-style>");
      expect(text).toContain("style guide overrides the defaults");
    }
  });

  it("keeps the instructions as they were without an examples tool", () => {
    for (const kind of ["full", "outline"] as const) {
      expect(draftInstructions(kind, undefined, undefined)).toBe(draftInstructions(kind));
      expect(draftInstructions(kind)).toContain("do not continue its work, call tools or answer its open questions. Any tool call you make is discarded.");
      expect(draftInstructions(kind)).toContain("Reply with the markdown only: no front matter, no preamble, no closing remarks.");
      expect(draftInstructions(kind)).not.toContain("draft-examples");
    }
  });

  it("passes configured extra arguments to the examples tool, and reports bad ones", () => {
    const text = draftInstructions("outline", undefined, "mcp__server__similar", { prefer: "archive", min_words: 600, exclude_domains: ["github.com"] });
    expect(text).toContain('with the idea\'s claim and angle as its text, plus exactly these other arguments: {"prefer":"archive","min_words":600,"exclude_domains":["github.com"]}.');
    const env = { PI_SIDEBAR_DRAFTS_DIR: "/d", PI_SIDEBAR_SHARE_EXAMPLES_TOOL: "t", PI_SIDEBAR_SHARE_EXAMPLES_ARGS: '{"k": 5}' };
    expect(shareConfig(env).examplesArgs).toEqual({ k: 5 });
    for (const bad of ["[1]", "nope", "3"]) {
      const config = shareConfig({ ...env, PI_SIDEBAR_SHARE_EXAMPLES_ARGS: bad });
      expect(config.examplesArgs).toBeUndefined();
      expect(config.guideProblems).toEqual(["PI_SIDEBAR_SHARE_EXAMPLES_ARGS: not a JSON object"]);
    }
  });

  it("tells the writer to look up examples with the configured tool, for form only", () => {
    const tool = "mcp__server__similar";
    for (const kind of ["full", "outline"] as const) {
      const text = draftInstructions(kind, "Never use semicolons.", tool);
      expect(text).toContain(`Before writing, call ${tool} (directly, or from a codemode script if it is only reachable there) with the idea's claim and angle as its text.`);
      expect(text).toContain("only as models of form: how they open, how the argument moves, how long they are, how they use headings, how they end. Never copy their content or their wording.");
      expect(text).toContain('reply with exactly <draft-not-ready>already made by "<title>" (<url>)</draft-not-ready> and nothing else');
      expect(text).toContain('judged from what it says (a similarity score or a "close" verdict is a hint, not proof either way)');
      expect(text).not.toContain("plus exactly these other arguments");
      expect(text).toContain('<draft-examples> containing one line per piece you actually used as a model, "- <title> | <url>", then </draft-examples>.');
      // The lookup comes before the form rules, and the existing rules stay.
      expect(text.indexOf("Before writing")).toBeLessThan(text.indexOf(kind === "full" ? "Open with the thesis" : "three to five beats"));
      expect(text).toContain("Start with a single '# Title' line. Reply with the markdown only: no front matter, no preamble, no closing remarks (apart from the <draft-examples> block).");
      expect(text).toContain("never include secrets");
      expect(text).toContain(`reply with exactly ${"<draft-not-ready>one sentence why</draft-not-ready>"} and nothing else`);
      expect(text).toContain("<share-style>\nNever use semicolons.\n</share-style>");
      expect(text).not.toContain("Any tool call you make is discarded");
      expect(text).toContain("call no tool except the examples lookup below");
    }
  });

  it("reads the not-ready reply as a refusal, never a draft", () => {
    const reply = "<draft-not-ready>No evidence in the session.</draft-not-ready>";
    expect(parseDraft(reply, note, "full")).toBeUndefined();
    expect(notReady(reply)).toBe("No evidence in the session.");
    expect(notReady("# Title\n\nBody")).toBeUndefined();
  });

  it("takes the title from the first heading and adds front matter", () => {
    const draft = parseDraft("```markdown\n# Splice Your Cache\n\nBody.\n```", note, "full")!;
    expect(draft).toEqual({ title: "Splice Your Cache", slug: "splice-your-cache", kind: "full", body: "# Splice Your Cache\n\nBody." });
    expect(parseDraft("  ", note, "full")).toBeUndefined();
    expect(parseDraft("no heading", note, "outline")!.title).toBe("Splicing a side request onto the main prompt cache");
    const md = draftMarkdown(draft, meta);
    expect(md).toMatch(/^---\ntitle: "Splice Your Cache"\ndate: 2026-10-22\nstatus: draft\nsource: "pi-plugins"\ntopic: "cache-splice"\ntags: \[blog-draft\]\n---\n\n# Splice/);
    expect(slugify("Ünïcode & Things!")).toBe("unicode-things");
  });

  it("strips the examples block from the draft and reads the pieces the writer used", () => {
    const reply = [
      "# Splice Your Cache",
      "",
      "Body | with a pipe.",
      "",
      "<draft-examples>",
      "- How caching bit us | https://example.com/a",
      "- Costs | and tradeoffs | https://example.com/b?x=1",
      "* A starred line | https://example.com/c",
      "not a piece",
      "- no url |",
      "</draft-examples>",
    ].join("\n");
    const draft = parseDraft(reply, note, "full")!;
    expect(draft.body).toBe("# Splice Your Cache\n\nBody | with a pipe.");
    expect(draft.examples).toEqual([
      { title: "How caching bit us", url: "https://example.com/a" },
      { title: "Costs | and tradeoffs", url: "https://example.com/b?x=1" },
      { title: "A starred line", url: "https://example.com/c" },
    ]);
    const md = draftMarkdown(draft, meta);
    expect(md).toContain('topic: "cache-splice"\nexamples:\n  - "How caching bit us | https://example.com/a"\n  - "Costs | and tradeoffs | https://example.com/b?x=1"\n  - "A starred line | https://example.com/c"\ntags: [blog-draft]\n---\n\n# Splice Your Cache');
    expect(md).not.toContain("draft-examples");
    // A fenced draft followed by the block, and the block inside the fence, both parse.
    for (const fenced of ["```markdown\n# T\n\nBody\n```\n\n<draft-examples>\n- A | https://a.example\n</draft-examples>", "```markdown\n# T\n\nBody\n\n<draft-examples>\n- A | https://a.example\n</draft-examples>\n```"]) {
      expect(parseDraft(fenced, note, "outline")).toMatchObject({ title: "T", body: "# T\n\nBody", examples: [{ title: "A", url: "https://a.example" }] });
    }
  });

  it("leaves the examples out when there are none", () => {
    expect("examples" in parseDraft("# T\n\nBody", note, "full")!).toBe(false);
    const empty = parseDraft("# T\n\nBody\n\n<draft-examples>\n</draft-examples>", note, "full")!;
    expect(empty.body).toBe("# T\n\nBody");
    expect("examples" in empty).toBe(false);
    expect(draftMarkdown(empty, meta)).not.toContain("examples:");
    expect(parseDraft("<draft-examples>\n- A | https://a.example\n</draft-examples>", note, "full")).toBeUndefined();
  });

  it("reads the already-made reply as not ready", () => {
    const reply = '<draft-not-ready>already made by "Old Post" (https://example.com/old)</draft-not-ready>';
    expect(notReady(reply)).toBe('already made by "Old Post" (https://example.com/old)');
    expect(parseDraft(reply, note, "full")).toBeUndefined();
  });

  it("saves to a directory without overwriting", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "drafts-")), "nested");
    const draft = parseDraft("# Title\n\nBody", note, "outline")!;
    const first = await saveDraft(draft, meta, { dir });
    const second = await saveDraft(draft, meta, { dir });
    expect(path.basename(first)).toBe("2026-10-22-title-outline.md");
    expect(path.basename(second)).toBe("2026-10-22-title-outline-2.md");
    expect(readdirSync(dir)).toHaveLength(2);
    expect(readFileSync(first, "utf8")).toContain("status: outline");
  });

  it("hands the markdown to a command with the draft's details", async () => {
    const draft = parseDraft("# Title\n\nBody", note, "full")!;
    let seen: { command: string; input: string; env: NodeJS.ProcessEnv } | undefined;
    const runCommand = async (command: string, input: string, env: NodeJS.ProcessEnv) => {
      seen = { command, input, env };
      return { code: 0, stdout: "Blog Drafts/2026-10-22 - title.md\n", stderr: "" };
    };
    expect(await saveDraft(draft, meta, { command: "save-it" }, { runCommand, env: {} })).toBe("Blog Drafts/2026-10-22 - title.md");
    expect(seen!.command).toBe("save-it");
    expect(seen!.input).toContain("# Title");
    expect(seen!.env).toMatchObject({ PI_SIDEBAR_DRAFT_TITLE: "Title", PI_SIDEBAR_DRAFT_SLUG: "title", PI_SIDEBAR_DRAFT_KIND: "full", PI_SIDEBAR_DRAFT_REPO: "pi-plugins" });
    const failing = async () => ({ code: 2, stdout: "", stderr: "no vault\n" });
    await expect(saveDraft(draft, meta, { command: "x" }, { runCommand: failing, env: {} })).rejects.toThrow(/exit 2\): no vault/);
  });

  it("runs a real shell command with the markdown on stdin", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "drafts-cmd-"));
    const draft = parseDraft("# Title\n\nBody", note, "full")!;
    const out = await saveDraft(draft, meta, { command: `f="${dir}/$PI_SIDEBAR_DRAFT_SLUG.md"; cat > "$f"; echo "$f"` });
    expect(out).toBe(`${dir}/title.md`);
    expect(readFileSync(out, "utf8")).toContain("# Title");
  });
});

describe("a share note above main's editor", () => {
  const note: HeadsUpNote = parseHeadsUp({ text: SHARE })!;

  it("offers only configured destinations", () => {
    const state = new NoteState();
    state.show(note, { bluesky: false, drafts: false });
    expect(state.action("1")).toBeUndefined();
    expect(state.action("4")).toEqual({ type: "known", via: "declined" });
    expect(state.lines(120, theme).at(-1)).toBe("   4: Not interested   0: Dismiss");
    state.show(note, { bluesky: true, drafts: true });
    expect(state.lines(120, theme).at(-1)).toBe("   1: Review post   2: Blog draft   3: Blog outline   4: Not interested   0: Dismiss");
    expect(state.action("3")).toEqual({ type: "draft", kind: "outline" });
    state.show({ ...note, post: undefined }, { bluesky: true, drafts: false });
    expect(state.action("1")).toBeUndefined();
  });

  it("reviews the post with a count, then goes back or discards", () => {
    const state = new NoteState();
    state.show(note, { bluesky: true, drafts: false });
    state.apply({ type: "review-post" }, 0);
    expect(state.phase).toBe("post");
    const lines = state.lines(60, theme);
    expect(lines.some((l) => l.includes("│ TIL you can splice"))).toBe(true);
    expect(lines.at(-2)).toBe(`   ${graphemes(note.post!).length}/300`);
    expect(lines.at(-1)).toBe("   1: Post to Bluesky   2: Edit   3: Back   0: Discard");
    for (const width of [20, 40]) for (const line of state.lines(width, theme)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(state.action("1")).toEqual({ type: "publish" });
    state.apply({ type: "back" }, 0);
    expect(state.phase).toBe("note");
    state.apply({ type: "review-post" }, 0);
    state.apply({ type: "known", via: "declined" }, 0);
    expect(state.showing).toBe(false);
  });

  it("takes no keys while busy", () => {
    const state = new NoteState();
    state.show(note, { bluesky: true, drafts: true });
    state.setBusy("Posting to Bluesky…");
    expect(state.action("1")).toBeUndefined();
    expect(state.lines(80, theme).at(-1)).toBe("   Posting to Bluesky…");
  });
});

const PROMPT = "You are an expert coding assistant operating inside pi.";
function mainPayload() {
  return {
    model: "claude-x",
    max_tokens: 32000,
    system: [{ type: "text", text: PROMPT, cache_control: { type: "ephemeral" } }],
    tools: [{ name: "read" }],
    messages: [{ role: "user", content: [{ type: "text", text: "do it", cache_control: { type: "ephemeral" } }] }],
  };
}

function stubStream(replies: string[]) {
  const sent: any[] = [];
  const stream = (_model: unknown, context: any, options: any) => ({
    result: async () => {
      const side = { model: "claude-x", max_tokens: 32000, system: "own", messages: context.messages.map((m: any) => ({ role: m.role, content: m.content.map((b: any) => ({ ...b })) })) };
      sent.push({ payload: await options.onPayload(side), options });
      return { role: "assistant", content: [{ type: "text", text: replies.shift() ?? "<headsup-none/>" }], usage: { input: 300, output: 40, cacheRead: 20_000, cacheWrite: 0 }, stopReason: "stop" };
    },
  });
  return { stream, sent };
}

describe("HeadsUp with sharing", () => {
  async function setup(replies: string[], env: NodeJS.ProcessEnv, share?: ShareConfig, host: Partial<HeadsUpHost> = {}) {
    const now = 1000;
    const pi = new FakePi();
    const main = new MainState(pi as never, () => now);
    const { ctx, notes } = fakeCtx({ systemPrompt: PROMPT });
    await pi.emit("session_start", { reason: "startup" }, ctx);
    await pi.emit("before_provider_request", { payload: mainPayload() }, ctx);
    await pi.emit("message_end", { message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 20_000, cacheWrite: 0 } } }, ctx);
    let edited: string | undefined;
    (ctx.ui as any).setWidget = () => {};
    (ctx.ui as any).editor = async (_title: string, prefill: string) => { edited = prefill; return "My own words."; };
    const dir = mkdtempSync(path.join(tmpdir(), "share-"));
    const { stream, sent } = stubStream(replies);
    const posts: string[] = [];
    const fetch: FetchFn = async (url, init) => {
      if (url.endsWith("createRecord")) posts.push(JSON.parse(init.body!).record.text);
      const body = url.endsWith("createSession") ? { did: "did:plc:a", accessJwt: "j", handle: "me.bsky.social" } : { uri: "at://did:plc:a/app.bsky.feed.post/rk" };
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };
    const written: unknown[] = [];
    const headsUp = new HeadsUp(pi as never, main, { deliver: () => false, askSidebar: () => true, draftWritten: (...args) => written.push(args), ...host }, {
      knowledgeDir: path.join(dir, "k"), logFile: path.join(dir, "log"), run: async () => undefined, stream, now: () => now, env: { ...env, PI_SIDEBAR_DRAFTS_DIR: env.PI_SIDEBAR_DRAFTS_DIR ? path.join(dir, "drafts") : "" }, fetch,
      ...(share ? { share } : {}),
    });
    const known = () => new ProfileStore(path.join(dir, "k"), "/repo").load().headsUp?.known.map((t) => t.id) ?? [];
    const settle = () => new Promise((r) => setTimeout(r, 10));
    return { headsUp, sent, notes, posts, written, dir, known, settle, edited: () => edited };
  }
  const BSKY = { PI_SIDEBAR_BLUESKY_HANDLE: "me.bsky.social", PI_SIDEBAR_BLUESKY_APP_PASSWORD: "pw", PI_SIDEBAR_BLUESKY_SERVICE: "https://bsky.social" };

  it("drops share notes and leaves the prompt alone when sharing is off", async () => {
    const { headsUp, sent } = await setup([SHARE], {});
    expect(await headsUp.check("turn")).toMatchObject({ outcome: "none" });
    expect(headsUp.note.showing).toBe(false);
    expect(JSON.stringify(sent[0].payload)).not.toContain('kind=\\"share\\"');
    expect(headsUp.summary()).toContain("Share notes are off");
  });

  it("reviews, edits and posts to Bluesky, then remembers the topic", async () => {
    const { headsUp, sent, notes, posts, known, settle, edited } = await setup([SHARE], BSKY);
    await headsUp.check("turn");
    expect(JSON.stringify(sent[0].payload)).toContain('kind=\\"share\\"');
    expect(headsUp.summary()).toContain("Bluesky as @me.bsky.social");
    expect(headsUp.note.note?.kind).toBe("share");
    expect(headsUp.handleKey("2", true)).toBe(false); // no drafts configured
    expect(headsUp.handleKey("1", true)).toBe(true);
    expect(headsUp.note.phase).toBe("post");
    headsUp.handleKey("2", true);
    await settle();
    expect(edited()).toContain("TIL you can splice");
    expect(headsUp.note.post).toBe("My own words.");
    headsUp.handleKey("1", true);
    await settle();
    expect(posts).toEqual(["My own words."]);
    expect(notes.at(-1)).toEqual({ message: "Posted to Bluesky: https://bsky.app/profile/me.bsky.social/post/rk", level: "info" });
    expect(headsUp.note.showing).toBe(false);
    expect(known()).toContain("cache-splice");
  });

  it("keeps the post to retry when posting fails", async () => {
    const { headsUp, notes, settle } = await setup([SHARE], BSKY);
    await headsUp.check("turn");
    (headsUp as any).options.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: "Down" }), text: async () => "" });
    headsUp.handleKey("1", true);
    headsUp.handleKey("1", true);
    await settle();
    expect(notes.at(-1)?.level).toBe("error");
    expect(headsUp.note.phase).toBe("post");
  });

  it("writes a blog outline through main's cache and saves it", async () => {
    const { headsUp, sent, notes, written, dir, known, settle } = await setup([SHARE, "# Splice Your Cache\n\n## Why\n- cost"], { PI_SIDEBAR_DRAFTS_DIR: "set" });
    await headsUp.check("turn");
    expect(headsUp.handleKey("1", true)).toBe(false); // no Bluesky
    headsUp.handleKey("3", true);
    expect(headsUp.note.phase).toBe("busy");
    await settle();
    const draftPayload = sent[1].payload;
    expect(draftPayload.messages[0]).toEqual(mainPayload().messages[0]);
    expect(JSON.stringify(draftPayload)).toContain("the strongest objection");
    expect(JSON.stringify(draftPayload)).toContain("sidebar-share-idea");
    expect(sent[1].options.maxTokens).toBe(3000);
    const files = readdirSync(path.join(dir, "drafts"));
    expect(files).toEqual(["1970-01-01-splice-your-cache-outline.md"]);
    expect(notes.at(-1)?.message).toMatch(/^Blog outline saved: .*splice-your-cache-outline\.md$/);
    expect(written).toHaveLength(1);
    expect(known()).toContain("cache-splice");
    expect(headsUp.note.showing).toBe(false);
  });

  it("sends the taste guide in the check and the style guide in the draft", async () => {
    const bsky = shareConfig(BSKY);
    const share = { ...bsky, drafts: { dir: path.join(mkdtempSync(path.join(tmpdir(), "share-guides-")), "drafts") }, taste: "Only counterintuitive numbers.", style: "Never use semicolons." };
    const { headsUp, sent, settle } = await setup([SHARE, "# Title\n\nBody"], { PI_SIDEBAR_DRAFTS_DIR: "set" }, share);
    await headsUp.check("turn");
    const check = JSON.stringify(sent[0].payload);
    expect(check).toContain("<share-taste>");
    expect(check).toContain("Only counterintuitive numbers.");
    expect(check).toContain('kind=\\"share\\"');
    expect(check).not.toContain("Default to not raising");
    headsUp.handleKey("2", true);
    await settle();
    expect(JSON.stringify(sent[1].payload)).toContain("Never use semicolons.");
  });

  it("does not save a draft the model says is not ready", async () => {
    const { headsUp, notes, written, dir, known, settle } = await setup([SHARE, "<draft-not-ready>The session shows no measurement.</draft-not-ready>"], { PI_SIDEBAR_DRAFTS_DIR: "set" });
    await headsUp.check("turn");
    headsUp.handleKey("2", true);
    await settle();
    expect(notes.at(-1)?.level).toBe("error");
    expect(notes.at(-1)?.message).toContain("the idea is not ready for a draft: The session shows no measurement.");
    expect(written).toHaveLength(0);
    expect(existsSync(path.join(dir, "drafts"))).toBe(false);
    expect(known()).not.toContain("cache-splice");
  });

  describe("with an examples tool", () => {
    const TOOL = "mcp__server__similar";
    const REPLY = "# Splice Your Cache\n\nBody.\n\n<draft-examples>\n- How caching bit us | https://example.com/a\n</draft-examples>";
    const examplesShare = () => ({ drafts: { dir: path.join(mkdtempSync(path.join(tmpdir(), "share-examples-")), "drafts") }, examplesTool: TOOL });
    const draftsOf = (share: { drafts: { dir: string } }) => readdirSync(share.drafts.dir);

    it("writes the draft through Sidebar's agent and files it with its examples", async () => {
      const share = examplesShare();
      const asked: Array<{ prompt: string; label: string }> = [];
      const saved: unknown[] = [];
      const host = { writeWithSidebar: async (prompt: string, label: string) => { asked.push({ prompt, label }); return REPLY; }, draftSaved: (outcome: unknown) => saved.push(outcome) };
      const { headsUp, sent, notes, written, known, settle } = await setup([SHARE], {}, share, host);
      await headsUp.check("turn");
      expect(headsUp.summary()).toContain(`drafts look up examples with ${TOOL}`);
      expect(headsUp.handleKey("2", true)).toBe(true);
      await settle();
      expect(sent).toHaveLength(1); // the check only: no side request for the draft
      expect(asked).toHaveLength(1);
      expect(asked[0]!.label).toBe("Writing a blog draft: Splicing a side request onto the main prompt cache.");
      expect(asked[0]!.prompt).toContain(`Before writing, call ${TOOL}`);
      expect(asked[0]!.prompt).toContain('<sidebar-share-idea topic="cache-splice">\nSplicing a side request onto the main prompt cache.\n\nA neat trick: reuse the cached prefix.\n</sidebar-share-idea>');
      expect(asked[0]!.prompt.startsWith(draftInstructions("full", undefined, TOOL))).toBe(true);
      const [file] = draftsOf(share);
      expect(file).toBe("1970-01-01-splice-your-cache.md");
      const markdown = readFileSync(path.join(share.drafts.dir, file!), "utf8");
      expect(markdown).toContain('examples:\n  - "How caching bit us | https://example.com/a"\n');
      expect(markdown).not.toContain("draft-examples");
      expect(notes.at(-1)?.message).toMatch(/^Blog draft saved: .*splice-your-cache\.md$/);
      expect(saved).toEqual([{ location: path.join(share.drafts.dir, file!) }]);
      expect(written).toHaveLength(0); // the exchange is already in Sidebar's thread
      expect(known()).toContain("cache-splice");
      expect(headsUp.note.showing).toBe(false);
    });

    it("puts the style guide and the outline's shape into the Sidebar prompt", async () => {
      const share = { ...examplesShare(), style: "Never use semicolons." };
      const asked: string[] = [];
      const { headsUp } = await setup([], {}, share, { writeWithSidebar: async (prompt) => { asked.push(prompt); return "# Outline\n\n- beat"; } });
      await headsUp.draft(parseHeadsUp({ text: SHARE })!, "outline");
      expect(asked[0]).toContain("three to five beats");
      expect(asked[0]).toContain("<share-style>\nNever use semicolons.\n</share-style>");
      expect(draftsOf(share)).toEqual(["1970-01-01-outline-outline.md"]);
    });

    it("falls back to the side request when the host cannot write with Sidebar", async () => {
      const share = examplesShare();
      const { headsUp, sent, written } = await setup(["# Title\n\nBody"], {}, share);
      await headsUp.draft(parseHeadsUp({ text: SHARE })!, "full");
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0].payload)).toContain("Any tool call you make is discarded");
      expect(JSON.stringify(sent[0].payload)).not.toContain(TOOL);
      expect(written).toHaveLength(1);
      expect(draftsOf(share)).toHaveLength(1);
    });

    it("uses the side request when no examples tool is set, even when the host could write with Sidebar", async () => {
      const share = { drafts: examplesShare().drafts };
      let asked = 0;
      const { headsUp, sent, written } = await setup(["# Title\n\nBody"], {}, share, { writeWithSidebar: async () => { asked++; return REPLY; }, draftSaved: () => { asked++; } });
      await headsUp.draft(parseHeadsUp({ text: SHARE })!, "full");
      expect(asked).toBe(0);
      expect(sent).toHaveLength(1);
      expect(written).toHaveLength(1);
    });

    it("saves nothing when Sidebar finds the idea already made", async () => {
      const share = examplesShare();
      const saved: unknown[] = [];
      const reply = '<draft-not-ready>already made by "Old Post" (https://example.com/old)</draft-not-ready>';
      const { headsUp, notes, written, known, settle } = await setup([SHARE], {}, share, { writeWithSidebar: async () => reply, draftSaved: (outcome) => saved.push(outcome) });
      await headsUp.check("turn");
      headsUp.handleKey("2", true);
      await settle();
      const message = 'the draft was not written: the idea is not ready for a draft: already made by "Old Post" (https://example.com/old)';
      expect(notes.at(-1)).toEqual({ message, level: "error" });
      expect(saved).toEqual([{ error: message }]);
      expect(written).toHaveLength(0);
      expect(existsSync(share.drafts.dir)).toBe(false);
      expect(known()).not.toContain("cache-splice");
      expect(headsUp.note.phase).toBe("note"); // back to where it was, to retry or discard
    });

    it("saves nothing when Sidebar writes nothing", async () => {
      const share = examplesShare();
      const { headsUp } = await setup([], {}, share, { writeWithSidebar: async () => "  " });
      await expect(headsUp.draft(parseHeadsUp({ text: SHARE })!, "full")).rejects.toThrow("the draft was not written: the model wrote nothing");
      expect(existsSync(share.drafts.dir)).toBe(false);
    });

    it("reports Sidebar's refusal as it is, without a line in its thread", async () => {
      const share = examplesShare();
      const saved: unknown[] = [];
      const { headsUp, written } = await setup([], {}, share, {
        writeWithSidebar: async () => { throw new Error("Sidebar is answering; try the draft again when it is done"); },
        draftSaved: (outcome) => saved.push(outcome),
      });
      await expect(headsUp.draft(parseHeadsUp({ text: SHARE })!, "full")).rejects.toThrow("Sidebar is answering; try the draft again when it is done");
      expect(saved).toEqual([]);
      expect(written).toHaveLength(0);
      expect(existsSync(share.drafts.dir)).toBe(false);
    });

    it("tells Sidebar's thread when saving fails", async () => {
      const share = { ...examplesShare(), drafts: { command: "save-it" } };
      const saved: Array<{ error?: string; location?: string }> = [];
      const { headsUp } = await setup([], {}, share, { writeWithSidebar: async () => REPLY, draftSaved: (outcome) => saved.push(outcome) });
      (headsUp as any).options.save = { runCommand: async () => ({ code: 2, stdout: "", stderr: "no vault\n" }), env: {} };
      await expect(headsUp.draft(parseHeadsUp({ text: SHARE })!, "full")).rejects.toThrow(/exit 2\): no vault/);
      expect(saved).toHaveLength(1);
      expect(saved[0]!.error).toMatch(/exit 2\): no vault/);
    });
  });

  it("marks a share idea the user is not interested in as known", async () => {
    const { headsUp, known, settle } = await setup([SHARE], BSKY);
    await headsUp.check("turn");
    headsUp.handleKey("4", true);
    await settle();
    expect(known()).toContain("cache-splice");
    expect(headsUp.lastShare?.topic).toBe("cache-splice");
  });
});
