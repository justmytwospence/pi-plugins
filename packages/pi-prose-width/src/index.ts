// prose-width: wraps prose in pi's transcript at a readable measure while code
// blocks and tables keep the full width of the terminal.
//
// pi's Markdown component renders one top-level token at a time with
// renderToken(token, width) and then wraps every line at the full width. This
// patches renderToken on the shared Markdown class (extensions import the host's
// pi-tui): a paragraph, heading, list or quote is rendered and wrapped at the
// measure instead, everything else at the width it was given. A list or quote
// holding a table, or a code line longer than the measure, keeps the full width.
//
// The measure comes from PROSE_WIDTH, else `width` in
// ~/.config/agents/prose-width.json (shared with the opencode and Claude Code
// ports), else 80. `0` or `off` turns it off; /prose-width changes it for the session.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export const DEFAULT_MEASURE = 80;
const STATE = Symbol.for("pi-prose-width");
const SEEN = Symbol.for("pi-prose-width.version");

type Token = { type: string; text?: string; tokens?: Token[]; items?: Token[] };
type RenderToken = (this: Markdown, token: Token, width: number, ...rest: unknown[]) => string[];
type Render = (this: Markdown, width: number) => string[];

interface State {
  measure: number;
  /** Bumped when the measure changes, so every Markdown drops its cached lines. */
  version: number;
}

/** The prototype as this patch sees it: renderToken is private in pi-tui's types. */
type Patched = {
  [STATE]?: State;
  renderToken?: RenderToken;
  render: Render;
};

const PROSE = new Set(["paragraph", "heading", "text", "list", "blockquote"]);
/** Tokens rendered as one line that the component itself never wraps before its final pass. */
const UNWRAPPED = new Set(["paragraph", "heading", "text"]);

export function parseMeasure(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "off" || value === false) return 0;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export function configuredMeasure(env = process.env, home = homedir()): number {
  const fromEnv = parseMeasure(env.PROSE_WIDTH);
  if (fromEnv !== undefined) return fromEnv;
  try {
    const file = JSON.parse(readFileSync(path.join(home, ".config/agents/prose-width.json"), "utf8"));
    return parseMeasure(file?.width) ?? DEFAULT_MEASURE;
  } catch {
    return DEFAULT_MEASURE;
  }
}

/** Whether a prose token holds preformatted content that must not be squeezed to the measure. */
export function holdsWideContent(token: Token, measure: number): boolean {
  if (token.type === "table") return true;
  if (token.type === "code") return (token.text ?? "").split("\n").some((line) => line.length > measure - 6);
  return [...(token.tokens ?? []), ...(token.items ?? [])].some((child) => holdsWideContent(child, measure));
}

/** Installs the patch once per process; a reload only updates the shared state. */
export function install(measure: number): State {
  const proto = Markdown.prototype as unknown as Patched;
  const existing = proto[STATE];
  if (existing) {
    if (existing.measure !== measure) {
      existing.measure = measure;
      existing.version++;
    }
    return existing;
  }
  const renderToken = proto.renderToken;
  if (typeof renderToken !== "function") throw new Error("pi-tui's Markdown has no renderToken to patch");
  const state: State = { measure, version: 0 };
  const render = proto.render;

  proto.renderToken = function (this: Markdown, token: Token, width: number, ...rest: unknown[]) {
    const m = state.measure;
    if (!m || width <= m || !PROSE.has(token.type) || holdsWideContent(token, m)) {
      return renderToken.call(this, token, width, ...rest);
    }
    const lines = renderToken.call(this, token, m, ...rest);
    return UNWRAPPED.has(token.type) ? lines.flatMap((line) => (line ? wrapTextWithAnsi(line, m) : [line])) : lines;
  };
  proto.render = function (this: Markdown, width: number) {
    const self = this as Markdown & { [SEEN]?: number };
    if (self[SEEN] !== state.version) {
      self.invalidate();
      self[SEEN] = state.version;
    }
    return render.call(this, width);
  };
  proto[STATE] = state;
  return state;
}

export default function (pi: ExtensionAPI) {
  const state = install(configuredMeasure());

  pi.registerCommand("prose-width", {
    description: "Show or set the measure prose wraps at (a column count, or off)",
    handler: async (args, ctx) => {
      const arg = args.trim();
      if (arg) {
        const next = parseMeasure(arg);
        if (next === undefined) {
          ctx.ui.notify(`prose-width: not a column count: ${arg}`, "error");
          return;
        }
        install(next);
      }
      ctx.ui.notify(state.measure ? `prose-width: prose wraps at ${state.measure} columns` : "prose-width: off", "info");
    },
  });
}
