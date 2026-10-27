import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MainState } from "../src/main-state.ts";
import { HeadsUp } from "../src/headsup/headsup.ts";
import { NoteState } from "../src/headsup/note.ts";
import { HEADSUP_ROLE, headsUpRole } from "../src/headsup/prompt.ts";
import { fitPost, graphemes, MAX_POST_GRAPHEMES, parseHeadsUp, type HeadsUpNote } from "../src/headsup/protocol.ts";
import { noteMessages } from "../src/headsup/thread.ts";
import { ProfileStore } from "../src/quiz/profile.ts";
import { facetsOf, postToBluesky, type FetchFn } from "../src/share/bluesky.ts";
import { shareConfig, shareEnabled, shareSummary } from "../src/share/config.ts";
import { draftMarkdown, parseDraft, saveDraft, slugify } from "../src/share/draft.ts";
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

  it("carries the post into Sidebar's thread", () => {
    const note = parseHeadsUp({ text: SHARE })!;
    const body = (noteMessages(note, { api: "a", provider: "p", model: "m" }, 0)[1] as any).content[0].text;
    expect(body).toContain("**Heads up: something worth sharing.**");
    expect(body).toContain("> TIL you can splice");
  });
});

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
    expect(config).toEqual({ bluesky: { handle: "me.bsky.social", password: "app-pass", service: "https://pds.example" }, drafts: { dir: "/home/u/drafts" } });
    expect(shareSummary(config)).not.toContain("app-pass");
    expect(shareConfig({ PI_SIDEBAR_DRAFTS_DIR: "/d", PI_SIDEBAR_DRAFTS_COMMAND: "save" }).drafts).toEqual({ command: "save" });
    expect(shareConfig({ PI_SIDEBAR_SHARE: "0", PI_SIDEBAR_DRAFTS_DIR: "/d" })).toEqual({});
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
  const config = { handle: "me.bsky.social", password: "secret-pass", service: "https://bsky.social" };

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

  it("takes the title from the first heading and adds front matter", () => {
    const draft = parseDraft("```markdown\n# Splice Your Cache\n\nBody.\n```", note, "full")!;
    expect(draft).toEqual({ title: "Splice Your Cache", slug: "splice-your-cache", kind: "full", body: "# Splice Your Cache\n\nBody." });
    expect(parseDraft("  ", note, "full")).toBeUndefined();
    expect(parseDraft("no heading", note, "outline")!.title).toBe("Splicing a side request onto the main prompt cache");
    const md = draftMarkdown(draft, meta);
    expect(md).toMatch(/^---\ntitle: "Splice Your Cache"\ndate: 2026-10-22\nstatus: draft\nsource: "pi-plugins"\ntopic: "cache-splice"\ntags: \[blog-draft\]\n---\n\n# Splice/);
    expect(slugify("Ünïcode & Things!")).toBe("unicode-things");
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
  async function setup(replies: string[], env: NodeJS.ProcessEnv) {
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
      if (url.endsWith("createRecord")) posts.push(JSON.parse(init.body).record.text);
      const body = url.endsWith("createSession") ? { did: "did:plc:a", accessJwt: "j", handle: "me.bsky.social" } : { uri: "at://did:plc:a/app.bsky.feed.post/rk" };
      return { ok: true, status: 200, json: async () => body, text: async () => "" };
    };
    const written: unknown[] = [];
    const headsUp = new HeadsUp(pi as never, main, { deliver: () => false, askSidebar: () => true, draftWritten: (...args) => written.push(args) }, {
      knowledgeDir: path.join(dir, "k"), logFile: path.join(dir, "log"), run: async () => undefined, stream, now: () => now, env: { ...env, PI_SIDEBAR_DRAFTS_DIR: env.PI_SIDEBAR_DRAFTS_DIR ? path.join(dir, "drafts") : "" }, fetch,
    });
    const known = () => new ProfileStore(path.join(dir, "k"), "/repo").load().headsUp?.known.map((t) => t.id) ?? [];
    const settle = () => new Promise((r) => setTimeout(r, 10));
    return { headsUp, sent, notes, posts, written, dir, known, settle, edited: () => edited };
  }
  const BSKY = { PI_SIDEBAR_BLUESKY_HANDLE: "me.bsky.social", PI_SIDEBAR_BLUESKY_APP_PASSWORD: "pw" };

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
    expect(JSON.stringify(draftPayload)).toContain("section-by-section outline");
    expect(JSON.stringify(draftPayload)).toContain("sidebar-share-idea");
    expect(sent[1].options.maxTokens).toBe(3000);
    const files = readdirSync(path.join(dir, "drafts"));
    expect(files).toEqual(["1970-01-01-splice-your-cache-outline.md"]);
    expect(notes.at(-1)?.message).toMatch(/^Blog outline saved: .*splice-your-cache-outline\.md$/);
    expect(written).toHaveLength(1);
    expect(known()).toContain("cache-splice");
    expect(headsUp.note.showing).toBe(false);
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
