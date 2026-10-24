// Sidebar's model: main's own (the default, sharing main's prompt cache), or one of your favorites,
// which reads main's session as a transcript of another agent's work and keeps its own cache.
// The choice is stored in main's session, so it follows /tree, resume and /reload.

export const MODEL_ENTRY = "sidebar:model";
/** Comma-separated favorites: `provider/id`, a bare id, or a glob such as `anthropic/claude-opus-*` (its newest match). */
export const MODELS_ENV = "PI_SIDEBAR_MODELS";
/** The model new sessions start with: `same` (default) or a favorite's pattern or name. */
export const MODEL_ENV = "PI_SIDEBAR_MODEL";
export const SAME = "same";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** The fields of Pi's model objects that Sidebar uses. */
export interface ModelLike {
  provider: string;
  id: string;
  api: string;
  name?: string;
  contextWindow?: number;
}

export interface ModelEntry {
  version: 1;
  /** `same`, or the favorite's pattern (kept as written, so a glob stays "the newest"). */
  model: string;
  at: number;
}

/** A favorite as configured, and what it resolves to now (nothing when no model with a login matches). */
export interface Favorite<M extends ModelLike = ModelLike> {
  pattern: string;
  model?: M;
  /** A thinking level given as `pattern:level`. */
  thinking?: string;
}

export type ModelChoice<M extends ModelLike = ModelLike> =
  | { kind: "same" }
  | { kind: "other"; pattern: string; model: M; thinking?: string; label: string }
  | { kind: "unavailable"; pattern: string };

type Entry = { type?: string; customType?: string; data?: unknown };

export function parsePatterns(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean);
}

/** Favorites from PI_SIDEBAR_MODELS, else Pi's own favorites (`enabledModels`). */
export function favoritePatterns(env: NodeJS.ProcessEnv, enabledModels: readonly string[] | undefined): string[] {
  const own = parsePatterns(env[MODELS_ENV]);
  return own.length ? own : [...(enabledModels ?? [])].map((p) => p.trim()).filter(Boolean);
}

/** `pattern:level` split into the pattern and a valid thinking level. */
export function splitThinking(pattern: string): { pattern: string; thinking?: string } {
  const at = pattern.lastIndexOf(":");
  if (at > 0 && THINKING_LEVELS.has(pattern.slice(at + 1).toLowerCase())) return { pattern: pattern.slice(0, at), thinking: pattern.slice(at + 1).toLowerCase() };
  return { pattern };
}

function globRegex(glob: string): RegExp {
  const source = glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${source}$`, "i");
}

const DATED = /-\d{8}$/;

/** Numbers in an id, for "newest first" (claude-opus-5-5 over 4-8, gpt-6.1-sol over gpt-6-sol). */
function versionOf(id: string): number[] {
  return (id.replace(DATED, "").match(/\d+/g) ?? []).map(Number);
}

/** Positive when `a` is newer than `b`: higher version numbers, then an alias over a dated snapshot, then the later date. */
export function compareNewest(a: string, b: string): number {
  const va = versionOf(a);
  const vb = versionOf(b);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] ?? -1) - (vb[i] ?? -1);
    if (d !== 0) return d;
  }
  const da = DATED.test(a);
  const db = DATED.test(b);
  if (da !== db) return da ? -1 : 1;
  if (da && db) return a.localeCompare(b);
  return b.length - a.length;
}

/** The model a pattern names: `provider/id`, a bare id (unambiguous), or a glob's newest match. */
export function resolvePattern<M extends ModelLike>(raw: string, models: readonly M[]): Favorite<M> {
  const { pattern, thinking } = splitThinking(raw.trim());
  const slash = pattern.indexOf("/");
  const provider = slash > 0 ? pattern.slice(0, slash) : undefined;
  const id = slash > 0 ? pattern.slice(slash + 1) : pattern;
  const pool = provider ? models.filter((m) => m.provider.toLowerCase() === provider.toLowerCase()) : models;
  let model: M | undefined;
  if (id.includes("*")) {
    const re = globRegex(id);
    model = pool.filter((m) => re.test(m.id)).sort((a, b) => compareNewest(b.id, a.id))[0];
  } else {
    const exact = pool.filter((m) => m.id.toLowerCase() === id.toLowerCase());
    model = exact.length === 1 || provider ? exact[0] : undefined;
  }
  return { pattern: raw.trim(), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}

export function modelKey(model: Pick<ModelLike, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

/** A short name for headers and lists: Pi's display name, else the id. */
export function modelLabel(model: ModelLike): string {
  return model.name?.trim() || model.id;
}

/**
 * The favorite (or any model with a login) a typed name means: an exact pattern or `provider/id`,
 * else the one favorite whose id or name contains it, else the one model whose id does.
 */
export function findModel<M extends ModelLike>(query: string, favorites: readonly Favorite<M>[], available: readonly M[]): Favorite<M> | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const exact = favorites.find((f) => f.pattern.toLowerCase() === q || (f.model && modelKey(f.model).toLowerCase() === q));
  if (exact) return exact;
  const resolved = favorites.filter((f) => f.model);
  const byId = resolved.filter((f) => f.model!.id.toLowerCase() === q);
  if (byId.length === 1) return byId[0];
  const partial = resolved.filter((f) => f.model!.id.toLowerCase().includes(q) || modelLabel(f.model!).toLowerCase().includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return undefined;
  const direct = resolvePattern(query, available);
  if (direct.model) return direct;
  const loose = available.filter((m) => m.id.toLowerCase().includes(q));
  return loose.length === 1 ? { pattern: modelKey(loose[0]!), model: loose[0]! } : undefined;
}

/** What a stored choice means now. */
export function resolveChoice<M extends ModelLike>(choice: string, available: readonly M[]): ModelChoice<M> {
  if (!choice || choice === SAME) return { kind: "same" };
  const fav = resolvePattern(choice, available);
  if (!fav.model) return { kind: "unavailable", pattern: choice };
  return { kind: "other", pattern: choice, model: fav.model, ...(fav.thinking ? { thinking: fav.thinking } : {}), label: modelLabel(fav.model) };
}

/** Whether a chosen model is main's own (then Sidebar shares main's cache as if `same` were chosen). */
export function isMainModel(model: Pick<ModelLike, "provider" | "id">, main: { provider: string; id: string } | undefined): boolean {
  return !!main && model.provider === main.provider && model.id === main.id;
}

/** The last choice stored on a branch. */
export function modelFromBranch(branch: readonly unknown[]): ModelEntry | undefined {
  let found: ModelEntry | undefined;
  for (const raw of branch) {
    const entry = raw as Entry;
    if (entry?.type !== "custom" || entry.customType !== MODEL_ENTRY) continue;
    const data = entry.data as Partial<ModelEntry> | undefined;
    if (data?.version === 1 && typeof data.model === "string") found = { version: 1, model: data.model, at: Number(data.at) || 0 };
  }
  return found;
}

export function modelDefault(env: NodeJS.ProcessEnv = process.env): string {
  return env[MODEL_ENV]?.trim() || SAME;
}

/** The next choice in `same, favorites…` (Ctrl+P forward, Shift+Ctrl+P back), skipping unavailable favorites. */
export function cycleChoice(current: string, favorites: readonly Favorite[], direction: 1 | -1): string {
  const options = [SAME, ...favorites.filter((f) => f.model).map((f) => f.pattern)];
  const at = options.indexOf(current);
  const from = at === -1 ? 0 : at;
  return options[(from + direction + options.length) % options.length]!;
}
