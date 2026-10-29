// Python run in a notebook's kernel without touching its cells: marimo's scratchpad, through the same
// endpoint `marimo pair execute` uses (POST /api/kernel/execute). It sees the notebook's globals; what
// it prints streams back as server-sent events, then a `done` event with the result. Cancelling the
// request makes marimo interrupt the kernel.
import { htmlToText } from "../core/output.js";
import { SseParser } from "../core/sse.js";
import { kernelHeaders } from "./interrupt.js";

export interface ScratchEvent {
  stream: "stdout" | "stderr";
  text: string;
}

export interface ScratchResult {
  success: boolean;
  output?: { mimetype: string; data: string };
}

type StreamFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; body: AsyncIterable<Uint8Array> | null; text(): Promise<string> }>;

export async function runScratch(target: { url: string; sessionId: string }, code: string, token: string | undefined, onEvent: (e: ScratchEvent) => void, signal?: AbortSignal, fetchImpl: StreamFetch = fetch as unknown as StreamFetch): Promise<ScratchResult> {
  const post = async (fresh: boolean) =>
    fetchImpl(`${target.url}/api/kernel/execute`, {
      method: "POST",
      headers: { ...(await kernelHeaders(target, token, fetchImpl as never, fresh)), Accept: "text/event-stream" },
      body: JSON.stringify({ code }),
      ...(signal ? { signal } : {}),
    });
  let res = await post(false);
  // A restarted server has a new token.
  if (res.status === 401 || res.status === 403) res = await post(true);
  if (!res.ok || !res.body) throw new Error(`marimo answered ${res.status}`);
  const parser = new SseParser();
  const decoder = new TextDecoder();
  let result: ScratchResult | undefined;
  const handle = (text: string) => {
    for (const event of parser.push(text)) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.event === "stdout" || event.event === "stderr") {
        const raw = typeof data.data === "string" ? data.data : "";
        const plain = event.event === "stderr" && raw.trimStart().startsWith("<") ? htmlToText(raw) : raw;
        const lines = plain.split("\n");
        if (lines.at(-1) === "") lines.pop();
        for (const line of lines) onEvent({ stream: event.event, text: line });
      } else if (event.event === "done") {
        const output = data.output as { mimetype?: unknown; data?: unknown } | undefined;
        result = {
          success: data.success === true,
          ...(output && typeof output.mimetype === "string" && typeof output.data === "string" ? { output: { mimetype: output.mimetype, data: output.data } } : {}),
        };
      }
    }
  };
  for await (const chunk of res.body) handle(decoder.decode(chunk, { stream: true }));
  handle(decoder.decode());
  return result ?? { success: false };
}
