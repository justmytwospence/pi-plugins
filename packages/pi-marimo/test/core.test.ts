import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { insertState } from "../src/index.js";
import { headingsFromCode, isMarkdownCell, mdLiterals } from "../src/core/markdown.js";
import { NotebookState } from "../src/core/notebook.js";
import { snapshot, statusParts, shortWhere, statusText } from "../src/core/render.js";
import { SseParser } from "../src/core/sse.js";
import { normalize, within } from "../src/core/io.js";
import { parseMode } from "../src/core/watcher.js";

const attachment = { url: "http://127.0.0.1:2799", sessionId: "s1", path: "/tmp/pmt/nb.py" };

function replay(file: string, until?: (op: string, data: any) => boolean): NotebookState {
  const nb = new NotebookState();
  const parser = new SseParser();
  for (const event of parser.push(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8"))) {
    const message = JSON.parse(event.data);
    nb.apply(message.op, message.data);
    if (until?.(message.op, message.data)) break;
  }
  return nb;
}

describe("markdown", () => {
  test("headings come from mo.md literals, not comments or fences", () => {
    const code = [
      "# a python comment",
      'mo.md(r"""',
      "    # Data loading",
      "    Some *text*.",
      "    ```python",
      "    # not a heading",
      "    ```",
      "    ## **Model** fit ##",
      '    """)',
    ].join("\n");
    expect(headingsFromCode(code)).toEqual([{ level: 1, text: "Data loading" }, { level: 2, text: "Model fit" }]);
  });

  test("single-quoted and f-string literals", () => {
    expect(headingsFromCode('mo.md(f"## Results for {name}")')).toEqual([{ level: 2, text: "Results for {name}" }]);
    expect(mdLiterals("x = mo.md('### A \\'quoted\\' title')")).toEqual(["### A 'quoted' title"]);
  });

  test("markdown cells", () => {
    expect(isMarkdownCell('mo.md("""\n# Title\n""")')).toBe(true);
    expect(isMarkdownCell('mo.md("# Title")\nx = 1')).toBe(false);
  });
});

describe("notebook state from a recorded stream", () => {
  test("tracks the running cell and its section", () => {
    // Stop while lEQa (under "## Slow model fit") is running.
    const nb = replay("kiosk-run.sse", (op, data) => op === "cell-op" && data.cell_id === "lEQa" && data.status === "running");
    const run = nb.running();
    expect(run?.cell.id).toBe("lEQa");
    expect(run?.section).toEqual(["Data loading", "Slow model fit"]);
    expect(nb.queued()).toBe(1);
  });

  test("after the run: errors, defs, idle", () => {
    const nb = replay("kiosk-run.sse");
    expect(nb.running()).toBeUndefined();
    expect(nb.errors().map((c) => [c.id, c.error])).toEqual([["PKri", "ZeroDivisionError: division by zero"]]);
    expect(nb.defs.get("lEQa")).toEqual(["y"]);
    expect(nb.sectionPath("vblA")).toEqual(["Data loading"]);
  });

  test("document transactions: browser edits, creates, reorders", () => {
    const nb = replay("kiosk-run.sse");
    nb.apply("notebook-document-transaction", {
      transaction: {
        source: "frontend",
        changes: [
          { type: "set-code", cellId: "vblA", code: "time.sleep(1)\nx = 2" },
          { type: "create-cell", cellId: "new1", code: 'mo.md("## Plots")', name: "", config: { disabled: false }, after: "lEQa" },
        ],
      },
    });
    expect(nb.order).toEqual(["Hbol", "MJUe", "vblA", "bkHC", "lEQa", "new1", "PKri"]);
    expect(nb.edited(nb.cells.get("vblA")!)).toBe(true);
    expect(nb.sectionPath("PKri")).toEqual(["Data loading", "Plots"]);
    const text = snapshot([{ notebook: nb, attachment, seenSeq: 0 }]);
    expect(text).toContain("vblA: defines x -- edited, not rerun; changed by the user in the browser");
    expect(snapshot([{ notebook: nb, attachment, seenSeq: nb.seq }])).not.toContain("changed by the user");
  });
});

describe("the browser respelling markdown cells", () => {
  // Recorded from marimo 0.25: code mode creates markdown cells, the open browser posts each one
  // back in its own form as a frontend set-code, with no one typing.
  const created = [
    ["dqNf", 'mo.md("Single line markdown.")', 'mo.md("""\nSingle line markdown.\n""")'],
    ["Urrc", 'mo.md("""\n    Indented markdown\n    second line\n""")', 'mo.md("""\nIndented markdown\nsecond line\n""")'],
    ["SKsZ", 'mo.md(\n    """\n    ## Heading\n    Text.\n    """\n)', 'mo.md("""\n## Heading\nText.\n""")'],
    ["XLKe", "mo.md(\'\'\'\nsingle quotes\n\'\'\')", 'mo.md("""\nsingle quotes\n""")'],
  ];

  test("is neither a browser edit nor an edit since the last run", () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: [], codes: [], names: [], configs: [] });
    nb.apply("notebook-document-transaction", {
      transaction: { source: "code-mode", changes: created.map(([cellId, code]) => ({ type: "create-cell", cellId, code, name: "", config: {} })) },
    });
    for (const [cellId] of created) {
      nb.apply("cell-op", { cell_id: cellId, status: "running", timestamp: 1 });
      nb.apply("cell-op", { cell_id: cellId, status: "idle", timestamp: 2 });
    }
    const seen = nb.seq;
    nb.apply("notebook-document-transaction", {
      transaction: { source: "frontend", changes: created.map(([cellId, , code]) => ({ type: "set-code", cellId, code })) },
    });
    for (const [cellId, , code] of created) {
      const cell = nb.cells.get(cellId!)!;
      expect(cell.code).toBe(code);
      expect(cell.editedBy).toBe("code-mode");
      expect(nb.edited(cell)).toBe(false);
    }
    expect(nb.sectionPath("SKsZ")).toEqual(["Heading"]);
    expect(snapshot([{ notebook: nb, attachment, seenSeq: seen }])).not.toMatch(/edited|changed by the user/);
  });

  test("a real change to the markdown still counts", () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: ["a"], codes: ['mo.md("Old text.")'], names: ["_"], configs: [], last_executed_code: { a: 'mo.md("Old text.")' } });
    nb.apply("notebook-document-transaction", { transaction: { source: "frontend", changes: [{ type: "set-code", cellId: "a", code: 'mo.md("""\nNew text.\n""")' }] } });
    const cell = nb.cells.get("a")!;
    expect(cell.editedBy).toBe("frontend");
    expect(nb.edited(cell)).toBe(true);
  });

  test("a reconnect after the respelling does not read as edited", () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: ["a"], codes: ['mo.md("""\nText.\n""")'], names: ["_"], configs: [], last_executed_code: { a: 'mo.md("Text.")' } });
    expect(nb.edited(nb.cells.get("a")!)).toBe(false);
  });
});

describe("render", () => {
  test("status line while running", () => {
    const nb = replay("kiosk-run.sse", (op, data) => op === "cell-op" && data.cell_id === "lEQa" && data.status === "running");
    const since = nb.running()!.since!;
    expect(statusText(statusParts(nb, attachment, "connected", since + 12_400))).toBe(
      "marimo: nb.py · :2799 · running Data loading › Slow model fit (12s) · 1 queued",
    );
    expect(statusText(statusParts(nb, attachment, "disconnected"))).toBe("marimo: nb.py · :2799 · disconnected");
    expect(shortWhere("http://localhost:2718")).toBe(":2718");
    expect(shortWhere("https://nb.example.com/lab/")).toBe("nb.example.com/lab");
    expect(statusText(statusParts(nb, attachment, "connected", since + 1000, [{ ...attachment, path: "/w/prep.py" }, { ...attachment, path: "/w/plots.py" }]))).toBe(
      "marimo: nb.py · :2799 · running Data loading › Slow model fit (1s) · 1 queued · also prep.py, plots.py",
    );
  });

  test("status line names the first error", () => {
    const nb = replay("kiosk-run.sse");
    expect(statusText(statusParts(nb, attachment, "connected"))).toMatch(/ · 1 error: [^·]+ \(ZeroDivisionError\)$/);
    const two = statusText({ notebook: "nb.py", connection: "connected", queued: 0, errors: 2, firstError: "Fit (KeyError)" });
    expect(two).toBe("marimo: nb.py · 2 errors: Fit (KeyError) +1");
  });

  test("snapshot outline", () => {
    const text = snapshot([{ notebook: replay("kiosk-run.sse"), attachment }]);
    expect(text).toContain("# Data loading  [MJUe]");
    expect(text).toContain("## Slow model fit  [bkHC]");
    expect(text).toContain("  PKri: defines z -- ERROR ZeroDivisionError: division by zero");
    expect(text).toContain("Kernel: 1 cell with errors.");
  });

  test("a long queue is counted, not listed", () => {
    const nb = new NotebookState();
    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    nb.apply("kernel-ready", { cell_ids: ids, codes: ids.map((id) => `${id} = 1`), names: [], configs: [] });
    for (const id of ids.slice(1)) nb.apply("cell-op", { cell_id: id, status: "queued", timestamp: 1 });
    nb.apply("cell-op", { cell_id: "c0", status: "running", timestamp: 1 });
    const text = snapshot([{ notebook: nb, attachment }], { maxCells: 10, now: 2000 });
    expect(text).toContain("Kernel: running c0, 19 queued.");
    expect(text).not.toContain("-- queued");
    expect(text).toContain("  c0: c0 = 1 -- RUNNING 1s\n  … 19 more cells");
  });

  test("stale on most cells is said once", () => {
    const nb = new NotebookState();
    nb.apply("kernel-ready", { cell_ids: ["a", "b", "c"], codes: ["a = 1", "b = a", "c = b"], names: [], configs: [] });
    for (const id of ["a", "b"]) nb.apply("cell-op", { cell_id: id, stale_inputs: true });
    const text = snapshot([{ notebook: nb, attachment }]);
    expect(text).toContain("Kernel: 2 of 3 cells stale (inputs changed, not rerun).");
    expect(text).not.toContain("-- stale");
  });

  test("several notebooks: the current one in full, the others as short outlines", () => {
    const current = replay("kiosk-run.sse");
    const other = new NotebookState();
    other.apply("kernel-ready", {
      cell_ids: ["m1", "a", "m2", "b", "c"],
      codes: ['mo.md("# Prep")', "raw = load()", 'mo.md("### Deep detail")', "clean = fix(raw)", "z = 1 / 0"],
      names: [], configs: [],
    });
    other.apply("cell-op", { cell_id: "c", status: "idle", output: { channel: "marimo-error", data: [{ type: "exception", exception_type: "ZeroDivisionError", msg: "division by zero" }] } });
    const text = snapshot([
      { notebook: current, attachment, current: true },
      { notebook: other, attachment: { ...attachment, path: "/w/prep.py", sessionId: "s2" } },
    ]);
    expect(text).toContain('<marimo_notebook_state notebooks="2">');
    expect(text).toContain("=== /tmp/pmt/nb.py (current; http://127.0.0.1:2799, session s1) ===");
    expect(text).toContain("  lEQa: defines y");
    const prep = text.slice(text.indexOf("=== /w/prep.py"));
    expect(prep).toContain("(also followed; http://127.0.0.1:2799, session s2) ===\nmarimo-pair: --url http://127.0.0.1:2799 --file /w/prep.py\nKernel: 1 cell with errors.\n# Prep  [m1]\n  … 2 more cells\n  c: z = 1 / 0 -- ERROR ZeroDivisionError: division by zero");
    expect(prep).not.toContain("Deep detail");
    // Marked full, it lists every cell and heading too, and the block says each is in full.
    const both = snapshot([
      { notebook: current, attachment, current: true },
      { notebook: other, attachment: { ...attachment, path: "/w/prep.py", sessionId: "s2" }, full: true },
    ]);
    expect(both).toContain("each is shown in full");
    expect(both).toContain("  a: raw = load()");
    expect(both).toContain("### Deep detail");
  });

  test("marimo-pair flags for a notebook, quoted when the shell needs it, and the note for an ambiguous call", async () => {
    const { pairFlags, ambiguityNote } = await import("../src/core/render.js");
    expect(pairFlags({ url: "http://127.0.0.1:2718", sessionId: "s1", path: "/w/fit.py" })).toBe("--url http://127.0.0.1:2718 --file /w/fit.py");
    expect(pairFlags({ url: "http://127.0.0.1:2718", sessionId: "s1", path: "/w/my nb's.py" })).toBe("--url http://127.0.0.1:2718 --file '/w/my nb'\\''s.py'");
    const note = ambiguityNote([{ url: "http://h:1", sessionId: "a", path: "/w/a.py" }, { url: "http://h:1", sessionId: "b", path: "/w/b.py" }]);
    expect(note).toMatch(/^pi-marimo: a marimo-pair call here could mean any of 2 followed notebooks/u);
    expect(note).toContain("  b.py: --url http://h:1 --file /w/b.py");
  });

  test("large notebooks fold quiet cells", () => {
    const nb = new NotebookState();
    const ids = Array.from({ length: 80 }, (_, i) => `c${i}`);
    nb.apply("kernel-ready", { cell_ids: ids, codes: ids.map((id, i) => (i % 20 === 0 ? `mo.md("# Part ${i / 20}")` : `${id} = ${i}`)), names: [], configs: [] });
    nb.apply("cell-op", { cell_id: "c45", status: "running", timestamp: 1 });
    const text = snapshot([{ notebook: nb, attachment }], { maxCells: 40, now: 3000 });
    expect(text).toContain("# Part 2  [c40]\n  … 4 more cells\n  c45: c45 = 45 -- RUNNING 2s\n  … 14 more cells\n# Part 3");
  });
});

describe("turn state placement", () => {
  test("after the turn's prompt, at the same place on every request of the turn", () => {
    const block = { role: "custom", timestamp: 0 };
    const prompt = { role: "user", timestamp: 5 };
    const first = insertState([{ role: "user", timestamp: 1 }, { role: "assistant" }, prompt], block, undefined);
    expect(first.messages.indexOf(block)).toBe(3);
    expect(first.anchor).toBe(5);
    // Later in the turn: tool results and a steering message follow; the block stays put.
    const later = insertState([{ role: "user", timestamp: 1 }, { role: "assistant" }, prompt, { role: "assistant" }, { role: "toolResult" }, { role: "user", timestamp: 9 }], block, first.anchor);
    expect(later.messages.indexOf(block)).toBe(3);
  });
});

test("paths", () => {
  expect(within("/a/b/c.py", "/a")).toBe(true);
  expect(within("/a/b/c.py", "/a/")).toBe(true);
  expect(within("/ab/c.py", "/a")).toBe(false);
  expect(normalize("../x/./y.py", "/a/b")).toBe("/a/x/y.py");
});

test("modes, including the single-notebook form saved by older versions", () => {
  expect(parseMode({ kind: "pinned", path: "/a.py", url: "u" })).toEqual({ kind: "pinned", paths: ["/a.py"] });
  expect(parseMode({ kind: "pinned", paths: ["/a.py", "/b.py"] })).toEqual({ kind: "pinned", paths: ["/a.py", "/b.py"] });
  expect(parseMode({ kind: "pinned", paths: [] })).toBeUndefined();
  expect(parseMode({ kind: "auto" })).toEqual({ kind: "auto" });
});

describe("which notebook a tool call works in", async () => {
  const { pairTargets } = await import("../src/core/touch.js");

  test("marimo-pair calls, as bash commands and as JSON tool input", () => {
    const bash = `cd /w && S=.agents/skills/marimo-pair/scripts; bash $S/execute-code.sh --url http://localhost:2730 - <<'PY' 2>&1 | tail -3
import marimo._code_mode as cm
PY
sleep 10; bash $S/execute-code.sh --url http://localhost:2718 --file spencer/notebooks/fit.py - <<'PY'
PY`;
    expect(pairTargets(bash)).toEqual([{ url: "http://localhost:2730" }, { url: "http://localhost:2718", file: "spencer/notebooks/fit.py" }]);
    expect(pairTargets(JSON.stringify({ command: `marimo pair execute --url "http://127.0.0.1:2718" --session s_ab12 --code-file -` }))).toEqual([
      { url: "http://127.0.0.1:2718", session: "s_ab12" },
    ]);
    expect(pairTargets(`marimo pair execute --url $URL --file="$F" -c 'x'`)).toEqual([{ unresolved: true }]);
    expect(pairTargets("ls -la")).toEqual([]);
  });
});

describe("the kernel hold after a turn", async () => {
  const { KernelHold } = await import("../src/core/hold.js");
  const running = () => replay("kiosk-run.sse", (op, data) => op === "cell-op" && data.cell_id === "lEQa" && data.status === "running");
  const followed = (notebook: NotebookState, touchedAt: number, connection: "connected" | "disconnected" = "connected") =>
    [{ attachment, notebook, connection, current: true, touchedAt }];

  test("holds while a notebook the agent worked in this turn runs, then finishes", () => {
    const hold = new KernelHold();
    const nb = running();
    expect(hold.begin(1000)).toEqual({ kind: "none" });
    expect(hold.end(followed(nb, 1500), 2000)).toEqual({ kind: "held", value: "nb.py: Slow model fit" });
    expect(hold.active).toBe(true);
    expect(hold.update(followed(nb, 1500), 2500)).toEqual({ kind: "none" });
    const done = replay("kiosk-run.sse");
    expect(hold.update(followed(done, 1500), 2000 + 75_000)).toEqual({ kind: "finished", title: "nb.py finished", body: "ran 1m15s · 1 error" });
    expect(hold.active).toBe(false);
  });

  test("no hold for a notebook the agent did not touch this turn, or a quiet one", () => {
    const hold = new KernelHold();
    hold.begin(1000);
    expect(hold.end(followed(running(), 500), 2000)).toEqual({ kind: "none" });
    hold.begin(3000);
    expect(hold.end(followed(replay("kiosk-run.sse"), 3500), 4000)).toEqual({ kind: "none" });
    // A turn end without a seen start (an extension reloaded mid-turn) holds nothing.
    expect(hold.end(followed(running(), 3500), 5000)).toEqual({ kind: "none" });
  });

  test("paths: the held notebooks, until the hold ends", () => {
    const hold = new KernelHold();
    hold.begin(1000);
    expect(hold.paths).toEqual([]);
    hold.end(followed(running(), 1500), 2000);
    expect(hold.paths).toEqual([attachment.path]);
    hold.update(followed(replay("kiosk-run.sse"), 1500), 3000);
    expect(hold.paths).toEqual([]);
  });

  test("a new turn releases it; a disconnect ends it as stopped", () => {
    const hold = new KernelHold();
    hold.begin(1000);
    hold.end(followed(running(), 1500), 2000);
    expect(hold.begin(3000)).toEqual({ kind: "released" });
    hold.end(followed(running(), 3500), 4000);
    expect(hold.update(followed(running(), 3500, "disconnected"), 5000)).toEqual({ kind: "finished", title: "nb.py stopped", body: "ran 1s · disconnected" });
  });
});

describe("what the view shows beyond the agent's snapshot", () => {
  const ready = (nb: NotebookState, extra: Record<string, unknown> = {}) =>
    nb.apply("kernel-ready", { cell_ids: ["a", "b", "c"], codes: ["x = 1", "y = x + 1", "z = y * x"], names: ["load", "_", "_"], ...extra });

  test("run times: from a run's start and end, and the milliseconds kernel-ready replays (not a start time)", () => {
    const nb = new NotebookState();
    ready(nb, { last_execution_time: { a: 1234, b: 1_760_000_000.5 } });
    expect(nb.cells.get("a")!.lastRunMs).toBe(1234);
    expect(nb.cells.get("b")!.lastRunMs).toBeUndefined();
    nb.apply("cell-op", { cell_id: "c", status: "running", timestamp: 100 });
    nb.apply("cell-op", { cell_id: "c", status: "idle", timestamp: 102.5 });
    expect(nb.cells.get("c")!.lastRunMs).toBe(2500);
  });

  test("the dataflow graph: what a cell uses, its parents and children; variable values pruned with their variables", () => {
    const nb = new NotebookState();
    ready(nb);
    nb.apply("variables", { variables: [{ name: "x", declared_by: ["a"], used_by: ["b", "c"] }, { name: "y", declared_by: ["b"], used_by: ["c"] }, { name: "z", declared_by: ["c"], used_by: [] }] });
    expect(nb.uses("c")).toEqual(["x", "y"]);
    expect(nb.parents("c")).toEqual(["a", "b"]);
    expect(nb.children("a")).toEqual(["b", "c"]);
    expect(nb.apply("variable-values", { variables: [{ name: "x", value: "1", datatype: "int" }, { name: "z", value: "4", datatype: "int" }] })).toBe(false);
    expect(nb.values.get("x")).toEqual({ value: "1", datatype: "int" });
    nb.apply("variables", { variables: [{ name: "x", declared_by: ["a"], used_by: [] }] });
    expect(nb.values.has("z")).toBe(false);
  });

  test("the agent's code-mode changes since the last prompt, live only; browser edits are not the agent's", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const nb = new NotebookState();
      ready(nb);
      // The replay on connect is history.
      nb.apply("notebook-document-transaction", { transaction: { source: "code-mode", changes: [{ type: "set-code", cellId: "a", code: "x = 0" }] } });
      expect(nb.agentChanges.size).toBe(0);
      vi.setSystemTime(1_005_000);
      const tx = (changes: unknown[], source = "code-mode") => nb.apply("notebook-document-transaction", { transaction: { source, changes } });
      tx([{ type: "set-code", cellId: "b", code: "y = x + 2" }]);
      tx([{ type: "set-code", cellId: "b", code: "y = x + 3" }]);
      expect(nb.agentChanges.get("b")).toMatchObject({ kind: "edited", before: "y = x + 1" });
      tx([{ type: "create-cell", cellId: "n", code: "w = 1", after: "c" }]);
      expect(nb.agentChanges.get("n")).toMatchObject({ kind: "created", before: "" });
      tx([{ type: "delete-cell", cellId: "n" }]);
      expect(nb.agentChanges.has("n")).toBe(false);
      tx([{ type: "delete-cell", cellId: "c" }]);
      expect(nb.agentChanges.get("c")).toMatchObject({ kind: "deleted", before: "z = y * x", name: "_" });
      tx([{ type: "set-code", cellId: "a", code: "x = 5" }], "frontend");
      expect(nb.agentChanges.has("a")).toBe(false);
      // A reconnect keeps them; the user's next prompt clears them.
      ready(nb);
      expect(nb.agentChanges.size).toBe(2);
      nb.markPrompt();
      expect(nb.agentChanges.size).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  test("widget values: kernel-ready's, then the user's from Pi, dropped when their cell runs again", () => {
    const nb = new NotebookState();
    ready(nb, { ui_values: { "a-0": 4 } });
    expect(nb.uiValues.get("a-0")).toBe(4);
    nb.setUserValue("a", "a-0", "n", 7);
    expect(nb.uiValues.get("a-0")).toBe(7);
    const text = snapshot([{ notebook: nb, attachment }]);
    expect(text).toContain('the user set "n" to 7 from Pi');
    nb.apply("cell-op", { cell_id: "a", status: "running", timestamp: 1 });
    expect(nb.uiValues.has("a-0")).toBe(false);
    nb.setUserValue("a", "a-1", "", true);
    nb.apply("remove-ui-elements", { cell_id: "a" });
    expect(nb.uiValues.has("a-1")).toBe(false);
    nb.markPrompt();
    expect(snapshot([{ notebook: nb, attachment }])).not.toContain("the user set");
  });
});
