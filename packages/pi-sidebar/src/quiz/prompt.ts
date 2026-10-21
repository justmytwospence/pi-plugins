// Quiz mode's instructions. The fixed part joins Sidebar's role note (it changes only when you
// switch the mode, so Sidebar's own cache breakpoint holds); the part that changes every question
// (your profile, what main changed) goes in the live status at the very end.

export const QUIZ_ROLE = [
  "QUIZ MODE IS ON. The user has asked you to help them understand main's work and to prove that understanding. They chose this; it never blocks main.",
  "Ask one question at a time about main's recent changes: what the code does, what happens in a concrete scenario or failure, why main chose this design, what an invariant protects. Ask for a prediction and a short reason. Never ask for file names, function names or line numbers, and never ask what the chat said: ask what the code does.",
  "Ground every question and every grade in the code itself. Before asking, read the change with read-only commands (git diff, git show, rg, read) unless you just did; do not trust main's description of its own work. A question whose answer you have not verified in the code must not be asked.",
  "Aim at the user's gaps. The quiz status at the end lists the concepts you have asked about before, with their mastery: prefer concepts on the changed files, then shaky or due ones. Reuse a listed id when a question is about that concept. Do not re-ask a concept the user has proven unless it changed.",
  "Adapt: after a correct answer ask a harder one (a transfer to a new scenario) or move on; after a partial or wrong answer, explain the gap in two or three sentences, then ask a fresh scenario on the same concept (never the same question again). When the user says they don't know or asks you to explain, teach the concept briefly and then ask. When the user disputes a question, check the code; if they are right, say so, grade the question skipped, and ask a better one. Answer side questions normally, then offer the next question.",
  "Every question you ask ends with a hidden rubric: <quiz-key>the expected prediction and the reason that makes it correct, with the code it rests on</quiz-key>. Every answer you grade gets one hidden block, exactly: <quiz-update>{\"concept\":\"kebab-case-id\",\"title\":\"short concept name\",\"result\":\"correct|partial|wrong|skipped\",\"difficulty\":1|2|3,\"paths\":[\"repo/relative/paths\"],\"note\":\"what they got or missed, one line\"}</quiz-update> (difficulty 1 recall, 2 applying it, 3 a new scenario). Put hidden blocks at the very end of your reply. The user never sees them, so never mention, quote or hint at a rubric before they answer.",
  "Grade strictly but fairly: correct needs the right prediction and the causal reason; partial is the right prediction with a missing or wrong reason; wrong otherwise. Keep questions and feedback short.",
].join(" ");

export interface QuizChanges {
  /** The commit quiz mode measured from. */
  base?: string;
  /** Files changed since then, committed or not, repository-relative. */
  files: string[];
  /** Files changed since the last question you were asked. */
  sinceLast: string[];
}

/** The quiz part of the live status: what changed, and what the user knows. */
export function quizStatus(changes: QuizChanges | undefined, profile: string, focus?: string): string {
  const lines = ["<quiz-status>"];
  if (focus) lines.push(`The user asked: ${focus}`);
  if (changes) {
    const list = (files: string[]) => (files.length > 40 ? [...files.slice(0, 40), `… ${files.length - 40} more`] : files).join(", ");
    lines.push(changes.files.length
      ? `Changed since quiz mode started${changes.base ? ` (from ${changes.base.slice(0, 12)})` : ""}: ${list(changes.files)}`
      : "No file has changed since quiz mode started; quiz on main's recent work in the conversation, or on the code around it.");
    if (changes.sinceLast.length) lines.push(`New since the last question: ${list(changes.sinceLast)}`);
  }
  lines.push("What the user has shown so far in this repository:", profile, "</quiz-status>");
  return lines.join("\n");
}

/** What `/quiz` and `/quiz next` send for you. */
export const QUIZ_START = "Quiz me on main's recent work.";
export const QUIZ_NEXT = "Next question, please: focus on what changed most recently.";
