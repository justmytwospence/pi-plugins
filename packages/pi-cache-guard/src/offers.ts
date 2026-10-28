// Model choice in the cold-cache question. A cold cache re-sends the whole conversation whatever the
// model, so the miss is also the cheapest moment to change model. cache-guard does not pick models
// itself: before the question it asks other extensions (pi-auto-effort, for one) for offers on
// `cache:model-offers`, and after it says which offer was taken on `cache:model-choice`. The listener
// that made the offer applies it; cache-guard never switches the model.

/** Emitted before the cold-cache question; listeners push promises of offers into `offers`. */
export const MODEL_OFFERS = "cache:model-offers";
/** Emitted after the cold-cache question: the offer taken, or null for every other answer. */
export const MODEL_CHOICE = "cache:model-choice";
/** The longest the question waits for offers, counted from the emit. */
export const OFFER_TIMEOUT_MS = 2_500;
/** Longest note shown in a menu line; a longer one is left out. */
export const NOTE_MAX = 32;
/** Longest offer label; a longer one is cut. */
const LABEL_MAX = 40;

/** A model another extension offers for the held prompt. */
export interface ModelOffer {
  /** `provider/id`. */
  model: string;
  /** How the menu names it, for example "Sonnet 5.5". */
  label: string;
  /** Jev's pick: listed first, so Enter takes it. At most one is honored (the first). */
  recommended?: boolean;
  /** A few words shown after the token count when short (at most NOTE_MAX characters). */
  note?: string;
}

/**
 * `cache:model-offers`'s payload, mutable. A listener pushes a promise (or a plain array) of offers
 * into `offers` while the emit runs (Pi's event bus calls listeners synchronously); anything pushed
 * later is not seen. The question waits for them at most OFFER_TIMEOUT_MS.
 */
export interface ModelOffers {
  /** The held prompt, as typed. */
  text: string;
  /** Tokens the miss re-caches on any model. */
  tokens: number;
  offers: Array<Promise<ModelOffer[] | undefined>>;
}

/** `cache:model-choice`'s payload: the offer taken (`provider/id`), or null. */
export interface ModelChoice {
  text: string;
  model: string | null;
}

/**
 * The offers that arrived within `timeoutMs`, in the order they were pushed, cleaned by
 * `cleanOffers`. Rejected or late promises count as no offers. No promises: [] at once, no timer.
 */
export async function collectOffers(pending: readonly unknown[], current: string | undefined, timeoutMs = OFFER_TIMEOUT_MS): Promise<ModelOffer[]> {
  if (!pending.length) return [];
  const results: unknown[][] = [];
  const settled = Promise.allSettled(pending.map(async (offer, i) => {
    const value = await offer;
    results[i] = Array.isArray(value) ? value : [];
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([settled, timeout]);
  } finally {
    clearTimeout(timer);
  }
  // Holes (still pending) drop out of flat().
  return cleanOffers(results.flat(), current);
}

/**
 * Well-formed offers only: `model` a `provider/id`, a non-empty `label`, put on one line. Drops the
 * current model, repeated models and repeated labels (the menu tells its lines apart by text).
 */
export function cleanOffers(raw: readonly unknown[], current: string | undefined): ModelOffer[] {
  const out: ModelOffer[] = [];
  const models = new Set<string>(current ? [current] : []);
  const labels = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const offer = item as Record<string, unknown>;
    const model = typeof offer.model === "string" ? offer.model.trim() : "";
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1 || /\s/u.test(model)) continue;
    const label = typeof offer.label === "string" ? oneLine(offer.label, LABEL_MAX) : "";
    if (!label || models.has(model) || labels.has(label.toLowerCase())) continue;
    models.add(model);
    labels.add(label.toLowerCase());
    const note = typeof offer.note === "string" ? oneLine(offer.note, Number.POSITIVE_INFINITY) : "";
    out.push({ model, label, ...(offer.recommended === true ? { recommended: true } : {}), ...(note ? { note } : {}) });
  }
  return out;
}

/** The note as a menu-line suffix, or "" when absent or too long for one line. */
export function noteSuffix(offer: ModelOffer): string {
  return offer.note && offer.note.length <= NOTE_MAX ? `; ${offer.note}` : "";
}

/** `text` on one line with single spaces, cut to `max` characters. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
