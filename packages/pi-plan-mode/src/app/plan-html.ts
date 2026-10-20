// A plan as an HTML page for the rendered plan view (plan-embed.ts): Markdown through marked, code
// through shiki, Mermaid fences drawn by the Mermaid library bundled in vendor/ (grok-mermaid's text
// art when it cannot draw one), and a stylesheet whose colors come from the Pi theme and whose code
// font is the terminal's. Nothing comes from the network: the one script loads from this package.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToHex, colorToRgb, mixColors } from "@earendil-works/pi-tui";
import type { MermaidArt } from "grok-mermaid";
import { Marked, type Token, type Tokens } from "marked";

interface Highlighter {
  codeToHtml(
    code: string,
    options: { lang: string; themes: { light: string; dark: string }; defaultColor: false },
  ): Promise<string>;
}
interface Mermaid {
  render(src: string): MermaidArt | null;
}

let shiki: Promise<Highlighter | null> | undefined;
let mermaid: Promise<Mermaid | null> | undefined;

function loadShiki(): Promise<Highlighter | null> {
  shiki ??= import("shiki").then(
    (module) => module as unknown as Highlighter,
    () => null,
  );
  return shiki;
}

function loadMermaid(): Promise<Mermaid | null> {
  mermaid ??= import("grok-mermaid").then(
    (module) => module as unknown as Mermaid,
    () => null,
  );
  return mermaid;
}

/** The bundled Mermaid library (vendor/mermaid, pinned; see its README), if the package has it. */
export function mermaidScript(): string | undefined {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../vendor/mermaid/mermaid.min.js");
  return fs.existsSync(file) ? pathToFileURL(file).href : undefined;
}

let terminalFont: Promise<string | undefined> | undefined;

/**
 * The terminal's font, for code on the page, so code looks as it does in the terminal. Only Ghostty
 * says what it is (`ghostty +show-config`, found by GHOSTTY_BIN_DIR, which Ghostty sets and herdr
 * passes on); elsewhere code uses the system's monospace font.
 */
export function ghosttyFont(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  terminalFont ??= new Promise((resolve) => {
    const bin = env.GHOSTTY_BIN_DIR
      ? path.join(env.GHOSTTY_BIN_DIR, "ghostty")
      : env.TERM_PROGRAM === "ghostty"
        ? "ghostty"
        : undefined;
    if (!bin) return resolve(undefined);
    execFile(bin, ["+show-config"], { timeout: 3000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? undefined : parseGhosttyFont(stdout));
    });
  });
  return terminalFont;
}

/** The first `font-family` in Ghostty's config (later ones are fallbacks). */
export function parseGhosttyFont(config: string): string | undefined {
  for (const line of config.split("\n")) {
    const at = line.indexOf("=");
    if (at < 0 || line.slice(0, at).trim() !== "font-family") continue;
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^"|"$/g, "");
    if (value) return value;
  }
  return undefined;
}

/** A plan opening with front matter (`---` YAML or `+++` TOML): the page leaves it out. */
export function stripFrontMatter(markdown: string): string {
  const match = /^(---|\+\+\+)[ \t]*\r?\n[\s\S]*?\r?\n\1[ \t]*(?:\r?\n|$)/.exec(markdown);
  return match ? markdown.slice(match[0].length) : markdown;
}

const DIAGRAM_LANGS = new Set([
  "mermaid",
  "statediagram",
  "statediagram-v2",
  "classdiagram",
  "classdiagram-v2",
  "erdiagram",
  "sequencediagram",
]);

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type CodeToken = Tokens.Code & { html?: string };
type AlertToken = Tokens.Blockquote & { alert?: string };

const ALERT = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)?/i;

async function codeHtml(token: CodeToken, drawDiagrams: boolean): Promise<string> {
  const lang = (token.lang ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (DIAGRAM_LANGS.has(lang)) {
    const source = lang === "mermaid" ? token.text : `${lang}\n${token.text}`;
    const module = await loadMermaid();
    let art: MermaidArt | null = null;
    try {
      art = module?.render(source) ?? null;
    } catch {
      art = null;
    }
    // The text art, or the source, stays in the page (hidden) for when Mermaid cannot draw it.
    const fallback = art
      ? `<pre class="diagram">${escapeHtml(art.plain.join("\n"))}</pre>`
      : `<pre><code>${escapeHtml(token.text)}</code></pre>`;
    if (!drawDiagrams) return fallback;
    return `<figure class="mermaid-block"><pre class="mermaid">${escapeHtml(source)}</pre><div class="mermaid-fallback" hidden>${fallback}</div></figure>`;
  }
  const highlighter = lang ? await loadShiki() : null;
  if (highlighter) {
    for (const candidate of [lang, "text"]) {
      try {
        // Both themes as CSS variables; the stylesheet picks the one for the page's palette.
        return await highlighter.codeToHtml(token.text, {
          lang: candidate,
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        });
      } catch {
        // An unknown language: try plain text, then fall through to an unhighlighted block.
      }
    }
  }
  return `<pre><code>${escapeHtml(token.text)}</code></pre>`;
}

/** The terminal's default colours, but only when the terminal reported them (not Pi's guess). */
export function reportedTerminalColors(theme: Theme): { foreground: Color; background: Color } | undefined {
  // A throwaway theme with every token on the terminal default resolves to the reported colours, or
  // to a guess that depends on the appearance (black for dark, white for light). Asking with both
  // appearances tells them apart: a reported background is the same either way.
  const probe = (appearance: "dark" | "light") => {
    const keys = Object.keys(theme.colors as Readonly<Record<string, Color>>);
    const fg = Object.fromEntries(keys.filter((key) => !key.endsWith("Bg")).map((key) => [key, ""]));
    const bg = Object.fromEntries(keys.filter((key) => key.endsWith("Bg")).map((key) => [key, ""]));
    const colors = new Theme(fg as never, bg as never, "truecolor", { appearance }).colors as Readonly<
      Record<string, Color>
    >;
    return { foreground: colors.text, background: colors.userMessageBg };
  };
  try {
    const dark = probe("dark");
    const light = probe("light");
    if (!dark.foreground || !dark.background || !light.background) return undefined;
    return colorToHex(dark.background) === colorToHex(light.background)
      ? { foreground: dark.foreground, background: dark.background }
      : undefined;
  } catch {
    return undefined;
  }
}

function luminance(color: Color): number {
  const { r, g, b } = colorToRgb(color);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const LIGHT_PAGE = {
  background: "#ffffff",
  text: "#1f2328",
  muted: "#59636e",
  accent: "#0969da",
  heading: "#1f2328",
  link: "#0969da",
  code: "#1f2328",
  border: "#d1d9e0",
  quote: "#d1d9e0",
  surface: "#f6f8fa",
  success: "#1a7f37",
  note: "#0969da",
  tip: "#1a7f37",
  important: "#8250df",
  warning: "#9a6700",
  caution: "#cf222e",
};

const DARK_PAGE = {
  background: "#0d1117",
  text: "#e6edf3",
  muted: "#9198a1",
  accent: "#4493f8",
  heading: "#e6edf3",
  link: "#4493f8",
  code: "#e6edf3",
  border: "#3d444d",
  quote: "#3d444d",
  surface: "#151b23",
  success: "#3fb950",
  note: "#4493f8",
  tip: "#3fb950",
  important: "#ab7df8",
  warning: "#d29922",
  caution: "#f85149",
};

export interface PageStyle {
  dark: boolean;
  colors: Record<keyof typeof LIGHT_PAGE, string>;
}

/**
 * The page's colours. On the terminal's own background when Pi knows it (the page then blends into
 * the screen) with the theme's colours, if the theme is made for a background that light or dark.
 * Otherwise a white page with a palette made for it.
 */
export function pageStyle(theme: Theme): PageStyle {
  const terminal = reportedTerminalColors(theme);
  if (!terminal) return { dark: false, colors: { ...LIGHT_PAGE } };
  const background = terminal.background;
  const dark = luminance(background) < 0.5;
  // The theme's colours are only safe on the kind of background the theme was made for.
  const matches = dark === (theme.appearance === "dark");
  if (!dark && !matches) return { dark: false, colors: { ...LIGHT_PAGE, background: colorToHex(background) } };
  const colors = theme.colors as Readonly<Record<string, Color>>;
  const text = matches && colors.text ? colors.text : terminal.foreground;
  const hex = (token: string, fallback: string) => {
    const color = matches ? colors[token] : undefined;
    try {
      return color ? colorToHex(color) : fallback;
    } catch {
      return fallback;
    }
  };
  const mix = (amount: number) => colorToHex(mixColors(background, text, amount));
  return {
    dark,
    colors: {
      background: colorToHex(background),
      text: colorToHex(text),
      muted: hex("muted", mix(0.6)),
      accent: hex("accent", dark ? "#7aa2f7" : LIGHT_PAGE.accent),
      heading: hex("mdHeading", colorToHex(text)),
      link: hex("mdLink", dark ? "#7aa2f7" : LIGHT_PAGE.link),
      code: hex("mdCode", colorToHex(text)),
      border: mix(0.16),
      quote: hex("mdQuoteBorder", mix(0.3)),
      surface: mix(0.06),
      success: hex("success", dark ? "#9ece6a" : LIGHT_PAGE.success),
      note: hex("accent", dark ? DARK_PAGE.note : LIGHT_PAGE.note),
      tip: hex("success", dark ? DARK_PAGE.tip : LIGHT_PAGE.tip),
      important: dark ? DARK_PAGE.important : LIGHT_PAGE.important,
      warning: hex("warning", dark ? DARK_PAGE.warning : LIGHT_PAGE.warning),
      caution: hex("error", dark ? DARK_PAGE.caution : LIGHT_PAGE.caution),
    },
  };
}

/** Changes whenever the page would come out differently: the lane rebuilds it then. */
export function styleKey(theme: Theme): string {
  return JSON.stringify(pageStyle(theme));
}

/** The page's colours as terminal-browser's embed protocol takes them, so its toolbar matches. */
export function embedColors(theme: Theme): { foreground: number[]; background: number[] } {
  const { colors } = pageStyle(theme);
  const rgba = (hex: string) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
    255,
  ];
  return { foreground: rgba(colors.text), background: rgba(colors.background) };
}

function cssVars(c: PageStyle["colors"]): string {
  return `--text: ${c.text}; --muted: ${c.muted}; --accent: ${c.accent}; --heading: ${c.heading};
  --link: ${c.link}; --code: ${c.code}; --border: ${c.border}; --quote: ${c.quote};
  --surface: ${c.surface}; --success: ${c.success}; --background: ${c.background};
  --note: ${c.note}; --tip: ${c.tip}; --important: ${c.important}; --warning: ${c.warning}; --caution: ${c.caution};`;
}

function cssString(text: string): string {
  return `"${text.replace(/["\\\n\r]/g, "")}"`;
}

function stylesheet(style: PageStyle, mono: string | undefined): string {
  // One palette: the browser does not follow the system appearance, so the lane rebuilds the page
  // when the colours change (styleKey) instead of the page switching by media query.
  const shiki = style.dark ? "dark" : "light";
  return `
:root {
  color-scheme: ${shiki}; ${cssVars(style.colors)}
  --mono: ${mono ? `${cssString(mono)}, ` : ""}ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}
.shiki, .shiki span {
  color: var(--shiki-${shiki});
  font-style: var(--shiki-${shiki}-font-style);
  font-weight: var(--shiki-${shiki}-font-weight);
}
html, body { background: var(--background); margin: 0; }
/* The page is captured as a picture and scrolled by the lane, so the browser never scrolls it. */
html { overflow: hidden; }
body {
  color: var(--text);
  font: 13.5px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  /* The top padding is where the lane cuts the browser's toolbar off (see plan-embed.ts). */
  padding: 24px 18px 40px;
}
main { max-width: 72ch; margin: 0 auto; }
h1, h2, h3, h4, h5, h6 { color: var(--heading); line-height: 1.25; margin: 1.6em 0 0.6em; font-weight: 650; }
h1 { font-size: 1.6em; margin-top: 0.1em; letter-spacing: -0.01em; }
h2 { font-size: 1.35em; padding-bottom: 0.3em; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.12em; }
h4, h5, h6 { font-size: 1em; color: var(--muted); }
p, ul, ol, table, pre, blockquote { margin: 0 0 1em; }
ul, ol { padding-left: 1.5em; }
li + li { margin-top: 0.25em; }
li > ul, li > ol { margin: 0.25em 0 0; }
li:has(> input[type="checkbox"]) { list-style: none; margin-left: -1.4em; }
input[type="checkbox"] { accent-color: var(--success); margin-right: 0.5em; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
strong { font-weight: 650; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
code, pre, .diagram {
  font-family: var(--mono);
  font-size: 0.875em;
}
:not(pre) > code {
  color: var(--code);
  background: var(--surface);
  border-radius: 5px;
  padding: 0.12em 0.4em;
}
pre, .shiki {
  background: var(--surface) !important;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  overflow-x: auto;
  line-height: 1.5;
}
pre code { background: none; padding: 0; font-size: inherit; }
.diagram { white-space: pre; color: var(--text); }
blockquote {
  margin-left: 0;
  padding: 0.2em 1em;
  color: var(--muted);
  border-left: 3px solid var(--quote);
}
.table-wrap { overflow-x: auto; margin: 0 0 1em; border: 1px solid var(--border); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; margin: 0; }
th, td { padding: 6px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border); }
th { font-weight: 600; background: var(--surface); }
tr:last-child td { border-bottom: 0; }
tbody tr:nth-child(even) td { background: color-mix(in srgb, var(--surface) 45%, transparent); }
img { max-width: 100%; }
/* A cell with no spaces (an id like D-01, a date, a path) does not break at its hyphens. */
.nowrap { white-space: nowrap; }
.mermaid-block { margin: 0 0 1em; padding: 12px; border: 1px solid var(--border); border-radius: 8px; text-align: center; }
.mermaid-block pre.mermaid { margin: 0; padding: 0; border: 0; background: none !important; color: transparent; }
.mermaid-block svg { max-width: 100%; height: auto; }
.mermaid-block .mermaid-fallback { text-align: left; }
.mermaid-block .mermaid-fallback > pre { margin: 0; }
.alert {
  margin: 0 0 1em;
  padding: 8px 14px;
  border-left: 3px solid var(--alert);
  border-radius: 6px;
  background: color-mix(in srgb, var(--alert) 9%, transparent);
}
.alert > :last-child { margin-bottom: 0; }
.alert-title { margin: 0 0 4px; font-weight: 600; color: var(--alert); }
.alert-note { --alert: var(--note); }
.alert-tip { --alert: var(--tip); }
.alert-important { --alert: var(--important); }
.alert-warning { --alert: var(--warning); }
.alert-caution { --alert: var(--caution); }
`;
}

export interface PlanHtmlOptions {
  /** The code font; undefined asks Ghostty (ghosttyFont), "" means the system's monospace font. */
  mono?: string;
  /** The Mermaid script's URL; undefined uses the bundled one, false draws diagrams as text. */
  mermaid?: string | false;
}

/** The ready signal the page puts in its title: its full height and its window's, in CSS pixels. */
export const READY_TITLE = "pi-plan-ready";

/** Mermaid's colours, from the page's palette, so diagrams look like the rest of the page. */
function mermaidConfig(style: PageStyle, mono: string | undefined) {
  const c = style.colors;
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    fontFamily: `-apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "Helvetica Neue", Arial, sans-serif`,
    themeVariables: {
      darkMode: style.dark,
      background: c.background,
      fontSize: "13px",
      primaryColor: c.surface,
      primaryTextColor: c.text,
      primaryBorderColor: c.accent,
      secondaryColor: c.surface,
      secondaryTextColor: c.text,
      secondaryBorderColor: c.border,
      tertiaryColor: c.background,
      tertiaryTextColor: c.text,
      tertiaryBorderColor: c.border,
      lineColor: c.muted,
      textColor: c.text,
      mainBkg: c.surface,
      nodeBorder: c.accent,
      clusterBkg: c.background,
      clusterBorder: c.border,
      edgeLabelBackground: c.background,
      noteBkgColor: c.surface,
      noteTextColor: c.text,
      noteBorderColor: c.border,
      actorBkg: c.surface,
      actorBorder: c.accent,
      actorTextColor: c.text,
      signalColor: c.muted,
      signalTextColor: c.text,
      labelBoxBkgColor: c.surface,
      labelBoxBorderColor: c.border,
      labelTextColor: c.text,
      ...(mono ? { fontFamilyMono: mono } : {}),
    },
    flowchart: { htmlLabels: true, curve: "basis" },
  };
}

/**
 * Draws the diagrams (a diagram Mermaid cannot draw shows its fallback), waits for the fonts, then
 * says the page is ready in its title: its content height, its window's size (CSS pixels) and the
 * pixel ratio. terminal-browser passes the title to Pi, which then captures the page and works out
 * from these where the page sits in the browser's frame. window.PI_SHIFT, set by Pi in each later
 * capture's copy of the page, moves the page up that many CSS pixels, so the captures stack.
 */
function readyScript(config: unknown): string {
  return `
window.PI_SHIFT = 0;
${config ? `window.mermaid?.initialize(${JSON.stringify(config)});` : ""}
(async () => {
  const blocks = [...document.querySelectorAll(".mermaid-block")];
  for (const block of blocks) {
    const pre = block.querySelector("pre.mermaid");
    const fallback = block.querySelector(".mermaid-fallback");
    try {
      if (!window.mermaid) throw new Error("no mermaid");
      await window.mermaid.run({ nodes: [pre] });
    } catch {
      pre.remove();
      fallback.hidden = false;
    }
  }
  try { await document.fonts.ready; } catch {}
  // The content's height, not the document's: that is never less than the window.
  const height = document.body.getBoundingClientRect().height;
  if (window.PI_SHIFT) document.body.style.transform = "translateY(" + (-window.PI_SHIFT) + "px)";
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.title = [${JSON.stringify(READY_TITLE)}, height, innerWidth, innerHeight, devicePixelRatio].join(" ");
  }));
})();
`;
}

/** The plan as a complete HTML document. */
export async function planHtml(
  markdown: string,
  theme: Theme,
  title = "Plan",
  options: PlanHtmlOptions = {},
): Promise<string> {
  const style = pageStyle(theme);
  const mono = options.mono ?? (await ghosttyFont());
  const mermaidSrc = options.mermaid === undefined ? mermaidScript() : options.mermaid || undefined;
  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(stripFrontMatter(markdown));
  const codes: CodeToken[] = [];
  marked.walkTokens(tokens, (token: Token) => {
    if (token.type === "code") codes.push(token as CodeToken);
    // GitHub alerts: a blockquote opening with [!NOTE] (or TIP, IMPORTANT, WARNING, CAUTION) is a
    // callout. Its body is lexed again without the marker; the walk then visits the new tokens.
    if (token.type === "blockquote") {
      const match = ALERT.exec(token.text);
      if (match) {
        const quote = token as AlertToken;
        quote.alert = (match[1] ?? "note").toLowerCase();
        quote.tokens = marked.lexer(token.text.slice(match[0].length));
      }
    }
  });
  await Promise.all(
    codes.map(async (token) => {
      token.html = await codeHtml(token, mermaidSrc !== undefined);
    }),
  );
  marked.use({
    renderer: {
      code(token: Tokens.Code) {
        return (token as CodeToken).html ?? `<pre><code>${escapeHtml(token.text)}</code></pre>`;
      },
      blockquote(this: { parser: { parse(tokens: Token[]): string } }, token: Tokens.Blockquote) {
        const inner = this.parser.parse(token.tokens);
        const alert = (token as AlertToken).alert;
        if (!alert) return `<blockquote>${inner}</blockquote>`;
        const title = alert[0]?.toUpperCase() + alert.slice(1);
        return `<div class="alert alert-${alert}"><p class="alert-title">${title}</p>${inner}</div>`;
      },
      tablecell(this: { parser: { parseInline(tokens: Token[]): string } }, token: Tokens.TableCell) {
        const tag = token.header ? "th" : "td";
        const align = token.align ? ` align="${token.align}"` : "";
        const content = this.parser.parseInline(token.tokens);
        const text = token.text.trim();
        const inner = text && !/\s/.test(text) ? `<span class="nowrap">${content}</span>` : content;
        return `<${tag}${align}>${inner}</${tag}>\n`;
      },
      // Raw HTML in a plan is shown as text: the page renders what the planner wrote, nothing more.
      html(token: Tokens.HTML | Tokens.Tag) {
        return escapeHtml(token.text);
      },
    },
  });
  // Tables sit in a frame that scrolls them sideways when they are wider than the lane, so the
  // table itself can fill the width (its header and stripes then span the frame).
  const body = marked
    .parser(tokens)
    .replaceAll("<table>", '<div class="table-wrap"><table>')
    .replaceAll("</table>", "</table></div>");
  const diagrams = mermaidSrc !== undefined && body.includes('class="mermaid-block"');
  const script = (text: string) => `<script>${text.replaceAll("</script", "<\\/script")}</script>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${stylesheet(style, mono)}</style>
</head>
<body><main>
${body}
</main>
${diagrams ? `<script src="${escapeHtml(mermaidSrc ?? "")}"></script>\n` : ""}${script(readyScript(diagrams ? mermaidConfig(style, mono) : undefined))}
</body>
</html>
`;
}
