import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { branchOf, listSessionFiles, prng, readSession, sampleSessions, sessionsDir, shuffle } from "./sessions.ts";

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
  return mkdtempSync(path.join(tmpdir(), "eval-sessions-"));
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
    assert.deepEqual(listSessionFiles(dir).map((f) => f.file), [fresh, mid, named, old]);
    assert.deepEqual(listSessionFiles(path.join(dir, "missing")), []);
  });

  test("the sessions directory follows PI_CODING_AGENT_DIR, else ~/.pi/agent", () => {
    assert.equal(sessionsDir({ PI_CODING_AGENT_DIR: "/x/agent" }), "/x/agent/sessions");
    assert.match(sessionsDir({}), /\.pi[/\\]agent[/\\]sessions$/u);
  });

  test("a session is parsed line by line: bad lines skipped, header read for the cwd", () => {
    const dir = root();
    const file = put(dir, "--a--/s.jsonl", [JSON.stringify({ type: "session", cwd: "/work/x" }), "{ not json", "", "[1]", JSON.stringify({ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } })].join("\n"), 1_000);
    const session = readSession(file);
    assert.equal(session?.cwd, "/work/x");
    assert.deepEqual(session?.entries, [{ type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } }]);
    assert.equal(readSession(path.join(dir, "nope.jsonl")), undefined);
    // Without a header the project directory's name stands in.
    assert.equal(readSession(put(dir, "--b--/s.jsonl", [{ type: "message" }], 1_000))?.cwd, "--b--");
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
    assert.deepEqual(names, ["noisy.jsonl", "ok.jsonl"]);
    assert.equal(sessions[0]?.cwd, "/work/app");
  });

  test("considers only the newest EVAL_RECENT files, then takes EVAL_SAMPLE", () => {
    const dir = root();
    for (let i = 0; i < 10; i++) put(dir, `--a--/s${i}.jsonl`, lines(5, 6), 1_000 + i);
    const env = { EVAL_RECENT: "4", EVAL_SAMPLE: "3", EVAL_SEED: "7" };
    const { seed, sessions } = sampleSessions({ dir, env, log: quiet });
    assert.equal(seed, 7);
    assert.equal(sessions.length, 3);
    for (const s of sessions) assert.ok(["s6.jsonl", "s7.jsonl", "s8.jsonl", "s9.jsonl"].includes(path.basename(s.file)));
  });

  test("the thresholds come from EVAL_MIN_PROMPTS and EVAL_MIN_TOOLS; options beat the environment", () => {
    const dir = root();
    put(dir, "--a--/small.jsonl", lines(2, 3), 1_000);
    assert.equal(sampleSessions({ dir, env: {}, log: quiet }).sessions.length, 0);
    assert.equal(sampleSessions({ dir, env: { EVAL_MIN_PROMPTS: "2", EVAL_MIN_TOOLS: "6" }, log: quiet }).sessions.length, 1);
    assert.equal(sampleSessions({ dir, env: { EVAL_MIN_PROMPTS: "2", EVAL_MIN_TOOLS: "6" }, minTools: 7, log: quiet }).sessions.length, 0);
  });

  test("the same seed gives the same sample; another seed another order; the seed is printed", () => {
    const dir = root();
    for (let i = 0; i < 12; i++) put(dir, `--a--/s${i}.jsonl`, lines(5, 6), 1_000 + i);
    const order = (seed: number) => sampleSessions({ dir, seed, sample: 6, log: quiet }).sessions.map((s) => path.basename(s.file));
    assert.deepEqual(order(11), order(11));
    assert.notDeepEqual(order(11), order(12));
    assert.equal(order(11).length, 6);
    const printed: string[] = [];
    const picked = sampleSessions({ dir, env: { EVAL_SEED: "99" }, log: (l) => printed.push(l) });
    assert.equal(picked.seed, 99);
    assert.ok(printed.join("\n").includes("EVAL_SEED=99"));
    // Without a seed one is drawn, returned and printed.
    const random = sampleSessions({ dir, env: {}, log: (l) => printed.push(l) });
    assert.equal(Number.isInteger(random.seed), true);
    assert.ok(printed.at(-1)?.includes(`EVAL_SEED=${random.seed}`));
    // An unusable EVAL_SEED falls back to a random one rather than NaN.
    assert.equal(Number.isInteger(sampleSessions({ dir, env: { EVAL_SEED: "abc" }, log: quiet }).seed), true);
  });

  test("the shuffle is a deterministic permutation", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = shuffle(items, 5);
    assert.deepEqual(a, shuffle(items, 5));
    assert.deepEqual([...a].sort(), items);
    assert.deepEqual(items, [1, 2, 3, 4, 5, 6, 7, 8]);
    const draw = (seed: number) => {
      const random = prng(seed);
      return [random(), random(), random()];
    };
    assert.deepEqual(draw(3), draw(3));
    assert.notDeepEqual(draw(3), draw(4));
    assert.equal(draw(3).every((x) => x >= 0 && x < 1), true);
  });
});

describe("branchOf", () => {
  const entry = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) => ({ type: "message", id, parentId, ...extra });

  test("follows parentId from the last entry to the root, root first", () => {
    // r - a - b - c, and a second child d of b appended last: the leaf is d.
    const entries = [entry("r", null), entry("a", "r"), entry("b", "a"), entry("c", "b"), entry("d", "b")];
    assert.deepEqual(branchOf(entries).map((e) => e.id), ["r", "a", "b", "d"]);
  });

  test("a linear session is the whole file", () => {
    const entries = [entry("r", null), entry("a", "r"), entry("b", "a")];
    assert.deepEqual(branchOf(entries).map((e) => e.id), ["r", "a", "b"]);
  });

  test("entries without id or parentId fall back to file order", () => {
    const entries = [{ type: "message", message: { role: "user" } }, { type: "custom" }, { type: "message", message: { role: "assistant" } }];
    assert.deepEqual(branchOf(entries), entries);
    // Ids without any parent link (nothing to follow) are file order too.
    const ids = [{ type: "message", id: "a" }, { type: "message", id: "b" }];
    assert.deepEqual(branchOf(ids), ids);
    assert.deepEqual(branchOf([]), []);
  });

  test("a missing parent ends the path, a cycle cannot loop, and an entry without an id is skipped", () => {
    assert.deepEqual(branchOf([entry("a", "gone"), entry("b", "a")]).map((e) => e.id), ["a", "b"]);
    assert.deepEqual(branchOf([entry("a", "b"), entry("b", "a")]).map((e) => e.id), ["a", "b"]);
    const trailing = [entry("a", null), entry("b", "a"), { type: "custom", data: 1 }];
    assert.deepEqual(branchOf(trailing).map((e) => e.id), ["a", "b"]);
  });

  test("a second root (navigation can start a new tree) is its own branch", () => {
    const entries = [entry("a", null), entry("b", "a"), entry("x", null), entry("y", "x")];
    assert.deepEqual(branchOf(entries).map((e) => e.id), ["x", "y"]);
  });
});
