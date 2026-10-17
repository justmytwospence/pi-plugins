// Ctrl+G (pi's app.editor.external) for inputs pi's own app does not own, such as the planning
// screen's lane inputs. Mirrors pi's helper, which the package does not export: the configured
// `externalEditor` setting, else $VISUAL / $EDITOR, on a temporary prompt.md.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
export async function editExternally(command: string, content: string): Promise<string | undefined> {
  const directory = mkdtempSync(join(tmpdir(), "pi-plan-editor-"));
  const file = join(directory, "prompt.md");
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
