import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { type LaneAction, LanesPage } from "../src/app/lanes-page.js";
import { OptionsPage, type TextArea } from "../src/app/options-page.js";
import { PiChat, piChatTheme } from "../src/app/pi-chat.js";
import { readInputContext } from "../src/editor-contract.js";
import type { PlannerAgent } from "../src/planner/agent.js";
import { PlannerTrace } from "../src/planner-trace.js";
import { SubagentTracker } from "../src/subagent-progress.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as never;
initTheme("dark");

const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", escape: "\x1b", tab: "\t" };
const ctrl = (letter: string) => String.fromCharCode(letter.charCodeAt(0) - 96);

test("the options page cycles the highlighted value with ←/→ and ctrl+h/ctrl+l, and edits text rows", () => {
  let level = 0;
  let task = "";
  let next = 0;
  let back = 0;
  const levels = ["low", "medium", "high"];
  const page = new OptionsPage(theme, {
    title: "Plan",
    step: "Settings",
    rows: [
      {
        id: "task",
        label: "Task",
        value: () => task,
        text: { get: () => task, set: (value) => (task = value) },
        description: "What to plan.",
      },
      {
        id: "effort",
        label: "Effort",
        value: () => levels[level] ?? "",
        cycle: (direction) => {
          level = (level + direction + levels.length) % levels.length;
        },
        description: "How hard.",
      },
    ],
    next: { label: "next", run: () => next++ },
    back: { label: "close", run: () => back++ },
    rowsAvailable: () => 20,
    requestRender: () => undefined,
  });
  page.handleInput(KEY.down);
  page.handleInput(KEY.right);
  page.handleInput(ctrl("l"));
  assert.equal(level, 2);
  page.handleInput(ctrl("h"));
  page.handleInput(KEY.left);
  assert.equal(level, 0);
  const lines = page.render(80);
  assert.equal(lines.length, 20, "the page fills the screen");
  assert.ok(lines.some((line) => line.includes("‹ low ›")));
  assert.ok(lines.some((line) => line.includes("Settings")));

  page.handleInput(KEY.up);
  page.handleInput(KEY.enter);
  assert.equal(page.typing, true);
  for (const char of "add a cache") page.handleInput(char);
  page.handleInput(KEY.enter);
  assert.equal(task, "add a cache");
  page.handleInput(KEY.tab);
  assert.equal(next, 1);
  page.handleInput(KEY.escape);
  assert.equal(back, 1);
});

function fakeAgent(id: string, extra: Partial<PlannerAgent> = {}): PlannerAgent {
  const trace = new PlannerTrace();
  trace.note("started");
  const chat = new PiChat(piChatTheme, { cwd: "/" });
  chat.note("started");
  return {
    id,
    chat,
    name: `Model ${id}`,
    spec: { provider: "p", modelId: id, thinkingLevel: "high" },
    trace,
    subagents: new SubagentTracker(id),
    status: "idle",
    working: false,
    stats: { startedAt: 0, endedAt: 1000, toolCalls: 0, subagentTasks: 0, totalTokens: 0, costUsd: 0 },
    revision: 0,
    lastReply: "",
    pending: undefined,
    plan: undefined,
    answer: () => undefined,
    ...extra,
  } as unknown as PlannerAgent;
}

function lanesPage(
  agents: PlannerAgent[],
  merger?: () => PlannerAgent | undefined,
  rows = 30,
  task = "add a cache",
  before: LaneAction[] = [],
) {
  const said: [string, string][] = [];
  const actions: string[] = [];
  let hidden = 0;
  const share: { value: number | undefined } = { value: undefined };
  const page = new LanesPage(theme, {
    title: "Plan",
    task: () => task,
    agents: () => agents,
    ...(merger ? { merger } : {}),
    sayToMerger: (text) => said.push(["M", text]),
    actions: () => [
      ...before,
      { id: "implement", label: "Implement…", description: "implement" },
      { id: "export", label: "Export…", description: "export" },
    ],
    onAction: (id) => {
      actions.push(id);
    },
    say: (agent, text) => said.push([agent.id, text]),
    hide: () => hidden++,
    stopAll: () => undefined,
    rowsAvailable: () => rows,
    requestRender: () => undefined,
    mergerShare: {
      get: () => share.value,
      set: (value) => {
        share.value = value;
      },
    },
  });
  return { page, said, actions, hidden: () => hidden, share };
}

test("the task under the header wraps onto a few lines, and shrinks on short screens", () => {
  const task = Array.from({ length: 10 }, (_unused, index) => `step ${index + 1} ${"word ".repeat(20)}`).join("\n");
  const taskRows = (lines: string[]) => {
    const start = lines.findIndex((line) => line.startsWith(" Task"));
    let end = start + 1;
    while (lines[end]?.startsWith("       ")) end += 1;
    return lines.slice(start, end);
  };
  let lines = lanesPage([fakeAgent("A")], undefined, 40, task).page.render(100);
  let shown = taskRows(lines);
  assert.equal(shown.length, 6, "up to six lines");
  assert.match(shown[0] ?? "", /Task {2}step 1 word/u);
  assert.match(shown.at(-1) ?? "", /… \d+ more lines$/u);
  lines = lanesPage([fakeAgent("A")], undefined, 40, "add a cache").page.render(100);
  assert.equal(taskRows(lines).length, 1, "a short task takes one line");
  lines = lanesPage([fakeAgent("A")], undefined, 16, task).page.render(100);
  shown = taskRows(lines);
  assert.ok(shown.length <= 2, "a short screen keeps the lanes");
  assert.equal(lines.length, 16);
});

test("ctrl+n/ctrl+p walk a lane through its subagents, and Esc goes back to the planner", () => {
  const a = fakeAgent("A");
  const scout = (index: number, label: string, state: string) => ({
    index,
    label,
    model: "haiku",
    task: `look into ${label}`,
    state,
    startedAt: 0,
  });
  a.subagents.apply("call", {
    kind: "plan-subagents-progress",
    version: 1,
    scouts: [scout(0, "auth", "done"), scout(1, "cache", "running")],
    events: [
      {
        scout: 0,
        record: {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "auth lives in src/auth.ts" },
        },
      },
    ],
  });
  const { page, hidden } = lanesPage([a], undefined, 30);
  const screen = () => page.render(100).join("\n");
  assert.match(screen(), /\^n\/\^p subagents/u);
  assert.doesNotMatch(screen(), /look into auth/u);
  page.handleInput(ctrl("n"));
  assert.match(screen(), /› ✓ A1 auth · haiku · done/u);
  assert.match(screen(), /auth: look into auth/u, "the subagent's task heads its trace");
  assert.match(screen(), /A1 chat/u);
  page.handleInput(ctrl("n"));
  assert.match(screen(), /› .* A2 cache/u);
  page.handleInput(ctrl("n"));
  assert.doesNotMatch(screen(), /› .* A\d /u, "past the last subagent, back to the planner");
  page.handleInput(ctrl("p"));
  assert.match(screen(), /› .* A2 cache/u);
  page.handleInput(KEY.escape);
  assert.doesNotMatch(screen(), /A2 chat/u, "Esc leaves the subagent");
  assert.doesNotMatch(screen(), /Leave planning\?/u, "and does not offer to leave yet");
  page.handleInput(KEY.escape);
  assert.match(screen(), /Leave planning\?/u);
  assert.equal(hidden(), 0);
});

test("lanes sit side by side, and what you type goes to the focused planner", () => {
  const a = fakeAgent("A", { plan: "# Plan A\n\nDo it.", revision: 1 } as never);
  const b = fakeAgent("B", { status: "working", working: true } as never);
  const { page, said } = lanesPage([a, b]);
  const lines = page.render(120);
  assert.equal(lines.length, 30);
  assert.ok(lines.some((line) => line.includes("A · Model A high") && line.includes("B · Model B high")));
  assert.ok(lines.some((line) => line.includes("# Plan A") || line.includes("Plan A")));
  assert.equal(page.step(), "Planning", "someone is still working");
  for (const char of "use sh") page.handleInput(char);
  page.handleInput(KEY.enter);
  page.handleInput(KEY.tab);
  for (const char of "faster") page.handleInput(char);
  page.handleInput(KEY.enter);
  assert.deepEqual(said, [
    ["A", "use sh"],
    ["B", "faster"],
  ]);
});

test("a pending question is a picker in its lane: digits and j/k move, ⏎ picks, Type something. takes typed words", () => {
  const answers: unknown[] = [];
  const a = fakeAgent("A", {
    status: "asking",
    working: true,
    pending: {
      questions: [
        {
          id: "lang",
          header: "Language",
          question: "Which?",
          options: [
            { label: "Python", description: "Py" },
            { label: "Node", description: "JS" },
          ],
        },
        {
          id: "tests",
          header: "Tests",
          question: "Tests?",
          options: [
            { label: "Yes", description: "y" },
            { label: "No", description: "n" },
          ],
        },
      ],
      resolve: () => undefined,
    },
    answer: (value: unknown) => answers.push(value),
  } as never);
  const { page, said } = lanesPage([a]);
  const shown = () => page.render(100).join("\n");
  assert.match(shown(), /\? Language \(1\/2\)/u);
  assert.match(shown(), /3\. Type something\.[^\n]*\n[^\n]*4\. Skip \(let the planner decide\)/u);
  assert.match(shown(), /── answer ─/u, "the lane's line is the answer line, not the chat");
  assert.equal(readInputContext(page), "list", "the list owns the keys");
  // j moves, a digit jumps, Enter picks.
  page.handleInput("j");
  assert.match(shown(), /❯ 2\. Node/u);
  page.handleInput("1");
  assert.match(shown(), /❯ 1\. Python/u);
  page.handleInput("2");
  page.handleInput(KEY.enter);
  assert.match(shown(), /\? Tests \(2\/2\)/u);
  // Typing on Type something. opens the answer line with that character; Esc goes back to the
  // options and keeps the draft; Enter saves it.
  page.handleInput("3");
  assert.match(shown(), /❯ 3\. Type something\./u);
  for (const char of "only u") page.handleInput(char);
  assert.equal(readInputContext(page), "editor");
  assert.match(shown(), /› only u/u);
  assert.match(shown(), /⏎ save answer/u);
  page.handleInput(KEY.escape);
  assert.equal(readInputContext(page), "list");
  assert.doesNotMatch(shown(), /Leave planning\?/u);
  page.handleInput(KEY.enter);
  assert.match(shown(), /› only u/u, "the draft is back");
  for (const char of "nit tests") page.handleInput(char);
  page.handleInput(KEY.enter);
  assert.deepEqual(answers, [
    [
      { id: "lang", header: "Language", question: "Which?", answer: "Node", wasCustom: false, optionIndex: 2 },
      { id: "tests", header: "Tests", question: "Tests?", answer: "only unit tests", wasCustom: true },
    ],
  ]);
  assert.deepEqual(said, [], "an answer is not a chat message");
});

test("Tab reaches the actions, where Enter runs one; Esc offers Hide", () => {
  const a = fakeAgent("A", { plan: "# Plan", revision: 1 } as never);
  const { page, actions, hidden } = lanesPage([a]);
  page.handleInput(KEY.tab);
  page.handleInput(KEY.enter);
  page.handleInput(KEY.right);
  page.handleInput(KEY.enter);
  assert.deepEqual(actions, ["implement", "export"]);
  page.handleInput(KEY.escape);
  assert.ok(page.render(100).some((line) => line.includes("Hide (keep the plans)")));
  page.handleInput(KEY.enter);
  assert.equal(hidden(), 1);
});

test("M's pane joins the screen below the lanes once the caller offers it: Tab reaches it, and it grows while focused", () => {
  const a = fakeAgent("A", { plan: "# Plan A", revision: 1 } as never);
  const b = fakeAgent("B", { status: "working", working: true } as never);
  const answers: unknown[] = [];
  const m = fakeAgent("M", {
    status: "asking",
    working: true,
    pending: {
      questions: [{ id: "q", header: "Store", question: "Which?", options: [{ label: "Redis", description: "r" }] }],
      resolve: () => undefined,
    },
    answer: (value: unknown) => answers.push(value),
  } as never);
  let shown = false;
  const { page, said, actions } = lanesPage([a, b], () => (shown ? m : undefined), 45);
  const mergerHeight = (lines: string[]) => {
    const top = lines.findIndex((line) => line.includes("M · main agent · Model M high"));
    const bottom = lines.findIndex((line, index) => index > top && line.startsWith("› "));
    return top === -1 ? 0 : bottom - top + 1;
  };
  let lines = page.render(120);
  assert.equal(lines.length, 45);
  assert.equal(mergerHeight(lines), 0, "no M pane while a plan is still to come");
  assert.ok(!lines.some((line) => line.includes(" M ")), "and no stats row for it");

  // Without M, Tab goes from B straight to the actions, where Enter acts.
  page.handleInput(KEY.tab);
  page.handleInput(KEY.tab);
  assert.ok(
    page.render(120).some((line) => line.includes("⏎ do it")),
    "Tab went from B to the actions",
  );
  page.handleInput(KEY.enter);
  assert.deepEqual(actions, ["implement"]);
  assert.deepEqual(said, []);
  page.handleInput(KEY.tab);

  // Once both plans are in, M is there: Tab reaches it, and it grows to the bottom third.
  Object.assign(b, { status: "idle", working: false, plan: "# Plan B", revision: 1 });
  shown = true;
  lines = page.render(120);
  assert.ok(
    lines.some((line) => line.includes("? M main agent · Model M high")),
    "M has a stats row",
  );
  page.handleInput(KEY.tab);
  page.handleInput(KEY.tab);
  lines = page.render(120);
  assert.equal(lines.length, 45);
  // 45 rows: header 3, task 1, stats 3, footer 4 leave 34; M takes a third of them.
  assert.equal(mergerHeight(lines), 11, "grows to the bottom third while focused");
  // M is a lane of its own: its questions, its plan, and the chat behind it.
  assert.ok(lines.some((line) => line.includes("? Store")));
  page.handleInput(KEY.enter);
  assert.equal(answers.length, 1);
  Object.assign(m, { status: "idle", working: false, pending: undefined });
  for (const char of "which is safer?") page.handleInput(char);
  page.handleInput(KEY.enter);
  assert.deepEqual(said, [["M", "which is safer?"]]);
  Object.assign(m, { plan: "# Merged", revision: 1 });
  lines = page.render(120);
  assert.ok(lines.some((line) => line.includes("# Merged") || line.includes("Merged")));
  assert.ok(lines.some((line) => line.includes("←→ chat")));
  page.handleInput(KEY.tab);
  assert.ok(
    page.render(120).some((line) => line.includes("Implement…")),
    "Tab goes on to the actions",
  );
});

test("with one planner there is no merger pane", () => {
  const { page } = lanesPage([fakeAgent("A", { plan: "# Plan", revision: 1 } as never)], () => undefined);
  assert.ok(!page.render(100).some((line) => line.includes("merger")));
  page.handleInput(KEY.tab);
  assert.ok(
    page.render(100).some((line) => line.includes("do it")),
    "Tab goes straight to the actions",
  );
});

test("the top of the planning screen shows each planner's live stats, and M's once it is there", () => {
  const a = fakeAgent("A", {
    status: "working",
    working: true,
    stats: {
      startedAt: Date.now() - 134_000,
      toolCalls: 38,
      subagentTasks: 4,
      totalTokens: 182_000,
      costUsd: 1.24,
      lastActivity: "read src/plan.ts",
    },
  } as never);
  const b = fakeAgent("B", { plan: "# Plan B", revision: 2 } as never);
  let m: PlannerAgent | undefined;
  const { page } = lanesPage([a, b], () => m);
  let lines = page.render(140);
  const row = (id: string) => lines.find((line) => line.includes(` ${id} Model ${id} high`)) ?? "";
  assert.match(row("A"), /2m 14s\s+38 tools\s+4 subagents\s+182k tok\s+\$1\.24\s+read src\/plan\.ts/u);
  assert.match(row("B"), /✓ B Model B high\s+1s.*plan ready \(v2\)/u);
  assert.equal(row("M"), "", "no row for M before it is there");
  // The lane titles carry the icon, id, model and version; the table has the rest.
  assert.ok(
    lines.some((line) => /\u2713 B \u00b7 Model B high \u2500+ v2 \u2500\u2500/u.test(line)),
    "B's title",
  );
  assert.ok(!lines.some((line) => line.includes("read src/plan.ts \u00b7")), "no activity in A's title");
  assert.equal(lines.length, 30);

  m = fakeAgent("M", { status: "asking", working: true } as never);
  lines = page.render(140);
  assert.match(
    lines.find((line) => line.includes("? M main agent")) ?? "",
    /\? M main agent · Model M high.*asking you/u,
  );
  assert.equal(lines.length, 30);
});

test("a multiline text row is a box above the rows that Tab moves in and out of", () => {
  let task = Array.from({ length: 12 }, (_unused, index) => `step ${index + 1} ${"word ".repeat(12)}`).join("\n");
  let rowsAvailable = 60;
  let next = 0;
  let back = 0;
  const area: TextArea & { text: string } = {
    focused: false,
    text: "",
    setText(text) {
      this.text = text;
    },
    getText() {
      return this.text;
    },
    handleInput(data) {
      if (data === "\r") this.onSubmit?.(this.text);
      else if (data === "\x1b") this.onEscape?.();
      else this.text += data;
    },
    render: (width) => ["─".repeat(width), `EDITOR ${area.text.slice(-12)}`, "─".repeat(width)],
  };
  let level = 0;
  const page = new OptionsPage(theme, {
    title: "Plan",
    step: "Settings",
    rows: [
      {
        id: "task",
        label: "Task",
        value: () => task,
        text: { get: () => task, set: (value) => (task = value), placeholder: "what to plan", multiline: true },
        description: "task",
      },
      {
        id: "a",
        label: "Planner A",
        section: "Planners",
        value: () => String(level),
        cycle: () => level++,
        description: "a",
      },
    ],
    next: { label: "next", run: () => next++ },
    back: { label: "close", run: () => back++ },
    rowsAvailable: () => rowsAvailable,
    requestRender: () => undefined,
    createTextArea: () => area,
  });
  let lines = page.render(80);
  assert.equal(lines.length, 60);
  const boxLines = () => lines.filter((line) => line.startsWith("    ") && !line.includes("──"));
  assert.ok(boxLines().length >= 12, "every line of the task shows, wrapped");
  assert.ok(lines.some((line) => line.includes("step 12")));
  assert.ok(lines.some((line) => line.includes("Planner A")));

  rowsAvailable = 22;
  lines = page.render(80);
  assert.equal(lines.length, 22);
  assert.ok(
    lines.some((line) => line.includes("more lines (tab to edit)")),
    "a long task is cut with a count",
  );
  assert.ok(
    lines.some((line) => line.includes("Planner A")),
    "the other rows still fit",
  );

  // The rows start with focus; ←/→ change the highlighted row, not the task.
  page.handleInput(KEY.right);
  assert.equal(level, 1);
  page.handleInput(KEY.tab);
  assert.equal(page.typing, true);
  assert.equal(area.focused, true);
  page.handleInput("!");
  assert.match(task, /word !$/u, "the task follows the editor as you type");
  lines = page.render(80);
  assert.ok(lines.some((line) => line.includes("EDITOR")));
  const top = lines.findIndex((line) => line.includes("Task"));
  const planner = lines.findIndex((line) => line.includes("Planner A"));
  assert.ok(planner - top > 5, "the box keeps its height while you edit");
  page.handleInput(KEY.tab);
  assert.equal(page.typing, false);
  assert.equal(area.focused, false);
  page.handleInput(KEY.tab);
  page.handleInput(KEY.escape);
  assert.equal(page.typing, false, "Escape the editor does not want leaves the box");
  assert.equal(back, 0);
  page.handleInput(KEY.tab);
  page.handleInput(KEY.enter);
  assert.equal(next, 1, "Enter in the box goes on");
});

test("the planning screen fits short terminals and always shows the actions bar", () => {
  const a = fakeAgent("A", { plan: "# Plan A", revision: 1 } as never);
  const b = fakeAgent("B", { status: "failed" } as never);
  const m = fakeAgent("M");
  for (const rows of [12, 14, 16, 18, 20, 22, 26, 40]) {
    for (const focusMerger of [false, true]) {
      const page = new LanesPage(theme, {
        title: "Plan",
        task: () => "add a cache",
        agents: () => [a, b],
        merger: () => (focusMerger ? m : undefined),
        actions: () => [{ id: "implement", label: "Implement…", description: "implement" }],
        onAction: () => undefined,
        say: () => undefined,
        hide: () => undefined,
        stopAll: () => undefined,
        rowsAvailable: () => rows,
        requestRender: () => undefined,
      });
      if (focusMerger) {
        page.handleInput(KEY.tab);
        page.handleInput(KEY.tab);
      }
      const lines = page.render(100);
      assert.equal(lines.length, rows, `rows=${rows}`);
      assert.ok(
        lines.some((line) => line.includes("Implement…")),
        `actions bar visible at rows=${rows}`,
      );
      if (focusMerger)
        assert.ok(
          lines.some((line) => line.includes("M · main agent")),
          `M stays while you are in it (${rows})`,
        );
      // Without the stats table, the lane titles say how each planner stands.
      const table = lines.some((line) => line.includes("✓ A Model A high"));
      const titled = lines.some((line) => line.includes("✓ plan ready") && line.includes("A · Model A high"));
      assert.ok(table || titled, `status somewhere at rows=${rows}`);
      assert.ok(!(table && titled), `status once at rows=${rows}`);
    }
  }
  // With room, the stats rows and the merger pane are there.
  const roomy = lanesPage([a, b], () => m).page.render(120);
  assert.ok(roomy.some((line) => line.includes("✓ A Model A high")));
  assert.ok(roomy.some((line) => line.includes("M · main agent")));
});

test("a planner's question and its options wrap instead of being cut", () => {
  const long =
    "Should the cache sit in front of the database for every read, or only for the hot paths we measured last week?";
  const a = fakeAgent("A", {
    status: "asking",
    working: true,
    pending: {
      questions: [
        {
          id: "where",
          header: "Cache",
          question: long,
          options: [
            {
              label: "Every read",
              description: "Simplest to reason about, but it doubles memory use on the read replicas.",
            },
            {
              label: "Hot paths only",
              description: "Less memory; each new hot path needs its own wiring and invalidation.",
            },
          ],
        },
      ],
      resolve: () => undefined,
    },
  } as never);
  const lines = lanesPage([a, fakeAgent("B")], undefined, 40).page.render(100);
  const text = lines.join(" ").replace(/[│\s]+/gu, " ");
  assert.match(text, /last week\?/u, "the whole question shows");
  assert.match(text, /❯ 1\. Every read/u);
  assert.match(text, /on the read replicas\./u, "descriptions wrap under their option");
  assert.match(text, /needs its own wiring and invalidation\./u);
  const question = lines.slice(lines.findIndex((line) => line.includes("? Cache")));
  const cut = question.filter((line) => /\w…/u.test(line) && !line.includes("Implement"));
  assert.deepEqual(cut, [], "nothing is cut");

  // A short lane keeps only the highlighted option's description, and still its input line.
  const short = lanesPage([a, fakeAgent("B")], undefined, 24)
    .page.render(100)
    .join("\n");
  assert.match(short, /❯ 1\. Every read/u);
  assert.match(short, /Simplest to reason about/u);
  assert.doesNotMatch(short, /Less memory/u);
  assert.match(short, /── answer ─/u, "the answer line stays");
});

test("in a planner's questions, ←/→ (and backspace) move between them to change an earlier answer", () => {
  const answers: unknown[] = [];
  const question = (id: string, header: string, labels: string[]) => ({
    id,
    header,
    question: `${header}?`,
    options: labels.map((label) => ({ label, description: label })),
  });
  const a = fakeAgent("A", {
    status: "asking",
    working: true,
    pending: {
      questions: [
        question("lang", "Language", ["Python", "Node"]),
        question("db", "Database", ["Postgres", "SQLite"]),
        question("tests", "Tests", ["Yes", "No"]),
      ],
      resolve: () => undefined,
    },
    answer: (value: unknown) => answers.push(value),
  } as never);
  const { page } = lanesPage([a]);
  const shown = () => page.render(120).join("\n");
  assert.match(shown(), /\? Language \(1\/3\).*◉○○/u);
  assert.match(shown(), /←→ question/u);

  page.handleInput(KEY.down); // Node
  page.handleInput(KEY.enter);
  page.handleInput("3"); // Type something.
  for (const char of "DuckDB") page.handleInput(char);
  page.handleInput(KEY.enter);
  assert.match(shown(), /\? Tests \(3\/3\).*●●◉/u);

  // Back to the database: the typed answer is a row of its own, selected.
  page.handleInput(KEY.left);
  assert.match(shown(), /\? Database \(2\/3\)/u);
  assert.match(shown(), /❯ 5\. ✎ your answer: DuckDB/u);
  // Backspace goes back again; Node is still selected there.
  page.handleInput("\x7f");
  assert.match(shown(), /\? Language \(1\/3\)/u);
  assert.match(shown(), /❯ 2\. Node ✓/u);
  page.handleInput("k"); // change it to Python
  page.handleInput(KEY.enter);
  // Enter moves on; keep DuckDB as it was, then answer the last one.
  assert.match(shown(), /\? Database \(2\/3\)/u);
  page.handleInput(KEY.enter);
  assert.match(shown(), /\? Tests \(3\/3\)/u);
  // → cannot run past the first unanswered question.
  page.handleInput(KEY.right);
  assert.match(shown(), /\? Tests \(3\/3\)/u);
  assert.equal(answers.length, 0, "nothing is sent until every question has an answer");
  page.handleInput(KEY.enter);
  assert.deepEqual(answers, [
    [
      { id: "lang", header: "Language", question: "Language?", answer: "Python", wasCustom: false, optionIndex: 1 },
      { id: "db", header: "Database", question: "Database?", answer: "DuckDB", wasCustom: true },
      { id: "tests", header: "Tests", question: "Tests?", answer: "Yes", wasCustom: false, optionIndex: 1 },
    ],
  ]);
});

test("while typing an answer, ←/→ edit it; a suite editor in Insert mode gets no keys until then", () => {
  const answers: unknown[] = [];
  const a = fakeAgent("A", {
    status: "asking",
    working: true,
    pending: {
      questions: [
        { id: "q1", header: "One", question: "1?", options: [{ label: "x", description: "x" }] },
        { id: "q2", header: "Two", question: "2?", options: [{ label: "y", description: "y" }] },
      ],
      resolve: () => undefined,
    },
    answer: (value: unknown) => answers.push(value),
  } as never);
  const { page } = lanesPage([a]);
  page.handleInput(KEY.enter);
  page.handleInput("2");
  for (const char of "ac") page.handleInput(char);
  page.handleInput(KEY.left);
  page.handleInput("b");
  assert.ok(
    page.render(120).some((line) => line.includes("? Two (2/2)")),
    "still on the second question",
  );
  page.handleInput(KEY.enter);
  assert.equal((answers[0] as Array<{ answer: string }>)[1]?.answer, "abc");

  // A pi-vim-style input (Insert mode, owns Enter): the list still gets ↑/↓/Enter/digits, and the
  // editor only once Type something. opens it, in Insert mode.
  const b = fakeAgent("B", {
    status: "asking",
    working: true,
    pending: {
      questions: [{ id: "q", header: "Store", question: "Which?", options: [{ label: "Redis", description: "r" }] }],
      resolve: () => undefined,
    },
    answer: (value: unknown) => answers.push(value),
  } as never);
  const log: string[] = [];
  let text = "";
  let inserts = 0;
  const fake = {
    focused: false,
    getValue: () => text,
    setValue: (value: string) => {
      text = value;
    },
    handleInput: (data: string) => {
      log.push(data);
      if (data === "\r") hooks?.submit(text);
      else text += data;
    },
    render: () => [text],
    ownsEnter: true,
    [Symbol.for("pi-plugins.editor-mode.v1")]: () => ({ state: "insert", autocomplete: false }),
    [Symbol.for("pi-plugins.editor-insert.v1")]: () => {
      inserts += 1;
    },
  };
  let hooks: { submit(text?: string): void } | undefined;
  const vim = new LanesPage(theme, {
    title: "Plan",
    task: () => "t",
    agents: () => [b],
    actions: () => [],
    onAction: () => undefined,
    say: () => undefined,
    hide: () => undefined,
    stopAll: () => undefined,
    rowsAvailable: () => 30,
    requestRender: () => undefined,
    createInput: (_id, given) => {
      hooks = given;
      return fake as never;
    },
  });
  vim.render(100);
  vim.handleInput("j");
  vim.handleInput(KEY.down);
  assert.deepEqual(log, [], "the list, not the editor, took the keys");
  assert.ok(vim.render(100).some((line) => line.includes("❯ 3. Skip")));
  vim.handleInput("2");
  for (const char of "memcached") vim.handleInput(char);
  assert.equal(inserts, 1, "Type something. put the editor in Insert mode");
  assert.equal(text, "memcached");
  vim.handleInput(KEY.enter);
  assert.deepEqual(answers.at(-1), [
    { id: "q", header: "Store", question: "Which?", answer: "memcached", wasCustom: true },
  ]);
});

test("the divider above M drags to resize it, shift+↑↓ moves it a row, and a double-click resets it", () => {
  const a = fakeAgent("A", { plan: "# Plan A", revision: 1 } as never);
  const b = fakeAgent("B", { plan: "# Plan B", revision: 1 } as never);
  const m = fakeAgent("M");
  const { page, share } = lanesPage([a, b], () => m, 45);
  const layout = () => {
    const lines = page.render(120);
    const divider = lines.findIndex((line) => line.includes("M · main agent · Model M high"));
    const bottom = lines.findIndex((line, index) => index > divider && line.startsWith("› "));
    return { lines, divider, height: bottom - divider + 1 };
  };
  const mouse = (type: string, y: number, extra: Record<string, unknown> = {}) =>
    page.handleMouse({
      type,
      button: "left",
      x: 10,
      y,
      screenX: 10,
      screenY: y,
      width: 120,
      height: 45,
      shift: false,
      alt: false,
      ctrl: false,
      ...extra,
    } as never);

  let { divider, height } = layout();
  assert.equal(height, 6, "collapsed by default");
  // Drag the divider up five rows: M grows by five, and stays that size after release.
  assert.deepEqual(mouse("press", divider), { capture: true });
  mouse("drag", divider - 5);
  mouse("release", divider - 5);
  ({ divider, height } = layout());
  assert.equal(height, 11);
  assert.ok(share.value !== undefined && share.value > 0.3 && share.value < 0.33, `share ${share.value}`);
  // Focus no longer changes it: the size you chose holds.
  page.handleInput(KEY.tab);
  page.handleInput(KEY.tab);
  assert.equal(layout().height, 11);
  // shift+↑/↓ move it a row at a time.
  page.handleInput("\x1b[1;2A");
  assert.equal(layout().height, 12);
  page.handleInput("\x1b[1;2B");
  page.handleInput("\x1b[1;2B");
  assert.equal(layout().height, 10);
  // It cannot squeeze the lanes or M below their minimums.
  mouse("press", layout().divider);
  mouse("drag", 0);
  mouse("release", 0);
  const top = layout();
  assert.equal(top.lines.length, 45);
  assert.ok(
    top.lines.some((line) => line.includes("A · Model A high")),
    "the lanes keep their minimum",
  );
  mouse("press", top.divider);
  mouse("drag", 44);
  mouse("release", 44);
  assert.equal(layout().height, 5, "M keeps its minimum");
  // A double-click on the divider goes back to automatic sizing.
  mouse("click", layout().divider, { clickCount: 2 });
  assert.equal(share.value, undefined);
  assert.equal(layout().height, 11, "automatic again: a third while M is focused");
});

test("an action for M sends its message to M and moves to M's chat", () => {
  const a = fakeAgent("A", { plan: "# Plan A", revision: 1 } as never);
  const b = fakeAgent("B", { plan: "# Plan B", revision: 1 } as never);
  const m = fakeAgent("M", { plan: "# Plan M", revision: 1 } as never);
  const write = { id: "merge", label: "Write plan M", description: "merge", toMerger: "Write plan M now." };
  const { page, said, actions } = lanesPage([a, b], () => m, 40, "add a cache", [write]);
  page.focusActions();
  let lines = page.render(120);
  assert.match(lines.join("\n"), /Write plan M\s+·\s+Implement…/u);
  assert.ok(
    lines.some((line) => stripVTControlCharacters(line).startsWith("Plan M")),
    "M shows its plan",
  );
  page.handleInput(KEY.enter);
  assert.deepEqual(said, [["M", "Write plan M now."]]);
  assert.deepEqual(actions, [], "not handed to onAction");
  lines = page.render(120);
  const footer = lines.slice(-2).join("\n");
  assert.match(footer, /←→ plan/u, "M's pane is focused, on its chat");
});

test("a lane draws its chat with Pi's components; ctrl+o expands tool output and ctrl+t hides thinking", () => {
  const a = fakeAgent("A");
  const output = Array.from({ length: 40 }, (_unused, index) => `line ${index + 1}`).join("\n");
  a.chat.apply({ type: "tool_execution_start", toolCallId: "1", toolName: "bash", args: { command: "seq 40" } });
  a.chat.apply({
    type: "tool_execution_end",
    toolCallId: "1",
    toolName: "bash",
    result: { content: [{ type: "text", text: output }] },
  });
  const { page } = lanesPage([a], undefined, 80);
  const shown = () =>
    page
      .render(100)
      .map((line) => stripVTControlCharacters(line))
      .join("\n");
  assert.match(shown(), /\$ seq 40/u, "the call as Pi draws it");
  assert.doesNotMatch(shown(), /line 1\b/u, "long output starts collapsed");
  assert.match(shown(), /\^o tools/u);
  page.handleInput(ctrl("o"));
  assert.match(shown(), /line 1\b/u, "expanded");
  assert.match(shown(), /\^o tools/u);

  // Thinking shows, as in pi, until ctrl+t hides it.
  const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "let me look at the cache first" }] };
  a.chat.apply({ type: "message_start", message: thinking });
  a.chat.apply({ type: "message_end", message: thinking });
  assert.match(shown(), /let me look at the cache first/u);
  assert.match(shown(), /\^t thinking/u);
  page.handleInput(ctrl("t"));
  assert.doesNotMatch(shown(), /let me look at the cache first/u, "hidden");
  assert.match(shown(), /\^t thinking/u);
});

test("←/→ on an empty line switch a lane between its plan and its chat, shown as tabs", () => {
  const a = fakeAgent("A", { plan: "# Plan A\n\nUse Redis.", revision: 1 } as never);
  const { page, said } = lanesPage([a]);
  const shown = () =>
    page
      .render(100)
      .map((line) => stripVTControlCharacters(line))
      .join("\n");
  assert.match(shown(), /Use Redis\./u, "a lane with a plan shows it");
  assert.match(shown(), /── plan {2}chat ─/u, "the plan tab is current");
  assert.match(shown(), /←→ chat/u);
  page.handleInput(KEY.right);
  assert.doesNotMatch(shown(), /Use Redis\./u);
  assert.match(shown(), /• started/u, "the chat");
  assert.match(shown(), /←→ plan/u);
  page.handleInput(KEY.left);
  assert.match(shown(), /Use Redis\./u, "and back");
  // With text typed, ←/→ belong to the editor.
  for (const char of "hi") page.handleInput(char);
  page.handleInput(KEY.left);
  assert.match(shown(), /Use Redis\./u);
  page.handleInput(KEY.enter);
  assert.deepEqual(said, [["A", "hi"]]);
  assert.match(shown(), /• started/u, "sending a message shows the chat");
});
