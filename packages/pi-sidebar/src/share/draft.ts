// A blog draft from a share note: written by the same side request a heads-up check uses (main's
// cache, or another model's transcript), or, when an examples tool is configured, by Sidebar's own
// agent (which can call it), then saved as markdown to a directory or handed to a configured command
// (which can file it anywhere, an Obsidian vault for one).
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sideRequest, type SideInput } from "../headsup/check.ts";
import type { HeadsUpNote } from "../headsup/protocol.ts";
import type { DraftsConfig } from "./config.ts";

export type DraftKind = "full" | "outline";

const NOT_READY = "<draft-not-ready>one sentence why</draft-not-ready>";
const ALREADY_MADE = '<draft-not-ready>already made by "<title>" (<url>)</draft-not-ready>';
const EXAMPLES_OPEN = "<draft-examples>";
const EXAMPLES_CLOSE = "</draft-examples>";

const FULL_SHAPE = "a complete blog post draft of 700 to 1500 words";
const FULL_RULES = [
  "Open with the thesis, the tension or a surprising number within the first two sentences: never setup, never \"In this post\".",
  "Write an argument, not a tour of what happened or a list of topics.",
  "Use headings only as claims in sentence form, and none at all under about 1200 words.",
  "Every abstract point carries a concrete moment or number from the session.",
  "Concede the strongest objection to the argument.",
  "Write in the first person, plain, with no hype.",
  "End on a sharp implication, an honest open question or a direct request to the reader, never a recap.",
].join(" ");

const OUTLINE_SHAPE = "an outline of a blog post (not the post itself)";
const OUTLINE_RULES = [
  "Write, in this order: (1) the claim in one sentence; (2) the hook, written out as the actual opening of the post; (3) three to five beats, each stating what it argues and the specific evidence from the session that carries it; (4) the strongest objection and where the argument stops; (5) the ending, written out.",
  "No section-per-topic headings and no lists of facts.",
].join(" ");

/** How a draft looks up example pieces to model its form on, with the tool the user configured. */
function examplesRules(tool: string, args?: Record<string, unknown>): string {
  const extra = args && Object.keys(args).length ? `, plus exactly these other arguments: ${JSON.stringify(args)}` : "";
  return [
    `Before writing, call ${tool} (directly, or from a codemode script if it is only reachable there) with the idea's claim and angle as its text${extra}.`,
    "Read the pieces it returns only as models of form: how they open, how the argument moves, how long they are, how they use headings, how they end. Never copy their content or their wording.",
    `If the closest piece makes essentially the same point, judged from what it says (a similarity score or a "close" verdict is a hint, not proof either way), either take a clearly different angle that the session supports, or reply with exactly ${ALREADY_MADE} and nothing else.`,
    "Whatever you say while looking things up, your final message is the whole reply described below.",
    `After the markdown, end the reply with a block ${EXAMPLES_OPEN} containing one line per piece you actually used as a model, "- <title> | <url>", then ${EXAMPLES_CLOSE}. Leave the block out if you used none.`,
  ].join(" ");
}

export function draftInstructions(kind: DraftKind, style?: string, examplesTool?: string, examplesArgs?: Record<string, unknown>): string {
  return [
    examplesTool
      ? "You are Sidebar's writer, a side reader of the main session above. You are not the main agent: do not continue its work or answer its open questions, and call no tool except the examples lookup below."
      : "You are Sidebar's writer, a side reader of the main session above. You are not the main agent: do not continue its work, call tools or answer its open questions. Any tool call you make is discarded.",
    `The user wants to share an idea from this session publicly. Write ${kind === "full" ? FULL_SHAPE : OUTLINE_SHAPE}, in markdown, in the user's voice (first person), for readers who may use none of the tools involved.`,
    ...(examplesTool ? [examplesRules(examplesTool, examplesArgs)] : []),
    kind === "full" ? FULL_RULES : OUTLINE_RULES,
    "Draw on what actually happened in the session, but generalize: never include secrets, credentials, private names, client or employer details, unreleased plans, internal hostnames or private paths.",
    `Start with a single '# Title' line. Reply with the markdown only: no front matter, no preamble, no closing remarks${examplesTool ? ` (apart from the ${EXAMPLES_OPEN} block)` : ""}.`,
    `Exception: if the claim${kind === "full" ? "" : " or the beats"} cannot honestly be written from what happened in the session, do not pad or invent; reply with exactly ${NOT_READY} and nothing else.`,
    ...(style ? [`<share-style>\n${style}\n</share-style>`, "This style guide overrides the defaults above where they differ."] : []),
  ].join(" ");
}

export function draftStatus(note: HeadsUpNote): string {
  return [`<sidebar-share-idea topic="${note.topic}">`, note.text, ...(note.detail ? ["", note.detail] : []), "</sidebar-share-idea>"].join("\n");
}

/** A piece the draft took its form from. */
export interface DraftExample {
  title: string;
  url: string;
}

export interface Draft {
  title: string;
  slug: string;
  kind: DraftKind;
  body: string;
  /** Pieces the writer reported using as models of form, when it looked any up. */
  examples?: DraftExample[];
}

export function slugify(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "draft";
}

const EXAMPLES_BLOCK = /<draft-examples>([\s\S]*?)<\/draft-examples>/g;

/** `- <title> | <url>` lines of an examples block (the url follows the last separator). */
function parseExamples(blocks: readonly string[]): DraftExample[] {
  const examples: DraftExample[] = [];
  for (const line of blocks.flatMap((block) => block.split("\n"))) {
    const item = line.trim().replace(/^(?:[-*]|\d+[.)])\s+/, "");
    const cut = item.lastIndexOf(" | ");
    if (cut < 0) continue;
    const title = item.slice(0, cut).trim();
    const url = item.slice(cut + 3).trim();
    if (title && url) examples.push({ title, url });
  }
  return examples;
}

/** The reply as a draft: its title from the first heading (else the note), the rest kept. */
export function parseDraft(text: string, note: HeadsUpNote, kind: DraftKind): Draft | undefined {
  if (notReady(text) !== undefined) return undefined;
  const blocks = [...text.matchAll(EXAMPLES_BLOCK)].map((match) => match[1]!);
  const bare = text.replace(EXAMPLES_BLOCK, "").trim();
  const body = bare.replace(/^```(?:markdown|md)?\n([\s\S]*)\n```\s*$/, "$1").trim();
  if (!body) return undefined;
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const title = heading || note.text.replace(/[.!?]$/, "");
  const examples = parseExamples(blocks);
  return { title, slug: slugify(title), kind, body, ...(examples.length ? { examples } : {}) };
}

/** The reason the model gave for not writing a draft, or undefined when the reply is a draft. */
export function notReady(text: string): string | undefined {
  const match = /^\s*<draft-not-ready>([\s\S]*?)<\/draft-not-ready>\s*$/.exec(text);
  return match ? match[1]!.trim() || "no reason given" : undefined;
}

export type DraftResult = { ok: true; draft: Draft } | { ok: false; reason: string };

/** A model's reply as a draft, or why there is none (the idea is not ready, or nothing was written). */
export function draftFromReply(text: string, note: HeadsUpNote, kind: DraftKind): DraftResult {
  const why = notReady(text);
  if (why !== undefined) return { ok: false, reason: `the idea is not ready for a draft: ${why}` };
  const draft = parseDraft(text, note, kind);
  return draft ? { ok: true, draft } : { ok: false, reason: "the model wrote nothing" };
}

/** What Sidebar's own agent is asked when a draft runs through it: the writer's instructions and the idea. */
export function sidebarDraftPrompt(note: HeadsUpNote, kind: DraftKind, style: string | undefined, examplesTool: string, examplesArgs?: Record<string, unknown>): string {
  return `${draftInstructions(kind, style, examplesTool, examplesArgs)}\n\n${draftStatus(note)}`;
}

export async function writeDraft(note: HeadsUpNote, kind: DraftKind, input: Omit<SideInput, "instructions" | "status"> & { style?: string }): Promise<DraftResult> {
  const { style, ...side } = input;
  const reply = await sideRequest({ ...side, instructions: draftInstructions(kind, style), status: () => draftStatus(note), maxTokens: kind === "full" ? 8000 : 3000 });
  if (reply.outcome !== "reply") return { ok: false, reason: reply.reason };
  return draftFromReply(reply.text, note, kind);
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
    ...(draft.examples?.length ? ["examples:", ...draft.examples.map((example) => `  - ${yamlString(`${example.title} | ${example.url}`)}`)] : []),
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
