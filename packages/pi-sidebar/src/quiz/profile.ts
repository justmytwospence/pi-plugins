// What you know about one repository: the concepts quiz mode has asked you about, with the evidence
// your answers gave. Kept per repository (git root, else the working directory) under Pi's agent
// directory, so it carries across sessions.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { QuizUpdate } from "./protocol.ts";

const DAY = 86_400_000;
/** Old evidence counts half as much after this long, so what you have not shown lately comes due. */
export const HALF_LIFE_DAYS = 14;
/** Mastery from this on, with enough distinct correct answers, counts as proven. */
export const PROVEN_MASTERY = 0.8;
export const PROVEN_CORRECT = 2;
/** Below this, after at least one answer, a concept is shaky. */
export const SHAKY_MASTERY = 0.5;
const MAX_PATHS = 20;

export interface Concept {
  id: string;
  title: string;
  paths: string[];
  /** Beta evidence beyond the uniform prior: weighted correct and wrong answers. */
  success: number;
  failure: number;
  attempts: number;
  correct: number;
  /** When evidence last arrived (decay runs from here). */
  updatedAt: number;
  lastResult?: QuizUpdate["result"];
  lastNote?: string;
}

export interface Profile {
  version: 1;
  root: string;
  concepts: Record<string, Concept>;
}

export type Standing = "proven" | "learning" | "shaky" | "due" | "new";

export function emptyProfile(root: string): Profile {
  return { version: 1, root, concepts: {} };
}

/** Evidence as of `now`: the prior plus decayed success and failure. */
export function mastery(concept: Concept, now: number): number {
  const weight = decay(concept, now);
  const a = 1 + concept.success * weight;
  const b = 1 + concept.failure * weight;
  return a / (a + b);
}

function decay(concept: Concept, now: number): number {
  const days = Math.max(0, now - concept.updatedAt) / DAY;
  return 0.5 ** (days / HALF_LIFE_DAYS);
}

export function standing(concept: Concept, now: number): Standing {
  if (concept.attempts === 0 || concept.success + concept.failure === 0) return "new";
  const m = mastery(concept, now);
  const stale = (now - concept.updatedAt) / DAY > HALF_LIFE_DAYS;
  if (stale && concept.correct > 0) return "due";
  if (m >= PROVEN_MASTERY && concept.correct >= PROVEN_CORRECT) return "proven";
  if (m < SHAKY_MASTERY) return "shaky";
  return "learning";
}

const WEIGHT: Record<1 | 2 | 3, number> = { 1: 1, 2: 1.5, 3: 2 };

/** The profile with one graded answer added. Older evidence is decayed into the new total. */
export function applyUpdate(profile: Profile, update: QuizUpdate, now: number): Profile {
  const existing = profile.concepts[update.concept];
  const weight = existing ? decay(existing, now) : 1;
  const concept: Concept = existing
    ? { ...existing, success: existing.success * weight, failure: existing.failure * weight, paths: [...existing.paths] }
    : { id: update.concept, title: update.title, paths: [], success: 0, failure: 0, attempts: 0, correct: 0, updatedAt: now };
  if (update.title && update.title !== update.concept) concept.title = update.title;
  for (const p of update.paths) if (!concept.paths.includes(p)) concept.paths.push(p);
  concept.paths = concept.paths.slice(-MAX_PATHS);
  const w = WEIGHT[update.difficulty];
  concept.attempts += 1;
  if (update.result === "correct") {
    concept.success += w;
    concept.correct += 1;
  } else if (update.result === "partial") {
    concept.success += w / 2;
    concept.failure += w / 2;
  } else if (update.result === "wrong") {
    concept.failure += w;
  }
  concept.updatedAt = now;
  concept.lastResult = update.result;
  if (update.note) concept.lastNote = update.note;
  else delete concept.lastNote;
  return { ...profile, concepts: { ...profile.concepts, [concept.id]: concept } };
}

function touches(concept: Concept, changed: readonly string[]): boolean {
  return concept.paths.some((p) => changed.some((c) => c === p || c.startsWith(`${p.replace(/\/$/, "")}/`) || p.startsWith(`${c.replace(/\/$/, "")}/`)));
}

const RANK: Record<Standing, number> = { shaky: 0, due: 1, learning: 2, new: 3, proven: 4 };

/** Concepts worth the model's attention: those on changed files first, then the weakest. */
export function relevantConcepts(profile: Profile, changed: readonly string[], now: number, limit = 30): Concept[] {
  return Object.values(profile.concepts)
    .map((concept) => ({ concept, near: touches(concept, changed), rank: RANK[standing(concept, now)], m: mastery(concept, now) }))
    .sort((a, b) => Number(b.near) - Number(a.near) || a.rank - b.rank || a.m - b.m || a.concept.id.localeCompare(b.concept.id))
    .slice(0, limit)
    .map((entry) => entry.concept);
}

export function ago(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One line per concept for the model: id, title, standing and evidence. */
export function profileSummary(profile: Profile, changed: readonly string[], now: number, limit = 30): string {
  const concepts = relevantConcepts(profile, changed, now, limit);
  if (concepts.length === 0) return "No concepts yet: this is the user's first quiz in this repository.";
  const total = Object.keys(profile.concepts).length;
  const lines = concepts.map((c) => {
    const parts = [`${Math.round(mastery(c, now) * 100)}%`, standing(c, now), `${c.correct}/${c.attempts} correct`, `last ${ago(now - c.updatedAt)}`];
    if (c.lastNote) parts.push(`note: ${c.lastNote}`);
    return `- ${c.id}: ${c.title} (${parts.join(", ")})`;
  });
  if (total > concepts.length) lines.push(`(${total - concepts.length} more concepts not listed.)`);
  return lines.join("\n");
}

export function counts(profile: Profile, now: number): Record<Standing, number> {
  const out: Record<Standing, number> = { proven: 0, learning: 0, shaky: 0, due: 0, new: 0 };
  for (const concept of Object.values(profile.concepts)) out[standing(concept, now)] += 1;
  return out;
}

function bar(fraction: number, width = 10): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/** `/quiz progress`: every concept, strongest last, with a mastery bar. */
export function progressLines(profile: Profile, now: number): string[] {
  const concepts = Object.values(profile.concepts);
  if (concepts.length === 0) return ["No quiz answers in this repository yet. /quiz starts one."];
  const c = counts(profile, now);
  const head = `${concepts.length} concepts: ${c.proven} proven, ${c.learning} learning, ${c.shaky} shaky, ${c.due} due for review`;
  const rows = concepts
    .sort((a, b) => RANK[standing(a, now)] - RANK[standing(b, now)] || mastery(a, now) - mastery(b, now))
    .map((concept) => `${bar(mastery(concept, now))} ${String(Math.round(mastery(concept, now) * 100)).padStart(3)}%  ${standing(concept, now).padEnd(8)} ${concept.title} (${concept.correct}/${concept.attempts}, ${ago(now - concept.updatedAt)})`);
  return [head, ...rows];
}

/** Where a repository's profile lives: a readable name plus a hash of the full path. */
export function profilePath(dir: string, root: string): string {
  const base = path.basename(root).replace(/[^A-Za-z0-9._-]+/g, "-") || "root";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 10);
  return path.join(dir, `${base}-${hash}.json`);
}

function valid(raw: unknown, root: string): Profile | undefined {
  const p = raw as Partial<Profile> | undefined;
  if (!p || p.version !== 1 || typeof p.concepts !== "object" || p.concepts === null || Array.isArray(p.concepts)) return undefined;
  const concepts: Record<string, Concept> = {};
  for (const [id, c] of Object.entries(p.concepts)) {
    if (!c || typeof c !== "object") continue;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    concepts[id] = {
      id,
      title: typeof c.title === "string" ? c.title : id,
      paths: Array.isArray(c.paths) ? c.paths.filter((x): x is string => typeof x === "string") : [],
      success: n(c.success),
      failure: n(c.failure),
      attempts: n(c.attempts),
      correct: n(c.correct),
      updatedAt: n(c.updatedAt),
      ...(c.lastResult ? { lastResult: c.lastResult } : {}),
      ...(typeof c.lastNote === "string" ? { lastNote: c.lastNote } : {}),
    };
  }
  return { version: 1, root, concepts };
}

/** Loads and saves one repository's profile. An unreadable file is set aside, not overwritten. */
export class ProfileStore {
  readonly file: string;
  private cached: Profile | undefined;

  constructor(private readonly dir: string, readonly root: string) {
    this.file = profilePath(dir, root);
  }

  load(): Profile {
    if (this.cached) return this.cached;
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch { return (this.cached = emptyProfile(this.root)); }
    let parsed: Profile | undefined;
    try { parsed = valid(JSON.parse(text), this.root); } catch { parsed = undefined; }
    if (!parsed) {
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch { /* left in place */ }
      parsed = emptyProfile(this.root);
    }
    return (this.cached = parsed);
  }

  save(profile: Profile): void {
    this.cached = profile;
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  apply(updates: readonly QuizUpdate[], now: number): Profile {
    let profile = this.load();
    for (const update of updates) profile = applyUpdate(profile, update, now);
    if (updates.length > 0) this.save(profile);
    return profile;
  }
}
