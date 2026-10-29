import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./plan-hook.js";

const ADJECTIVES = [
  "amber",
  "bold",
  "brisk",
  "calm",
  "clear",
  "crisp",
  "deft",
  "eager",
  "fair",
  "gentle",
  "keen",
  "lively",
  "lucid",
  "mellow",
  "nimble",
  "quiet",
  "rapid",
  "steady",
  "sunny",
  "swift",
  "tidy",
  "vivid",
  "warm",
  "wise",
];
const NOUNS = [
  "anchor",
  "beacon",
  "brook",
  "canyon",
  "cedar",
  "comet",
  "delta",
  "ember",
  "falcon",
  "fern",
  "harbor",
  "heron",
  "lantern",
  "maple",
  "meadow",
  "orbit",
  "otter",
  "pine",
  "quarry",
  "river",
  "sparrow",
  "summit",
  "tide",
  "willow",
];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)] as T;
}

/** A new plan file path with a memorable name, e.g. `~/.pi/agent/plans/calm-river.md`. */
export function newPlanFile(directory: string): string {
  for (let i = 0; i < 20; i++) {
    const candidate = join(directory, `${pick(ADJECTIVES)}-${pick(NOUNS)}.md`);
    if (!existsSync(candidate)) return candidate;
  }
  return join(directory, `plan-${Date.now().toString(36)}.md`);
}

/** Where plan files go: the configured directory, else `~/.pi/agent/plans`. */
export function plansDirectoryPath(configured?: string): string {
  return resolve(expandHome(configured ?? join(getAgentDir(), "plans")));
}

/** Whether `path` (as a tool call gave it, relative to `cwd`) is the plan file. */
export function isPlanFile(path: unknown, cwd: string, planFile: string): boolean {
  return resolve(cwd, expandHome(String(path ?? ""))) === resolve(planFile);
}

/** The plan file's name without `.md`, e.g. `calm-river`. Only a file name: never show it as what the plan is. */
export function planName(file: string): string {
  return basename(file).replace(/\.md$/u, "");
}

/**
 * What the plan is called for the user: its first heading (else its first line), with Markdown
 * marks removed and long titles cut, e.g. `Toy demo: greet.mjs CLI`. "the plan" when it has none.
 */
export function planTitle(file: string, max = 60): string {
  const line = readPlan(file)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^(```|---)/u.test(l));
  const title = (line ?? "")
    .replace(/^#+\s*/u, "")
    .replace(/^plan\s*:\s*(?=\S)/iu, "")
    .replace(/[`*_]/gu, "")
    .trim();
  if (!title) return "the plan";
  return title.length > max ? `${title.slice(0, max - 1).trimEnd()}…` : title;
}

/** The plan file's trimmed contents, or "" when it is missing. */
export function readPlan(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** Write `plan` to a new plan file in `directory`; returns its path. */
export function writePlanFile(directory: string, plan: string): string {
  const file = newPlanFile(directory);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${plan.trim()}\n`);
  return file;
}

export function tildify(file: string) {
  const home = process.env.HOME;
  return home && file.startsWith(`${home}/`) ? `~/${file.slice(home.length + 1)}` : file;
}

/** The paths a plan names: every backtick span that looks like a file or directory path. */
export function planPaths(plan: string): string[] {
  const paths = new Set<string>();
  for (const match of plan.matchAll(/`([^`\n]+)`/gu)) {
    const span = (match[1] ?? "")
      .trim()
      .replace(/:\d+(-\d+)?$/u, "")
      .replace(/#L\d+.*$/u, "");
    if (!span || /\s/u.test(span) || span.includes("://") || span.startsWith("-")) continue;
    if (!span.includes("/") && !/^[\w.-]+\.[A-Za-z0-9]+$/u.test(span)) continue;
    paths.add(span.replace(/^\.\//u, ""));
  }
  return [...paths];
}

/** Whether `file` (absolute) is one of the plan's `paths`: the same file, a path suffix, or inside a listed directory. */
export function inPlan(file: string, cwd: string, paths: readonly string[]): boolean {
  return paths.some((p) => {
    if (resolve(cwd, expandHome(p)) === file) return true;
    if (!p.startsWith("/") && !p.startsWith("~") && file.endsWith(`/${p}`)) return true;
    return p.endsWith("/") && file.startsWith(`${resolve(cwd, expandHome(p))}/`);
  });
}
