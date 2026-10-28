// This machine's project grants: the rules and folder grants a user allowed "in this project", kept
// across sessions. They live outside the repository (`<agent dir>/tool-gate/project-grants.json`,
// keyed by the project's main checkout, so its worktrees share them) because their paths are this
// machine's. The file keeps its original shape, a list of `{ key, label, added }` per project, so an
// older version still reads it: permissions.ts reads the old keys (`bash:<key>`, `tool:<x>`,
// `edit:<dir>`, `dir:read:/abs`) as rules or folders, and new rules are saved under keys of their own
// (`allow:Bash(git push:*)`) that an older version lists as grants and never matches.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentDir, isRecord } from "./config.ts";

export interface Grant {
  /** What it grants: `allow:<rule>`, `ask:<rule>` or `deny:<rule>`, a folder (`dir:read:/abs`), or an old key (`bash:npm test`, `tool:web_fetch`, `edit:<dir>`). */
  key: string;
  /** What it says, as the dialog or `/gate rules` showed it. */
  label: string;
  /** When it was granted (ISO). */
  added: string;
}

export function grantsFile(): string {
  return path.join(agentDir(), "tool-gate", "project-grants.json");
}

let cache: { file: string; mtime: number; data: Record<string, Grant[]> } | undefined;

function readAll(file: string): Record<string, Grant[]> {
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (cache && cache.file === file && cache.mtime === mtime) return cache.data;
  const data: Record<string, Grant[]> = {};
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isRecord(raw)) {
      for (const [project, list] of Object.entries(raw)) {
        if (!Array.isArray(list)) continue;
        data[project] = list.flatMap((g) =>
          isRecord(g) && typeof g.key === "string" && g.key
            ? [{ key: g.key, label: typeof g.label === "string" ? g.label : g.key, added: typeof g.added === "string" ? g.added : "" }]
            : [],
        );
      }
    }
  } catch {
    // Unreadable or invalid: no grants, never a broken session.
  }
  cache = { file, mtime, data };
  return data;
}

function writeAll(file: string, data: Record<string, Grant[]>) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, file);
  cache = undefined;
}

export function loadGrants(project: string, file = grantsFile()): Grant[] {
  return readAll(file)[project] ?? [];
}

/** Adds grants to a project, replacing any with the same key. */
export function addGrants(project: string, grants: readonly Omit<Grant, "added">[], file = grantsFile()) {
  const data = { ...readAll(file) };
  const added = new Date().toISOString();
  const keys = new Set(grants.map((g) => g.key));
  data[project] = [...(data[project] ?? []).filter((g) => !keys.has(g.key)), ...grants.map((g) => ({ ...g, added }))];
  writeAll(file, data);
}

export function removeGrant(project: string, key: string, file = grantsFile()) {
  const data = { ...readAll(file) };
  const rest = (data[project] ?? []).filter((g) => g.key !== key);
  if (rest.length) data[project] = rest;
  else delete data[project];
  writeAll(file, data);
}
