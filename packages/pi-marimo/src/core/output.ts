// What a cell printed, kept compact for the notebook view (never for the agent's snapshot): the
// last output as text (HTML stripped, tables and images named), and the last console lines.
export type OutputKind = "text" | "table" | "image" | "chart" | "other";

export interface CellOutput {
  kind: OutputKind;
  text: string;
  /** A PNG the view can draw inline (base64, no data: prefix), when the output is small enough. */
  image?: { mime: "image/png"; data: string };
}

export interface ConsoleLine {
  stream: "stdout" | "stderr";
  text: string;
}

const MAX_TEXT = 8_000;
/** Largest PNG kept for inline drawing, as base64 characters (about 1.5 MB of image). */
const MAX_IMAGE = 2_000_000;

const pngOf = (data: string): CellOutput["image"] | undefined => {
  const b64 = data.replace(/^data:image\/png;base64,/iu, "").replace(/\s+/gu, "");
  return b64.length > 0 && b64.length <= MAX_IMAGE && /^[A-Za-z0-9+/]+=*$/u.test(b64) ? { mime: "image/png", data: b64 } : undefined;
};
const MAX_CONSOLE_LINES = 40;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function decode(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (whole, dec, hex, name) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ENTITIES[String(name).toLowerCase()] ?? whole;
  });
}

/** HTML as plain text: block ends become newlines, tags go, entities are decoded. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, "")
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/pre|\/ul|\/ol|\/table)\b[^>]*>/giu, "\n")
      .replace(/<\/t[dh]>/giu, "\t")
      .replace(/<[^>]*>/gu, ""),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

const clip = (text: string): string => (text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}…`);

/** A cell-op `output` as something to show, or undefined for an empty output (or an error: see Cell.error). */
export function summarizeOutput(raw: unknown): CellOutput | undefined {
  const output = record(raw);
  const mime = typeof output.mimetype === "string" ? output.mimetype : "";
  const data = output.data;
  if (output.channel === "marimo-error" || mime.includes("marimo+error") || mime.includes("marimo+traceback")) return undefined;
  if (data === null || data === undefined || data === "") return undefined;
  if (mime.startsWith("image/")) {
    const image = mime === "image/png" && typeof data === "string" ? pngOf(data) : undefined;
    return { kind: "image", text: `[image ${mime.slice(6)}]`, ...(image ? { image } : {}) };
  }
  if (/vega|plotly|altair|bokeh/iu.test(mime)) return { kind: "chart", text: `[chart ${mime}]` };
  if (mime === "text/html" && typeof data === "string") {
    const table = /<marimo-table\b[^>]*?data-total-rows=(?:"|&quot;)?(\d+)/iu.exec(data);
    if (table) return { kind: "table", text: `[table, ${table[1]} row${table[1] === "1" ? "" : "s"}]` };
    if (/<marimo-table\b/iu.test(data)) return { kind: "table", text: "[table]" };
    // matplotlib and PIL figures arrive as an <img> with a PNG data URL.
    const img = /<img\b[^>]*?\bsrc=["']?(data:image\/png;base64,[A-Za-z0-9+/=\s]+)/iu.exec(data);
    const embedded = img ? pngOf(img[1]!) : undefined;
    const text = htmlToText(data);
    if (embedded && !text) return { kind: "image", text: "[image png]", image: embedded };
    if (text) return { kind: "text", text: clip(text) };
    if (/<(?:img|svg|iframe|canvas|marimo-[a-z-]+)\b/iu.test(data)) return { kind: "chart", text: "[interactive output: o opens the notebook]" };
    return undefined;
  }
  if (typeof data === "string") return { kind: "text", text: clip(data) };
  try {
    return { kind: "other", text: clip(JSON.stringify(data, null, 1) ?? "") };
  } catch {
    return { kind: "other", text: `[${mime || "output"}]` };
  }
}

/** The console of a cell-op: marimo sends one message or a list, each with a `channel` and `data`. */
export function consoleLines(raw: unknown): { reset: boolean; lines: ConsoleLine[] } {
  const items = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  if (Array.isArray(raw) && !raw.length) return { reset: true, lines: [] };
  const lines: ConsoleLine[] = [];
  for (const item of items) {
    const o = record(item);
    if (typeof o.data !== "string" || !o.data) continue;
    const text = o.mimetype === "text/html" ? htmlToText(o.data) : o.data;
    const stream = o.channel === "stderr" ? "stderr" : "stdout";
    for (const line of text.replace(/\r/gu, "\n").split("\n")) lines.push({ stream, text: line });
  }
  return { reset: false, lines };
}

export function appendConsole(existing: ConsoleLine[] | undefined, raw: unknown): ConsoleLine[] | undefined {
  const { reset, lines } = consoleLines(raw);
  if (reset) return undefined;
  if (!lines.length) return existing;
  // A chunk that ends without a newline continues the previous line.
  const next = [...(existing ?? []), ...lines].filter((l, i, all) => l.text !== "" || i < all.length - 1);
  return next.slice(-MAX_CONSOLE_LINES);
}
