// A marimo table's own kernel functions (`search`, `get_column_summaries`, `calculate_top_k_rows`,
// `download_as`), called as the browser calls them: POST /api/kernel/function_call, with the result
// arriving on the notebook's message stream as `function-call-result` (NotebookState.functionResults).
import { randomBytes } from "node:crypto";
import { kernelPost } from "../ui/interrupt.js";
import { FUNCTION_CALL_PREFIX, type NotebookState } from "./notebook.js";
import { authHeaders } from "./registry.js";

export interface RpcTarget {
  attachment: { url: string; sessionId: string };
  notebook: NotebookState;
}

export interface RpcOptions {
  token?: string;
  waitMs?: number;
  post?: typeof kernelPost;
  fetchImpl?: typeof fetch;
}

export interface FilterCondition {
  type: "condition";
  column_id: string;
  operator: string;
  value?: unknown;
  negate: boolean;
}

export interface FilterGroup {
  type: "group";
  operator: "and";
  negate: false;
  children: FilterCondition[];
}

export interface SearchArgs {
  page_size: number;
  /** 0-based. */
  page_number: number;
  query?: string;
  sort?: Array<{ by: string; descending: boolean }>;
  filters?: FilterGroup;
}

export type CellStyles = Record<string, Record<string, Record<string, unknown>>>;

export interface SearchResult {
  records: Array<Record<string, unknown>>;
  totalRows: number | "many";
  cellStyles?: CellStyles;
}

export interface ColumnSummaries {
  stats: Record<string, Record<string, number | string | null>>;
  bins: Record<string, Array<{ bin_start: unknown; bin_end: unknown; count: number }>>;
  counts: Record<string, Array<{ value: unknown; count: number }>>;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Calls a function of a UI element (by its object id, the namespace) and returns its value. */
export async function callFunction(t: RpcTarget, namespace: string, functionName: string, args: unknown, o: RpcOptions = {}): Promise<unknown> {
  const id = FUNCTION_CALL_PREFIX + randomBytes(8).toString("hex");
  await (o.post ?? kernelPost)(t.attachment, "function_call", { functionCallId: id, namespace, functionName, args }, o.token);
  const deadline = Date.now() + (o.waitMs ?? 15_000);
  for (;;) {
    const result = t.notebook.functionResults.get(id);
    if (result) {
      t.notebook.functionResults.delete(id);
      if (!result.ok) throw new Error(result.message ?? `${functionName} failed`);
      return result.value;
    }
    if (Date.now() >= deadline) throw new Error(`marimo did not answer ${functionName}`);
    await sleep(50);
  }
}

/** The text a `data:` URL or a server file (`./@file/1-x.json`, relative to the server) holds. */
export async function fileText(t: RpcTarget, ref: string, o: RpcOptions = {}): Promise<string> {
  if (ref.startsWith("data:")) {
    const comma = ref.indexOf(",");
    const body = ref.slice(comma + 1);
    return /;base64\s*$/iu.test(ref.slice(0, comma)) ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body);
  }
  const url = new URL(ref.replace(/^\.\//u, ""), `${t.attachment.url}/`);
  const res = await (o.fetchImpl ?? fetch)(url, { headers: authHeaders(o.token), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`marimo answered ${res.status} for ${ref}`);
  return res.text();
}

/** A `search` result: the rows are inline JSON, or a file reference. */
export async function parseSearch(value: unknown, file: (ref: string) => Promise<string>): Promise<SearchResult> {
  const result = record(value);
  let data = result.data;
  if (typeof data === "string") data = JSON.parse(data.trimStart().startsWith("[") ? data : await file(data));
  const records = Array.isArray(data) ? data.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object" && !Array.isArray(r)) : [];
  const total = result.total_rows;
  const totalRows = typeof total === "number" ? total : total === "too_many" ? "many" as const : records.length;
  const styles = record(result.cell_styles);
  return { records, totalRows, ...(Object.keys(styles).length ? { cellStyles: styles as CellStyles } : {}) };
}

export async function searchTable(t: RpcTarget, objectId: string, args: SearchArgs, o: RpcOptions = {}): Promise<SearchResult> {
  return parseSearch(await callFunction(t, objectId, "search", args, o), (ref) => fileText(t, ref, o));
}

export function parseSummaries(raw: unknown): ColumnSummaries {
  const value = record(raw);
  return {
    stats: record(value.stats) as ColumnSummaries["stats"],
    bins: record(value.bin_values) as ColumnSummaries["bins"],
    counts: record(value.value_counts) as ColumnSummaries["counts"],
  };
}

export function parseTopK(raw: unknown): Array<[string, number]> {
  const value = record(raw);
  return Array.isArray(value.data) ? value.data.filter((e): e is [string, number] => Array.isArray(e) && e.length >= 2) : [];
}

export async function columnSummaries(t: RpcTarget, objectId: string, o: RpcOptions = {}): Promise<ColumnSummaries> {
  return parseSummaries(await callFunction(t, objectId, "get_column_summaries", {}, o));
}

export async function topK(t: RpcTarget, objectId: string, column: string, k: number, o: RpcOptions = {}): Promise<Array<[string, number]>> {
  return parseTopK(await callFunction(t, objectId, "calculate_top_k_rows", { column, k }, o));
}

export async function downloadCsv(t: RpcTarget, objectId: string, o: RpcOptions = {}): Promise<{ filename: string; text: string }> {
  const value = record(await callFunction(t, objectId, "download_as", { format: "csv" }, o));
  if (typeof value.error === "string" && value.error) throw new Error(value.error);
  if (typeof value.url !== "string") throw new Error("marimo returned no file");
  return { filename: typeof value.filename === "string" ? value.filename : "download.csv", text: await fileText(t, value.url, o) };
}
