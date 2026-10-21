// Quiz mode's hidden reply blocks. Sidebar's model cannot get a tool of its own (its tool list is
// main's, for the cache), so it reports through tagged blocks in its reply:
//   <quiz-key>…</quiz-key>          the private rubric for the question it just asked
//   <quiz-update>{…}</quiz-update>  one graded answer, as JSON
// Both stay in Sidebar's stored thread (the model reads its own key when it grades) and are never
// shown in the panel.

export type QuizResult = "correct" | "partial" | "wrong" | "skipped";

export interface QuizUpdate {
  /** A short, stable kebab-case id, reused for the same concept across questions. */
  concept: string;
  title: string;
  result: QuizResult;
  /** 1 recall, 2 apply, 3 transfer to a new scenario. */
  difficulty: 1 | 2 | 3;
  paths: string[];
  note?: string;
}

const HIDDEN = /<(quiz-key|quiz-update)>[\s\S]*?<\/\1>/g;
const UPDATE = /<quiz-update>([\s\S]*?)<\/quiz-update>/g;
const RESULTS = new Set<QuizResult>(["correct", "partial", "wrong", "skipped"]);
const OPENERS = ["<quiz-key>", "<quiz-update>"];

/**
 * Reply text without its hidden blocks. A block still streaming (opened, not yet closed) is cut
 * from its opening tag, and a tag still being typed at the very end is held back, so the rubric
 * never flashes on screen.
 */
export function stripHidden(text: string): string {
  if (!text.includes("<")) return text;
  let out = text.replace(HIDDEN, "");
  for (const opener of OPENERS) {
    const at = out.indexOf(opener);
    if (at !== -1) out = out.slice(0, at);
  }
  const lt = out.lastIndexOf("<");
  if (lt !== -1) {
    const tail = out.slice(lt);
    if (OPENERS.some((opener) => opener.startsWith(tail))) out = out.slice(0, lt);
  }
  return out === text ? text : out.replace(/\n{3,}/g, "\n\n").trimEnd();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** One update, validated; undefined for anything that is not a usable grade. */
export function parseUpdate(raw: unknown): QuizUpdate | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === "string" ? r.title.trim().slice(0, 120) : "";
  const concept = slug(typeof r.concept === "string" && r.concept.trim() ? r.concept : title);
  const result = r.result as QuizResult;
  if (!concept || !RESULTS.has(result)) return undefined;
  const d = Number(r.difficulty);
  const difficulty = (d === 1 || d === 2 || d === 3 ? d : 2) as 1 | 2 | 3;
  const paths = Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string" && p.length > 0).slice(0, 12) : [];
  const note = typeof r.note === "string" && r.note.trim() ? r.note.trim().slice(0, 300) : undefined;
  return { concept, title: title || concept, result, difficulty, paths, ...(note ? { note } : {}) };
}

/** Every grade in a reply, plus how many blocks could not be read. */
export function parseUpdates(text: string): { updates: QuizUpdate[]; invalid: number } {
  const updates: QuizUpdate[] = [];
  let invalid = 0;
  for (const match of text.matchAll(UPDATE)) {
    let parsed: unknown;
    try { parsed = JSON.parse(match[1]!.trim()); } catch { invalid++; continue; }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      const update = parseUpdate(item);
      if (update) updates.push(update);
      else invalid++;
    }
  }
  return { updates, invalid };
}

type Block = { type?: string; text?: string };

/** The text of an assistant message's text blocks. */
export function messageText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return (message.content as Block[]).filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

/** A copy of an assistant message for display: hidden blocks stripped from its text blocks. */
export function displayMessage<T extends { role?: string; content?: unknown }>(message: T): T {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return message;
  const content = message.content as Block[];
  let changed = false;
  const shown = content.map((b) => {
    if (b?.type !== "text" || typeof b.text !== "string") return b;
    const text = stripHidden(b.text);
    if (text === b.text) return b;
    changed = true;
    return { ...b, text };
  });
  return changed ? { ...message, content: shown } : message;
}
