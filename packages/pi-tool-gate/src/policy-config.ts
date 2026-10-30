import { readFileSync } from "node:fs";
import path from "node:path";

import { agentDir, sharedConfigDir, isRecord } from "./config.ts";
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

/**
 * Merge user, active shared project and main local project config. Invalid files never throw;
 * policyErrors exposes diagnostics separately. Wrong-typed fields retain the earlier value.
 * A string retains the legacy launch-directory lookup; callers resolve Git roots asynchronously.
 */
export function loadConfig<T extends Record<string, unknown>>(name: string, defaults: T, project: ProjectContext | string): T {
  let merged: Record<string, unknown> = merge({}, structuredClone(defaults));
  for (const [index, file] of configFiles(name, project).entries()) {
    const { value } = readPolicy(file);
    if (!value) continue;
    const { persistence: rawPersistence, ...settings } = value;
    if (isRecord(rawPersistence)) {
      const persistence = { ...rawPersistence };
      if (persistence.project !== "local" && persistence.project !== "shared") delete persistence.project;
      if (index >= 2 || typeof persistence.userWritable !== "boolean") delete persistence.userWritable;
      merged = merge(merged, { ...settings, persistence });
    } else {
      // A scalar must not replace the persistence object or its user-owned writable flag.
      merged = merge(merged, settings);
    }
  }
  return merged as T;
}

function merge(base: Record<string, unknown>, over: Record<string, unknown>, keys: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    if (keys.length === 1 && keys[0] === "directories" && (key === "read" || key === "write")) {
      // Directory grants are additive; an empty higher-precedence list cannot revoke them.
      if (Array.isArray(value) && value.every(item => typeof item === "string")
        && (current === undefined || (Array.isArray(current) && current.every(item => typeof item === "string")))) {
        out[key] = [...new Set([...(current ?? []), ...value])];
      }
    } else if (isRecord(current) || (current === undefined && keys.length === 0 && key === "directories" && isRecord(value))) {
      if (isRecord(value)) out[key] = merge(isRecord(current) ? current : {}, value, [...keys, key]);
    } else if (Array.isArray(current)) {
      if (Array.isArray(value) && (!current.length || value.every(item => typeof item === typeof current[0]))) out[key] = value;
    } else if (current === undefined || (typeof value === typeof current && (typeof value !== "number" || Number.isFinite(value)))) out[key] = value;
  }
  return out;
}
