// Posting to Bluesky over the AT Protocol's XRPC endpoints: a session from the handle and an app
// password, then one app.bsky.feed.post record. Links and hashtags become rich-text facets so they
// render as links; nothing else is needed (no SDK). The session goes straight to the account's own
// PDS, resolved from the handle (DNS or HTTPS, then its DID document), so a self-hosted PDS works
// as a bsky.social one does, with no other server in between.
import { resolveTxt as dnsResolveTxt } from "node:dns/promises";
import { graphemes, MAX_POST_GRAPHEMES } from "../headsup/protocol.ts";
import type { BlueskyConfig } from "./config.ts";

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
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

export type ResolveTxt = (name: string) => Promise<string[][]>;

export interface ResolveOptions {
  fetch: FetchFn;
  resolveTxt?: ResolveTxt;
  signal?: AbortSignal;
}

async function getJson(fetchFn: FetchFn, url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetchFn(url, { method: "GET", headers: { accept: "application/json" }, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

/** A handle's DID: the _atproto DNS TXT record, else https://<handle>/.well-known/atproto-did. */
export async function resolveHandle(handle: string, options: ResolveOptions): Promise<string> {
  if (handle.startsWith("did:")) return handle;
  try {
    const records = await (options.resolveTxt ?? dnsResolveTxt)(`_atproto.${handle}`);
    for (const record of records) {
      const value = record.join("");
      if (value.startsWith("did=did:")) return value.slice("did=".length);
    }
  } catch { /* no record: try HTTPS */ }
  try {
    const response = await options.fetch(`https://${handle}/.well-known/atproto-did`, { method: "GET", headers: {}, ...(options.signal ? { signal: options.signal } : {}) });
    const text = response.ok ? (await response.text()).trim() : "";
    if (text.startsWith("did:")) return text.split(/\s/)[0]!;
  } catch { /* unreachable */ }
  throw new Error(`could not resolve the handle @${handle} (no _atproto DNS record or /.well-known/atproto-did)`);
}

/** The PDS in a DID's document (did:plc through the PLC directory, did:web from its host). */
export async function resolvePds(did: string, plc: string, options: ResolveOptions): Promise<string> {
  let url: string;
  if (did.startsWith("did:plc:")) url = `${plc}/${did}`;
  else if (did.startsWith("did:web:")) url = `https://${decodeURIComponent(did.slice("did:web:".length).split(":")[0]!)}/.well-known/did.json`;
  else throw new Error(`unsupported DID method: ${did}`);
  const doc = (await getJson(options.fetch, url, options.signal)) as { service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }> };
  const pds = doc.service?.find((s) => s.id?.endsWith("#atproto_pds") || s.type === "AtprotoPersonalDataServer")?.serviceEndpoint;
  if (typeof pds !== "string" || !/^https:\/\//.test(pds)) throw new Error(`${did} names no https PDS in its DID document`);
  return pds.replace(/\/+$/, "");
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
export async function postToBluesky(text: string, config: BlueskyConfig, options: { fetch?: FetchFn; resolveTxt?: ResolveTxt; now?: number; signal?: AbortSignal } = {}): Promise<Posted> {
  const body = text.trim();
  if (!body) throw new Error("the post is empty");
  const length = graphemes(body).length;
  if (length > MAX_POST_GRAPHEMES) throw new Error(`the post has ${length} characters; Bluesky allows ${MAX_POST_GRAPHEMES}`);
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as FetchFn);
  let service = config.service;
  if (!service) {
    const resolve: ResolveOptions = { fetch: fetchFn, ...(options.resolveTxt ? { resolveTxt: options.resolveTxt } : {}), ...(options.signal ? { signal: options.signal } : {}) };
    try {
      service = await resolvePds(await resolveHandle(config.handle, resolve), config.plc, resolve);
    } catch (error) {
      throw new Error(`Bluesky: could not find @${config.handle}'s PDS (${error instanceof Error ? error.message : String(error)}); set PI_SIDEBAR_BLUESKY_SERVICE`);
    }
  }
  let session: Record<string, unknown>;
  try {
    session = await call(fetchFn, `${service}/xrpc/com.atproto.server.createSession`, { identifier: config.handle, password: config.password }, undefined, options.signal);
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
    created = await call(fetchFn, `${service}/xrpc/com.atproto.repo.createRecord`, { repo: did, collection: "app.bsky.feed.post", record }, token, options.signal);
  } catch (error) {
    throw new Error(`Bluesky post failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const uri = typeof created.uri === "string" ? created.uri : "";
  const rkey = uri.split("/").pop() ?? "";
  return { uri, url: config.web ? `${config.web}/profile/${handle}/post/${rkey}` : uri };
}
