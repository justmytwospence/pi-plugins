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
  active: boolean;
  owners: Set<symbol>;
  instances: Set<WeakRef<Markdown>>;
  restore(): void;
}

export interface Installation {
  readonly measure: number;
  setMeasure(measure: number): void;
  dispose(): void;
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

/** Shared wrappers have independent leases, so an old runtime cannot unpatch a new one. */
export function install(measure: number): Installation {
  const proto = Markdown.prototype as unknown as Patched;
  let state = proto[STATE];
  if (!state) {
    const renderToken = proto.renderToken;
    if (typeof renderToken !== "function") throw new Error("pi-tui's Markdown has no renderToken to patch");
    const render = proto.render;
    state = { measure, version: 0, active: true, owners: new Set(), instances: new Set(), restore() {} };
    const shared = state;

    const patchedToken: RenderToken = function (token, width, ...rest) {
      const m = shared.measure;
      if (!shared.active || !m || width <= m || !PROSE.has(token.type) || holdsWideContent(token, m)) {
        return renderToken.call(this, token, width, ...rest);
      }
      const lines = renderToken.call(this, token, m, ...rest);
      return UNWRAPPED.has(token.type) ? lines.flatMap((line) => (line ? wrapTextWithAnsi(line, m) : [line])) : lines;
    };
    const patchedRender: Render = function (width) {
      const self = this as Markdown & { [SEEN]?: { state: State; version: number } };
      if (shared.active && (self[SEEN]?.state !== shared || self[SEEN]?.version !== shared.version)) {
        self.invalidate();
        if (self[SEEN]?.state !== shared) shared.instances.add(new WeakRef(this));
        self[SEEN] = { state: shared, version: shared.version };
        for (const ref of shared.instances) if (!ref.deref()) shared.instances.delete(ref);
      }
      return render.call(this, width);
    };
    proto.renderToken = patchedToken;
    proto.render = patchedRender;
    proto[STATE] = shared;
    // Keep restoration with the state rather than with any one runtime's lease.
    shared.restore = () => {
      shared.active = false; // Later third-party wrappers may still delegate to ours.
      for (const ref of shared.instances) ref.deref()?.invalidate();
      shared.instances.clear();
      if (proto.renderToken === patchedToken) proto.renderToken = renderToken;
      if (proto.render === patchedRender) proto.render = render;
      if (proto[STATE] === shared) delete proto[STATE];
    };
  }
  const shared = state;
  const owner = Symbol();
  shared.owners.add(owner);
  const setMeasure = (next: number) => {
    if (!shared.owners.has(owner) || shared.measure === next) return;
    shared.measure = next;
    shared.version++;
  };
  setMeasure(measure);
  return {
    get measure() { return shared.measure; },
    setMeasure,
    dispose() {
      if (!shared.owners.delete(owner) || shared.owners.size) return;
      shared.restore();
    },
  };
}

export default function (pi: ExtensionAPI) {
  let state: Installation | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    state ??= install(configuredMeasure());
  });
  pi.on("session_shutdown", () => {
    state?.dispose();
    state = undefined;
  });

  pi.registerCommand("prose-width", {
    description: "Show or set the measure prose wraps at (a column count, or off)",
    handler: async (args, ctx) => {
      if (!state) {
        ctx.ui.notify("prose-width: terminal rendering is not active", "info");
        return;
      }
      const arg = args.trim();
      if (arg) {
        const next = parseMeasure(arg);
        if (next === undefined) {
          ctx.ui.notify(`prose-width: not a column count: ${arg}`, "error");
          return;
        }
        state.setMeasure(next);
      }
      ctx.ui.notify(state.measure ? `prose-width: prose wraps at ${state.measure} columns` : "prose-width: off", "info");
    },
  });
}
