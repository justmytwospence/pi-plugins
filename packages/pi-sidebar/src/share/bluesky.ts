// Posting to Bluesky over the AT Protocol's XRPC endpoints: a session from the handle and an app
// password, then one app.bsky.feed.post record. Links and hashtags become rich-text facets so they
// render as links; nothing else is needed (no SDK).
import { graphemes, MAX_POST_GRAPHEMES } from "../headsup/protocol.ts";
import type { BlueskyConfig } from "./config.ts";

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: "app.bsky.richtext.facet#link"; uri: string } | { $type: "app.bsky.richtext.facet#tag"; tag: string }>;
}

const LINK = /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;
const TAG = /(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_-]*)/gu;

function byteOffset(text: string, index: number): number {
  return new TextEncoder().encode(text.slice(0, index)).length;
}

/** Link and hashtag facets, with the UTF-8 byte ranges Bluesky expects. */
export function facetsOf(text: string): Facet[] {
  const facets: Facet[] = [];
  for (const match of text.matchAll(LINK)) {
    const start = match.index ?? 0;
    facets.push({ index: { byteStart: byteOffset(text, start), byteEnd: byteOffset(text, start + match[0].length) }, features: [{ $type: "app.bsky.richtext.facet#link", uri: match[0] }] });
  }
  for (const match of text.matchAll(TAG)) {
    const tag = match[2] ?? "";
    if (/^\d+$/.test(tag)) continue;
    const start = (match.index ?? 0) + (match[1] ?? "").length;
    facets.push({ index: { byteStart: byteOffset(text, start), byteEnd: byteOffset(text, start + 1 + tag.length) }, features: [{ $type: "app.bsky.richtext.facet#tag", tag }] });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

export interface Posted {
  uri: string;
  url: string;
}

async function call(fetchFn: FetchFn, url: string, body: unknown, token: string | undefined, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    let reason = `HTTP ${response.status}`;
    try {
      const error = (await response.json()) as { error?: string; message?: string };
      reason = [error.error, error.message].filter(Boolean).join(": ") || reason;
    } catch { /* keep the status */ }
    throw new Error(reason);
  }
  return (await response.json()) as Record<string, unknown>;
}

/** Publish `text` as a post on the configured account; returns its at:// URI and web URL. */
export async function postToBluesky(text: string, config: BlueskyConfig, options: { fetch?: FetchFn; now?: number; signal?: AbortSignal } = {}): Promise<Posted> {
  const body = text.trim();
  if (!body) throw new Error("the post is empty");
  const length = graphemes(body).length;
  if (length > MAX_POST_GRAPHEMES) throw new Error(`the post has ${length} characters; Bluesky allows ${MAX_POST_GRAPHEMES}`);
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchFn);
  let session: Record<string, unknown>;
  try {
    session = await call(fetchFn, `${config.service}/xrpc/com.atproto.server.createSession`, { identifier: config.handle, password: config.password }, undefined, options.signal);
  } catch (error) {
    throw new Error(`Bluesky sign-in as @${config.handle} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const did = typeof session.did === "string" ? session.did : undefined;
  const token = typeof session.accessJwt === "string" ? session.accessJwt : undefined;
  const handle = typeof session.handle === "string" ? session.handle : config.handle;
  if (!did || !token) throw new Error("Bluesky sign-in returned no session");
  const facets = facetsOf(body);
  const record = {
    $type: "app.bsky.feed.post",
    text: body,
    createdAt: new Date(options.now ?? Date.now()).toISOString(),
    ...(facets.length ? { facets } : {}),
  };
  let created: Record<string, unknown>;
  try {
    created = await call(fetchFn, `${config.service}/xrpc/com.atproto.repo.createRecord`, { repo: did, collection: "app.bsky.feed.post", record }, token, options.signal);
  } catch (error) {
    throw new Error(`Bluesky post failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const uri = typeof created.uri === "string" ? created.uri : "";
  const rkey = uri.split("/").pop() ?? "";
  return { uri, url: `https://bsky.app/profile/${handle}/post/${rkey}` };
}
