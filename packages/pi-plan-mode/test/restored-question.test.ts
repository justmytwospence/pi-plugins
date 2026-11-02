import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { PlannerAgent } from "../src/planner/agent.js";
import { PLANNER_SEED_END_ENTRY } from "../src/planners.js";
import { planModeQuestionAnswered, planModeQuestionCancelled } from "../src/question-tool.js";

initTheme("dark");

test("restored planner question cards retain their owner rendering before a session opens", () => {
  const dir = mkdtempSync(join(tmpdir(), "planner-question-"));
  const manager = SessionManager.create("/repo", dir);
  manager.appendCustomEntry(PLANNER_SEED_END_ENTRY, {});
  manager.appendMessage({ role: "user", content: "task", timestamp: 1 } as never);
  const questions = [
    {
      id: "internal_question_id",
      header: "Storage",
      question: "Where should it go?",
      options: [
        { label: "Disk", description: "Persist it" },
        { label: "Memory", description: "Keep it temporary" },
      ],
    },
  ];
  const answers = [
    {
      id: "internal_question_id",
      header: "Storage",
      question: "Where should it go?",
      answer: "Disk",
      wasCustom: false,
    },
  ];
  for (const [id, result] of [
    ["internal_call_one", planModeQuestionAnswered(questions, answers)],
    ["internal_call_two", planModeQuestionCancelled(questions, "cancelled", "Skipped by user")],
  ] as const) {
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "plan_mode_question", arguments: { questions } }],
      stopReason: "toolUse",
      timestamp: 2,
    } as never);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "plan_mode_question",
      ...result,
      isError: false,
      timestamp: 3,
    } as never);
  }
  const file = manager.getSessionFile();
  assert.ok(file);
  const planner = new PlannerAgent({
    id: "A",
    spec: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    name: "Claude",
    cwd: "/repo",
    access: { tools: [], extensions: [], skills: [], policy: {} as never, systemPrompt: [] },
    timeoutMs: 0,
    sessionDir: dir,
    seed: [],
    sessionFile: file,
    onChange: () => undefined,
  });
  planner.chat.setExpanded(true);
  const shown = planner.chat
    .render(100)
    .map((line) => stripVTControlCharacters(line))
    .join("\n");
  assert.match(shown, /Plan question/u);
  assert.match(shown, /Storage: Where should it go\?/u);
  assert.match(shown, /Disk/u);
  assert.match(shown, /Answered/u);
  assert.match(shown, /Storage \(selected\): Disk/u);
  assert.match(shown, /Questions cancelled[\s\S]*Skipped by user/u);
  assert.doesNotMatch(shown, /internal_question_id|internal_call_one|internal_call_two|"cancelled"/u);
});
