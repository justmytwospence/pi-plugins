// pi children: how they start (`pi --name <name> [--model] [--thinking]`), and their reply: the
// text of the last assistant message in the session file (JSONL, newest entries last), without
// the `<next>` suggestion, cut to what fits in a message.
import { readFileSync } from "node:fs";
import type { ChildAgent } from "./core/children.ts";
import { clipReply, stripNext } from "./core/text.ts";

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p): p is { type: string; text: string } => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** The last assistant text in a session file's contents, or undefined if there is none. */
export function lastAssistantText(jsonl: string): string | undefined {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.includes('"assistant"')) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const text = textOf(entry.message.content).trim();
    if (text) return text;
  }
  return undefined;
}

export function readReply(sessionPath: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(sessionPath, "utf8");
  } catch {
    return undefined;
  }
  const text = lastAssistantText(raw);
  return text === undefined ? undefined : clipReply(stripNext(text), sessionPath);
}

/** pi children: `pi --name <name> [--model] [--thinking]`, replies from their session files. */
export const PI_CHILD: ChildAgent = {
  kind: "pi",
  args: (opts, name) => {
    const args = ["--name", name];
    if (opts.model) args.push("--model", opts.model);
    if (opts.thinking) args.push("--thinking", opts.thinking);
    return args;
  },
  reply: async (rec) => (rec.session ? readReply(rec.session) : undefined),
};
