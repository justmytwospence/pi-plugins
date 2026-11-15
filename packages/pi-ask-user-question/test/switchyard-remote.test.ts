import { describe, expect, it } from "vitest";
import { raceRemote, remoteUi } from "../src/switchyard-remote.js";

const never = (signal: AbortSignal) =>
  new Promise<string | undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined)));

describe("switchyard remote ui", () => {
  it("remote wins and aborts the terminal dialog", async () => {
    let terminalSignal: AbortSignal | undefined;
    const r = await raceRemote<string>(
      (s) => {
        terminalSignal = s;
        return never(s);
      },
      async () => "web",
    );
    expect(r).toEqual({ value: "web", from: "remote" });
    expect(terminalSignal?.aborted).toBe(true);
  });

  it("terminal wins and aborts the remote dialog with reason terminal", async () => {
    let remoteSignal: AbortSignal | undefined;
    const r = await raceRemote<string>(
      async () => "tty",
      (s) => {
        remoteSignal = s;
        return never(s);
      },
    );
    expect(r).toEqual({ value: "tty", from: "terminal" });
    expect(remoteSignal?.aborted).toBe(true);
    expect(remoteSignal?.reason).toBe("terminal");
  });

  it("an outer abort aborts the remote with reason pi", async () => {
    const outer = new AbortController();
    let remoteSignal: AbortSignal | undefined;
    let terminalSignal: AbortSignal | undefined;
    const p = raceRemote<string>(
      (s) => {
        terminalSignal = s;
        return never(s);
      },
      (s) => {
        remoteSignal = s;
        return never(s);
      },
      outer.signal,
    );
    outer.abort();
    expect((await p).value).toBeUndefined();
    expect(remoteSignal?.reason).toBe("pi");
    expect(terminalSignal?.aborted).toBe(true);
  });

  it.each(["terminal", "remote"] as const)("a %s failure aborts both owners and does not retry", async (side) => {
    const signals: AbortSignal[] = [];
    const calls: string[] = [];
    const dialog = (name: string) => (signal: AbortSignal) => {
      signals.push(signal);
      calls.push(name);
      if (name === side) return Promise.reject(new Error("failed claim"));
      return never(signal).then(() => { throw new Error("loser abort rejection"); });
    };
    await expect(raceRemote(dialog("terminal"), dialog("remote"))).rejects.toThrow("failed claim");
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["remote", "terminal"]);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it.each(["terminal", "remote"] as const)("a synchronous %s throw still cleans up both branches", async (side) => {
    const signals: AbortSignal[] = [];
    const dialog = (name: string) => (signal: AbortSignal) => {
      signals.push(signal);
      if (name === side) throw new Error("sync failure");
      return never(signal);
    };
    await expect(raceRemote(dialog("terminal"), dialog("remote"))).rejects.toThrow("sync failure");
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("first answer wins even when the loser later rejects", async () => {
    let rejectLoser!: (error: Error) => void;
    const result = await raceRemote(
      () => new Promise<string>((_resolve, reject) => { rejectLoser = reject; }),
      async () => "web",
    );
    rejectLoser(new Error("retired terminal"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(result).toEqual({ value: "web", from: "remote" });
  });

  it("a pre-aborted outer signal starts neither dialog", async () => {
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    const dialog = async () => { calls++; return "not reached"; };
    expect(await raceRemote(dialog, dialog, abort.signal)).toEqual({ value: undefined, from: "terminal" });
    expect(calls).toBe(0);
  });

  it("remoteUi is undefined without a provider", () => {
    expect(remoteUi({ events: { emit: () => {} } })).toBeUndefined();
    expect(remoteUi({})).toBeUndefined();
    const ui = {} as never;
    expect(
      remoteUi({
        events: {
          emit: (_c, d) => {
            (d as { ui?: unknown }).ui = ui;
          },
        },
      }),
    ).toBe(ui);
  });
});
