// One-line summaries for tool calls, for herdr-web-ui's chat view (herdr's phone and browser
// client). It reads the session file and labels each tool row with the call's `intent` field when
// the call has one (omp records it), else with the first of a few well-known arguments (`command`,
// `path`, `pattern`, `url`...). Most suite and MCP tools have none of those, so their rows showed
// only the tool's name. `message_end` adds `intent` to each such call before pi saves the message.
//
// The field is only read by herdr-web-ui: every pi-ai provider builds its request from a tool
// call's id, name and arguments, so the model never sees it. Calls whose arguments already name
// a command or a file keep their own summary: the client labels those rows "Ran", "Read",
// "Edited" or "Wrote" only when the summary is that argument.

const MAX = 120;

/** Arguments herdr-web-ui already summarizes a call by (its `toolSummary`), `description` aside. */
const NATIVE_KEYS = ["command", "file_path", "notebook_path", "path", "pattern", "url"];

/** Tools the client summarizes itself, whatever their arguments. */
const NATIVE_TOOLS = new Set(["bash", "read", "edit", "write", "todo", "todo_write", "TodoWrite", "update_plan"]);

type Args = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value : undefined);

/** The first non-blank line, whitespace collapsed. */
function line(value: unknown): string | undefined {
  const text = str(value);
  const first = text?.split("\n").find((l) => l.trim());
  return first?.replace(/\s+/g, " ").trim() || undefined;
}

function clip(text: string, max = MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const records = (value: unknown): Args[] =>
  Array.isArray(value) ? value.filter((v): v is Args => typeof v === "object" && v !== null && !Array.isArray(v)) : [];

/** A task's short name: its label, else its first line. */
const taskName = (task: Args): string | undefined => line(task.label) ?? line(task.task);

function subagent(args: Args): string | undefined {
  const action = str(args.action) ?? "run";
  if (action !== "run") return [action, str(args.id)].filter(Boolean).join(" ");
  const tasks = records(args.tasks);
  if (tasks.length) return `${tasks.length} parallel: ${tasks.map(taskName).filter(Boolean).join(" · ")}`;
  const chain = records(args.chain);
  if (chain.length) return `chain: ${chain.map(taskName).filter(Boolean).join(" → ")}`;
  return line(args.label) ?? line(args.task);
}

/** A script's own description: a comment it opens with, else its first statement. */
function script(code: unknown): string | undefined {
  const first = (str(code) ?? "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("// @options"));
  if (!first) return undefined;
  if (!first.startsWith("//") && !first.startsWith("/*")) return first;
  return first.replace(/^(\/\/+|\/\*+)\s*/, "").replace(/\s*\*+\/\s*$/, "") || undefined;
}

function questions(args: Args): string | undefined {
  const list = records(args.questions);
  const parts = list.map((q) => line(q.header) ?? line(q.question)).filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

function strings(value: unknown): string | undefined {
  const list = Array.isArray(value) ? value.map(line).filter(Boolean) : [];
  return list.length ? list.join(" · ") : undefined;
}

/** A stored result by its id and the page asked for (web tools' `get_search_content`). */
function stored(args: Args): string | undefined {
  const id = str(args.responseId);
  if (!id) return undefined;
  const at = typeof args.urlIndex === "number" ? ` url ${args.urlIndex}` : typeof args.queryIndex === "number" ? ` query ${args.queryIndex}` : "";
  return `${id}${at}`;
}

/** Generic arguments that say what a call is about, in order of preference. */
const GENERIC_KEYS = ["query", "claim", "task", "prompt", "message", "subject", "title", "name", "id", "taskId", "action"];

/** The summary for one call, or undefined when herdr-web-ui already has one or there is none. */
export function toolIntent(name: string, args: unknown): string | undefined {
  if (NATIVE_TOOLS.has(name)) return undefined;
  const a: Args = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Args) : {};
  if (NATIVE_KEYS.some((key) => str(a[key]))) return undefined;
  let text: string | undefined;
  switch (name) {
    case "subagent":
      text = subagent(a);
      break;
    case "codemode":
      text = script(a.code);
      break;
    case "ask_user_question":
      text = questions(a);
      break;
    case "herdr":
    case "herdr_child":
      text = [str(a.action), str(a.name), str(a.machine) ? `on ${str(a.machine)}` : undefined, str(a.action) === "spawn" && !str(a.name) ? line(a.task) : undefined].filter(Boolean).join(" ");
      break;
    case "bg_wait":
    case "bg_logs":
    case "bg_kill":
    case "bg_status":
      text = [str(a.id), str(a.grep) ? `/${str(a.grep)}/` : undefined].filter(Boolean).join(" ") || (name === "bg_wait" ? "next to finish" : name === "bg_logs" ? "all tasks" : undefined);
      break;
  }
  text ??= strings(a.queries) ?? strings(a.urls) ?? strings(a.findText) ?? stored(a);
  for (const key of GENERIC_KEYS) {
    if (text) break;
    text = line(a[key]);
  }
  text = text?.replace(/\s+/g, " ").trim();
  return text ? clip(text) : undefined;
}

type Block = { type?: string; name?: unknown; arguments?: unknown; intent?: unknown };

/** The assistant message with `intent` on each call that lacks a summary, or undefined if none changed. */
export function withIntents<M extends { role?: string; content?: unknown }>(message: M): M | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  let changed = false;
  const content = (message.content as Block[]).map((block) => {
    if (block?.type !== "toolCall" || typeof block.name !== "string" || str(block.intent)) return block;
    const intent = toolIntent(block.name, block.arguments);
    if (!intent) return block;
    changed = true;
    return { ...block, intent };
  });
  return changed ? { ...message, content } : undefined;
}
