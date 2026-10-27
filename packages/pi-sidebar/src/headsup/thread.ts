// A heads-up note delivered into Sidebar's thread: a hidden marker (the model's view of why an
// answer appears unasked) and Sidebar's answer carrying the note and its explanation. Following up
// is ordinary chat, and Sidebar sees what it raised.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { HeadsUpNote } from "./protocol.ts";

export const NOTE_MARKER = "<sidebar-headsup-note>";

const KIND_TITLE: Record<HeadsUpNote["kind"], string> = {
  tradeoff: "a tradeoff",
  "suspect-result": "a result to check",
  risk: "a risk",
  context: "context",
  share: "something worth sharing",
};

/** Whether a user message in Sidebar's thread is a note's hidden marker (never displayed). */
export function isNoteMarker(text: string): boolean {
  return text.trimStart().startsWith(NOTE_MARKER);
}

export interface NoteModel {
  api: string;
  provider: string;
  model: string;
}

/** The two thread messages for a note. */
export function noteMessages(note: HeadsUpNote, model: NoteModel, now: number): AgentMessage[] {
  const marker = `${NOTE_MARKER}\nSidebar's heads-up check raised the note below on its own, about main's work at this point (topic id: ${note.topic}). The user did not ask for it and has not replied yet; their next message may be about it.\n</sidebar-headsup-note>`;
  const post = note.post ? `\n\nDraft post:\n\n${note.post.split("\n").map((line) => `> ${line}`).join("\n")}` : "";
  const body = `**Heads up: ${KIND_TITLE[note.kind]}.** ${note.text}${note.detail ? `\n\n${note.detail}` : ""}${post}`;
  return pair(marker, body, model, now);
}

/** The thread messages for a blog draft written from a share note, so following up edits it. */
export function draftMessages(note: HeadsUpNote, draft: { title: string; kind: "full" | "outline"; body: string }, location: string, model: NoteModel, now: number): AgentMessage[] {
  const marker = `${NOTE_MARKER}\nThe user asked for a blog ${draft.kind === "full" ? "draft" : "outline"} from the share note about ${note.topic}; it was written and saved to ${location}. Their next message may ask to revise it.\n</sidebar-headsup-note>`;
  return pair(marker, `**Blog ${draft.kind === "full" ? "draft" : "outline"} saved** to ${location}.\n\n${draft.body}`, model, now);
}

function pair(marker: string, body: string, model: NoteModel, now: number): AgentMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: marker }], timestamp: now } as AgentMessage,
    {
      role: "assistant",
      content: [{ type: "text", text: body }],
      api: model.api,
      provider: model.provider,
      model: model.model,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: now,
    } as unknown as AgentMessage,
  ];
}
