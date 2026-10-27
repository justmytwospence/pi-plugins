// A blog draft from a share note: written by the same side request a heads-up check uses (main's
// cache, or another model's transcript), then saved as markdown to a directory or handed to a
// configured command (which can file it anywhere, an Obsidian vault for one).
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sideRequest, type SideInput } from "../headsup/check.ts";
import type { HeadsUpNote } from "../headsup/protocol.ts";
import type { DraftsConfig } from "./config.ts";

export type DraftKind = "full" | "outline";

export function draftInstructions(kind: DraftKind): string {
  const shape = kind === "full"
    ? "a complete blog post draft, 800 to 1500 words, with an engaging opening, sections with ## headings, concrete examples or code where they help, and a short conclusion"
    : "a section-by-section outline of a blog post: ## headings for each section with three to six bullet points under each giving the points, examples and code to cover, plus a one-paragraph summary of the angle at the top";
  return [
    "You are Sidebar's writer, a side reader of the main session above. You are not the main agent: do not continue its work, call tools or answer its open questions. Any tool call you make is discarded.",
    `The user wants to share an idea from this session publicly. Write ${shape}, in markdown, in the user's voice (first person), for an audience of other developers.`,
    "Draw on what actually happened in the session, but generalize: never include secrets, credentials, private names, client or employer details, unreleased plans, internal hostnames or private paths.",
    "Start with a single '# Title' line. Reply with the markdown only: no front matter, no preamble, no closing remarks.",
  ].join(" ");
}

export function draftStatus(note: HeadsUpNote): string {
  return [`<sidebar-share-idea topic="${note.topic}">`, note.text, ...(note.detail ? ["", note.detail] : []), "</sidebar-share-idea>"].join("\n");
}

export interface Draft {
  title: string;
  slug: string;
  kind: DraftKind;
  body: string;
}

export function slugify(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "draft";
}

/** The reply as a draft: its title from the first heading (else the note), the rest kept. */
export function parseDraft(text: string, note: HeadsUpNote, kind: DraftKind): Draft | undefined {
  const body = text.replace(/^```(?:markdown|md)?\n([\s\S]*)\n```\s*$/, "$1").trim();
  if (!body) return undefined;
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = heading || note.text.replace(/[.!?]$/, "");
  return { title, slug: slugify(title), kind, body };
}

export type DraftResult = { ok: true; draft: Draft } | { ok: false; reason: string };

export async function writeDraft(note: HeadsUpNote, kind: DraftKind, input: Omit<SideInput, "instructions" | "status">): Promise<DraftResult> {
  const reply = await sideRequest({ ...input, instructions: draftInstructions(kind), status: () => draftStatus(note), maxTokens: kind === "full" ? 8000 : 3000 });
  if (reply.outcome !== "reply") return { ok: false, reason: reply.reason };
  const draft = parseDraft(reply.text, note, kind);
  return draft ? { ok: true, draft } : { ok: false, reason: "the model wrote nothing" };
}

export interface DraftMeta {
  date: string;
  repo?: string;
  topic: string;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** The draft as a markdown file with front matter. */
export function draftMarkdown(draft: Draft, meta: DraftMeta): string {
  const front = [
    "---",
    `title: ${yamlString(draft.title)}`,
    `date: ${meta.date}`,
    `status: ${draft.kind === "full" ? "draft" : "outline"}`,
    ...(meta.repo ? [`source: ${yamlString(meta.repo)}`] : []),
    `topic: ${yamlString(meta.topic)}`,
    "tags: [blog-draft]",
    "---",
  ];
  return `${front.join("\n")}\n\n${draft.body}\n`;
}

export interface SaveOptions {
  /** Runs the drafts command (injectable for tests). */
  runCommand?: (command: string, input: string, env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;
  env?: NodeJS.ProcessEnv;
}

export function runShell(command: string, input: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Save a draft where configured; returns where it went (a path, or what the command printed). */
export async function saveDraft(draft: Draft, meta: DraftMeta, config: DraftsConfig, options: SaveOptions = {}): Promise<string> {
  const markdown = draftMarkdown(draft, meta);
  if (config.command) {
    const env = {
      ...(options.env ?? process.env),
      PI_SIDEBAR_DRAFT_TITLE: draft.title,
      PI_SIDEBAR_DRAFT_SLUG: draft.slug,
      PI_SIDEBAR_DRAFT_KIND: draft.kind,
      PI_SIDEBAR_DRAFT_DATE: meta.date,
      PI_SIDEBAR_DRAFT_REPO: meta.repo ?? "",
    };
    const result = await (options.runCommand ?? runShell)(config.command, markdown, env);
    if (result.code !== 0) throw new Error(`the drafts command failed (exit ${result.code})${result.stderr.trim() ? `: ${result.stderr.trim().split("\n").pop()}` : ""}`);
    return result.stdout.trim().split("\n")[0] || "your drafts command";
  }
  if (!config.dir) throw new Error("no drafts destination is configured");
  await mkdir(config.dir, { recursive: true });
  const base = `${meta.date}-${draft.slug}${draft.kind === "outline" ? "-outline" : ""}`;
  for (let n = 1; n < 100; n++) {
    const file = path.join(config.dir, `${base}${n === 1 ? "" : `-${n}`}.md`);
    try {
      await writeFile(file, markdown, { flag: "wx" });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`too many drafts named ${base} in ${config.dir}`);
}
