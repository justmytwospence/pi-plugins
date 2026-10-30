import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { agentDir, sharedConfigDir } from "./config.ts";
import type { ProjectContext } from "./project.ts";

export const RULES_FILE = "tool-gate-rules.md";
export const MAX_RULES = 30;

/** Each top-level bullet (`-`, `*`, `+` or `1.`) is one rule; indented lines continue it. */
export function parseRules(markdown: string): string[] {
  const rules: string[] = [];
  let current: string | undefined;
  let inFence = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (/^\s*```/u.test(line)) inFence = !inFence;
    if (inFence) continue;
    const top = /^(?:[-*+]|\d+[.)])\s+(.+)$/u.exec(line);
    if (top) {
      if (current) rules.push(current);
      current = (top[1] as string).trim();
    } else if (current && /^\s+\S/u.test(line)) {
      current += ` ${line.trim()}`;
    } else if (current) {
      rules.push(current);
      current = undefined;
    }
  }
  if (current) rules.push(current);
  return rules.filter(Boolean);
}

const cache = new Map<string, { mtime: number; rules: string[] }>();

function readRules(file: string): string[] {
  try {
    const mtime = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtime === mtime) return hit.rules;
    const rules = parseRules(readFileSync(file, "utf8"));
    cache.set(file, { mtime, rules });
    return rules;
  } catch {
    return [];
  }
}

/**
 * Active-root rules (`.agents/tool-gate-rules.md`, then `.pi/`) first, then user ones
 * (`~/.config/agents/`, then `~/.pi/agent/`); duplicates dropped, at most 30.
 */
export function loadRules(project: ProjectContext | string): string[] {
  const root = typeof project === "string" ? project : project.root;
  const files = [
    path.join(root, ".agents", RULES_FILE),
    path.join(root, ".pi", RULES_FILE),
    path.join(sharedConfigDir(), RULES_FILE),
    path.join(agentDir(), RULES_FILE),
  ];
  return [...new Set(files.flatMap(readRules))].slice(0, MAX_RULES);
}
