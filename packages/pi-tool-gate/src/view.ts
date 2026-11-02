// What a held call looks like to the user: the call laid out for reading (bash split one step per
// line, edits and overwrites as diffs, new files and other tools as highlightable code). Pure apart
// from reading the target file; colouring happens in the dialog.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { generateDiffString, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./bash.ts";
import { layoutBash } from "./bash-layout.ts";

export type CallBody =
  | { kind: "code"; lang: string | undefined; text: string }
  /** Pi's diff format (`+12 line`, `-12 line`, ` 12 line`), as the edit tool renders it. */
  | { kind: "diff"; text: string };

export interface CallView {
  tool: string;
  /** The file for edit/write, else empty. */
  subject: string;
  action?: string;
  target?: string;
  /** A short remark on the body, e.g. "new file, 40 lines". */
  note?: string;
  body: CallBody;
}

/** Most lines worth laying out; the dialog shows fewer until expanded. */
const MAX_LINES = 2_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_DISPLAY_CHARS = 20_000;

/** Safe, flat labels for approval cards; never changes the call's arguments. */
export function describeCallPresentation(tool: string, input: Record<string, unknown>): { action: string; target: string; description: string } {
  const flat = (value: unknown): string => {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return "";
    return String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 500);
  };
  const verb = [input.action, input.method, input.operation].map(flat).find(Boolean);
  const action = [flat(tool) || "Tool", verb].filter(Boolean).join(": ");
  const candidates = tool === "bash" || tool === "bg_run"
    ? [input.command]
    : [input.path, input.file_path, input.url, input.target, input.name, Array.isArray(input.names) ? input.names.map(flat).filter(Boolean).join(", ") : input.names, input.query, input.command];
  const target = candidates.map(flat).find(Boolean) || "Not specified";
  return { action, target, description: `${action} — ${target}` };
}

/** Indented display only, bounded independently of the original argument object. */
function displayFields(input: Record<string, unknown>): string {
  const lines: string[] = [];
  let chars = 0;
  const seen = new Set<object>();
  const add = (line: string) => {
    if (lines.length >= MAX_LINES || chars >= MAX_DISPLAY_CHARS) return;
    const safe = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "�");
    const remaining = MAX_DISPLAY_CHARS - chars;
    lines.push(safe.slice(0, remaining));
    chars += Math.min(safe.length, remaining) + 1;
  };
  const visit = (label: string, value: unknown, depth: number) => {
    if (lines.length >= MAX_LINES || chars >= MAX_DISPLAY_CHARS) return;
    const prefix = "  ".repeat(depth) + label;
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) { add(`${prefix}: [circular]`); return; }
      if (depth >= 20) { add(`${prefix}: [nested value]`); return; }
      const entries = Array.isArray(value) ? value.map((v, i) => [`${i + 1}.`, v] as const) : Object.entries(value);
      if (!entries.length) { add(`${prefix}: ${Array.isArray(value) ? "[]" : "{}"}`); return; }
      if (label) add(`${prefix}:`);
      seen.add(value);
      for (const [key, child] of entries) visit(key, child, label ? depth + 1 : depth);
      seen.delete(value);
      return;
    }
    const text = typeof value === "string" ? (value === "" ? '""' : value) : String(value);
    const parts = text.split("\n");
    add(`${prefix}: ${parts[0]}`);
    for (const part of parts.slice(1)) add(`${"  ".repeat(depth + 1)}${part}`);
  };
  visit("", input, 0);
  if (lines.length >= MAX_LINES || chars >= MAX_DISPLAY_CHARS) lines.push("... display truncated");
  return lines.join("\n");
}

export async function callView(tool: string, input: Record<string, unknown>, cwd: string): Promise<CallView> {
  const { action, target } = describeCallPresentation(tool, input);
  if (tool === "bash" || tool === "bg_run") return { tool, action, target, subject: tool === "bash" ? "" : String(input.name ?? ""), body: { kind: "code", lang: "bash", text: formatBash(String(input.command ?? "")) } };
  if (tool === "edit" || tool === "write") {
    const file = String(input.path ?? "");
    const abs = path.resolve(cwd, expandHome(file));
    const existing = await readSmall(abs);
    if (tool === "write") {
      const content = String(input.content ?? "");
      if (existing === undefined) {
        return { tool, action, target, subject: file, note: `new file, ${lineCount(content)} lines`, body: { kind: "code", lang: getLanguageFromPath(file), text: clipLines(content) } };
      }
      return { tool, action, target, subject: file, note: "overwrites", body: { kind: "diff", text: diff(existing, content) } };
    }
    const edits = editsOf(input);
    const note = edits.length === 1 ? undefined : `${edits.length} edits`;
    const applied = existing === undefined ? undefined : applyEdits(existing, edits);
    if (existing !== undefined && applied !== undefined) return { tool, action, target, subject: file, note, body: { kind: "diff", text: diff(existing, applied) } };
    // The edit will not apply as given (or the file is unreadable): show the edit text alone.
    const text = edits.map((e) => diff(e.oldText, e.newText)).join("\n     ...\n");
    return { tool, action, target, subject: file, note: `${note ? `${note}, ` : ""}no exact match in the file`, body: { kind: "diff", text } };
  }
  return { tool, action, target, subject: "", body: { kind: "code", lang: undefined, text: displayFields(input) } };
}

/** A command laid out one step per line (see bash-layout.ts, shared with pi-cc-render). */
export function formatBash(command: string): string {
  return layoutBash(command);
}

function editsOf(input: Record<string, unknown>): Array<{ oldText: string; newText: string }> {
  const list = Array.isArray(input.edits) ? input.edits : [input];
  return list
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({ oldText: String(e.oldText ?? ""), newText: String(e.newText ?? "") }))
    .filter((e) => e.oldText || e.newText);
}

/** Each oldText replaced at its unique match in the original, or undefined if any is missing or ambiguous. */
function applyEdits(content: string, edits: Array<{ oldText: string; newText: string }>): string | undefined {
  const at: Array<{ index: number; oldText: string; newText: string }> = [];
  for (const e of edits) {
    if (!e.oldText) return undefined;
    const index = content.indexOf(e.oldText);
    if (index < 0 || content.indexOf(e.oldText, index + 1) >= 0) return undefined;
    at.push({ index, ...e });
  }
  at.sort((a, b) => a.index - b.index);
  for (let i = 1; i < at.length; i++) {
    const prev = at[i - 1]!;
    if (at[i]!.index < prev.index + prev.oldText.length) return undefined;
  }
  let out = content;
  for (const e of at.reverse()) out = out.slice(0, e.index) + e.newText + out.slice(e.index + e.oldText.length);
  return out;
}

function diff(before: string, after: string): string {
  return clipLines(generateDiffString(before, after, 3).diff);
}

async function readSmall(file: string): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > MAX_FILE_BYTES) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function lineCount(text: string): number {
  return text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
}

function clipLines(text: string): string {
  const lines = text.split("\n");
  return lines.length <= MAX_LINES ? text : [...lines.slice(0, MAX_LINES), `... ${lines.length - MAX_LINES} more lines`].join("\n");
}
