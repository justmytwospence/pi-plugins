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
    const p = raceRemote<string>(
      (s) => never(s),
      (s) => {
        remoteSignal = s;
        return never(s);
      },
      outer.signal,
    );
    outer.abort();
    expect((await p).value).toBeUndefined();
    expect(remoteSignal?.reason).toBe("pi");
  });

  it("remoteUi is undefined without a provider", () => {
    expect(remoteUi({ events: { emit: () => {} } })).toBeUndefined();
    expect(remoteUi({})).toBeUndefined();
    const ui = {} as never;
    expect(remoteUi({ events: { emit: (_c, d) => void ((d as { ui?: unknown }).ui = ui) } })).toBe(ui);
  });
});
