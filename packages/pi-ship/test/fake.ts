import type { Exec, ExecResult } from "../src/exec.ts";

export const SHA = "a".repeat(40);
export const OLD = "b".repeat(40);

/** A manual clock: timers fire only when the test advances time. */
export function clock() {
  let t = 0;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => {
    for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
  };
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => void timers.delete(id as number),
    settle,
    /** Runs everything due within `ms`, in order, letting async work settle between timers. */
    async advance(ms: number) {
      const target = t + ms;
      await settle();
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
        await settle();
      }
      t = target;
      await settle();
    },
  };
}

export const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });
export const fail = (stderr = "", code = 1): ExecResult => ({ stdout: "", stderr, code });

/** An exec that answers by the joined command line (`cmd arg arg`), first matching rule wins; records calls. */
export function fakeExec(rules: Array<[RegExp, ExecResult | ((line: string) => ExecResult)]>) {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    for (const [re, result] of rules) if (re.test(line)) return typeof result === "function" ? result(line) : result;
    return fail(`unexpected: ${line}`, 127);
  };
  return { exec, calls };
}

export function run(over: Partial<{ databaseId: number; workflowName: string; status: string; conclusion: string; url: string }> = {}) {
  return { databaseId: 1, name: "Checks", workflowName: "Checks", status: "completed", conclusion: "success", url: "https://github.com/o/r/actions/runs/1", event: "push", ...over };
}
