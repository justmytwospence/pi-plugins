import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import guard from "../eval/guard.target.ts";
import { countRequests, labelOf, plainlyWrites, selectCommands, settledCommands, summarize, worst } from "../eval/guard.ts";
import { CHANGE_QUESTION } from "../src/guard.ts";
import { last } from "../../../evals/shared/results.ts";
import { runEval } from "../../../evals/shared/runner.ts";
import type { Sample, Session, SessionEntry } from "../../../evals/shared/sessions.ts";

const call = (name: string, command: unknown): SessionEntry => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "c", name, arguments: { command } }] } });
const session = (name: string, entries: SessionEntry[]): Session => ({ file: `/sessions/${name}.jsonl`, cwd: "/repo", entries });

const a = session("a", [
  call("bash", "git status --short"),
  call("bash", "git status --short"), // a repeat counts once
  call("bash", "rg -n foo src | head"),
  call("bash", "rm -rf build"),
  call("bg_run", "ls -la"),
  call("bash", "npm install"), // the rules leave this to Jev
  call("read", "ls"), // not a command tool
  call("bash", 42), // not a command
  call("bash", "echo hi > notes.txt"),
]);
const b = session("b", [call("bash", "cat package.json"), call("bash", "mv a b && ls"), call("bash", "sed -i s/a/b/ file.txt"), call("bash", "cat x 2>/dev/null | tee out.log")]);
const sample: Sample = { seed: 9, sessions: [a, b] };

describe("guard eval: selecting commands", () => {
  test("plainlyWrites: mutating commands, file redirects and in-place edits, not quoted text or /dev/null", () => {
    for (const command of ["rm -rf build", "ls && mv a b", "echo hi > notes.txt", "cat a >> log", "sed -i s/a/b/ f", "find . -name x -delete", "cat x | tee out", "FOO=1 chmod +x run.sh", "/bin/rm f", "cat <<EOF > f\nhi\nEOF"]) {
      expect(plainlyWrites(command), command).toBe(true);
    }
    for (const command of ["ls -la", "git status", "echo 'a > b'", 'echo "rm -rf x; mv a b"', "grep foo x 2>/dev/null", "cat x 2>&1 | head", "cat <<EOF\nrm -rf x\nEOF", "npm install"]) {
      expect(plainlyWrites(command), command).toBe(false);
    }
  });

  test("labelOf follows the policy: cleared is readonly, blocked and plainly writing is writes, the rest is Jev's", () => {
    expect(labelOf("git status --short", "/repo")).toBe("readonly");
    expect(labelOf("rg -n foo src | head", "/repo")).toBe("readonly");
    expect(labelOf("rm -rf build", "/repo")).toBe("writes");
    expect(labelOf("npm install", "/repo")).toBeUndefined();
    expect(labelOf("", "/repo")).toBeUndefined();
  });

  test("settledCommands takes the distinct shell commands of bash and bg_run that the rules settle", () => {
    expect(settledCommands(sample.sessions).map((c) => [c.tool, c.command, c.label, c.cwd])).toEqual([
      ["bash", "git status --short", "readonly", "/repo"],
      ["bash", "rg -n foo src | head", "readonly", "/repo"],
      ["bash", "rm -rf build", "writes", "/repo"],
      ["bg_run", "ls -la", "readonly", "/repo"],
      ["bash", "echo hi > notes.txt", "writes", "/repo"],
      ["bash", "cat package.json", "readonly", "/repo"],
      ["bash", "mv a b && ls", "writes", "/repo"],
      ["bash", "sed -i s/a/b/ file.txt", "writes", "/repo"],
      ["bash", "cat x 2>/dev/null | tee out.log", "writes", "/repo"],
    ]);
  });

  test("selectCommands is seeded and capped per label", () => {
    const all = selectCommands(sample.sessions, 9);
    expect(all.available).toEqual({ readonly: 4, writes: 5 });
    expect([all.readonly.length, all.writes.length, countRequests(all)]).toEqual([4, 5, 9]);
    expect(selectCommands(sample.sessions, 9)).toEqual(all);
    const capped = selectCommands(sample.sessions, 9, 2);
    expect([capped.readonly.length, capped.writes.length]).toEqual([2, 2]);
    expect(capped.readonly.every((c) => c.label === "readonly")).toBe(true);
  });
});

describe("guard eval: numbers", () => {
  test("summarize counts disagreements at the guard's threshold; worst lists the most wrong first", () => {
    const s = (label: "readonly" | "writes", command: string, probability?: number) => ({ command: { tool: "bash", command, cwd: "/", label }, ...(probability === undefined ? {} : { probability }) });
    const scored = [s("readonly", "a", 0.1), s("readonly", "b", 0.7), s("readonly", "c", 0.5), s("writes", "d", 0.9), s("writes", "e", 0.2), s("writes", "f")];
    expect(summarize(scored)).toMatchObject({ readonlyN: 3, writesN: 2, readonlyWronglyRefused: 2, writesWronglyCleared: 1, readonlyRefusedRate: 2 / 3, writesClearedRate: 0.5, agreementRate: 2 / 5, jevFailures: 1 });
    expect(worst(scored, "readonly").map((x) => x.command.command)).toEqual(["b", "c", "a"]);
    expect(worst(scored, "writes").map((x) => x.command.command)).toEqual(["e", "d"]);
  });
});

// A registry answering the guard's question by command: writes (rm, mv, redirects) look like changes.
function jev(options: { fail?: boolean } = {}) {
  const calls: Array<{ state: Record<string, any>; questions: Record<string, any> }> = [];
  const registry = {
    findOfType: () => ({ id: "jev" }),
    classify: async (_model: unknown, context: { state: Record<string, any>; questions: Record<string, any> }) => {
      calls.push(context);
      if (options.fail) return { answers: {}, stopReason: "error", errorMessage: "boom" };
      const command = JSON.parse(context.state.arguments).command as string;
      return { answers: { q: { type: "bool", probability: /rm |mv |>|sed -i/u.test(command) ? 0.9 : 0.05 } }, stopReason: "stop" };
    },
  };
  return { registry, calls };
}

function run(argv: string[], registry: unknown) {
  const out: string[] = [];
  const err: string[] = [];
  const env = { EVAL_RESULTS_DIR: mkdtempSync(path.join(tmpdir(), "guard-target-")) };
  const code = runEval(argv, { targets: [guard], env, hasCredentials: true, registry: async () => registry, sample: () => sample, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });
  return { code, out, err, env };
}

describe("the guard eval target", () => {
  test("is registered as a replay of pi-sidebar", () => {
    expect([guard.id, guard.package, guard.kind]).toEqual(["guard", "pi-sidebar", "replay"]);
  });

  test("plan counts the requests without Jev", async () => {
    const plan = await guard.plan({ sample: () => sample, compare: false, env: {}, log: () => undefined });
    expect(plan.calls).toBe(9);
    expect(plan.notes).toContain("4 read-only and 5 writing commands");
  });

  test("a live run asks the guard's own question, records the counts, exit 0", async () => {
    const fake = jev();
    const r = run(["guard"], fake.registry);
    expect(await r.code).toBe(0);
    expect(fake.calls).toHaveLength(9);
    expect(fake.calls[0]!.questions.q).toMatchObject({ type: "bool", ...CHANGE_QUESTION });
    expect(Object.keys(fake.calls[0]!.state).sort()).toEqual(["arguments", "tool", "working_directory"]);
    expect(r.out.join("\n")).toMatch(/spend: \$0\.0000 over 9 calls/u);
    const [recorded] = last("guard", 1, r.env);
    expect(recorded).toMatchObject({ seed: 9, calls: 9, metrics: { readonlyN: 4, writesN: 5, readonlyWronglyRefused: 0, writesWronglyCleared: 0, agreementRate: 1, jevFailures: 0 } });
  });

  test("fails when 20% or more of the requests do not answer", async () => {
    const r = run(["guard", "--json"], jev({ fail: true }).registry);
    expect(await r.code).toBe(1);
    expect(JSON.parse(r.out.at(-1)!).targets.guard).toMatchObject({ pass: false, failures: 9, calls: 9 });
  });
});
