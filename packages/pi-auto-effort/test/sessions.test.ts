import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { branchOf, listSessionFiles, prng, readSession, sampleSessions, sessionsDir, shuffle } from "../eval/sessions.ts";

const quiet = () => undefined;

/** A session file: a header, then `prompts` user messages each followed by tool results, chained by parentId. */
function lines(prompts: number, toolsPerPrompt: number, cwd = "/work/app") {
  const out: unknown[] = [{ type: "session", version: 3, id: "s", cwd }];
  let parent: string | null = null;
  let n = 0;
  const add = (entry: Record<string, unknown>) => {
    const id = `e${n++}`;
    out.push({ ...entry, id, parentId: parent });
    parent = id;
  };
  for (let i = 0; i < prompts; i++) {
    add({ type: "message", message: { role: "user", content: `prompt ${i}` } });
    for (let t = 0; t < toolsPerPrompt; t++) add({ type: "message", message: { role: "toolResult", toolName: "bash", content: [] } });
  }
  return out;
}

function root() {
  return mkdtempSync(path.join(tmpdir(), "auto-effort-sessions-"));
}

/** Writes a session file with the given mtime (seconds since the epoch). */
function put(dir: string, name: string, content: unknown[] | string, mtime: number) {
  const file = path.join(dir, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : content.map((l) => JSON.stringify(l)).join("\n") + "\n");
  utimesSync(file, mtime, mtime);
  return file;
}

describe("listing", () => {
  test("newest first by mtime, jsonl only, subagents directories excluded", () => {
    const dir = root();
    const old = put(dir, "--a--/old.jsonl", lines(1, 1), 1_000);
    const mid = put(dir, "--b--/mid.jsonl", lines(1, 1), 2_000);
    const fresh = put(dir, "--a--/fresh.jsonl", lines(1, 1), 3_000);
    put(dir, "--a--/notes.txt", "x", 4_000);
    put(dir, "--a--/subagents/child.jsonl", lines(1, 1), 5_000);
    put(dir, "subagents/--b--/other.jsonl", lines(1, 1), 6_000);
    // A project whose name merely contains "subagents" is a normal session directory.
    const named = put(dir, "--Users-me-pi-subagents--/s.jsonl", lines(1, 1), 1_500);
    expect(listSessionFiles(dir).map((f) => f.file)).toEqual([fresh, mid, named, old]);
    expect(listSessionFiles(path.join(dir, "missing"))).toEqual([]);
  });

  test("the sessions directory follows PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
    expect(sessionsDir({ PI_CODING_AGENT_DIR: "/x/agent" })).toBe("/x/agent/sessions");
    expect(sessionsDir({})).toMatch(/\.pi[/\\]agent[/\\]sessions$/u);
  });

  test("a session is parsed line by line: bad lines skipped, header read for the cwd", () => {
    const dir = root();
    const file = put(dir, "--a--/s.jsonl", [JSON.stringify({ type: "session", cwd: "/work/x" }), "{ not json", "", "[1]", JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } })].join("\n"), 1_000);
    const session = readSession(file);
    expect(session?.cwd).toBe("/work/x");
    expect(session?.entries).toEqual([{ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } }]);
    expect(readSession(path.join(dir, "nope.jsonl"))).toBeUndefined();
    // Without a header the project directory's name stands in.
    expect(readSession(put(dir, "--b--/s.jsonl", [{ type: "message" }], 1_000))?.cwd).toBe("--b--");
  });
});

describe("the sample", () => {
  test("keeps sessions with enough prompts and tool results, counted on the current branch", () => {
    const dir = root();
    put(dir, "--a--/ok.jsonl", lines(5, 6), 1_000); // 5 prompts, 30 tool results
    put(dir, "--a--/few-prompts.jsonl", lines(4, 10), 1_001);
    put(dir, "--a--/few-tools.jsonl", lines(5, 5), 1_002); // 25
    // Bad lines in an otherwise fine session are skipped.
    const withNoise = [...lines(5, 6).map((l) => JSON.stringify(l)), "{ nope"].join("\n");
    put(dir, "--a--/noisy.jsonl", withNoise, 1_003);
    // Plenty of messages in the file, but most on an abandoned branch: the branch has too few.
    const forked = lines(5, 6);
    forked.push({ type: "message", id: "side", parentId: "e0", message: { role: "user", content: "other" } });
    put(dir, "--a--/forked.jsonl", forked, 1_004);
    const { sessions } = sampleSessions({ dir, seed: 1, log: quiet });
    const names = sessions.map((s) => path.basename(s.file)).sort();
    // The fork's leaf is the last line, whose branch is just e0 and the side message.
    expect(names).toEqual(["noisy.jsonl", "ok.jsonl"]);
    expect(sessions[0]?.cwd).toBe("/work/app");
  });

  test("considers only the newest EVAL_RECENT files, then takes EVAL_SAMPLE", () => {
    const dir = root();
    for (let i = 0; i < 10; i++) put(dir, `--a--/s${i}.jsonl`, lines(5, 6), 1_000 + i);
    const env = { EVAL_RECENT: "4", EVAL_SAMPLE: "3", EVAL_SEED: "7" };
    const { seed, sessions } = sampleSessions({ dir, env, log: quiet });
    expect(seed).toBe(7);
    expect(sessions).toHaveLength(3);
    for (const s of sessions) expect(["s6.jsonl", "s7.jsonl", "s8.jsonl", "s9.jsonl"]).toContain(path.basename(s.file));
  });

  test("the thresholds come from EVAL_MIN_PROMPTS and EVAL_MIN_TOOLS; options beat the environment", () => {
    const dir = root();
    put(dir, "--a--/small.jsonl", lines(2, 3), 1_000);
    expect(sampleSessions({ dir, env: {}, log: quiet }).sessions).toHaveLength(0);
    expect(sampleSessions({ dir, env: { EVAL_MIN_PROMPTS: "2", EVAL_MIN_TOOLS: "6" }, log: quiet }).sessions).toHaveLength(1);
    expect(sampleSessions({ dir, env: { EVAL_MIN_PROMPTS: "2", EVAL_MIN_TOOLS: "6" }, minTools: 7, log: quiet }).sessions).toHaveLength(0);
  });

  test("the same seed gives the same sample; another seed another order; the seed is printed", () => {
    const dir = root();
    for (let i = 0; i < 12; i++) put(dir, `--a--/s${i}.jsonl`, lines(5, 6), 1_000 + i);
    const order = (seed: number) => sampleSessions({ dir, seed, sample: 6, log: quiet }).sessions.map((s) => path.basename(s.file));
    expect(order(11)).toEqual(order(11));
    expect(order(11)).not.toEqual(order(12));
    expect(order(11)).toHaveLength(6);
    const printed: string[] = [];
    const picked = sampleSessions({ dir, env: { EVAL_SEED: "99" }, log: (l) => printed.push(l) });
    expect(picked.seed).toBe(99);
    expect(printed.join("\n")).toContain("EVAL_SEED=99");
    // Without a seed one is drawn, returned and printed.
    const random = sampleSessions({ dir, env: {}, log: (l) => printed.push(l) });
    expect(Number.isInteger(random.seed)).toBe(true);
    expect(printed.at(-1)).toContain(`EVAL_SEED=${random.seed}`);
    // An unusable EVAL_SEED falls back to a random one rather than NaN.
    expect(Number.isInteger(sampleSessions({ dir, env: { EVAL_SEED: "abc" }, log: quiet }).seed)).toBe(true);
  });

  test("the shuffle is a deterministic permutation", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffle(items, 5);
    expect(a).toEqual(shuffle(items, 5));
    expect([...a].sort()).toEqual(items);
    expect(items).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const draw = (seed: number) => {
      const random = prng(seed);
      return [random(), random(), random()];
    };
    expect(draw(3)).toEqual(draw(3));
    expect(draw(3)).not.toEqual(draw(4));
    expect(draw(3).every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

describe("branchOf", () => {
  const entry = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) => ({ type: "message", id, parentId, ...extra });

  test("follows parentId from the last entry to the root, root first", () => {
    // r - a - b - c, and a second child d of b appended last: the leaf is d.
    const entries = [entry("r", null), entry("a", "r"), entry("b", "a"), entry("c", "b"), entry("d", "b")];
    expect(branchOf(entries).map((e) => e.id)).toEqual(["r", "a", "b", "d"]);
  });

  test("a linear session is the whole file", () => {
    const entries = [entry("r", null), entry("a", "r"), entry("b", "a")];
    expect(branchOf(entries).map((e) => e.id)).toEqual(["r", "a", "b"]);
  });

  test("entries without id or parentId fall back to file order", () => {
    const entries = [{ type: "message", message: { role: "user" } }, { type: "custom" }, { type: "message", message: { role: "assistant" } }];
    expect(branchOf(entries)).toEqual(entries);
    // Ids without any parent link (nothing to follow) are file order too.
    const ids = [{ type: "message", id: "a" }, { type: "message", id: "b" }];
    expect(branchOf(ids)).toEqual(ids);
    expect(branchOf([])).toEqual([]);
  });

  test("a missing parent ends the path, a cycle cannot loop, and an entry without an id is skipped", () => {
    expect(branchOf([entry("a", "gone"), entry("b", "a")]).map((e) => e.id)).toEqual(["a", "b"]);
    expect(branchOf([entry("a", "b"), entry("b", "a")]).map((e) => e.id)).toEqual(["a", "b"]);
    const trailing = [entry("a", null), entry("b", "a"), { type: "custom", data: 1 }];
    expect(branchOf(trailing).map((e) => e.id)).toEqual(["a", "b"]);
  });

  test("a second root (navigation can start a new tree) is its own branch", () => {
    const entries = [entry("a", null), entry("b", "a"), entry("x", null), entry("y", "x")];
    expect(branchOf(entries).map((e) => e.id)).toEqual(["x", "y"]);
  });
});
