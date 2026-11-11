import { readFileSync } from "node:fs";
import path from "node:path";

import { agentDir, sharedConfigDir, isRecord } from "./config.ts";
import { parseLegacyCombinedMode } from "./modes.ts";
import { projectFiles, type ProjectContext } from "./project.ts";

function context(project: ProjectContext | string): ProjectContext {
  return typeof project === "string"
    ? { cwd: project, root: project, main: project, isGit: false }
    : project;
}

function configFiles(name: string, project: ProjectContext | string): string[] {
  return [
    path.join(sharedConfigDir(), `${name}.json`),
    path.join(agentDir(), `${name}.json`),
    ...projectFiles(context(project)).map(file => path.join(path.dirname(file), path.basename(file).replace("tool-gate", name))),
  ];
}

/** All user and project JSON sources, in low-to-high precedence order. */
export function policyFiles(project: ProjectContext | string): string[] {
  return configFiles("tool-gate", project);
}

function readPolicy(file: string): { value?: Record<string, unknown>; error?: string } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" ? {} : { error: `${file}: Could not read policy file (${code ?? "unknown error"}).` };
  }
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { value } : { error: `${file}: Policy JSON must be an object.` };
  } catch {
    return { error: `${file}: Invalid policy JSON.` };
  }
}

export type PolicyIssue = { file: string; message: string };

/** Retain the file separately: diagnostic access must never parse paths from prose. */
export function policyIssues(project: ProjectContext | string): PolicyIssue[] {
  return policyFiles(project).flatMap(file => {
    const { error } = readPolicy(file);
    return error ? [{ file, message: error }] : [];
  });
}

/** Missing files are normal; malformed or unreadable existing policy must be surfaced by the gate. */
export function policyErrors(project: ProjectContext | string): string[] {
  return policyIssues(project).map(issue => issue.message);
}

export interface IgnoredSetting { file: string; key: string }

/** Settings a project file may not loosen: they are honored only from the user's own files. */
const USER_ONLY_KEYS = ["enabled", "allowTools", "readOnlyCommands", "thresholds", "jev", "persistence", "modes"] as const;
const USER_ONLY_DIRECTORIES = ["alwaysWrite", "exemptCommands"] as const;

/** Remove what a project file may not set (it may only tighten), recording each removed key. */
function tightenOnly(file: string, value: Record<string, unknown>, ignored: IgnoredSetting[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  const drop = (key: string, path = key) => {
    if (key in out) { delete out[key]; ignored.push({ file, key: path }); }
  };
  for (const key of USER_ONLY_KEYS) drop(key);
  for (const key of ["defaultApproval", "defaultMode"]) {
    if (key in out && parseLegacyCombinedMode(out[key]) === "bypassPermissions") drop(key);
  }
  if (out.denyInsteadOfPrompting === false) drop("denyInsteadOfPrompting");
  if ("planShell" in out && out.planShell !== "read-only") drop("planShell");
  if (isRecord(out.directories)) {
    const directories = { ...out.directories };
    for (const key of USER_ONLY_DIRECTORIES) {
      if (key in directories) { delete directories[key]; ignored.push({ file, key: `directories.${key}` }); }
    }
    if (directories.enabled === false) { delete directories.enabled; ignored.push({ file, key: "directories.enabled" }); }
    out.directories = directories;
  }
  return out;
}

/**
 * Merge user, active shared project and main local project config. Invalid files never throw;
 * policyErrors exposes diagnostics separately. Wrong-typed fields retain the earlier value.
 * Project files (the last three) may only tighten: loosening settings are dropped and reported in
 * `ignored`. A string retains the legacy launch-directory lookup; callers resolve Git roots asynchronously.
 */
export function loadConfigReport<T extends Record<string, unknown>>(name: string, defaults: T, project: ProjectContext | string): { config: T; ignored: IgnoredSetting[] } {
  let merged: Record<string, unknown> = merge({}, structuredClone(defaults));
  const ignored: IgnoredSetting[] = [];
  for (const [index, file] of configFiles(name, project).entries()) {
    const { value } = readPolicy(file);
    if (!value) continue;
    const fromProject = index >= 2;
    const settings = fromProject ? tightenOnly(file, value, ignored) : { ...value };
    const { persistence: rawPersistence, ...rest } = settings;
    if (isRecord(rawPersistence)) {
      const persistence = { ...rawPersistence };
      if (persistence.project !== "local" && persistence.project !== "shared") delete persistence.project;
      if (typeof persistence.userWritable !== "boolean") delete persistence.userWritable;
      merged = merge(merged, { ...rest, persistence }, [], fromProject);
    } else {
      // A scalar must not replace the persistence object or its user-owned writable flag.
      merged = merge(merged, rest, [], fromProject);
    }
  }
  return { config: merged as T, ignored };
}

export function loadConfig<T extends Record<string, unknown>>(name: string, defaults: T, project: ProjectContext | string): T {
  return loadConfigReport(name, defaults, project).config;
}

function union(current: unknown[] | undefined, value: unknown[]): unknown[] {
  const seen = new Set<string>();
  return [...(current ?? []), ...value].filter((item) => {
    const key = typeof item === "string" ? item : JSON.stringify(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>, keys: string[] = [], fromProject = false): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    if (keys.length === 1 && keys[0] === "directories" && (key === "read" || key === "write")) {
      // Directory grants are additive; an empty higher-precedence list cannot revoke them.
      if (Array.isArray(value) && value.every(item => typeof item === "string")
        && (current === undefined || (Array.isArray(current) && current.every(item => typeof item === "string")))) {
        out[key] = [...new Set([...(current ?? []), ...value])];
      }
    } else if (fromProject && keys.length === 1 && keys[0] === "directories" && (key === "private" || key === "derived")) {
      // A project may add private roots and derived paths, never remove the user's.
      if (Array.isArray(value) && (current === undefined || Array.isArray(current))) out[key] = union(current as unknown[] | undefined, value);
    } else if (isRecord(current) || (current === undefined && keys.length === 0 && key === "directories" && isRecord(value))) {
      if (isRecord(value)) out[key] = merge(isRecord(current) ? current : {}, value, [...keys, key], fromProject);
    } else if (Array.isArray(current)) {
      if (Array.isArray(value) && (!current.length || value.every(item => typeof item === typeof current[0]))) out[key] = value;
    } else if (current === undefined || (typeof value === typeof current && (typeof value !== "number" || Number.isFinite(value)))) out[key] = value;
  }
  return out;
}
