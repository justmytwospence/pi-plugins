// Where share notes can go, from environment variables read where main starts. Nothing is set by
// default, so share notes stay off until a destination is configured.
import { readFileSync } from "node:fs";

/** `0` (or `off`) keeps share notes off even with a destination configured. */
export const SHARE_ENV = "PI_SIDEBAR_SHARE";
export const BLUESKY_HANDLE_ENV = "PI_SIDEBAR_BLUESKY_HANDLE";
export const BLUESKY_PASSWORD_ENV = "PI_SIDEBAR_BLUESKY_APP_PASSWORD";
/** The account's PDS. By default it is resolved from the handle (works for bsky.social and self-hosted). */
export const BLUESKY_SERVICE_ENV = "PI_SIDEBAR_BLUESKY_SERVICE";
/** The web app post links point at (default https://bsky.app); `none` reports the at:// URI. */
export const BLUESKY_WEB_ENV = "PI_SIDEBAR_BLUESKY_WEB";
/** The did:plc directory used to resolve the PDS (default https://plc.directory). */
export const BLUESKY_PLC_ENV = "PI_SIDEBAR_BLUESKY_PLC";
/** A directory blog drafts are written to as markdown files. */
export const DRAFTS_DIR_ENV = "PI_SIDEBAR_DRAFTS_DIR";
/** A shell command that saves a blog draft (markdown on stdin); overrides the directory. */
export const DRAFTS_COMMAND_ENV = "PI_SIDEBAR_DRAFTS_COMMAND";

/** A markdown file saying what is worth sharing (replaces the default bar for raising ideas). */
export const SHARE_TASTE_ENV = "PI_SIDEBAR_SHARE_TASTE";
/** A markdown file saying how pieces are written (overrides the default draft style). */
export const SHARE_STYLE_ENV = "PI_SIDEBAR_SHARE_STYLE";
/**
 * The name of a read-only tool (an MCP tool, say) that finds exemplar pieces for a text. When set,
 * blog drafts run through Sidebar's own agent, which can call tools, instead of a tool-less side request.
 */
export const SHARE_EXAMPLES_TOOL_ENV = "PI_SIDEBAR_SHARE_EXAMPLES_TOOL";
/** A JSON object of extra arguments for that tool (filters, tiers, result count). */
export const SHARE_EXAMPLES_ARGS_ENV = "PI_SIDEBAR_SHARE_EXAMPLES_ARGS";
/** Longest guide kept, in characters; the rest is cut. */
export const TASTE_MAX_CHARS = 4000;
export const STYLE_MAX_CHARS = 12000;

export const DEFAULT_BLUESKY_WEB = "https://bsky.app";
export const DEFAULT_PLC = "https://plc.directory";

export interface BlueskyConfig {
  /** A handle or a DID. */
  handle: string;
  password: string;
  /** The PDS; resolved from the handle when not set. */
  service?: string;
  /** Post links' web app, or undefined for at:// URIs. */
  web?: string;
  plc: string;
}

export interface DraftsConfig {
  dir?: string;
  command?: string;
}

export interface ShareConfig {
  bluesky?: BlueskyConfig;
  drafts?: DraftsConfig;
  /** The taste guide's text: what is worth sharing. */
  taste?: string;
  /** The style guide's text: how pieces are written. */
  style?: string;
  /** A tool drafts call to find example pieces to model their form on. */
  examplesTool?: string;
  /** Extra arguments the examples tool is called with. */
  examplesArgs?: Record<string, unknown>;
  /** Guides that could not be used in full, one line each. */
  guideProblems?: string[];
}

/** Reads a file as UTF-8 text (injectable for tests). */
export type ReadFile = (file: string) => string;
const readUtf8: ReadFile = (file) => readFileSync(file, "utf8");

function expandHome(value: string, home: string | undefined): string {
  return home && (value === "~" || value.startsWith("~/")) ? `${home}${value.slice(1)}` : value;
}

function loadGuide(name: string, max: number, env: NodeJS.ProcessEnv, readFile: ReadFile): { text?: string; problem?: string } {
  const raw = env[name]?.trim();
  if (!raw) return {};
  const file = expandHome(raw, env.HOME);
  let text: string;
  try {
    text = readFile(file).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: `${name}: cannot read ${file}: ${code ?? (error instanceof Error ? error.message : String(error))}` };
  }
  if (!text) return { problem: `${name}: ${file} is empty` };
  if (text.length > max) return { text: text.slice(0, max).trimEnd(), problem: `${name}: ${file} is ${text.length} characters; cut to the first ${max}` };
  return { text };
}

function parseExamplesArgs(raw: string | undefined): { value?: Record<string, unknown>; problem?: string } {
  const text = raw?.trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) return { value: value as Record<string, unknown> };
  } catch { /* reported below */ }
  return { problem: `${SHARE_EXAMPLES_ARGS_ENV}: not a JSON object` };
}

export function shareConfig(env: NodeJS.ProcessEnv = process.env, readFile: ReadFile = readUtf8): ShareConfig {
  const off = env[SHARE_ENV]?.trim().toLowerCase();
  if (off === "0" || off === "off" || off === "false" || off === "no") return {};
  const config: ShareConfig = {};
  const handle = env[BLUESKY_HANDLE_ENV]?.trim().replace(/^@/, "");
  const password = env[BLUESKY_PASSWORD_ENV]?.trim();
  if (handle && password) {
    const url = (value: string | undefined) => value?.trim().replace(/\/+$/, "") || undefined;
    const service = url(env[BLUESKY_SERVICE_ENV]);
    const webRaw = env[BLUESKY_WEB_ENV]?.trim();
    const web = webRaw?.toLowerCase() === "none" ? undefined : url(webRaw) ?? DEFAULT_BLUESKY_WEB;
    config.bluesky = { handle, password, ...(service ? { service } : {}), ...(web ? { web } : {}), plc: url(env[BLUESKY_PLC_ENV]) ?? DEFAULT_PLC };
  }
  const command = env[DRAFTS_COMMAND_ENV]?.trim();
  const dir = env[DRAFTS_DIR_ENV]?.trim();
  if (command) config.drafts = { command };
  else if (dir) config.drafts = { dir: expandHome(dir, env.HOME) };
  const taste = loadGuide(SHARE_TASTE_ENV, TASTE_MAX_CHARS, env, readFile);
  const style = loadGuide(SHARE_STYLE_ENV, STYLE_MAX_CHARS, env, readFile);
  if (taste.text) config.taste = taste.text;
  if (style.text) config.style = style.text;
  const examplesTool = env[SHARE_EXAMPLES_TOOL_ENV]?.trim();
  if (examplesTool) config.examplesTool = examplesTool;
  const args = parseExamplesArgs(env[SHARE_EXAMPLES_ARGS_ENV]);
  if (args.value) config.examplesArgs = args.value;
  const problems = [taste.problem, style.problem, args.problem].filter((p): p is string => !!p);
  if (problems.length) config.guideProblems = problems;
  return config;
}

/** Whether any share destination is configured (share notes are only asked for then). */
export function shareEnabled(config: ShareConfig): boolean {
  return !!(config.bluesky || config.drafts);
}

/** One line for `/sidebar headsup`. */
export function shareSummary(config: ShareConfig): string {
  const guides = [...(config.taste ? ["your taste guide"] : []), ...(config.style ? ["your style guide"] : [])];
  const guideLine = [
    ...(guides.length ? [`Guides in use: ${guides.join(" and ")}.`] : []),
    ...(config.guideProblems ?? []).map((problem) => `Guide problem: ${problem}.`),
  ].join(" ");
  const withGuides = (line: string) => (guideLine ? `${line} ${guideLine}` : line);
  if (!shareEnabled(config)) return withGuides(`Share notes are off: set ${BLUESKY_HANDLE_ENV} and ${BLUESKY_PASSWORD_ENV}, or ${DRAFTS_DIR_ENV} or ${DRAFTS_COMMAND_ENV}, to turn them on.`);
  const where = [
    ...(config.bluesky ? [`Bluesky as @${config.bluesky.handle}${config.bluesky.service ? ` on ${config.bluesky.service}` : ""}`] : []),
    ...(config.drafts?.command ? ["blog drafts through your drafts command"] : config.drafts?.dir ? [`blog drafts in ${config.drafts.dir}`] : []),
  ];
  const examples = config.drafts && config.examplesTool ? [`drafts look up examples with ${config.examplesTool}`] : [];
  return withGuides(`Share notes are on: ${[...where, ...examples].join("; ")}.`);
}
