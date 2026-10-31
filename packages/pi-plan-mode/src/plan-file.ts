import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./plan-hook.js";

/** A unique working draft path; generating it does not create a file or directory. */
export function newPlanFile(directory: string): string {
  return join(directory, `draft-${Date.now()}-${randomUUID()}.md`);
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
  return planTextTitle(readPlan(file), max);
}

/** The same title from reviewed text; untruncated unless a display limit is supplied. */
export function planTextTitle(plan: string, max = Number.POSITIVE_INFINITY): string {
  const line = plan
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
  return savePlanSnapshot(directory, plan, planFilenameStem(plan));
}

/** A deterministic ASCII filename stem, without Markdown title markup. */
export function planSlug(text: string): string {
  return text
    .replace(/^#+\s*/u, "")
    .replace(/^plan\s*:\s*(?=\S)/iu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[`*_~]/gu, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "");
}

/** A descriptive filename stem derived from the full plan title, with a safe fallback. */
export function planFilenameStem(plan: string): string {
  const stem = planSlug(planTextTitle(plan));
  return !stem || stem === "plan" || stem === "the-plan" ? "untitled-plan" : stem;
}

/** Save a private, collision-safe copy without mutating the working draft. */
export function savePlanSnapshot(directory: string, plan: string, name: string): string {
  // Validate before normalizing: a path must never silently turn into a filename.
  if (/[/\\\p{Cc}]/u.test(name)) throw new Error("Enter a descriptive plan name.");
  const stem = name.trim().replace(/\.md$/iu, "");
  if (!stem || stem === "." || stem === "..") throw new Error("Enter a descriptive plan name.");
  const slug = planSlug(stem);
  if (!slug) throw new Error("Enter a descriptive plan name.");
  const destination = resolve(directory);
  mkdirSync(destination, { recursive: true });
  for (let candidate = 1; candidate <= 1000; candidate++) {
    const file = join(destination, `${slug}${candidate === 1 ? "" : `-${candidate}`}.md`);
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      try {
        writeFileSync(fd, `${plan.trim()}\n`);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      // Only this exclusively created file belongs to us, never a colliding candidate.
      try {
        unlinkSync(file);
      } catch {
        // Preserve the original I/O error if cleanup also fails.
      }
      throw error;
    }
    return file;
  }
  throw new Error("Could not find an available plan name after 1000 candidates.");
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
