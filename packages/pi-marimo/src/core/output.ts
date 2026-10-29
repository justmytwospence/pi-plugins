// What a cell printed, kept compact for the notebook view (never for the agent's snapshot): the
// last output as text (HTML stripped, images named), its table's first page and its widgets, and
// the last console lines.
export type OutputKind = "text" | "table" | "image" | "chart" | "widgets" | "other";

/** The rows a table output carries (marimo sends its first page), as text. */
export interface TableData {
  columns: string[];
  numeric: boolean[];
  rows: string[][];
  /** How many rows the whole table has (`many`: marimo did not count them). */
  totalRows?: number | "many";
  totalColumns?: number;
}

export type WidgetKind = "slider" | "number" | "range-slider" | "checkbox" | "switch" | "text" | "text-area" | "dropdown" | "radio" | "multiselect" | "button" | "date" | "other";

/** A marimo UI element in an output (`<marimo-ui-element object-id>`), with what the view needs to show and drive it. */
export interface Widget {
  objectId: string;
  kind: WidgetKind;
  /** The element's tag, `marimo-slider`. */
  tag: string;
  label: string;
  /** The value the element was created with (its current one may differ: NotebookState.uiValues). */
  initial: unknown;
  options: string[];
  start?: number;
  stop?: number;
  step?: number;
  steps: number[];
  disabled: boolean;
}

export interface CellOutput {
  kind: OutputKind;
  text: string;
  /** A PNG the view can draw inline (base64, no data: prefix), when the output is small enough. */
  image?: { mime: "image/png"; data: string };
  /** A Vega or Vega-Lite spec (JSON text) the view can turn into `image`, for a chart. */
  vega?: string;
  /** A Plotly figure (JSON text with `data` and `layout`), likewise. */
  plotly?: string;
  /** A table's first page, when the output is a table. */
  table?: TableData;
  /** The UI elements the output shows. */
  widgets?: Widget[];
}

export interface ConsoleLine {
  stream: "stdout" | "stderr";
  text: string;
}

const MAX_TEXT = 8_000;
/** Largest PNG kept for inline drawing, as base64 characters (about 1.5 MB of image). */
const MAX_IMAGE = 2_000_000;
/** Largest chart spec kept, in characters (Vega-Lite specs carry their data). */
const MAX_SPEC = 1_500_000;

const vegaOf = (spec: unknown): string | undefined => {
  const text = typeof spec === "string" ? spec : spec !== null && typeof spec === "object" ? JSON.stringify(spec) : "";
  return text.length > 1 && text.length <= MAX_SPEC && text.trimStart().startsWith("{") ? text : undefined;
};

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

/** The JSON value starting at `from` in `text` (an object or array), found by balancing brackets outside strings. */
function jsonAt(text: string, from: number): { json: string; end: number } | undefined {
  let i = from;
  while (/\s/u.test(text[i] ?? "")) i++;
  const open = text[i];
  if (open !== "{" && open !== "[") return undefined;
  let depth = 0;
  let inString = false;
  for (let j = i; j < text.length; j++) {
    const c = text[j]!;
    if (inString) {
      if (c === "\\") j++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if ((c === "}" || c === "]") && --depth === 0) return { json: text.slice(i, j + 1), end: j + 1 };
  }
  return undefined;
}

/** A Plotly figure from marimo's HTML: `<marimo-plotly data-figure>` (mo.ui.plotly) or a figure's own `Plotly.newPlot(id, data, layout, ...)` page in an iframe. */
export function plotlyFrom(html: string): string | undefined {
  const attr = /<marimo-plotly\b[^>]*?\bdata-figure=(?:'([^']*)'|"([^"]*)")/iu.exec(html);
  if (attr) return vegaOf(decode(attr[1] ?? attr[2] ?? ""));
  const srcdoc = /<iframe\b[^>]*?\bsrcdoc=(?:'([^']*)'|"([^"]*)")/iu.exec(html);
  const page = srcdoc ? decode(srcdoc[1] ?? srcdoc[2] ?? "") : html;
  const call = /Plotly\.newPlot\(\s*(?:"[^"]*"|'[^']*')\s*,/u.exec(page);
  if (!call) return undefined;
  const data = jsonAt(page, call.index + call[0].length);
  if (!data || !data.json.startsWith("[")) return undefined;
  const after = /^\s*,/u.exec(page.slice(data.end));
  const layout = after ? jsonAt(page, data.end + after[0].length) : undefined;
  return vegaOf(`{"data":${data.json},"layout":${layout && layout.json.startsWith("{") ? layout.json : "{}"}}`);
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

/** The attributes of an opening tag, entity-decoded. */
export function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s>]+))/gu;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1]!] = decode(m[2] ?? m[3] ?? m[4] ?? "");
  return out;
}

function json(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const MAX_TABLE_ROWS = 50;
const MAX_TABLE_COLUMNS = 50;

function cellText(value: unknown): string {
  const text = value === null || value === undefined ? "" : typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value) ?? "";
  const flat = text.replace(/\s+/gu, " ");
  return flat.length <= 200 ? flat : `${flat.slice(0, 199)}…`;
}

/** A `<marimo-table>`'s first page (marimo double-encodes it: a JSON string of the JSON rows) and its row count. */
export function marimoTable(html: string): { table?: TableData; totalRows?: number | "many" } | undefined {
  const tag = /<marimo-table\b[^>]*>/iu.exec(html)?.[0];
  if (!tag) return undefined;
  const a = attributes(tag);
  const total = json(a["data-total-rows"]);
  const totalRows = typeof total === "number" && Number.isFinite(total) ? total : total === "too_many" ? "many" as const : undefined;
  let data = json(a["data-data"]);
  if (typeof data === "string" && data.trimStart().startsWith("[")) data = json(data);
  const objects = Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r)) : [];
  const out: { table?: TableData; totalRows?: number | "many" } = totalRows !== undefined ? { totalRows } : {};
  if (!objects.length) return out;
  const columns = Object.keys(objects[0]!).filter((k) => !k.startsWith("_marimo")).slice(0, MAX_TABLE_COLUMNS);
  const types = json(a["data-field-types"]);
  const numericNames = new Set<string>();
  if (Array.isArray(types)) {
    for (const entry of types) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const type = Array.isArray(entry[1]) ? entry[1][0] : undefined;
      if (type === "integer" || type === "number") numericNames.add(entry[0]);
    }
  }
  const columnsTotal = json(a["data-total-columns"]);
  out.table = {
    columns,
    numeric: columns.map((c) => numericNames.has(c)),
    rows: objects.slice(0, MAX_TABLE_ROWS).map((r) => columns.map((c) => cellText(r[c]))),
    ...(totalRows !== undefined ? { totalRows } : {}),
    ...(typeof columnsTotal === "number" && Number.isFinite(columnsTotal) ? { totalColumns: columnsTotal } : {}),
  };
  return out;
}

const NUMBER = /^-?[\d,]*\.?\d+(?:e[-+]?\d+)?%?$/iu;

/** The first HTML `<table>` (pandas, markdown tables) as rows; undefined without a body row. */
export function htmlTable(html: string): TableData | undefined {
  const table = /<table\b[\s\S]*?<\/table>/iu.exec(html)?.[0];
  if (!table) return undefined;
  const rows: Array<{ header: boolean; cells: string[] }> = [];
  for (const tr of table.match(/<tr\b[\s\S]*?<\/tr>/giu) ?? []) {
    const cells: string[] = [];
    const re = /<(t[hd])\b[^>]*>([\s\S]*?)<\/\1>/giu;
    for (let m = re.exec(tr); m; m = re.exec(tr)) cells.push(htmlToText(m[2] ?? "").replace(/\s+/gu, " ").trim());
    if (cells.length) rows.push({ header: /<th\b/iu.test(tr), cells });
  }
  const headerAt = rows.findIndex((r) => r.header);
  const header = headerAt === 0 ? rows[0]! : undefined;
  const body = (header ? rows.slice(1) : rows).slice(0, MAX_TABLE_ROWS);
  if (!body.length) return undefined;
  const width = Math.max(header?.cells.length ?? 0, ...body.map((r) => r.cells.length));
  const columns = Array.from({ length: width }, (_, i) => header?.cells[i] ?? `col ${i + 1}`);
  const cells = body.map((r) => Array.from({ length: width }, (_, i) => r.cells[i] ?? ""));
  return {
    columns,
    numeric: columns.map((_, i) => cells.some((r) => r[i]) && cells.every((r) => !r[i] || NUMBER.test(r[i]!))),
    rows: cells,
  };
}

const WIDGET_KINDS: Record<string, WidgetKind> = {
  "marimo-slider": "slider",
  "marimo-number": "number",
  "marimo-range-slider": "range-slider",
  "marimo-checkbox": "checkbox",
  "marimo-switch": "switch",
  "marimo-text": "text",
  "marimo-text-area": "text-area",
  "marimo-dropdown": "dropdown",
  "marimo-radio": "radio",
  "marimo-multiselect": "multiselect",
  "marimo-button": "button",
  "marimo-date": "date",
};
/** UI elements drawn some other way: tables, charts, anywidgets (Lens among them). */
const NOT_WIDGETS = new Set(["marimo-table", "marimo-plotly", "marimo-vega", "marimo-anywidget"]);
const MAX_WIDGETS = 16;

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The UI elements an output shows; every `data-*` attribute marimo writes is JSON. */
export function parseWidgets(html: string): Widget[] {
  const out: Widget[] = [];
  const re = /<marimo-ui-element\b([^>]*)>\s*<(marimo-[a-z-]+)\b([^>]*)>/giu;
  for (let m = re.exec(html); m && out.length < MAX_WIDGETS; m = re.exec(html)) {
    const objectId = attributes(m[1] ?? "")["object-id"];
    const tag = (m[2] ?? "").toLowerCase();
    if (!objectId || NOT_WIDGETS.has(tag)) continue;
    const a = attributes(m[3] ?? "");
    const label = json(a["data-label"]);
    const options = json(a["data-options"]);
    const steps = json(a["data-steps"]);
    const start = finite(json(a["data-start"]));
    const stop = finite(json(a["data-stop"]));
    const step = finite(json(a["data-step"]));
    out.push({
      objectId,
      kind: WIDGET_KINDS[tag] ?? "other",
      tag,
      label: label === null || label === undefined ? "" : htmlToText(String(label)).replace(/\s+/gu, " ").trim(),
      initial: json(a["data-initial-value"]),
      options: Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : [],
      ...(start !== undefined ? { start } : {}),
      ...(stop !== undefined ? { stop } : {}),
      ...(step !== undefined ? { step } : {}),
      steps: Array.isArray(steps) ? steps.filter((s): s is number => typeof s === "number" && Number.isFinite(s)) : [],
      disabled: json(a["data-disabled"]) === true,
    });
  }
  return out;
}

const rowCount = (n: number | "many" | undefined): string =>
  n === undefined ? "[table]" : n === "many" ? "[table, many rows]" : `[table, ${n} row${n === 1 ? "" : "s"}]`;

/** A cell-op `output` as something to show, or undefined for an empty output (or an error: see Cell.error). */
export function summarizeOutput(raw: unknown): CellOutput | undefined {
  const output = record(raw);
  const mime = typeof output.mimetype === "string" ? output.mimetype : "";
  const data = output.data;
  if (output.channel === "marimo-error" || mime.includes("marimo+error") || mime.includes("marimo+traceback")) return undefined;
  if (data === null || data === undefined || data === "") return undefined;
  // A mimebundle (matplotlib figures in marimo 0.25): the richest form the view can show.
  if (mime.includes("mimebundle")) {
    const bundle = typeof data === "string" ? (() => { try { return record(JSON.parse(data)); } catch { return {}; } })() : record(data);
    for (const kind of ["image/png", "application/vnd.vegalite.v5+json", "application/vnd.vegalite.v6+json", "text/html", "image/svg+xml", "text/markdown", "text/plain"]) {
      if (bundle[kind] !== undefined && bundle[kind] !== null && bundle[kind] !== "") return summarizeOutput({ channel: output.channel, mimetype: kind, data: bundle[kind] });
    }
    return undefined;
  }
  if (mime.startsWith("image/")) {
    const image = mime === "image/png" && typeof data === "string" ? pngOf(data) : undefined;
    return { kind: "image", text: `[image ${mime.slice(6)}]`, ...(image ? { image } : {}) };
  }
  if (/vega|plotly|altair|bokeh/iu.test(mime)) {
    const vega = /vnd\.vega(?:lite)?\b/iu.test(mime) ? vegaOf(data) : undefined;
    return { kind: "chart", text: `[chart ${mime}]`, ...(vega ? { vega } : {}) };
  }
  if (mime === "text/html" && typeof data === "string") {
    const widgets = parseWidgets(data);
    const extra = widgets.length ? { widgets } : {};
    const marimo = marimoTable(data);
    if (marimo) return { kind: "table", text: rowCount(marimo.totalRows), ...(marimo.table ? { table: marimo.table } : {}), ...extra };
    // matplotlib and PIL figures arrive as an <img> with a PNG data URL.
    const img = /<img\b[^>]*?\bsrc=["']?(data:image\/png;base64,[A-Za-z0-9+/=\s]+)/iu.exec(data);
    const embedded = img ? pngOf(img[1]!) : undefined;
    // mo.ui.altair_chart: the spec sits in the element's data-spec attribute.
    const spec = /<marimo-vega\b[^>]*?\bdata-spec=(?:'([^']*)'|"([^"]*)")/iu.exec(data);
    const vega = spec ? vegaOf(decode(spec[1] ?? spec[2] ?? "")) : undefined;
    if (vega) return { kind: "chart", text: "[chart vega-lite]", vega, ...extra };
    const plotly = plotlyFrom(data);
    if (plotly) return { kind: "chart", text: "[chart plotly]", plotly, ...extra };
    const text = htmlToText(data);
    if (embedded && !text) return { kind: "image", text: "[image png]", image: embedded, ...extra };
    // A table with little around it (a pandas frame, a markdown table) is drawn as one.
    const table = htmlTable(data);
    if (table) {
      const around = htmlToText(data.replace(/<table\b[\s\S]*?<\/table>/iu, ""));
      if (around.length <= 80) return { kind: "table", text: rowCount(table.rows.length), table, ...extra };
    }
    if (text) return { kind: "text", text: clip(text), ...extra };
    if (widgets.length) return { kind: "widgets", text: "", widgets };
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
    // Tracebacks are highlighted HTML on stderr.
    const traceback = o.mimetype === "application/vnd.marimo+traceback";
    const text = o.mimetype === "text/html" || traceback ? htmlToText(o.data) : o.data;
    const stream = o.channel === "stderr" || traceback ? "stderr" : "stdout";
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
