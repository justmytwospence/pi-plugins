// The external editor for text pi's own app does not own: Ctrl+G (pi's app.editor.external) in the
// planning screen's lane inputs, and /plan's "Edit the plan". Mirrors pi's helper, which the package
// does not export: the configured `externalEditor` setting, else $VISUAL / $EDITOR, on a temporary
// Markdown file.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Color, colorToHex, mixColors } from "@earendil-works/pi-tui";
import { reportedTerminalColors } from "./app/plan-html.js";

function settingFrom(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const value = JSON.parse(readFileSync(path, "utf8"))?.externalEditor;
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The editor command pi would use, or undefined when none is configured. */
export function externalEditorCommand(cwd = process.cwd()): string | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return (
    settingFrom(join(cwd, ".pi", "settings.json")) ??
    settingFrom(join(agentDir, "settings.json")) ??
    (process.env.VISUAL || process.env.EDITOR || undefined)
  );
}

/** Edit `content` in `command`; resolves the new text, or undefined if the editor failed. */
export async function editExternally(
  command: string,
  content: string,
  name = "prompt.md",
): Promise<string | undefined> {
  const directory = mkdtempSync(join(tmpdir(), "pi-plan-editor-"));
  const file = join(directory, name);
  try {
    writeFileSync(file, content, "utf8");
    const [editor, ...args] = command.split(" ");
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(editor, [...args, file], { stdio: "inherit", shell: process.platform === "win32" });
      child.on("error", () => resolve(null));
      child.on("close", (exit) => resolve(exit));
    });
    if (code !== 0) return undefined;
    return readFileSync(file, "utf8")
      .replace(/^\uFEFF/, "")
      .replace(/\n$/, "");
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

/** What editInTerminal needs from pi's UI: a custom component, which hands over the terminal. */
interface TerminalOwner {
  custom<T>(
    factory: (
      tui: { stop(): void; start(): void; requestRender(force?: boolean): void },
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => { render(width: number): string[]; invalidate(): void },
  ): Promise<T>;
}

/**
 * Edit `content` in `command` in pi's own terminal: pi stops drawing while the editor runs, then
 * takes the screen back. Resolves the new text, or undefined if the editor failed.
 */
export function editInTerminal(
  ui: TerminalOwner,
  command: string,
  content: string,
  name?: string,
): Promise<string | undefined> {
  return ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    prepareEditor(command, theme as Theme | undefined);
    tui.stop();
    void editExternally(command, content, name)
      .catch(() => undefined)
      .then((text) => {
        tui.start();
        tui.requestRender(true);
        done(text);
      });
    return { render: () => [], invalidate: () => undefined };
  });
}

/** The edamame theme Pi writes (themes/pi.toml): select it with `theme = "pi"` in edamame's config. */
export const EDAMAME_THEME = "pi";

/** edamame's config folder: $XDG_CONFIG_HOME/edamame (absolute only), else ~/.config/edamame. */
export function edamameConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "edamame");
}

/**
 * Pi's theme as an edamame theme: its text, heading, link, code and status colours on the
 * terminal's own background, with stripes and chrome mixed from the terminal's colours. edamame
 * then looks like the Pi it was opened from. The background is the terminal's colour itself, not
 * `reset`: edamame tints code spans and quotes by blending toward the background, which only
 * works on a real colour (on `reset`, a code span's background became its text colour).
 */
export function edamameTheme(theme: Theme): string {
  const colors = theme.colors as Readonly<Record<string, Color>>;
  const terminal = reportedTerminalColors(theme);
  const hex = (color: Color | undefined): string | undefined => {
    try {
      return color ? colorToHex(color) : undefined;
    } catch {
      return undefined;
    }
  };
  const text = colors.text || terminal?.foreground;
  const mix = (amount: number, fallback: string) =>
    terminal && text ? (hex(mixColors(terminal.background, text, amount)) ?? fallback) : fallback;
  const pick = (...tokens: string[]) => {
    for (const token of tokens) {
      const value = hex(colors[token]);
      if (value) return value;
    }
    return "reset";
  };
  const palette: Record<string, string> = {
    text: hex(text) ?? "reset",
    text_muted: pick("muted", "dim"),
    bg: hex(terminal?.background) ?? (theme.appearance === "light" ? "#ffffff" : "#1e1e1e"),
    bg_muted: mix(0.06, pick("selectedBg")),
    surface: mix(0.14, pick("selectedBg")),
    surface_elevated: mix(0.1, pick("userMessageBg", "selectedBg")),
    primary: pick("mdHeading", "accent"),
    secondary: pick("mdQuoteBorder", "borderMuted", "border"),
    accent: pick("accent"),
    link: pick("mdLink", "accent"),
    success: pick("success"),
    warning: pick("warning"),
    error: pick("error"),
    code: pick("mdCode", "accent"),
    diff_add: pick("toolDiffAdded", "success"),
    diff_delete: pick("toolDiffRemoved", "error"),
  };
  return [
    "# Written by pi-plan-mode from Pi's theme each time Pi opens edamame: edits here do not last.",
    `light = ${theme.appearance === "light"}`,
    "task_strikethrough = true",
    "",
    "[palette]",
    ...Object.entries(palette).map(([slot, value]) => `${slot} = "${value}"`),
    "",
  ].join("\n");
}

/** Before Pi opens `command`: an edamame gets Pi's current theme. Never fails the edit. */
export function prepareEditor(command: string, theme: Theme | undefined, env: NodeJS.ProcessEnv = process.env) {
  const program = basename(command.trim().split(/\s+/)[0] ?? "");
  if (program !== "edamame" || !theme) return;
  try {
    const dir = join(edamameConfigDir(env), "themes");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${EDAMAME_THEME}.toml`);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, edamameTheme(theme), "utf8");
    renameSync(temporary, file);
  } catch {
    // edamame keeps its last theme.
  }
}
